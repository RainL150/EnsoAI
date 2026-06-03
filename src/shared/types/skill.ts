// Skill Gateway v2 types — shared across main and renderer.
//
// Two-level model:
//   SkillSource (a git repo or a local directory)
//     └─ AvailableSkill[] (directories with SKILL.md inside the source)
//
// Installed skills are tracked separately (InstalledSkill) with per-target
// status so we can detect: managed / modified / missing / wrong-symlink.

export type SkillTarget = 'claude' | 'codex';
export type SkillSourceType = 'git' | 'local';
export type SkillInstallMode = 'symlink' | 'copy';
export type SkillTargetStatus = 'managed' | 'modified' | 'missing' | 'wrong-symlink';

export interface SkillSource {
  /** Stable generated id, e.g. `src_<uuid>`. */
  id: string;
  type: SkillSourceType;
  /** User-facing label (e.g. "Anthropic Official", "My Dev Skills"). */
  name: string;

  // Git-type source
  /** Required when type='git'. */
  repoUrl?: string;
  /** Default 'main'. */
  branch?: string;
  /** Relative path inside the repo to scan for skills. Default '.'. */
  sourceDir?: string;

  // Local-type source
  /** Required when type='local'. Absolute path to a directory containing SKILL.md or skill subdirs. */
  localPath?: string;

  enabled: boolean;
  lastRefreshAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  author?: string;
}

/**
 * A skill discovered inside a source. May or may not be installed yet.
 * Browsing a source produces a list of these.
 */
export interface AvailableSkill {
  sourceId: string;
  /** From SKILL.md frontmatter `name`. Unique within a source. */
  name: string;
  description?: string;
  version?: string;
  /** Absolute path to the directory containing SKILL.md. */
  contentPath: string;
  /** SHA256 of skill directory content; drives update detection. */
  contentHash: string;
  installed: boolean;
}

export interface SkillTargetState {
  mode: SkillInstallMode;
  /** Absolute path of the mirror entry (e.g. ~/.claude/skills/<name>). */
  path: string;
  status: SkillTargetStatus;
  installedAt: string;
  /** For mode='copy', hash of the copied content used to detect drift. */
  installedHash?: string;
}

/**
 * An installed skill — persisted in the lock file.
 * `id` is a composite key: `<sourceId>::<name>`.
 */
export interface InstalledSkill {
  id: string;
  sourceId: string;
  name: string;
  description?: string;
  version?: string;
  /** Path on disk where the canonical content lives (cache for git, dev dir for local). */
  contentPath: string;
  /** Content hash at install time; compare against current source to detect updates. */
  contentHash: string;
  targets: Partial<Record<SkillTarget, SkillTargetState>>;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
}

/** Lock file payload — single source of truth on disk. */
export interface SkillLockFile {
  version: 2;
  sources: SkillSource[];
  skills: InstalledSkill[];
}

// ---- IPC request/response shapes ----

export interface AddSkillSourceRequest {
  type: SkillSourceType;
  name: string;
  repoUrl?: string;
  branch?: string;
  sourceDir?: string;
  localPath?: string;
}

export interface InstallSkillRequest {
  sourceId: string;
  /** Skill name within the source (matches AvailableSkill.name). */
  name: string;
  /** Which providers to install to, with mode per provider. */
  targets: Partial<Record<SkillTarget, { mode: SkillInstallMode }>>;
}

export interface UninstallSkillOptions {
  /**
   * When true, only remove the mirror entries; keep the canonical content
   * on disk (always true for type='local' sources to protect user dev dirs).
   */
  keepContent?: boolean;
}

export interface UpdateAvailableInfo {
  skillId: string;
  name: string;
  currentHash: string;
  remoteHash: string;
}
