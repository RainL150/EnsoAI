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

function getDiscoveryDirs(target: SkillTarget): string[] {
  const provider = getProvider(target);
  return provider.getDiscoveryDirs?.() ?? [provider.getSkillsDir()];
}

/** Symlink whose target resolves inside ~/.ensoai/sources — already gateway-managed. */
async function isGatewayLink(linkPath: string, sourcesRoot: string): Promise<boolean> {
  const resolved = await readlinkAbsolute(linkPath);
  if (!resolved) return false;
  const normalized = path.resolve(sourcesRoot);
  return resolved === normalized || resolved.startsWith(normalized + path.sep);
}

/** True if `p` equals any of the bundle roots or sits strictly inside one. */
function isInsideBundleRoot(p: string, bundleRoots: string[]): boolean {
  const resolved = path.resolve(p);
  for (const root of bundleRoots) {
    const r = path.resolve(root);
    if (resolved === r) return true;
    if (resolved.startsWith(r + path.sep)) return true;
  }
  return false;
}

async function scanProvider(
  target: SkillTarget,
  sourcesRoot: string,
  excludeNames: Set<string>,
  bundleRoots: string[]
): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = [];
  const seenNames = new Set<string>();
  for (const dir of getDiscoveryDirs(target)) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      if (excludeNames.has(entry.name) || seenNames.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (await isGatewayLink(fullPath, sourcesRoot)) continue;
      // Bundle-claimed: entry IS a registered bundle root.
      if (isInsideBundleRoot(fullPath, bundleRoots)) continue;

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

      // Bundle-managed wrapper: real-dir whose SKILL.md is a file-symlink
      // resolving into a registered bundle root (gstack's wrapper layout).
      // These are owned by the bundle's installer — leave them alone.
      if (kind === 'real-dir' && bundleRoots.length > 0) {
        const skillMdReal = path.join(contentPath, 'SKILL.md');
        const skillMdAlt = path.join(contentPath, 'skill.md');
        const skillMdResolved =
          (await readlinkAbsolute(skillMdReal)) ?? (await readlinkAbsolute(skillMdAlt));
        if (skillMdResolved && isInsideBundleRoot(skillMdResolved, bundleRoots)) continue;
      }

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

      seenNames.add(entry.name);
      out.push({
        target,
        name: entry.name,
        description,
        providerPath: fullPath,
        contentPath,
        kind,
        symlinkTarget,
        contentHash,
      });
    }
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

  const bundleRoots: string[] = [];
  for (const source of lock.sources) {
    if (source.type === 'bundle' && source.bundleRoot) {
      bundleRoots.push(source.bundleRoot);
    }
  }

  const out: DiscoveredSkill[] = [];
  for (const target of ALL_TARGETS) {
    const items = await scanProvider(
      target,
      sourcesRoot,
      trackedByTarget.get(target) ?? new Set(),
      bundleRoots
    );
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
