import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { WorkspacePolicy } from "../tools/security.ts";
import type { LoadedSkill, SkillCatalogLike, SkillDescriptor, SkillManifest, SkillResource, SkillSource, SkillCatalogOptions, SkillVerification } from "./types.ts";

const manifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  description: z.string().min(1).max(2000),
  version: z.string().max(100).optional(),
  triggers: z.array(z.string().min(1).max(200)).max(32).optional(),
  tags: z.array(z.string().min(1).max(100)).max(32).optional(),
  capabilities: z.array(z.enum(["read", "write", "execute", "network"])).max(4).optional(),
  dependencies: z.array(z.string().min(1).max(200)).max(32).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
}).strict();

const DEFAULTS = {
  maxSkills: 128,
  maxFileBytes: 256 * 1024,
  maxContentChars: 32_000,
  maxResourceBytes: 128 * 1024,
  maxResources: 64,
} as const;

/** 受控、只读的 SKILL.md 目录；Skill 内容永远不会改变工具授权。 */
export class SkillCatalog implements SkillCatalogLike {
  private readonly options: Required<SkillCatalogOptions> & { userRoot: string };
  private descriptors: SkillDescriptor[] = [];

  constructor(options: SkillCatalogOptions) {
    const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    this.options = {
      ...options,
      userRoot: options.userRoot ?? path.join(home, "skills"),
      maxSkills: options.maxSkills ?? DEFAULTS.maxSkills,
      maxFileBytes: options.maxFileBytes ?? DEFAULTS.maxFileBytes,
      maxContentChars: options.maxContentChars ?? DEFAULTS.maxContentChars,
      maxResourceBytes: options.maxResourceBytes ?? DEFAULTS.maxResourceBytes,
      maxResources: options.maxResources ?? DEFAULTS.maxResources,
    };
    for (const key of ["maxSkills", "maxFileBytes", "maxContentChars", "maxResourceBytes", "maxResources"] as const) {
      const value = this.options[key];
      if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
    }
    }

  async refresh(): Promise<readonly SkillDescriptor[]> {
    const next: SkillDescriptor[] = [];
    const repositoryPolicy = new WorkspacePolicy({ root: this.options.workspaceRoot, allowHidden: true, maxFileBytes: this.options.maxFileBytes, maxEntries: this.options.maxSkills });
    await this.scanRoot(path.join(this.options.workspaceRoot, ".codex", "skills"), "repository", next, (candidate) => {
      const relative = path.relative(repositoryPolicy.root, candidate);
      if (relative === ".codex\\skills" || relative === ".codex/skills") return candidate;
      return repositoryPolicy.resolveControlledExisting(relative, ".codex/skills");
    });
    const userRoot = await realDirectory(this.options.userRoot);
    if (userRoot) {
      const userPolicy = new WorkspacePolicy({ root: userRoot, allowHidden: true, maxFileBytes: this.options.maxFileBytes, maxEntries: this.options.maxSkills });
      await this.scanRoot(userRoot, "user", next, (candidate) => userPolicy.resolveExisting(path.relative(userRoot, candidate)));
    }
    this.descriptors = next;
    return this.list();
  }

  get userRoot(): string { return this.options.userRoot; }

  list(): readonly SkillDescriptor[] { return [...this.descriptors]; }

  async verify(name: string, source?: SkillSource, expectedDigest?: string): Promise<SkillVerification> {
    const descriptor = this.findDescriptor(name, source);
    const raw = await fs.readFile(descriptor.instructionPath, "utf8");
    const currentDigest = digestText(raw);
    return { skill: descriptor, currentDigest, matchesCatalogDigest: currentDigest === descriptor.digest && (!expectedDigest || currentDigest === expectedDigest) };
  }

  async read(name: string, source?: SkillSource): Promise<LoadedSkill> {
    const descriptor = this.findDescriptor(name, source);
    const raw = await fs.readFile(descriptor.instructionPath, "utf8");
    // 用同一次读取的数据计算摘要并解析，避免校验后再次读取形成 TOCTOU 窗口。
    if (digestText(raw) !== descriptor.digest) throw new Error(`Skill digest changed after discovery: ${name}`);
    const content = parseSkillDocument(raw).content;
    const truncated = content.length > this.options.maxContentChars;
    const resources = await this.readResources(descriptor);
    return { descriptor, content: content.slice(0, this.options.maxContentChars), resources, truncated };
  }

  private findDescriptor(name: string, source?: SkillSource): SkillDescriptor {
    const candidates = this.descriptors.filter((descriptor) => descriptor.valid && descriptor.manifest.name === name && (!source || descriptor.source === source));
    const descriptor = candidates.sort((a, b) => sourceRank(a.source) - sourceRank(b.source))[0];
    if (!descriptor) throw new Error(`Skill not found or invalid: ${name}${source ? ` (${source})` : ""}`);
    return descriptor;
  }

  private async scanRoot(root: string, source: SkillSource, output: SkillDescriptor[], resolveCandidate: (path: string) => string): Promise<void> {
    const realRoot = await realDirectory(root);
    if (!realRoot) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(realRoot, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (output.length >= this.options.maxSkills) break;
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(realRoot, entry.name);
      let safeDirectory: string;
      try { safeDirectory = resolveCandidate(directory); } catch { continue; }
      const descriptor = await this.inspectSkill(safeDirectory, source);
      output.push(descriptor);
    }
  }

  private async inspectSkill(directory: string, source: SkillSource): Promise<SkillDescriptor> {
    const instructionPath = path.join(directory, "SKILL.md");
    const diagnostics: string[] = [];
    let raw = "";
    try {
      const stat = await fs.stat(instructionPath);
      if (!stat.isFile()) diagnostics.push("SKILL.md is not a regular file");
      else if (stat.size > this.options.maxFileBytes) diagnostics.push(`SKILL.md exceeds ${this.options.maxFileBytes} bytes`);
      else raw = await fs.readFile(instructionPath, "utf8");
    } catch { diagnostics.push("SKILL.md is missing or unreadable"); }
    let manifest: SkillManifest = { name: path.basename(directory), description: "" };
    let digest = digestText(raw);
    let resourceCount = 0;
    if (raw) {
      const parsed = parseSkillDocument(raw);
      diagnostics.push(...parsed.diagnostics);
      const result = manifestSchema.safeParse(parsed.frontmatter);
      if (result.success) manifest = result.data as SkillManifest;
      else diagnostics.push(...result.error.issues.map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`));
      if (manifest.name !== path.basename(directory)) diagnostics.push("manifest name must match its directory");
      resourceCount = await countResources(directory, this.options.maxResources + 1);
      if (resourceCount > this.options.maxResources) diagnostics.push(`resource count exceeds ${this.options.maxResources}`);
    }
    return { manifest, source, directory, instructionPath, digest, valid: diagnostics.length === 0, diagnostics, resourceCount };
  }

  private async readResources(descriptor: SkillDescriptor): Promise<readonly SkillResource[]> {
    const resources: SkillResource[] = [];
    for (const [directoryName, kind] of [["references", "reference"], ["templates", "template"], ["assets", "asset"]] as const) {
      await walk(path.join(descriptor.directory, directoryName), async (file) => {
        if (resources.length >= this.options.maxResources) return;
        const stat = await fs.stat(file);
        if (stat.size > this.options.maxResourceBytes) return;
        resources.push({ path: path.relative(descriptor.directory, file), kind, size: stat.size });
      }, this.options.maxResources);
    }
    return resources;
  }
}

function parseSkillDocument(raw: string): { frontmatter: Record<string, unknown>; content: string; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, content: raw, diagnostics: ["SKILL.md must start with YAML frontmatter"] };

  // 先保留明确的终止检查，避免 gray-matter 将未闭合正文误当成 YAML 内容。
  const lines = normalized.split("\n");
  if (lines.findIndex((line, index) => index > 0 && line === "---") < 0) {
    return { frontmatter: {}, content: raw, diagnostics: ["YAML frontmatter is not terminated"] };
  }

  try {
    const parsed = matter(raw, {
      engines: {
        yaml: {
          parse: (value: string): object => {
            const result = parseYaml(value);
            if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("frontmatter must be a YAML mapping");
            return result as Record<string, unknown>;
          },
        },
      },
    });
    return { frontmatter: parsed.data as Record<string, unknown>, content: parsed.content, diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(`invalid YAML frontmatter: ${message}`);
    return { frontmatter: {}, content: raw, diagnostics };
  }
}

function sourceRank(source: SkillSource): number { return source === "repository" ? 0 : 1; }
function digestText(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
async function realDirectory(value: string): Promise<string | undefined> { try { const real = await fs.realpath(value); return (await fs.stat(real)).isDirectory() ? real : undefined; } catch { return undefined; } }
async function countResources(directory: string, limit: number): Promise<number> { let count = 0; for (const name of ["references", "templates", "assets"]) { await walk(path.join(directory, name), async () => { count += 1; }, limit); if (count >= limit) break; } return count; }
async function walk(directory: string, visit: (file: string) => Promise<void>, limit: number): Promise<void> { let entries: import("node:fs").Dirent[]; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; } for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { if (entry.name.startsWith(".")) continue; const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file, visit, limit); else if (entry.isFile()) { await visit(file); if (limit <= 1) return; } } }

export { manifestSchema, parseSkillDocument };
