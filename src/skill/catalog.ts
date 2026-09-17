import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { JsonObject, JsonSchema, ToolCapability } from "../agent/types.ts";
import { WorkspacePolicy } from "../tools/security.ts";
import type { LoadedSkill, SkillCatalogLike, SkillDescriptor, SkillMatch, SkillManifest, SkillResource, SkillSource, SkillCatalogOptions } from "./types.ts";

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
  maxMatches: 8,
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
      maxMatches: options.maxMatches ?? DEFAULTS.maxMatches,
    };
    for (const key of ["maxSkills", "maxFileBytes", "maxContentChars", "maxResourceBytes", "maxResources", "maxMatches"] as const) {
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

  match(request: string): readonly SkillMatch[] {
    const tokens = tokenize(request);
    if (!tokens.length) return [];
    return this.descriptors
      .filter((skill) => skill.valid)
      .map((skill) => scoreSkill(skill, tokens))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || sourceRank(a.skill.source) - sourceRank(b.skill.source) || a.skill.manifest.name.localeCompare(b.skill.manifest.name))
      .slice(0, this.options.maxMatches);
  }

  async read(name: string, source?: SkillSource): Promise<LoadedSkill> {
    const candidates = this.descriptors.filter((descriptor) => descriptor.valid && descriptor.manifest.name === name && (!source || descriptor.source === source));
    const descriptor = candidates.sort((a, b) => sourceRank(a.source) - sourceRank(b.source))[0];
    if (!descriptor) throw new Error(`Skill not found or invalid: ${name}${source ? ` (${source})` : ""}`);
    const raw = await fs.readFile(descriptor.instructionPath, "utf8");
    const content = parseSkillDocument(raw).content;
    const truncated = content.length > this.options.maxContentChars;
    const resources = await this.readResources(descriptor);
    return { descriptor, content: content.slice(0, this.options.maxContentChars), resources, truncated };
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
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return { frontmatter: {}, content: raw, diagnostics: ["SKILL.md must start with YAML frontmatter"] };
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const end = lines.indexOf("---", 1);
  if (end < 0) return { frontmatter: {}, content: raw, diagnostics: ["YAML frontmatter is not terminated"] };
  const frontmatter: Record<string, unknown> = {};
  let currentArray: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item && currentArray) { (frontmatter[currentArray] as string[]).push(item[1].trim().replace(/^['\"]|['\"]$/g, "")); continue; }
    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) { diagnostics.push(`invalid frontmatter line: ${line.slice(0, 120)}`); continue; }
    const [, key, value] = pair;
    if (!value) { frontmatter[key] = []; currentArray = key; continue; }
    currentArray = undefined;
    try { frontmatter[key] = parseScalar(value); } catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)); }
  }
  return { frontmatter, content: lines.slice(end + 1).join("\n").replace(/^\n/, ""), diagnostics };
}

function parseScalar(value: string): string | boolean | number | null | string[] | JsonObject {
  const text = value.trim();
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith("[") && text.endsWith("]")) || (text.startsWith("{") && text.endsWith("}"))) {
    try { return JSON.parse(text) as string[] | JsonObject; } catch { throw new Error(`invalid JSON-like frontmatter value: ${text.slice(0, 100)}`); }
  }
  return text.replace(/^['"]|['"]$/g, "");
}

function scoreSkill(skill: SkillDescriptor, tokens: readonly string[]): SkillMatch {
  const fields: Array<[string, string, number]> = [["name", skill.manifest.name, 6], ["description", skill.manifest.description, 2], ["trigger", (skill.manifest.triggers ?? []).join(" "), 4], ["tag", (skill.manifest.tags ?? []).join(" "), 3]];
  let score = 0;
  const reasons: string[] = [];
  for (const [label, value, weight] of fields) {
    const fieldTokens = tokenize(value);
    const count = tokens.filter((token) => fieldTokens.includes(token)).length;
    if (count) { score += count * weight; reasons.push(`${label} matched ${count} token(s)`); }
  }
  return { skill, score, reasons };
}
function tokenize(value: string): string[] { return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1))]; }
function sourceRank(source: SkillSource): number { return source === "repository" ? 0 : 1; }
function digestText(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
async function realDirectory(value: string): Promise<string | undefined> { try { const real = await fs.realpath(value); return (await fs.stat(real)).isDirectory() ? real : undefined; } catch { return undefined; } }
async function countResources(directory: string, limit: number): Promise<number> { let count = 0; for (const name of ["references", "templates", "assets"]) { await walk(path.join(directory, name), async () => { count += 1; }, limit); if (count >= limit) break; } return count; }
async function walk(directory: string, visit: (file: string) => Promise<void>, limit: number): Promise<void> { let entries: import("node:fs").Dirent[]; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; } for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { if (entry.name.startsWith(".")) continue; const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file, visit, limit); else if (entry.isFile()) { await visit(file); if (limit <= 1) return; } } }

export { manifestSchema, parseSkillDocument };
