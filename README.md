# dsh-moss-image-prompt-enhancer

DeepSeek Harness (DSH) plugin that packages the
[moss-image-prompt-enhancer](https://github.com/OpenMOSS/MOSS-Image/tree/main/skills/moss-image-prompt-enhancer)
agent skill and adds a native, dependency-free prompt compiler tool.

- Turns an image idea into a detailed **MOSS-Image caption** or a **pixel Layout** draft.
- Compiles a draft into a ready-to-paste prompt.
- Does **not** generate images, call any model API, or require Python.

Target: **DSH 0.2.1-rc.2** (Cordis 4.0.5, Node `^22.19.0 || >=24.0.0`).

## What it adds

| Surface | Name | Purpose |
| --- | --- | --- |
| Skill | `moss-image-prompt-enhancer` | The upstream skill text, verbatim, plus a short DSH runtime section appended at load time |
| Tool | `moss_compile_prompt` | Validates a caption/Layout JSON draft and compiles it into the MOSS-Image prompt (same rules as the bundled `compile_prompt.py`) |

The upstream `scripts/compile_prompt.py` is still shipped verbatim as a fallback.

## Install

From a local checkout (linked install):

```bash
dsh plugin --profile desktop add link:/absolute/path/to/dsh-moss-image-prompt-enhancer
```

From the registry once published:

```bash
dsh plugin --profile desktop add dsh-moss-image-prompt-enhancer@0.1.0
```

You can also install a bundle from the Web UI: **Plugins** -> install a bundle with the
absolute package directory as the source. A restart (or HMR reload) makes the new row active.

## Use

Ask the agent for an image description; the skill is listed in the session skill catalog and
can be loaded by name. The compiler tool takes either an inline draft or a draft file:

```json
{ "caption": "A weathered lighthouse on a cliff at dusk, warm light in the windows." }
```

```json
{
  "width": 1024,
  "height": 1024,
  "bbox_coord_space": "abs",
  "bbox_format": "xyxy",
  "summary": { "caption": "A poster with a serif title." },
  "items": [
    { "label": "text", "caption": "Serif title in warm off-white.", "text": "STILL POINT", "bbox": [64, 64, 960, 160] }
  ]
}
```

Calling `moss_compile_prompt` with `{ "draft": ... }` returns the compiled prompt; with
`{ "draftPath": "...", "outputPath": "..." }` it also writes the prompt to a file.

## Compatibility and differences from upstream

- The five files under `skills/moss-image-prompt-enhancer/` are byte-identical to the upstream
  skill; sha256 pins live in `tests/integrity.test.mjs`.
- The loaded skill body is the upstream body plus a `## DSH runtime` section that names the native
  tool, the absolute compiler path, and the layout reference path. The bundled file is untouched.
- The native tool reimplements `compile_prompt.py` in JavaScript for parity; the Python compiler
  remains available and byte-for-byte compatible.
- On Windows the Python fallback uses `python`; on Linux/macOS use `python3`.

## Development

```bash
node --test tests/
```

The test suite covers the manifest/bundle contract, upstream file integrity (sha256), the skill
provider, the native compiler tool, and a parity check against the Python compiler (skipped when
`python` is unavailable).

## Uninstall

```bash
dsh plugin --profile desktop remove dsh-moss-image-prompt-enhancer
```

## License

Plugin code: MIT (see `LICENSE`). Bundled skill content: Apache-2.0, see `NOTICE` and
`LICENSES/Apache-2.0.txt`.
