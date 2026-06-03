// SkillInstaller — install / uninstall a skill into a target provider's
// skills dir, and detect the live per-target status of an existing entry.
//
// Status semantics:
//   - 'managed':       entry exists and matches the skill's contentPath/hash
//   - 'modified':      mode=copy and content drifted from installedHash
//   - 'missing':       entry does not exist at the provider path
//   - 'wrong-symlink': entry is a symlink pointing somewhere other than contentPath

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  InstalledSkill,
  SkillInstallMode,
  SkillTarget,
  SkillTargetState,
  SkillTargetStatus,
} from '@shared/types';
import { copyDir, linkOrCopy, readlinkAbsolute, unlinkSafe } from './linker';
import { getProvider } from './providers';
import { hashDir } from './SkillHash';
import { ensureLayout, getBackupsRoot } from './SkillLockStore';

function makeError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

export interface InstallOptions {
  mode: SkillInstallMode;
  /** If true, back up any pre-existing entry before overwriting. Default true. */
  backupExisting?: boolean;
}

/**
 * Compute the path inside the target provider's dir for a skill `name`.
 * Pure — does not touch the filesystem.
 */
export function getTargetPath(target: SkillTarget, name: string): string {
  return path.join(getProvider(target).getSkillsDir(), name);
}

/**
 * Install (or repair) a skill into one target. Idempotent if already managed.
 * Returns the new per-target state to store in the lock.
 */
export async function installToTarget(
  skill: Pick<InstalledSkill, 'name' | 'contentPath' | 'contentHash'>,
  target: SkillTarget,
  options: InstallOptions
): Promise<SkillTargetState> {
  const provider = getProvider(target);
  if (!(await provider.isAvailable())) {
    throw makeError('EUNAVAILABLE_TARGET', `Target ${target} is not writable`);
  }

  const dst = getTargetPath(target, skill.name);
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });

  // Inspect what's currently at dst
  const existing = await peekTarget(dst);

  if (
    existing.kind === 'managed-symlink' &&
    existing.resolved === path.resolve(skill.contentPath)
  ) {
    // Already correctly symlinked to our contentPath — idempotent success
    return {
      mode: 'symlink',
      path: dst,
      status: 'managed',
      installedAt: new Date().toISOString(),
    };
  }

  if (existing.kind !== 'missing' && options.backupExisting !== false) {
    await backupEntry(dst, skill.name);
  } else if (existing.kind !== 'missing') {
    await unlinkSafe(dst);
  }

  let appliedMode: SkillInstallMode;
  let installedHash: string | undefined;
  if (options.mode === 'symlink') {
    appliedMode = await linkOrCopy(skill.contentPath, dst);
  } else {
    await copyDir(skill.contentPath, dst);
    appliedMode = 'copy';
    installedHash = skill.contentHash;
  }

  return {
    mode: appliedMode,
    path: dst,
    status: 'managed',
    installedAt: new Date().toISOString(),
    installedHash,
  };
}

/**
 * Remove the target entry. No-op if missing.
 * Does NOT touch skill.contentPath — that's the responsibility of GatewayManager
 * (and only for 'git' source skills; 'local' sources must never have their
 * contentPath deleted).
 */
export async function uninstallFromTarget(target: SkillTarget, name: string): Promise<void> {
  await unlinkSafe(getTargetPath(target, name));
}

/**
 * Inspect a target entry and report its live status against the recorded
 * SkillTargetState. Does not mutate anything.
 */
export async function checkTargetStatus(
  skill: Pick<InstalledSkill, 'name' | 'contentPath'>,
  state: SkillTargetState
): Promise<SkillTargetStatus> {
  const existing = await peekTarget(state.path);
  if (existing.kind === 'missing') return 'missing';

  if (state.mode === 'symlink') {
    if (existing.kind !== 'managed-symlink') return 'wrong-symlink';
    return existing.resolved === path.resolve(skill.contentPath) ? 'managed' : 'wrong-symlink';
  }

  // Copy mode — compare hash if we have one
  if (existing.kind !== 'directory') return 'wrong-symlink';
  if (!state.installedHash) return 'managed';
  try {
    const liveHash = await hashDir(state.path);
    return liveHash === state.installedHash ? 'managed' : 'modified';
  } catch {
    return 'missing';
  }
}

// ----- internals -----

type Peek =
  | { kind: 'missing' }
  | { kind: 'managed-symlink'; resolved: string }
  | { kind: 'directory' }
  | { kind: 'file' };

async function peekTarget(dst: string): Promise<Peek> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (stat.isSymbolicLink()) {
    const resolved = await readlinkAbsolute(dst);
    return { kind: 'managed-symlink', resolved: resolved ?? '' };
  }
  if (stat.isDirectory()) return { kind: 'directory' };
  return { kind: 'file' };
}

async function backupEntry(src: string, name: string): Promise<void> {
  await ensureLayout();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = getBackupsRoot();
  await fs.promises.mkdir(backupRoot, { recursive: true });
  const target = path.join(backupRoot, `${name}-${ts}`);

  // For symlinks, record the symlink itself (cheap, preserves user state)
  // For directories, move them in (faster than copy)
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(src);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.promises.readlink(src);
    await fs.promises.symlink(linkTarget, target, 'dir').catch(async () => {
      await fs.promises.writeFile(`${target}.link`, linkTarget);
    });
    await unlinkSafe(src);
  } else {
    await fs.promises.rename(src, target).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.promises.cp(src, target, { recursive: true });
      await fs.promises.rm(src, { recursive: true, force: true });
    });
  }
}
