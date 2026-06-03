// Parse the YAML frontmatter prefix (---...---) of a SKILL.md file.
// Reused by SkillRepository (M3) for scan + GatewayManager for status checks.

export interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
}

function stripQuotes(input: string): string {
  const trimmed = input.trim();
  return trimmed.replace(/^['"]|['"]$/g, '');
}

export function parseSkillFrontMatter(content: string): ParsedSkillFrontmatter | null {
  const lines = content.split(/\r?\n/);
  if (lines.length < 3) return null;
  if (lines[0]?.trim() !== '---') return null;

  const endIndex = lines.slice(1).findIndex((l) => l.trim() === '---');
  if (endIndex === -1) return null;

  const metaLines = lines.slice(1, endIndex + 1);
  const meta: ParsedSkillFrontmatter = {};
  for (const line of metaLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = stripQuotes(trimmed.slice(idx + 1));
    if (!value) continue;
    if (key === 'name') meta.name = value;
    else if (key === 'description') meta.description = value;
    else if (key === 'version') meta.version = value;
    else if (key === 'author') meta.author = value;
  }
  if (!meta.name && !meta.description) return null;
  return meta;
}
