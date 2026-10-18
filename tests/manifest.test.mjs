import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');

test('package manifest declares a DSH bundle', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.name, 'dsh-moss-image-prompt-enhancer');
  assert.match(pkg.version, /^0\.1\.0$/u);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.exports['.'], './src/index.mjs');
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
  assert.equal(pkg.exports['./package.json'], './package.json');
  for (const entry of ['src', 'skills', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(pkg.files.includes(entry), 'files must include ' + entry);
  }
  assert.equal(pkg.peerDependencies['@deepseek-ai/cordis'], '~4.0.5');
  assert.ok(Object.keys(pkg.peerDependencies).some((peer) => peer.startsWith('@deepseek-ai/dsh-')));
});

test('bundle patch inserts this plugin row', async () => {
  const patch = await read('cordis.patch.yml');
  assert.match(patch, /- insert:/u);
  assert.match(patch, /id: moss-image-prompt-enhancer/u);
  assert.match(patch, /name: 'dsh-moss-image-prompt-enhancer'/u);
});

test('entry module exports the Cordis plugin shape', async () => {
  const entry = await import('../src/index.mjs');
  assert.equal(entry.name, 'moss-image-prompt-enhancer');
  assert.deepEqual(entry.inject, ['skills', 'tools']);
  assert.equal(typeof entry.apply, 'function');
});

test('locale files carry display metadata', async () => {
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(await read('locale/' + locale + '.json')).meta;
    assert.equal(typeof meta.title, 'string');
    assert.ok(meta.title.length > 0);
    assert.equal(typeof meta.description, 'string');
    assert.ok(meta.description.length > 0);
  }
});
