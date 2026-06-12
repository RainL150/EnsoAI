// SkillRepository — for each SkillSource, fetch content + scan for skills.
//
// For type='git':  clone to ~/.ensoai/sources/<sourceId>/ on first use, then
//                  `git fetch --depth 1` + `git reset --hard origin/<branch>` on
//                  subsequent refreshes. The cache dir survives across runs.
// For type='local': no fetch — scan localPath directly (it's the user's dev dir).
//
// Scan walks at most 2 levels under <root>/<sourceDir> looking for SKILL.md
// (case-insensitive). This matches qunar's policy and keeps perf bounded.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AvailableSkill, SkillSource } from '@shared/types';
import { execInPty } from '../../utils/shell';
import { parseSkillFrontMatter } from '../../utils/skillFrontmatter';
import { readlinkAbsolute } from './linker';
import { getProvider } from './providers';
import { hashDir } from './SkillHash';
import { ensureLayout, getSourcesCacheRoot } from './SkillLockStore';

const execFileAsync = promisify(execFile);

export interface ScanResult {
  skills: AvailableSkill[];
  /** Non-fatal issues to surface in the source's lastError or UI. */
  warnings: string[];
}

function makeError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Resolve the root directory we'll scan, depending on source type. */
async function resolveScanRoot(source: SkillSource): Promise<string> {
  if (source.type === 'git') {
    return getGitCacheDir(source);
  }
  if (source.type === 'local') {
    if (!source.localPath) throw makeError('EINVAL', 'local source missing localPath');
    return source.localPath;
  }
  throw makeError('EINVAL', `Unknown source type: ${source.type}`);
}

/** Sub-dir names that should never count as a bundle sub-skill. */
const BUNDLE_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'scripts',
  'bin',
  'spec',
  'template',
  'fixtures',
  '__pycache__',
]);

/** ~/.ensoai/sources/<sourceId>/ — where git clones live. */
function getGitCacheDir(source: SkillSource): string {
  return path.join(getSourcesCacheRoot(), source.id);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function getDiscoveryDirs(source: SkillSource): string[] {
  if (!source.nativeTarget) return [];
  const provider = getProvider(source.nativeTarget);
  return provider.getDiscoveryDirs?.() ?? [provider.getSkillsDir()];
}

/**
 * Probe a git repo + branch without writing anything to disk.
 * Returns void on success; throws with a specific code on failure so the
 * caller (SkillSourceManager.add) can surface a meaningful message.
 *
 * Uses execFile (not PTY) with GIT_TERMINAL_PROMPT=0 so private-repo auth
 * prompts fail fast instead of hanging.
 */
export async function validateGitSource(repoUrl: string, branch?: string): Promise<void> {
  if (!repoUrl?.trim()) throw makeError('EINVAL', 'repoUrl is required');
  const ref = branch?.trim() || 'main';
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync('git', ['ls-remote', '--heads', repoUrl, ref], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      timeout: 30000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const msg = `${e.stderr ?? ''}\n${e.message ?? ''}`.toLowerCase();
    if (
      msg.includes('could not read username') ||
      msg.includes('authentication failed') ||
      msg.includes('terminal prompts disabled')
    ) {
      throw makeError('EAUTH_REQUIRED', `仓库需要认证（私有仓库或凭证缺失）：${repoUrl}`);
    }
    if (msg.includes('repository not found') || msg.includes('not found')) {
      throw makeError('EREPO_NOT_FOUND', `仓库不存在或不可访问：${repoUrl}`);
    }
    if (msg.includes('could not resolve host')) {
      throw makeError('ENETWORK', `网络不可达：${repoUrl}`);
    }
    throw makeError('EGIT_FAIL', `git 探测失败：${(e.stderr || e.message || '').trim()}`);
  }
  if (!stdout.trim()) {
    throw makeError(
      'EBRANCH_NOT_FOUND',
      `分支 "${ref}" 不存在于仓库 ${repoUrl}（stderr: ${stderr.trim()}）`
    );
  }
}

/**
 * Check whether an existing clone dir is healthy (HEAD is a real ref).
 * A failed initial clone can leave a partial `.git/` with HEAD pointing to
 * `refs/heads/.invalid`; we must not treat that as "already cloned".
 */
async function isCloneHealthy(cacheDir: string): Promise<boolean> {
  if (!(await dirExists(path.join(cacheDir, '.git')))) return false;
  try {
    await execFileAsync('git', ['-C', cacheDir, 'rev-parse', '--verify', 'HEAD'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone if missing; otherwise fetch + hard reset to origin/<branch>.
 * Returns the absolute path to the clone dir.
 */
async function ensureGitClone(source: SkillSource): Promise<string> {
  if (!source.repoUrl) throw makeError('EINVAL', 'git source missing repoUrl');
  await ensureLayout();
  const cacheDir = getGitCacheDir(source);
  const branch = source.branch?.trim() || 'main';

  const healthy = await isCloneHealthy(cacheDir);
  if (!healthy) {
    // Clean any stale partial dir (broken HEAD, half-clone, leftover .git)
    await fs.promises.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    const cmd = `GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "${branch}" "${source.repoUrl}" "${cacheDir}"`;
    await execInPty(cmd, { timeout: 180000 });
    return cacheDir;
  }

  // Refresh existing clone
  const fetchCmd = `cd "${cacheDir}" && GIT_TERMINAL_PROMPT=0 git fetch --depth 1 origin "${branch}"`;
  await execInPty(fetchCmd, { timeout: 120000 });
  const resetCmd = `cd "${cacheDir}" && git reset --hard "origin/${branch}"`;
  await execInPty(resetCmd, { timeout: 30000 });
  return cacheDir;
}

/**
 * Walk up to `maxDepth` levels under `root`, collecting absolute paths of
 * directories that directly contain a SKILL.md (case-insensitive).
 * Excludes hidden / underscore-prefixed dirs to skip cache / system dirs.
 */
async function findSkillDirs(root: string, maxDepth = 2): Promise<string[]> {
  const results: string[] = [];

  async function hasSkillMd(dir: string): Promise<boolean> {
    try {
      const entries = await fs.promises.readdir(dir);
      return entries.some((e) => e.toLowerCase() === 'skill.md');
    } catch {
      return false;
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (await hasSkillMd(dir)) {
      results.push(dir);
      return; // don't descend further into a confirmed skill dir
    }
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      if (entry.name === 'node_modules') continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sub = path.join(dir, entry.name);
      // Follow symlinks during scan (user dev-dir convention); the hash step
      // does not follow symlinks, so any wrapped skill content needs to live
      // directly under the link target.
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(sub);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      await walk(sub, depth + 1);
    }
  }

  await walk(root, 0);
  return results;
}

async function readSkillMd(dir: string): Promise<string | null> {
  for (const candidate of ['SKILL.md', 'skill.md']) {
    const p = path.join(dir, candidate);
    if (await fileExists(p)) {
      try {
        return await fs.promises.readFile(p, 'utf-8');
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Refresh the source (fetch if git, no-op if local/native) and produce the
 * list of AvailableSkill it currently contains.
 */
export async function scanSource(source: SkillSource): Promise<ScanResult> {
  if (source.type === 'native') {
    return scanNativeSource(source);
  }
  if (source.type === 'bundle') {
    return scanBundleSource(source);
  }

  const warnings: string[] = [];

  if (source.type === 'git') {
    await ensureGitClone(source);
  }
  const scanRoot = await resolveScanRoot(source);

  // sourceDir defaults to '.' (root). Resolve relative to the scan root.
  const sourceDir = source.sourceDir?.trim() || '.';
  const fullScanRoot = path.resolve(scanRoot, sourceDir);

  if (!(await dirExists(fullScanRoot))) {
    throw makeError('ENOENT_SCAN_ROOT', `scan root does not exist: ${fullScanRoot}`);
  }

  const skillDirs = await findSkillDirs(fullScanRoot);

  const skills: AvailableSkill[] = [];
  for (const dir of skillDirs) {
    const content = await readSkillMd(dir);
    if (!content) {
      warnings.push(`skipped ${dir}: SKILL.md unreadable`);
      continue;
    }
    const meta = parseSkillFrontMatter(content);
    if (!meta?.name) {
      warnings.push(`skipped ${dir}: SKILL.md missing required \`name\` frontmatter`);
      continue;
    }
    if (!meta.description) {
      warnings.push(`skipped ${dir}: SKILL.md missing required \`description\` frontmatter`);
      continue;
    }

    let contentHash: string;
    try {
      contentHash = await hashDir(dir);
    } catch (err) {
      warnings.push(`skipped ${dir}: hash failed (${(err as Error).message})`);
      continue;
    }

    skills.push({
      sourceId: source.id,
      name: meta.name,
      description: meta.description,
      version: meta.version,
      contentPath: dir,
      contentHash,
      installed: false, // GatewayManager (M5) overlays the installed bit
    });
  }

  return { skills, warnings };
}

/**
 * Scan a type='native' source — i.e., list everything under the matching
 * provider's skills dir, classify symlink-external vs real-dir, but do not
 * recurse. The skill name is the directory name (not parsed frontmatter),
 * because provider expectations require exact dir-name == skill-name.
 *
 * `takenOver` is left undefined here; GatewayManager.browse fills it in by
 * checking whether the skill name is already installed under the native
 * source id (i.e., promote already happened).
 */
async function scanNativeSource(source: SkillSource): Promise<ScanResult> {
  const warnings: string[] = [];
  if (!source.nativeTarget) {
    return { skills: [], warnings: ['native source missing nativeTarget'] };
  }
  const skills: AvailableSkill[] = [];
  const seenNames = new Set<string>();
  for (const dir of getDiscoveryDirs(source)) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      if (seenNames.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);

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

      // Must contain SKILL.md to count as a skill
      let hasSkillMd = false;
      try {
        const children = await fs.promises.readdir(contentPath);
        hasSkillMd = children.some((c) => c.toLowerCase() === 'skill.md');
      } catch {
        continue;
      }
      if (!hasSkillMd) continue;

      let description: string | undefined;
      let version: string | undefined;
      const content = await readSkillMd(contentPath);
      if (content) {
        const meta = parseSkillFrontMatter(content);
        description = meta?.description;
        version = meta?.version;
      }

      let contentHash: string;
      try {
        contentHash = await hashDir(contentPath);
      } catch (err) {
        warnings.push(`skipped ${fullPath}: hash failed (${(err as Error).message})`);
        continue;
      }

      seenNames.add(entry.name);
      skills.push({
        sourceId: source.id,
        name: entry.name,
        description,
        version,
        contentPath,
        contentHash,
        installed: false,
        nativeKind: kind,
        nativeSymlinkTarget: symlinkTarget,
        nativeProviderPath: fullPath,
      });
    }
  }

  return { skills, warnings };
}

/**
 * Scan a type='bundle' source — a third-party multi-skill installer like
 * gstack. Each first-level subdirectory of `bundleRoot` that contains a
 * SKILL.md becomes one AvailableSkill. The bundle's own umbrella SKILL.md
 * at `bundleRoot/SKILL.md` is intentionally NOT enumerated — the bundle
 * source itself represents the umbrella, and its wrapper at the provider
 * dir IS the bundleRoot (so installing it would mean linking bundleRoot to
 * itself, which is meaningless).
 *
 * The `name` for each sub-skill matches the wrapper-naming convention used
 * by the installer: SKILL.md frontmatter `name` if present, else dir name.
 * This is what the bundle's own installer (e.g. gstack setup) uses to pick
 * the wrapper path under the provider dir.
 */
async function scanBundleSource(source: SkillSource): Promise<ScanResult> {
  const warnings: string[] = [];
  if (!source.bundleRoot) {
    return { skills: [], warnings: ['bundle source missing bundleRoot'] };
  }
  const bundleRoot = source.bundleRoot;
  if (!(await dirExists(bundleRoot))) {
    return { skills: [], warnings: [`bundleRoot does not exist: ${bundleRoot}`] };
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(bundleRoot, { withFileTypes: true });
  } catch (err) {
    return { skills: [], warnings: [`readdir bundleRoot failed: ${(err as Error).message}`] };
  }

  const skills: AvailableSkill[] = [];
  const seenNames = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (BUNDLE_SKIP_DIRS.has(entry.name)) continue;
    if (!entry.isDirectory()) continue;

    const subDir = path.join(bundleRoot, entry.name);
    const content = await readSkillMd(subDir);
    if (!content) continue;

    const meta = parseSkillFrontMatter(content);
    const skillName = meta?.name?.trim() || entry.name;
    if (seenNames.has(skillName)) {
      warnings.push(`bundle ${source.name}: duplicate skill name "${skillName}" — skipping`);
      continue;
    }
    if (!meta?.description) {
      warnings.push(`bundle ${source.name}: ${entry.name}/SKILL.md missing description — skipping`);
      continue;
    }

    let contentHash: string;
    try {
      contentHash = await hashDir(subDir);
    } catch (err) {
      warnings.push(`bundle ${source.name}: hash ${entry.name} failed (${(err as Error).message})`);
      continue;
    }

    seenNames.add(skillName);
    skills.push({
      sourceId: source.id,
      name: skillName,
      description: meta.description,
      version: meta.version,
      contentPath: subDir,
      contentHash,
      installed: false,
    });
  }

  return { skills, warnings };
}
