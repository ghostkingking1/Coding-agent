import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ToolOutputArtifact { readonly artifactId: string; readonly path: string; readonly bytes: number; readonly complete: boolean; }
export interface ToolOutputStoreOptions { readonly rootDirectory?: string; readonly maxArtifactBytes?: number; readonly maxPreviewCharacters?: number; }
export interface ToolOutputWriter { append(chunk: Buffer | string): Promise<void>; close(): Promise<{ artifactId: string; content: string; complete: boolean }>; }

/** 将完整工具输出放在临时目录，模型上下文只携带可恢复的引用和预览。 */
export class ToolOutputStore {
  private readonly rootDirectory: string;
  readonly maxArtifactBytes: number;
  readonly maxPreviewCharacters: number;
  constructor(options: ToolOutputStoreOptions = {}) {
    this.rootDirectory = options.rootDirectory ?? path.join(os.tmpdir(), "coding-agent-tool-output", crypto.randomUUID());
    this.maxArtifactBytes = options.maxArtifactBytes ?? 10 * 1024 * 1024;
    this.maxPreviewCharacters = options.maxPreviewCharacters ?? 4_000;
    if (!Number.isInteger(this.maxArtifactBytes) || this.maxArtifactBytes < 1) throw new Error("maxArtifactBytes must be a positive integer");
    if (!Number.isInteger(this.maxPreviewCharacters) || this.maxPreviewCharacters < 32) throw new Error("maxPreviewCharacters must be at least 32");
  }
  async save(sessionId: string | undefined, runId: string | undefined, content: string): Promise<{ artifact: ToolOutputArtifact; message: string }> {
    const artifactId = `out_${crypto.randomUUID()}`;
    const directory = path.join(this.rootDirectory, safePart(sessionId ?? "anonymous"), safePart(runId ?? "run"));
    const filePath = path.join(directory, `${artifactId}.txt`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(filePath, "", "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    const complete = bytes <= this.maxArtifactBytes;
    const stored = complete ? content : Buffer.from(content, "utf8").subarray(0, this.maxArtifactBytes).toString("utf8");
    await fs.writeFile(filePath, stored, "utf8");
    await fs.writeFile(path.join(directory, `${artifactId}.json`), JSON.stringify({ complete }), "utf8");
    const availability = complete ? "完整输出已保存" : `输出超过 ${this.maxArtifactBytes} 字节，已保存可用前缀`;
    const instruction = complete ? "需要其余内容时调用 read_tool_output，使用 offset/limit 分页读取。" : "未保存的尾部不可恢复。";
    return { artifact: { artifactId, path: filePath, bytes: Buffer.byteLength(stored, "utf8"), complete }, message: `${previewText(content, this.maxPreviewCharacters)}\n[${availability}] artifactId=${artifactId}。${instruction}` };
  }
  async createWriter(sessionId: string | undefined, runId: string | undefined, name: string): Promise<ToolOutputWriter> {
    const artifactId = `out_${crypto.randomUUID()}`;
    const directory = path.join(this.rootDirectory, safePart(sessionId ?? "anonymous"), safePart(runId ?? "run"));
    const filePath = path.join(directory, `${artifactId}.txt`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(filePath, "", "utf8");
    const maxBytes = this.maxArtifactBytes;
    let bytes = 0;
    let overflowed = false;
    let closed = false;
    return {
      async append(chunk) {
        if (closed) throw new Error("Tool output writer is closed");
        if (bytes >= maxBytes) { overflowed = true; return; }
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        const remaining = maxBytes - bytes;
        await fs.appendFile(filePath, data.subarray(0, remaining));
        bytes += Math.min(data.byteLength, remaining);
        if (data.byteLength > remaining) overflowed = true;
      },
      async close() {
        closed = true;
        const complete = !overflowed;
        await fs.writeFile(path.join(directory, `${artifactId}.json`), JSON.stringify({ complete, name: safePart(name) }), "utf8");
        return { artifactId, content: await fs.readFile(filePath, "utf8"), complete };
      },
    };
  }
  async read(sessionId: string | undefined, runId: string | undefined, artifactId: string, offset: number, limit: number): Promise<{ content: string; nextOffset?: number; complete: boolean }> {
    if (!/^out_[A-Za-z0-9-]+$/.test(artifactId)) throw new Error("Invalid artifactId");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new Error("offset and limit are invalid");
    const filePath = path.join(this.rootDirectory, safePart(sessionId ?? "anonymous"), safePart(runId ?? "run"), `${artifactId}.txt`);
    try { await fs.access(filePath); } catch { throw new Error("Tool output artifact not found"); }
    const data = await fs.readFile(filePath, "utf8");
    const metadata = JSON.parse(await fs.readFile(filePath.replace(/\.txt$/, ".json"), "utf8")) as { complete?: boolean };
    const content = data.slice(offset, offset + limit);
    return { content, ...(offset + content.length < data.length ? { nextOffset: offset + content.length } : {}), complete: metadata.complete === true };
  }
  async dispose(): Promise<void> { await fs.rm(this.rootDirectory, { recursive: true, force: true }); }
}
function safePart(value: string): string { return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : "invalid"; }
function previewText(value: string, limit: number): string { return value.length <= limit ? value : `${value.slice(0, Math.ceil(limit / 2))}\n...[tool output preview truncated]...\n${value.slice(-Math.floor(limit / 2))}`; }
