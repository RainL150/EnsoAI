// SHA256 content hash of a skill directory.
// Deterministic across runs: files are sorted by relative path, then each
// (path, content) pair is fed into the hash in order.
// Excludes noise files/dirs that shouldn't influence the hash.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', '.vscode', '.idea', '__pycache__']);
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

async function listFilesRec(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      // Allow some dotfiles (e.g. config) but skip excluded ones
      if (EXCLUDED_DIRS.has(entry.name) || EXCLUDED_FILES.has(entry.name)) continue;
    }
    if (EXCLUDED_DIRS.has(entry.name) || EXCLUDED_FILES.has(entry.name)) continue;
    const relPath = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRec(root, relPath);
      out.push(...nested);
    } else if (entry.isFile()) {
      out.push(relPath);
    }
    // Symlinks are intentionally not followed (would risk circular hashes).
  }
  return out;
}

/**
 * Compute a stable SHA256 over the contents of `dirPath`.
 * Throws if the dir does not exist or is unreadable.
 */
export async function hashDir(dirPath: string): Promise<string> {
  const stat = await fs.promises.stat(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`hashDir: not a directory: ${dirPath}`);
  }
  const files = (await listFilesRec(dirPath)).sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    const buf = await fs.promises.readFile(path.join(dirPath, rel));
    hash.update(buf);
    hash.update('\0');
  }
  return hash.digest('hex');
}
