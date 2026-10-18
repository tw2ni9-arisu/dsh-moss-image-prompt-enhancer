import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * sha256 of the upstream skill files copied verbatim from
 * OpenMOSS/MOSS-Image @ main (tree c1355e6b1986dfe8fba3c0455783a05899212342).
 * These pins are the guard that the bundled copy is never silently edited.
 */
const UPSTREAM_SHA256 = {
  'SKILL.md': '72cd39883af0b6c6997038b068af2d858dcd968ca43466ebf93fea21833878a0',
  'agents/openai.yaml': 'd215006ac6563bd63fb95a331a9613e9c223517eaa402960b102f3431c243996',
  'references/layout.md': 'e3d74ded6ab402ef69131fc7609117affff5ee1c6d14a49752d44c865b79525c',
  'scripts/compile_prompt.py': '1d75780cf9f22f9ebed1a33d8100158f8d73ebfe59a5d435c1cc8c8e1374a8a3',
  'scripts/test_compile_prompt.py': '2ef6ec435575bfaa9797008a2ffd30790b291eefbc190de00274a74b0de34d5c',
};

const SKILL_ROOT = new URL('../skills/moss-image-prompt-enhancer/', import.meta.url);

for (const [relative, expected] of Object.entries(UPSTREAM_SHA256)) {
  test('bundled upstream file is unmodified: ' + relative, async () => {
    const bytes = await readFile(new URL(relative, SKILL_ROOT));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  });
}
