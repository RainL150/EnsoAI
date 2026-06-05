// One-shot migration from v1 `~/.ensoai/skills/_index.json` to v2 lock format.
// Idempotent guard: skipped if v1 file missing, or if v2 lock already has data.
// On success, renames the v1 file to `_index.json.v1.bak.<timestamp>` so it
// can be inspected by the user but won't re-trigger migration.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstalledSkill, SkillSource, SkillTarget } from '@shared/types';
import { CLAUDE_NATIVE_SOURCE_ID, CODEX_NATIVE_SOURCE_ID } from '@shared/types';
import { parseSkillFrontMatter } from '../../utils/skillFrontmatter';
import { unlinkSafe } from './linker';
import { hashDir } from './SkillHash';
import {
  ensureLayout,
  generateSourceId,
  getCanonicalContentRoot,
  getEnsoaiRoot,
  getLegacyV1IndexPath,
  getSourcesCacheRoot,
  hasLegacyV1Index,
  readLock,
  writeLock,
} from './SkillLockStore';

interface V1Entry {
  targets: string[];
  enabled: boolean;
  source: 'git' | 'native-promoted' | 'manual';
  gitUrl?: string;
  author?: string;
  version?: string;
  installedAt: string;
  updatedAt: string;
}

interface V1Index {
  version: 1;
  skills: Record<string, V1Entry>;
}

export interface MigrationResult {
  migrated: boolean;
  reason?: string;
  sourcesCreated: number;
  skillsCreated: number;
  warnings: string[];
}

function emptyResult(reason: string): MigrationResult {
  return { migrated: false, reason, sourcesCreated: 0, skillsCreated: 0, warnings: [] };
}

/**
 * Run the v1→v2 migration if applicable. Safe to call on every startup —
 * the function self-checks idempotency.
 */
export async function migrateV1IfNeeded(): Promise<MigrationResult> {
  if (!(await hasLegacyV1Index())) {
    return emptyResult('no v1 _index.json found');
  }

  const lock = await readLock();
  if (lock.sources.length > 0 || lock.skills.length > 0) {
    // v2 lock already populated — either previously migrated (and the user
    // somehow restored v1 file) or fresh v2 install. Skip to avoid overwrite.
    return emptyResult('v2 lock already has data — refusing to overwrite');
  }

  let v1: V1Index;
  try {
    const raw = await fs.promises.readFile(getLegacyV1IndexPath(), 'utf-8');
    const parsed = JSON.parse(raw) as V1Index;
    if (parsed.version !== 1 || typeof parsed.skills !== 'object') {
      return emptyResult('v1 index unparseable or wrong version');
    }
    v1 = parsed;
  } catch (err) {
    return emptyResult(`v1 index read failed: ${(err as Error).message}`);
  }

  await ensureLayout();

  const warnings: string[] = [];
  let sourcesCreated = 0;
  let skillsCreated = 0;

  for (const [name, entry] of Object.entries(v1.skills)) {
    try {
      if (entry.source === 'git' && entry.gitUrl) {
        await migrateGitEntry(lock, name, entry);
        sourcesCreated++;
        skillsCreated++;
      } else {
        // native-promoted / manual: treat the v1 location as a local source so
        // the user's data stays put and is now tracked by v2.
        await migrateLocalEntry(lock, name, entry);
        sourcesCreated++;
        skillsCreated++;
      }
    } catch (err) {
      warnings.push(`migrate ${name}: ${(err as Error).message}`);
    }
  }

  await writeLock(lock);

  // Rename so we don't re-migrate; user can keep the .bak for forensics.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bakPath = `${getLegacyV1IndexPath()}.v1.bak.${ts}`;
  await fs.promises.rename(getLegacyV1IndexPath(), bakPath).catch((err) => {
    warnings.push(`v1 backup rename failed: ${(err as Error).message}`);
  });

  return { migrated: true, sourcesCreated, skillsCreated, warnings };
}

async function migrateGitEntry(
  lock: { sources: SkillSource[]; skills: InstalledSkill[] },
  name: string,
  entry: V1Entry
): Promise<void> {
  const oldDir = path.join(getEnsoaiRoot(), 'skills', name);
  if (!(await dirExists(oldDir))) {
    throw new Error(`v1 content dir missing: ${oldDir}`);
  }

  const sourceId = generateSourceId();
  const newDir = path.join(getSourcesCacheRoot(), sourceId);

  // Move whole skill dir into sources cache as a single-skill repo layout.
  // sourceDir='.' means the skill content is at the cache root itself.
  await fs.promises.rename(oldDir, newDir).catch(async (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.promises.cp(oldDir, newDir, { recursive: true });
    await fs.promises.rm(oldDir, { recursive: true, force: true });
  });

  const now = new Date().toISOString();
  const source: SkillSource = {
    id: sourceId,
    type: 'git',
    name,
    repoUrl: entry.gitUrl,
    branch: 'main',
    sourceDir: '.',
    enabled: true,
    createdAt: entry.installedAt || now,
    updatedAt: now,
  };
  lock.sources.push(source);

  // Compute hash + frontmatter from the moved dir
  const contentHash = await hashDir(newDir);
  const meta = await readSkillMeta(newDir);

  const skill: InstalledSkill = {
    id: `${sourceId}::${name}`,
    sourceId,
    name,
    description: meta?.description,
    version: meta?.version ?? entry.version,
    contentPath: newDir,
    contentHash,
    // Mirrors not transferred: user must re-install (mirror state was unreliable
    // in v1 — likely 'wrong-symlink' for the user's actual workflow).
    targets: {},
    enabled: entry.enabled !== false,
    installedAt: entry.installedAt || now,
    updatedAt: now,
  };
  lock.skills.push(skill);
}

async function migrateLocalEntry(
  lock: { sources: SkillSource[]; skills: InstalledSkill[] },
  name: string,
  entry: V1Entry
): Promise<void> {
  const oldDir = path.join(getEnsoaiRoot(), 'skills', name);
  if (!(await dirExists(oldDir))) {
    throw new Error(`v1 content dir missing: ${oldDir}`);
  }

  // Leave content where it is; register the v1 location as a local source.
  const sourceId = generateSourceId();
  const now = new Date().toISOString();

  const source: SkillSource = {
    id: sourceId,
    type: 'local',
    name,
    localPath: oldDir,
    enabled: true,
    createdAt: entry.installedAt || now,
    updatedAt: now,
  };
  lock.sources.push(source);

  const contentHash = await hashDir(oldDir);
  const meta = await readSkillMeta(oldDir);

  const skill: InstalledSkill = {
    id: `${sourceId}::${name}`,
    sourceId,
    name,
    description: meta?.description,
    version: meta?.version ?? entry.version,
    contentPath: oldDir,
    contentHash,
    targets: {},
    enabled: entry.enabled !== false,
    installedAt: entry.installedAt || now,
    updatedAt: now,
  };
  lock.skills.push(skill);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readSkillMeta(
  dir: string
): Promise<{ description?: string; version?: string } | null> {
  for (const candidate of ['SKILL.md', 'skill.md']) {
    try {
      const content = await fs.promises.readFile(path.join(dir, candidate), 'utf-8');
      return parseSkillFrontMatter(content);
    } catch {
      // try next
    }
  }
  return null;
}

// ---------- M11: v2.5 promoted-source migration ----------

export interface V25MigrationResult {
  migrated: boolean;
  promotedFixed: number;
  warnings: string[];
}

interface Candidate {
  source: SkillSource;
  skill: InstalledSkill;
  target: SkillTarget;
  flavor: 'real-dir' | 'symlink-external';
}

function nativeSourceIdFor(target: SkillTarget): string {
  return target === 'claude' ? CLAUDE_NATIVE_SOURCE_ID : CODEX_NATIVE_SOURCE_ID;
}

async function readlinkAbs(p: string): Promise<string | null> {
  try {
    const stat = await fs.promises.lstat(p);
    if (!stat.isSymbolicLink()) return null;
    const target = await fs.promises.readlink(p);
    return path.isAbsolute(target) ? target : path.resolve(path.dirname(p), target);
  } catch {
    return null;
  }
}

/**
 * Rewrite v2.5 promote artifacts to the M11 model:
 *   - Auto-generated type='local' sources with exactly one dependent skill
 *     get removed.
 *   - The dependent InstalledSkill is re-attached to the matching native
 *     source sentinel (claude-native / codex-native).
 *   - real-dir flavor: content moves from canonical/<oldSourceId>/<name>/
 *     to canonical/<target>/<name>/, and the provider-side symlink is
 *     repointed.
 *   - symlink-external flavor: no FS work — dev dir is preserved.
 *
 * Idempotent: re-running on already-migrated state is a no-op (the
 * canonical-rooted localPath heuristic and the symlink-target check both
 * fail once the source has been removed).
 */
export async function migrateV25PromotedIfNeeded(): Promise<V25MigrationResult> {
  const warnings: string[] = [];
  const lock = await readLock();
  const canonicalRoot = path.resolve(getCanonicalContentRoot());

  const candidates: Candidate[] = [];
  for (const source of lock.sources) {
    if (source.type !== 'local' || !source.localPath) continue;

    const deps = lock.skills.filter((s) => s.sourceId === source.id);
    if (deps.length !== 1) continue;
    const skill = deps[0];

    const targets = Object.keys(skill.targets) as SkillTarget[];
    if (targets.length !== 1) continue;
    const target = targets[0];

    const localAbs = path.resolve(source.localPath);
    const isUnderCanonical =
      localAbs === canonicalRoot || localAbs.startsWith(canonicalRoot + path.sep);

    if (isUnderCanonical) {
      candidates.push({ source, skill, target, flavor: 'real-dir' });
      continue;
    }

    // Symlink-external probe: providerPath must be a symlink whose target == localPath
    const providerPath = skill.targets[target]?.path;
    if (!providerPath) continue;
    const linkTarget = await readlinkAbs(providerPath);
    if (linkTarget && path.resolve(linkTarget) === localAbs) {
      candidates.push({ source, skill, target, flavor: 'symlink-external' });
    }
  }

  if (candidates.length === 0) {
    return { migrated: false, promotedFixed: 0, warnings };
  }

  let promotedFixed = 0;

  for (const { source, skill, target, flavor } of candidates) {
    try {
      const nativeId = nativeSourceIdFor(target);
      let newContentPath = skill.contentPath;

      if (flavor === 'real-dir') {
        const targetDir = path.join(canonicalRoot, target);
        await fs.promises.mkdir(targetDir, { recursive: true });
        newContentPath = path.join(targetDir, skill.name);

        // Refuse to clobber an existing path at the new location.
        let conflict = false;
        try {
          await fs.promises.access(newContentPath);
          conflict = true;
        } catch {
          // expected — path does not exist
        }
        if (conflict) {
          warnings.push(
            `m11 skip ${skill.name}: ${newContentPath} already exists; manual review required`
          );
          continue;
        }

        await fs.promises.rename(skill.contentPath, newContentPath).catch(async (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          await fs.promises.cp(skill.contentPath, newContentPath, { recursive: true });
          await fs.promises.rm(skill.contentPath, { recursive: true, force: true });
        });

        // Drop the now-empty per-source canonical wrapper dir.
        await fs.promises.rmdir(path.dirname(skill.contentPath)).catch(() => {});

        // Repoint the provider symlink at the new canonical path.
        const providerPath = skill.targets[target]?.path;
        if (providerPath) {
          await unlinkSafe(providerPath);
          await fs.promises.symlink(newContentPath, providerPath, 'dir');
        }
      }
      // symlink-external: leave fs alone; symlink already points at the dev dir.

      // Re-key the InstalledSkill onto the native source.
      skill.sourceId = nativeId;
      skill.id = `${nativeId}::${skill.name}`;
      skill.contentPath = newContentPath;
      skill.updatedAt = new Date().toISOString();

      // Drop the obsolete local source.
      const idx = lock.sources.findIndex((s) => s.id === source.id);
      if (idx !== -1) lock.sources.splice(idx, 1);

      // Persist after each successful candidate so a mid-loop crash leaves
      // a consistent partial state instead of a fully-mutated fs with stale lock.
      await writeLock(lock);
      promotedFixed++;
    } catch (err) {
      warnings.push(`m11 ${skill.name}: ${(err as Error).message}`);
    }
  }

  return { migrated: promotedFixed > 0, promotedFixed, warnings };
}
