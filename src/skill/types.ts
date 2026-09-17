import type { JsonSchema, ToolCapability } from "../agent/types.ts";

export type SkillSource = "repository" | "user";

export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly triggers?: readonly string[];
  readonly tags?: readonly string[];
  readonly capabilities?: readonly ToolCapability[];
  readonly dependencies?: readonly string[];
  readonly input?: JsonSchema;
}

export interface SkillResource {
  readonly path: string;
  readonly kind: "reference" | "template" | "asset";
  readonly size: number;
}

export interface SkillDescriptor {
  readonly manifest: SkillManifest;
  readonly source: SkillSource;
  readonly directory: string;
  readonly instructionPath: string;
  readonly digest: string;
  readonly valid: boolean;
  readonly diagnostics: readonly string[];
  readonly resourceCount: number;
}

export interface SkillMatch {
  readonly skill: SkillDescriptor;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface LoadedSkill {
  readonly descriptor: SkillDescriptor;
  readonly content: string;
  readonly resources: readonly SkillResource[];
  readonly truncated: boolean;
}

export interface SkillCatalogOptions {
  readonly workspaceRoot: string;
  readonly userRoot?: string;
  readonly maxSkills?: number;
  readonly maxFileBytes?: number;
  readonly maxContentChars?: number;
  readonly maxResourceBytes?: number;
  readonly maxResources?: number;
  readonly maxMatches?: number;
}

export interface SkillCatalogLike {
  list(): readonly SkillDescriptor[];
  match(request: string): readonly SkillMatch[];
  read(name: string, source?: SkillSource): Promise<LoadedSkill>;
}

export interface SkillCaptureInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly name: string;
  readonly global?: boolean;
}

export interface SkillDraft {
  readonly manifest: SkillManifest;
  readonly content: string;
  readonly evidence: readonly string[];
  readonly target: SkillSource;
  readonly path: string;
}
