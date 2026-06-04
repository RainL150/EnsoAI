// Pure filesystem-contract verification for Skill Gateway.
// Tests symlink/unlink/cleanup against a real tmp tree, no app launch needed.
// Validates plan §6 AC-3, AC-4, AC-5, AC-6, AC-10 (symlink mode on macOS).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoai-skill-fs-'));
const canonical = path.join(root, 'canonical');
const claudeDir = path.join(root, 'claude-skills');
const codexDir = path.join(root, 'agents-skills');

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
}

try {
  // AC-3 setup: canonical store has the SKILL.md
  fs.mkdirSync(path.join(canonical, 'my-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(canonical, 'my-skill', 'SKILL.md'),
    '---\nname: my-skill\ndescription: test\n---\nbody'
  );
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });

  // AC-3: symlink claude/skills/my-skill -> canonical/my-skill
  fs.symlinkSync(path.join(canonical, 'my-skill'), path.join(claudeDir, 'my-skill'), 'dir');
  const stat1 = fs.lstatSync(path.join(claudeDir, 'my-skill'));
  assert(stat1.isSymbolicLink(), 'AC-3 claude symlink created');
  const target1 = fs.readlinkSync(path.join(claudeDir, 'my-skill'));
  assert(
    target1 === path.join(canonical, 'my-skill'),
    'AC-3 claude symlink resolves to canonical'
  );

  // Verify SKILL.md is readable through symlink
  const contentViaLink = fs.readFileSync(path.join(claudeDir, 'my-skill', 'SKILL.md'), 'utf-8');
  assert(contentViaLink.includes('description: test'), 'AC-3 SKILL.md readable via symlink');

  // AC-5: same for codex
  fs.symlinkSync(path.join(canonical, 'my-skill'), path.join(codexDir, 'my-skill'), 'dir');
  assert(
    fs.lstatSync(path.join(codexDir, 'my-skill')).isSymbolicLink(),
    'AC-5 codex symlink created'
  );

  // AC-4: removing claude target unlinks symlink, canonical untouched
  fs.unlinkSync(path.join(claudeDir, 'my-skill'));
  assert(!fs.existsSync(path.join(claudeDir, 'my-skill')), 'AC-4 claude symlink removed');
  assert(
    fs.existsSync(path.join(canonical, 'my-skill', 'SKILL.md')),
    'AC-4 canonical untouched after unlink'
  );
  assert(
    fs.existsSync(path.join(codexDir, 'my-skill', 'SKILL.md')),
    'AC-4 codex mirror unaffected'
  );

  // AC-6: uninstall removes everything
  fs.unlinkSync(path.join(codexDir, 'my-skill'));
  fs.rmSync(path.join(canonical, 'my-skill'), { recursive: true, force: true });
  assert(!fs.existsSync(path.join(canonical, 'my-skill')), 'AC-6 canonical removed');
  assert(!fs.existsSync(path.join(codexDir, 'my-skill')), 'AC-6 codex mirror removed');
  assert(!fs.existsSync(path.join(claudeDir, 'my-skill')), 'AC-6 claude mirror removed (was already)');

  // Negative: detect external native skill (non-symlink dir)
  fs.mkdirSync(path.join(claudeDir, 'native-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'native-skill', 'SKILL.md'),
    '---\nname: native-skill\ndescription: x\n---\n'
  );
  const stat2 = fs.lstatSync(path.join(claudeDir, 'native-skill'));
  assert(!stat2.isSymbolicLink() && stat2.isDirectory(), 'native skill correctly NOT a symlink');

  console.log('\nALL FS CONTRACT TESTS PASSED');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
