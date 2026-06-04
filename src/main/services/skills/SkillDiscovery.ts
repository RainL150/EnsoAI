// Scans each provider's skills dir for native skills NOT registered in the v2 lock.
// Surfaces them as DiscoveredSkill[] for the UI overlay (Installed tab merges
// lock-managed + discovered cards). Read-only — no FS writes happen here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DiscoveredSkill, SkillTarget } from '@shared/types';
import { parseSkillFrontMatter } from '../../utils/skillFrontmatter';
import { readlinkAbsolute } from './linker';
import { getProvider } from './providers';
import { hashDir } from './SkillHash';
import { getSourcesCacheRoot, readLock } from './SkillLockStore';

const ALL_TARGETS: SkillTarget[] = ['claude', 'codex'];

/** Symlink whose target resolves inside ~/.ensoai/sources — already gateway-managed. */
async function isGatewayLink(linkPath: string, sourcesRoot: string): Promise<boolean> {
  const resolved = await readlinkAbsolute(linkPath);
  if (!resolved) return false;
  const normalized = path.resolve(sourcesRoot);
  return resolved === normalized || resolved.startsWith(normalized + path.sep);
}

async function scanProvider(
  target: SkillTarget,
  sourcesRoot: string,
  excludeNames: Set<string>
): Promise<DiscoveredSkill[]> {
  const dir = getProvider(target).getSkillsDir();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }

  const out: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (excludeNames.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (await isGatewayLink(fullPath, sourcesRoot)) continue;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(fullPath);
    } catch {
      continue;
    }

    let kind: 'symlink-external' | 'real-dir';
    let symlinkTarget: string | undefined;
    let contentPath: string;

    if (stat.isSymbolicLink()) {
      const resolved = await readlinkAbsolute(fullPath);
      if (!resolved) continue;
      kind = 'symlink-external';
      symlinkTarget = resolved;
      contentPath = resolved;
    } else if (stat.isDirectory()) {
      kind = 'real-dir';
      contentPath = fullPath;
    } else {
      continue;
    }

    // Verify the resolved content actually contains a SKILL.md
    let hasSkillMd = false;
    try {
      const children = await fs.promises.readdir(contentPath);
      hasSkillMd = children.some((c) => c.toLowerCase() === 'skill.md');
    } catch {
      continue;
    }
    if (!hasSkillMd) continue;

    let description: string | undefined;
    try {
      const skillMdPath = path.join(contentPath, 'SKILL.md');
      let content: string;
      try {
        content = await fs.promises.readFile(skillMdPath, 'utf-8');
      } catch {
        content = await fs.promises.readFile(path.join(contentPath, 'skill.md'), 'utf-8');
      }
      description = parseSkillFrontMatter(content)?.description;
    } catch {
      // best-effort; description is optional
    }

    let contentHash: string;
    try {
      contentHash = await hashDir(contentPath);
    } catch {
      continue;
    }

    out.push({
      target,
      name: entry.name,
      description,
      contentPath,
      kind,
      symlinkTarget,
      contentHash,
    });
  }
  return out;
}

/**
 * Return all discovered native skills across providers, excluding anything
 * that is already tracked in the v2 lock for that same target.
 */
export async function listAllDiscovered(): Promise<DiscoveredSkill[]> {
  const lock = await readLock();
  const sourcesRoot = getSourcesCacheRoot();

  const trackedByTarget = new Map<SkillTarget, Set<string>>();
  for (const t of ALL_TARGETS) trackedByTarget.set(t, new Set());
  for (const skill of lock.skills) {
    for (const t of Object.keys(skill.targets) as SkillTarget[]) {
      trackedByTarget.get(t)?.add(skill.name);
    }
  }

  const out: DiscoveredSkill[] = [];
  for (const target of ALL_TARGETS) {
    const items = await scanProvider(target, sourcesRoot, trackedByTarget.get(target) ?? new Set());
    out.push(...items);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.target.localeCompare(b.target));
}

/**
 * Look up a single discovered skill by (target, name). Returns null if missing.
 * Used by action handlers (mirror / promote / delete) to re-validate state.
 */
export async function findDiscovered(
  target: SkillTarget,
  name: string
): Promise<DiscoveredSkill | null> {
  const items = await listAllDiscovered();
  return items.find((d) => d.target === target && d.name === name) ?? null;
}
