// Persistence layer for the Skill Gateway v2 lock file.
// Location: ~/.ensoai/skills-lock.json
// Replaces the v1 ~/.ensoai/skills/_index.json (migrated in M6).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillLockFile } from '@shared/types';

const LOCK_FILE_MODE = 0o600;

export function getEnsoaiRoot(): string {
  return path.join(os.homedir(), '.ensoai');
}

/** Cache root for git-type sources (one subdir per source). */
export function getSourcesCacheRoot(): string {
  return path.join(getEnsoaiRoot(), 'sources');
}

/** Backups of overwritten mirror entries, timestamped. */
export function getBackupsRoot(): string {
  return path.join(getEnsoaiRoot(), 'backups');
}

export function getLockFilePath(): string {
  return path.join(getEnsoaiRoot(), 'skills-lock.json');
}

/** Path to the legacy v1 index — used by the migration step in M6. */
export function getLegacyV1IndexPath(): string {
  return path.join(getEnsoaiRoot(), 'skills', '_index.json');
}

function emptyLock(): SkillLockFile {
  return { version: 2, sources: [], skills: [] };
}

/** Ensure ~/.ensoai/ and ~/.ensoai/sources/ exist. */
export async function ensureLayout(): Promise<void> {
  await fs.promises.mkdir(getEnsoaiRoot(), { recursive: true });
  await fs.promises.mkdir(getSourcesCacheRoot(), { recursive: true });
}

/**
 * Read the lock file. Returns empty payload if missing or unparseable.
 * On a malformed file, the existing file is renamed with .corrupted suffix
 * so the user can inspect; we then return empty.
 */
export async function readLock(): Promise<SkillLockFile> {
  const filePath = getLockFilePath();
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyLock();
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SkillLockFile>;
    if (parsed.version === 2 && Array.isArray(parsed.sources) && Array.isArray(parsed.skills)) {
      return {
        version: 2,
        sources: parsed.sources,
        skills: parsed.skills,
      };
    }
    throw new Error('lock file shape invalid');
  } catch (err) {
    const corruptedPath = `${filePath}.corrupted.${Date.now()}`;
    await fs.promises.rename(filePath, corruptedPath).catch(() => {});
    console.warn('[SkillLockStore] lock file invalid, moved to', corruptedPath, 'error:', err);
    return emptyLock();
  }
}

/**
 * Atomic write: write to a temp file in the same dir then rename.
 * Prevents truncated lock files if the app is killed mid-write.
 */
export async function writeLock(lock: SkillLockFile): Promise<void> {
  await ensureLayout();
  const filePath = getLockFilePath();
  const tmp = `${filePath}.tmp.${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify(lock, null, 2), {
    mode: LOCK_FILE_MODE,
  });
  await fs.promises.rename(tmp, filePath);
}

/** True if a v1 _index.json exists (caller should run the migration step). */
export async function hasLegacyV1Index(): Promise<boolean> {
  try {
    await fs.promises.access(getLegacyV1IndexPath(), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function generateSourceId(): string {
  // Short, stable, prefix-tagged. Not cryptographic — uniqueness within the lock file is what matters.
  const random = Math.random().toString(36).slice(2, 10);
  return `src_${Date.now().toString(36)}_${random}`;
}
