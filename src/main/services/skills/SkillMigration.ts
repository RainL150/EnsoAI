// One-shot migration from v1 `~/.ensoai/skills/_index.json` to v2 lock format.
// Idempotent guard: skipped if v1 file missing, or if v2 lock already has data.
// On success, renames the v1 file to `_index.json.v1.bak.<timestamp>` so it
// can be inspected by the user but won't re-trigger migration.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstalledSkill, SkillSource } from '@shared/types';
import { parseSkillFrontMatter } from '../../utils/skillFrontmatter';
import { hashDir } from './SkillHash';
import {
  ensureLayout,
  generateSourceId,
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
