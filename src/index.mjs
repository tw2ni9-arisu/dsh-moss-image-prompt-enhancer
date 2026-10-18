/**
 * DSH plugin entry: the bundled MOSS-Image prompt-enhancer skill plus a native
 * caption/Layout prompt compiler tool.
 *
 * The upstream skill ships verbatim under skills/moss-image-prompt-enhancer.
 * This module contributes only DSH-specific runtime notes (native tool and the
 * absolute compiler path) and the `moss_compile_prompt` tool. It imports no
 * `@deepseek-ai/*` package, so it also loads inside a plain Node test process.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDraftText, compilePrompt } from './compile.mjs';
import { parseSkillDocument } from './frontmatter.mjs';

/** Cordis plugin name. */
export const name = 'moss-image-prompt-enhancer';
/** Services used by this plugin. */
export const inject = ['skills', 'tools'];

const PROVIDER_NAME = 'moss-image-prompt-enhancer';
const TOOL_NAME = 'moss_compile_prompt';
const SKILL_DIRECTORY = fileURLToPath(new URL('../skills/moss-image-prompt-enhancer/', import.meta.url));
const SKILL_PATH = join(SKILL_DIRECTORY, 'SKILL.md');
const COMPILER_PATH = join(SKILL_DIRECTORY, 'scripts', 'compile_prompt.py');
const LAYOUT_REFERENCE = join(SKILL_DIRECTORY, 'references', 'layout.md');
const RESOURCE_BASE = Object.freeze({ kind: 'directory', path: SKILL_DIRECTORY });
const INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true });
/** Rank used by packaged skill providers and local bundled roots. */
const SKILL_RANK = 600;

let parsed;
async function readSkill(signal) {
  if (parsed === undefined) {
    parsed = parseSkillDocument(await readFile(SKILL_PATH, { encoding: 'utf8', signal }), SKILL_PATH);
  }
  return parsed;
}

function runtimeNotes() {
  return [
    '',
    '',
    '## DSH runtime',
    '',
    'This skill is installed by the `dsh-moss-image-prompt-enhancer` DSH plugin.',
    '',
    '- Preferred compile step: call the `' + TOOL_NAME + '` tool with `draftPath` (or an inline `draft`) and optionally `outputPath`. It applies the same validation and compilation as the bundled compiler, so no Python runtime is required.',
    '- Python fallback with identical behavior: `python "' + COMPILER_PATH + '" draft.json --output prompt.txt` on Windows, or the same command with `python3` on Linux and macOS.',
    '- The layout reference used by the Layout section is installed at `' + LAYOUT_REFERENCE + '`.',
    '',
    'Everything above this section is the upstream skill text, unchanged.',
  ].join('\n');
}

/**
 * Resolve a tool argument path against the calling session's working directory.
 * @param ctx - plugin context, used to read the optional workingDirectory service.
 * @param target - a path as supplied by the model.
 * @param exec - tool execution context carrying the agent and abort signal.
 * @returns an absolute path.
 */
async function toAbsolute(ctx, target, exec) {
  if (isAbsolute(target)) return target;
  const directories = ctx.get('workingDirectory');
  if (directories !== undefined && exec.agent !== undefined) {
    return resolve(await directories.ensure(exec.agent, exec.signal), target);
  }
  return resolve(process.cwd(), target);
}

/**
 * Register the bundled skill provider and the native compiler tool.
 * @param ctx - Cordis context providing the skill registry and tool registry.
 */
export function apply(ctx) {
  const provider = {
    name: PROVIDER_NAME,
    async list() {
      const skill = await readSkill();
      return [{
        name: skill.name,
        description: skill.description,
        invocation: { ...INVOCATION },
        provider: PROVIDER_NAME,
        source: 'bundled',
        rank: SKILL_RANK,
        resourceBase: RESOURCE_BASE,
        locator: SKILL_PATH,
      }];
    },
    async get(candidate, options) {
      const skill = await readSkill(options?.signal);
      return {
        name: skill.name,
        description: skill.description,
        invocation: { ...INVOCATION },
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: RESOURCE_BASE,
        content: skill.body + runtimeNotes(),
      };
    },
  };
  ctx.skills.registerProvider(() => provider);

  ctx.tools.register({
    name: TOOL_NAME,
    description: 'Compile a MOSS-Image caption or absolute-pixel Layout JSON draft into a ready-to-paste prompt. Validates the draft exactly like the bundled compiler, optionally writes the result to outputPath, and never generates images.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        draftPath: { type: 'string', description: 'Path to a UTF-8 JSON draft. Relative paths resolve against the session working directory.' },
        draft: { type: 'object', additionalProperties: true, description: 'Inline draft object; use this instead of draftPath.' },
        outputPath: { type: 'string', description: 'Optional path for the compiled prompt. Must differ from draftPath; parent directories are created.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['caption', 'layout'], description: 'Which draft kind was compiled.' },
          prompt: { type: 'string', description: 'The ready-to-paste MOSS-Image positive prompt.' },
          outputPath: { type: 'string', description: 'Absolute path the prompt was written to, when outputPath was given.' },
        },
        required: ['kind', 'prompt'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.outputPath === undefined ? value.prompt : 'Wrote ' + value.outputPath + '\n' + value.prompt }];
      },
    },
    async execute(args, exec) {
      const hasPath = args.draftPath !== undefined;
      const hasDraft = args.draft !== undefined;
      if (hasPath === hasDraft) throw new Error('provide exactly one of draftPath or draft');
      let draftAbsolute;
      let compiled;
      if (hasPath) {
        draftAbsolute = await toAbsolute(ctx, args.draftPath, exec);
        compiled = compileDraftText(await readFile(draftAbsolute, { encoding: 'utf8', signal: exec.signal }));
      } else {
        compiled = compilePrompt(args.draft);
      }
      let written;
      if (args.outputPath !== undefined) {
        written = await toAbsolute(ctx, args.outputPath, exec);
        if (draftAbsolute !== undefined && resolve(written) === resolve(draftAbsolute)) {
          throw new Error('Output must be separate from the editable draft');
        }
        await mkdir(dirname(written), { recursive: true });
        await writeFile(written, compiled.prompt + '\n', 'utf8');
      }
      return written === undefined
        ? { kind: compiled.kind, prompt: compiled.prompt }
        : { kind: compiled.kind, prompt: compiled.prompt, outputPath: written };
    },
  });
}
