// Parse the YAML frontmatter prefix (---...---) of a SKILL.md file.
// Reused by SkillRepository (M3) for scan + GatewayManager for status checks.
//
// Supports a subset of YAML sufficient for SKILL.md authoring:
//   - inline scalars: `key: value`
//   - quoted scalars: `key: "value"` / `key: 'value'`
//   - folded block scalars: `key: >` followed by indented lines (joins with space;
//     blank line = paragraph break, becomes \n\n)
//   - literal block scalars: `key: |` followed by indented lines (keeps \n)
//   - chomp indicators `>-`, `>+`, `|-`, `|+` are accepted (treated like `>` / `|`)

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

function foldLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (current.length) {
        paragraphs.push(current.join(' '));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.join('\n\n');
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

export function parseSkillFrontMatter(content: string): ParsedSkillFrontmatter | null {
  const lines = content.split(/\r?\n/);
  if (lines.length < 3) return null;
  if (lines[0]?.trim() !== '---') return null;

  const endRel = lines.slice(1).findIndex((l) => l.trim() === '---');
  if (endRel === -1) return null;

  const metaLines = lines.slice(1, endRel + 1);
  const meta: ParsedSkillFrontmatter = {};

  const setKey = (key: string, value: string): void => {
    if (!value) return;
    if (key === 'name') meta.name = value;
    else if (key === 'description') meta.description = value;
    else if (key === 'version') meta.version = value;
    else if (key === 'author') meta.author = value;
  };

  let i = 0;
  while (i < metaLines.length) {
    const line = metaLines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const idx = trimmed.indexOf(':');
    if (idx <= 0) {
      i++;
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1).trim();

    // Block scalar header: `>`, `|`, optionally with chomp indicator `-`/`+`.
    const blockMatch = /^([>|])[+-]?$/.exec(rawValue);
    if (blockMatch) {
      const style = blockMatch[1] as '>' | '|';
      i++;
      // Collect subsequent indented lines into the block; stop at dedent.
      let blockIndent = -1;
      const collected: string[] = [];
      while (i < metaLines.length) {
        const bl = metaLines[i];
        const blTrim = bl.trim();
        if (blTrim === '') {
          collected.push('');
          i++;
          continue;
        }
        const indent = leadingSpaces(bl);
        if (blockIndent === -1) {
          if (indent === 0) break; // not indented — block is empty / next key
          blockIndent = indent;
        } else if (indent < blockIndent) {
          break; // dedented — block ended
        }
        collected.push(bl.slice(blockIndent));
        i++;
      }
      // Trim trailing blank lines that came from chomping.
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      const value = style === '>' ? foldLines(collected) : collected.join('\n');
      setKey(key, value);
      continue;
    }

    setKey(key, stripQuotes(rawValue));
    i++;
  }
  if (!meta.name && !meta.description) return null;
  return meta;
}
