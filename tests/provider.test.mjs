import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply, inject, name } = await import('../src/index.mjs');

function harness() {
  const captured = {};
  const ctx = {
    get: () => undefined,
    skills: {
      registerProvider(factory) {
        captured.provider = factory();
        return () => {};
      },
    },
    tools: {
      register(definition) {
        captured.tool = definition;
        return () => {};
      },
    },
  };
  apply(ctx);
  return captured;
}

const LAYOUT_DRAFT = {
  width: 1024,
  height: 1024,
  bbox_coord_space: 'abs',
  bbox_format: 'xyxy',
  summary: { caption: 'A poster with a title.' },
  items: [{ label: 'text', caption: 'Serif title.', text: 'STILL POINT', bbox: [512, 64, 960, 160] }],
};

test('plugin registers one skill provider and one tool', () => {
  assert.equal(name, 'moss-image-prompt-enhancer');
  assert.deepEqual(inject, ['skills', 'tools']);
  const { provider, tool } = harness();
  assert.equal(provider.name, 'moss-image-prompt-enhancer');
  assert.equal(tool.name, 'moss_compile_prompt');
});

test('provider advertises the bundled skill with a directory resource base', async () => {
  const { provider } = harness();
  const candidates = await provider.list();
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.name, 'moss-image-prompt-enhancer');
  assert.match(candidate.description, /^Expand an image-generation request/u);
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(candidate.provider, 'moss-image-prompt-enhancer');
  assert.equal(candidate.source, 'bundled');
  assert.equal(candidate.rank, 600);
  assert.equal(candidate.resourceBase.kind, 'directory');
  assert.ok(candidate.resourceBase.path.endsWith('skills' + (process.platform === 'win32' ? '\\' : '/') + 'moss-image-prompt-enhancer') || candidate.resourceBase.path.includes('moss-image-prompt-enhancer'));
  await readFile(join(candidate.resourceBase.path, 'references', 'layout.md'), 'utf8');
});

test('loaded skill keeps the upstream body verbatim and appends runtime notes', async () => {
  const { provider } = harness();
  const [candidate] = await provider.list();
  const skill = await provider.get(candidate, {});
  const upstream = await readFile(new URL('../skills/moss-image-prompt-enhancer/SKILL.md', import.meta.url), 'utf8');
  const upstreamBody = upstream.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim();
  assert.ok(skill.content.startsWith(upstreamBody), 'upstream body must be preserved at the start');
  assert.match(skill.content, /## DSH runtime/u);
  assert.match(skill.content, /moss_compile_prompt/u);
  assert.match(skill.content, /compile_prompt\.py/u);
});

test('tool compiles an inline caption draft', async () => {
  const { tool } = harness();
  const result = await tool.execute({ draft: { caption: 'A weathered lighthouse at dusk.' } }, {});
  assert.deepEqual(result, { kind: 'caption', prompt: 'A weathered lighthouse at dusk.' });
});

test('tool compiles an inline layout draft into one compact line', async () => {
  const { tool } = harness();
  const result = await tool.execute({ draft: LAYOUT_DRAFT }, {});
  assert.equal(result.kind, 'layout');
  assert.ok(!result.prompt.includes('\n'), 'compiled layout must be one line');
  const parsed = JSON.parse(result.prompt);
  assert.equal(parsed.bbox_coord_space, 'abs_centralized');
  assert.equal(parsed.bbox_format, 'yxyx');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].text, 'STILL POINT');
});

test('tool rejects an invalid draft', async () => {
  const { tool } = harness();
  await assert.rejects(() => tool.execute({ draft: { ...LAYOUT_DRAFT, width: 1000 } }, {}), /multiple of 16|positive integer/u);
  await assert.rejects(() => tool.execute({ draft: { ...LAYOUT_DRAFT, items: [{ ...LAYOUT_DRAFT.items[0], bbox: [0, 0, 1024, 1024] }, { ...LAYOUT_DRAFT.items[0], bbox: [2000, 0, 2100, 100] }] } }, {}), /exceeds the 1024x1024 canvas/u);
});

test('tool requires exactly one draft source', async () => {
  const { tool } = harness();
  await assert.rejects(() => tool.execute({}, {}), /exactly one of draftPath or draft/u);
  await assert.rejects(() => tool.execute({ draft: { caption: 'x' }, draftPath: 'draft.json' }, {}), /exactly one of draftPath or draft/u);
});

test('tool reads a draft file and writes the compiled prompt', async () => {
  const { tool } = harness();
  const directory = await mkdtemp(join(tmpdir(), 'moss-plugin-'));
  try {
    const draftPath = join(directory, 'draft.json');
    const outputPath = join(directory, 'out', 'prompt.txt');
    await writeFile(draftPath, JSON.stringify(LAYOUT_DRAFT), 'utf8');
    const result = await tool.execute({ draftPath, outputPath }, {});
    assert.equal(result.outputPath, outputPath);
    const written = await readFile(outputPath, 'utf8');
    assert.ok(written.endsWith('\n'));
    assert.equal(JSON.parse(written.trim()).bbox_format, 'yxyx');
    await assert.rejects(() => tool.execute({ draftPath, outputPath: draftPath }, {}), /separate from the editable draft/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
