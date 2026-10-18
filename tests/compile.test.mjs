/**
 * Tests for src/compile.mjs, the ESM port of the upstream MOSS-Image skill's
 * scripts/compile_prompt.py reference compiler.
 *
 * Suite layout:
 *   1. "port of ..." tests mirror the eight unittest cases in
 *      test_compile_prompt.py. Python cases 7 and 8 drive the CLI
 *      (--output file handling, exit code 2); this port has no CLI because
 *      the DSH plugin calls the library functions, so those two cases are
 *      ported at the library level (file round-trip without mutating the
 *      source, and parse-level rejection of duplicate keys / non-finite
 *      constants).
 *   2. Additional coverage for the schema, the strict JSON parser and the
 *      Python-shaped error messages.
 *   3. Differential tests that run the real Python compiler once per fixture
 *      (python <reference>/compile_prompt.py <draft> --output <tmp>) and
 *      compare the output bytes. They are skipped when no python executable
 *      or reference script is available.
 *
 * Known deviations from the Python reference (documented, not papered over):
 *   1. JavaScript has a single Number type, so JSON 1024 (Python int) and
 *      1024.0 (Python float) are indistinguishable here. The port therefore
 *      accepts integral floats as width/height/dimensions even though
 *      Python's type(value) is int check rejects them. Covered explicitly by
 *      the "known deviation: integral floats" test below.
 *   2. Python keeps arbitrary-precision ints. Numbers beyond
 *      Number.MAX_SAFE_INTEGER (2**53-1) are rounded to the nearest double
 *      (or overflow to Infinity) here, so a canvas/bbox that large cannot be
 *      validated or compiled exactly. No test fabricates parity for this.
 *   3. The Python CLI opens output files in text mode, which translates "\n"
 *      to CRLF on Windows. The differential helpers normalize CRLF to LF
 *      before comparing the library's prompt strings with the CLI output.
 *   4. Python json.dumps(ensure_ascii=False) emits lone surrogate escapes
 *      verbatim while JSON.stringify escapes unpaired surrogates; inputs with
 *      invalid Unicode are out of scope.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CompileError,
  compileDraftText,
  compilePrompt,
  parseDraftJson,
} from "../src/compile.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_COMPILER =
  process.env.MOSS_PYTHON_COMPILER ??
  "D:\\dsh\\research\\upstream-skill\\scripts\\compile_prompt.py";

/* ---------------------------------------------------------------------- */
/* Fixtures / helpers                                                      */
/* ---------------------------------------------------------------------- */

function freshLandscapeDraft() {
  return {
    width: 1536,
    height: 1024,
    bbox_coord_space: "abs",
    bbox_format: "xyxy",
    summary: { meta: ["poster"], canvas: "single", caption: "A ceramic campaign." },
    items: [
      {
        label: "text",
        caption: "Dark-green lettering.",
        text: '把日常，过成诗。\n"MOSS" 🪴',
        bbox: [928, 272, 1408, 448],
      },
    ],
  };
}

function portraitDraft(box) {
  return {
    width: 768,
    height: 1344,
    bbox_coord_space: "abs",
    bbox_format: "xyxy",
    summary: { caption: "Portrait test." },
    items: [{ label: "object", caption: "Portrait item.", bbox: box }],
  };
}

/** Compile a single bbox through the public API and return the yxyx result. */
function compileBox(box, width, height) {
  const draft = {
    width,
    height,
    bbox_coord_space: "abs",
    bbox_format: "xyxy",
    summary: { caption: "Box helper." },
    items: [{ label: "object", caption: "Box helper item.", bbox: box }],
  };
  return JSON.parse(compilePrompt(draft).prompt).items[0].bbox;
}

function layoutDraft(width, height, summary, items) {
  return {
    width,
    height,
    bbox_coord_space: "abs",
    bbox_format: "xyxy",
    summary,
    items,
  };
}

function findPython() {
  const candidates = [process.env.MOSS_PYTHON, "python", "python3"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["-c", "import json,sys; sys.stdout.write('ok')"], {
      encoding: "utf8",
    });
    if (probe.status === 0 && (probe.stdout ?? "").trim() === "ok") return candidate;
  }
  return null;
}

const PYTHON = findPython();
const pythonSkip = (() => {
  if (!PYTHON) return "python executable is not available";
  if (!existsSync(PYTHON_COMPILER)) return "Python reference not found: " + PYTHON_COMPILER;
  return false;
})();

/** Python writes CLI output in text mode; normalize Windows CRLF to LF. */
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Run the real Python reference compiler on a draft and return its result.
 * The returned output already has CRLF normalized (see deviation 3).
 */
function runPythonCompiler(draftText) {
  const directory = mkdtempSync(join(tmpdir(), "moss-compile-python-"));
  try {
    const source = join(directory, "draft.json");
    const target = join(directory, "prompt.txt");
    writeFileSync(source, draftText, "utf8");
    const result = spawnSync(
      PYTHON,
      [PYTHON_COMPILER, source, "--output", target],
      {
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        timeout: 60_000,
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: normalizeNewlines(result.stderr ?? ""),
      output: existsSync(target) ? normalizeNewlines(readFileSync(target, "utf8")) : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------------- */
/* 1. Ported upstream cases                                                */
/* ---------------------------------------------------------------------- */

test("port of test_landscape_conversion_preserves_content_and_source", () => {
  const draft = freshLandscapeDraft();
  const before = structuredClone(draft);

  const result = compilePrompt(draft);
  assert.equal(result.kind, "layout");
  const serialized = result.prompt;
  const parsed = JSON.parse(serialized);

  assert.deepEqual(parsed.items[0].bbox, [-240, 160, -64, 640]);
  assert.equal(parsed.items[0].text, draft.items[0].text);
  assert.deepEqual(parsed.summary, draft.summary);
  assert.equal(parsed.bbox_coord_space, "abs_centralized");
  assert.equal(parsed.bbox_format, "yxyx");
  assert.ok(!Object.hasOwn(parsed, "width"));
  assert.ok(!Object.hasOwn(parsed, "height"));
  assert.ok(!serialized.includes("\n"));
  assert.deepEqual(draft, before, "compilePrompt must not mutate the draft");
});

test("port of test_portrait_edges_and_fractional_enclosure", () => {
  assert.deepEqual(compileBox([0, 0, 768, 1344], 768, 1344), [-672, -384, 672, 384]);
  assert.deepEqual(
    compileBox([10.9, 20.1, 100.01, 200.99], 768, 1344),
    [-652, -374, -471, -283],
  );
  assert.deepEqual(
    compileBox([1.00000000001, 2, 100, 200], 768, 1344),
    [-670, -383, -472, -284],
  );
});

test("port of test_invalid_geometry_is_rejected", () => {
  const cases = [
    [-1, 0, 100, 100],
    [0, 0, 1537, 100],
    [0, 0, 100, 1025],
    [100, 0, 50, 100],
    [0, 0, 0, 100],
    [0, 0, 100],
    [true, 0, 100, 100],
    [0, 0, Number.NaN, 100],
    [0, 0, Number.POSITIVE_INFINITY, 100],
    [0, 0, "100", 100],
    [0, 0, 0.00000000001, 100],
  ];
  for (const box of cases) {
    assert.throws(
      () => compileBox(box, 1536, 1024),
      CompileError,
      "expected rejection for " + JSON.stringify(box),
    );
  }
});

test("port of test_invalid_dimensions_and_conventions_are_rejected", () => {
  const draft = freshLandscapeDraft();
  const cases = [
    ["width", 1023],
    ["height", 0],
    ["width", true],
    // Python also rejects ("height", 1024.0) because json.loads makes it a
    // float and type(value) is int fails. JS cannot distinguish 1024.0 from
    // 1024 - see the "known deviation: integral floats" test below.
    ["bbox_coord_space", "abs_centralized"],
    ["bbox_coord_space", "normalized_1000"],
    ["bbox_format", "yxyx"],
  ];
  for (const [field, value] of cases) {
    const candidate = structuredClone(draft);
    candidate[field] = value;
    assert.throws(
      () => compilePrompt(candidate),
      CompileError,
      "expected rejection for " + field + "=" + String(value),
    );
  }
});

test("port of test_unrepresentable_content_is_not_silently_dropped", () => {
  const unknownFieldCases = [
    ["children", [{ bbox: [0, 0, 20, 20] }]],
    ["font_size", 32],
    ["parent", "cup"],
  ];
  for (const [field, value] of unknownFieldCases) {
    const draft = freshLandscapeDraft();
    draft.items[0][field] = value;
    assert.throws(
      () => compilePrompt(draft),
      (error) =>
        error instanceof CompileError &&
        error.message === "items[0]: unknown fields ['" + field + "']",
      "unknown item field " + field,
    );
  }

  const missingText = freshLandscapeDraft();
  delete missingText.items[0].text;
  assert.throws(
    () => compilePrompt(missingText),
    /items\[0\]: text items require literal text/,
  );
});

test("port of test_caption_is_plain_text_and_keeps_exact_wording", () => {
  const caption = 'An ivory cup marked "茶".\nPreserve this second line.';
  assert.deepEqual(compilePrompt({ caption }), { kind: "caption", prompt: caption });
  for (const draft of [{ caption: "" }, { caption, items: [] }]) {
    assert.throws(() => compilePrompt(draft), CompileError);
  }
});

test("port of test_cli_writes_output_without_overwriting_draft (library-level adaptation)", () => {
  // The Python case exercises the CLI. The JS port exposes library functions
  // only, so this checks the equivalent invariant: a draft file round-trips
  // through parse+compile and the editable source is never modified.
  const directory = mkdtempSync(join(tmpdir(), "moss-compile-files-"));
  try {
    const source = join(directory, "draft.json");
    const target = join(directory, "prompt.txt");
    const draft = freshLandscapeDraft();
    const original = JSON.stringify(draft, null, 2);
    writeFileSync(source, original, "utf8");

    const compiled = compileDraftText(readFileSync(source, "utf8"));
    assert.equal(compiled.kind, "layout");
    assert.equal(existsSync(target), false, "compile must not write files implicitly");

    writeFileSync(target, compiled.prompt + "\n", "utf8");
    assert.equal(JSON.parse(readFileSync(target, "utf8")).items[0].text, draft.items[0].text);
    assert.equal(readFileSync(source, "utf8"), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("port of test_cli_rejects_duplicate_keys_and_nonfinite_constants (library-level adaptation)", () => {
  // The Python case asserts CLI exit codes and that no output file is
  // written. Here the same rejection is asserted on parseDraftJson; the
  // differential test below additionally checks the CLI exit code/message.
  const cases = [
    ['{"caption":"one","caption":"two"}', "Duplicate JSON key: caption"],
    ['{"caption":NaN}', "Invalid JSON number: NaN"],
    ['{"caption":Infinity}', "Invalid JSON number: Infinity"],
    ['{"caption":-Infinity}', "Invalid JSON number: -Infinity"],
  ];
  for (const [source, message] of cases) {
    assert.throws(
      () => parseDraftJson(source),
      (error) => error instanceof CompileError && error.message === message,
      source,
    );
  }
});

/* ---------------------------------------------------------------------- */
/* 2. Additional coverage                                                  */
/* ---------------------------------------------------------------------- */

test("compilePrompt and compileDraftText report caption vs layout", () => {
  assert.deepEqual(compileDraftText('{"caption":"hi"}'), { kind: "caption", prompt: "hi" });
  const layout = compileDraftText(JSON.stringify(freshLandscapeDraft()));
  assert.equal(layout.kind, "layout");
  assert.equal(JSON.parse(layout.prompt).bbox_format, "yxyx");
});

test("compilePrompt requires a JSON object", () => {
  for (const value of [null, [], "text", 42, true]) {
    assert.throws(() => compilePrompt(value), /Draft must be a JSON object/);
  }
  assert.throws(() => compileDraftText("null"), /Draft must be a JSON object/);
  assert.throws(() => parseDraftJson(42), /Draft JSON text must be a string/);
});

test("schema errors use Python sorted field lists", () => {
  const missing = freshLandscapeDraft();
  delete missing.width;
  delete missing.height;
  delete missing.items;
  assert.throws(
    () => compilePrompt(missing),
    /Layout draft: missing fields \['height', 'items', 'width'\]/,
  );

  const unknown = freshLandscapeDraft();
  unknown.alpha = 1;
  unknown.zeta = 2;
  assert.throws(
    () => compilePrompt(unknown),
    /Layout draft: unknown fields \['alpha', 'zeta'\]/,
  );

  const itemUnknown = freshLandscapeDraft();
  itemUnknown.items[0].children = [];
  itemUnknown.items[0].font_size = 12;
  assert.throws(
    () => compilePrompt(itemUnknown),
    /items\[0\]: unknown fields \['children', 'font_size'\]/,
  );

  const summaryMissing = freshLandscapeDraft();
  summaryMissing.summary = {};
  assert.throws(() => compilePrompt(summaryMissing), /summary: missing fields \['caption'\]/);

  assert.throws(
    () => compilePrompt({ caption: "x", items: [] }),
    /Caption draft: unknown fields \['items'\]/,
  );
});

test("summary and item schema validation", () => {
  const makeDraft = (summary, itemOverrides) =>
    layoutDraft(1536, 1024, summary, [
      Object.assign({}, freshLandscapeDraft().items[0], itemOverrides),
    ]);

  assert.throws(
    () => compilePrompt(makeDraft({ caption: "s", canvas: "diorama" }, {})),
    /summary\.canvas must be single, multi_panel or collage/,
  );
  assert.throws(
    () => compilePrompt(makeDraft({ caption: "s", meta: "poster" }, {})),
    /summary\.meta must be an array/,
  );
  assert.throws(
    () => compilePrompt(makeDraft({ caption: "s", palette: ["ok", ""] }, {})),
    /summary\.palette\[1\] must be nonempty text/,
  );
  assert.throws(
    () => compilePrompt(makeDraft({ caption: "   " }, {})),
    /summary\.caption must be nonempty text/,
  );
  assert.throws(
    () => compilePrompt(Object.assign(freshLandscapeDraft(), { items: [] })),
    /items must be a nonempty flat array/,
  );
  assert.throws(
    () => compilePrompt(makeDraft({ caption: "s" }, { tags: ["ok", 7] })),
    /items\[0\]\.tags\[1\] must be nonempty text/,
  );
  assert.throws(
    () => compilePrompt(makeDraft({ caption: "s" }, { palette: "nope" })),
    /items\[0\]\.palette must be an array/,
  );
  assert.throws(
    () => compilePrompt(makeDraft({ caption: "s" }, { bbox: [0, 0, 10] })),
    /items\[0\]\.bbox must be \[x1,y1,x2,y2\]/,
  );
  assert.throws(
    () => compilePrompt(makeDraft({ caption: "s" }, { bbox: [0, 0, Number.NaN, 10] })),
    /items\[0\]\.bbox must contain four finite numbers/,
  );
  assert.throws(
    () => compilePrompt(makeDraft({ caption: "s" }, { bbox: [0, 0, 1e-11, 10] })),
    /items\[0\]\.bbox is too small at export precision/,
  );
  assert.throws(
    () => compilePrompt(makeDraft({ caption: "s" }, { label: "symbol" })),
    /items\[0\]\.label must be object, character or text/,
  );
});

test("bbox validation and error wording match the Python tool", () => {
  assert.throws(
    () => compileBox([-1, 0, 100, 100], 1536, 1024),
    /items\[0\]\.bbox exceeds the 1536x1024 canvas/,
  );
  assert.throws(
    () => compileBox([0, 0, 100, 1025], 1536, 1024),
    /items\[0\]\.bbox exceeds the 1536x1024 canvas/,
  );
  assert.throws(
    () => compileBox([100, 0, 50, 100], 1536, 1024),
    /items\[0\]\.bbox must have positive width and height/,
  );
  assert.throws(
    () => compileBox([0, 0, 0.00000000001, 100], 1536, 1024),
    /items\[0\]\.bbox is too small at export precision/,
  );
  assert.deepEqual(compileBox([512, 512, 1024, 1024], 1024, 1024), [0, 0, 512, 512]);
  assert.deepEqual(compileBox([0.5, 0.5, 1023.5, 1023.5], 1024, 1024), [-512, -512, 512, 512]);
});

test("layout output is compact, one line, ordered and UTF-8 raw", () => {
  const draft = layoutDraft(1024, 512, { caption: "s" }, [
    { text: "hello", bbox: [10, 20, 100, 200], caption: "c", label: "text" },
  ]);
  const result = compilePrompt(draft);
  assert.equal(result.kind, "layout");
  assert.equal(
    result.prompt,
    '{"summary":{"caption":"s"},"items":[{"text":"hello","bbox":[-236,-502,-56,-412],"caption":"c","label":"text"}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}',
  );
  assert.equal(JSON.stringify(JSON.parse(result.prompt)), result.prompt);
  assert.ok(!result.prompt.includes("\n"));
  assert.ok(!result.prompt.includes("\r"));

  const unicodeDraft = freshLandscapeDraft();
  unicodeDraft.summary.caption = "把日常，过成诗。";
  unicodeDraft.items[0].text = "把日常，过成诗。\nMOSS 🪴";
  const unicodePrompt = compilePrompt(unicodeDraft).prompt;
  assert.ok(unicodePrompt.includes("把日常，过成诗。"));
  assert.ok(unicodePrompt.includes("🪴"));
  assert.ok(!unicodePrompt.includes("\\u"), "non-ASCII must not be \\u-escaped");
  assert.ok(unicodePrompt.includes('\\nMOSS'), "JSON newlines stay escaped");
});

test("caption validation follows Python str.strip() whitespace semantics", () => {
  const blanks = ["", " ", "\t\n", "\u000b\u000c\r", "\u001c", "\u0085", "\u00a0", "\u1680", "\u2007", "\u2028", "\u202f", "\u3000"];
  for (const blank of blanks) {
    assert.throws(
      () => compilePrompt({ caption: blank }),
      /caption must be nonempty text/,
      "blank caption " + JSON.stringify(blank),
    );
  }
  // U+FEFF (BOM) is not str.isspace() in Python, so it is accepted.
  assert.deepEqual(compilePrompt({ caption: "\uFEFF" }), { kind: "caption", prompt: "\uFEFF" });
  const padded = " \n padded \t";
  assert.equal(compilePrompt({ caption: padded }).prompt, padded);
});

test("parseDraftJson preserves key order and decodes escapes", () => {
  const parsed = parseDraftJson('{"z":1,"a":2,"caption":"\\u628a\\n"}');
  assert.deepEqual(Object.keys(parsed), ["z", "a", "caption"]);
  assert.equal(parsed.caption, "把\n");
  assert.equal(parsed.z, 1);
  const surrogatePair = parseDraftJson('{"caption":"\\ud83d\\ude00"}');
  assert.equal(surrogatePair.caption, "😀");
});

test("parseDraftJson rejects duplicate keys at any depth", () => {
  const cases = [
    '{"caption":"one","caption":"two"}',
    '{"summary":{"caption":"a","caption":"b"}}',
    '{"items":[{"label":"object","label":"text"}]}',
    '{"caption":"one","\\u0063aption":"two"}',
  ];
  for (const source of cases) {
    assert.throws(
      () => parseDraftJson(source),
      (error) => error instanceof CompileError && error.message.startsWith("Duplicate JSON key: "),
      source,
    );
  }
});

test("parseDraftJson rejects NaN and Infinity constants", () => {
  const cases = [
    ['{"caption":NaN}', "Invalid JSON number: NaN"],
    ['{"caption":Infinity}', "Invalid JSON number: Infinity"],
    ['{"caption":-Infinity}', "Invalid JSON number: -Infinity"],
    ["NaN", "Invalid JSON number: NaN"],
    ["[Infinity]", "Invalid JSON number: Infinity"],
  ];
  for (const [source, message] of cases) {
    assert.throws(
      () => parseDraftJson(source),
      (error) => error instanceof CompileError && error.message === message,
      source,
    );
  }
});

test("parseDraftJson is strict and reports Python-style positions", () => {
  const syntaxCases = [
    ["", /^Expecting value: line 1 column 1 \(char 0\)$/],
    ["-", /^Expecting value: line 1 column 1 \(char 0\)$/],
    ["tru", /^Expecting value: line 1 column 1 \(char 0\)$/],
    ["1.", /^Extra data: line 1 column 2 \(char 1\)$/],
    ["01", /^Extra data: line 1 column 2 \(char 1\)$/],
    ['{"a":1 "b":2}', /^Expecting ',' delimiter: line 1 column 8 \(char 7\)$/],
    ["[1 2]", /^Expecting ',' delimiter: line 1 column 4 \(char 3\)$/],
    ['{"a"}', /^Expecting ':' delimiter: line 1 column 5 \(char 4\)$/],
    ['{"a":}', /^Expecting value: line 1 column 6 \(char 5\)$/],
    ['"abc', /^Unterminated string starting at: line 1 column 1 \(char 0\)$/],
    ['"a\\q"', /^Invalid \\escape: line 1 column 3 \(char 2\)$/],
    ['"\\u12"', /^Invalid \\uXXXX escape: line 1 column 3 \(char 2\)$/],
    ["\ufeff{}", /^Unexpected UTF-8 BOM \(decode using utf-8-sig\): line 1 column 1 \(char 0\)$/],
    ['{"a":1,}', /^Illegal trailing comma before end of object: line 1 column 7 \(char 6\)$/],
    ["[1,]", /^Illegal trailing comma before end of array: line 1 column 3 \(char 2\)$/],
    ['{"a":1}{"b":2}', /^Extra data: line 1 column 8 \(char 7\)$/],
  ];
  for (const [source, expected] of syntaxCases) {
    assert.throws(
      () => parseDraftJson(source),
      (error) => error instanceof CompileError && expected.test(error.message),
      JSON.stringify(source),
    );
  }
  // Multi-line documents report the correct line/column.
  assert.throws(
    () => parseDraftJson('{\n  "a":\n}'),
    /Expecting value: line 3 column 1 \(char 9\)/,
  );
});

test("known deviation: integral floats are accepted (Python rejects them)", () => {
  // Python: json.loads turns 1024.0 into a float and type(value) is int
  // rejects it. JavaScript has exactly one Number type, so 1024.0 === 1024 is
  // indistinguishable after parsing. The port accepts it; this documents the
  // deviation rather than faking a rejection.
  const draft = freshLandscapeDraft();
  draft.width = 1536.0;
  draft.height = 1024.0;
  assert.equal(compilePrompt(draft).kind, "layout");

  // Same root cause for integers beyond 2**53-1: Python would keep the exact
  // integer, JS rounds it to the nearest double. Not exercised as supported
  // behaviour - no parity is claimed here.
  assert.equal(JSON.parse('{"value":9007199254740993}').value, 9007199254740992);
});

/* ---------------------------------------------------------------------- */
/* 3. Differential tests against the Python reference                      */
/* ---------------------------------------------------------------------- */

const differentialFixtures = [
  { name: "landscape-cjk-text", draft: freshLandscapeDraft() },
  {
    name: "portrait-full-canvas",
    draft: portraitDraft([0, 0, 768, 1344]),
  },
  {
    name: "fractional-enclosure",
    draft: portraitDraft([10.9, 20.1, 100.01, 200.99]),
  },
  {
    name: "fractional-subpixel-precision",
    draft: layoutDraft(768, 1344, { caption: "Precision." }, [
      { label: "object", caption: "Precision edge.", bbox: [1.00000000001, 2, 100, 200] },
    ]),
  },
  {
    name: "round-half-even-edges",
    draft: layoutDraft(1024, 1024, { caption: "Rounding." }, [
      { label: "object", caption: "Tie near one.", bbox: [0.9999999995, 1, 100, 200] },
      { label: "object", caption: "Tie near zero.", bbox: [0.0000000005, 2, 3, 4] },
      { label: "object", caption: "Tiny coordinate.", bbox: [1e-7, 10.9, 20.1, 100.01] },
    ]),
  },
  {
    name: "single-pixel-canvas",
    draft: layoutDraft(16, 16, { caption: "Tiny canvas." }, [
      { label: "object", caption: "Full bleed.", bbox: [0, 0, 16, 16] },
    ]),
  },
  {
    name: "collage-tags-palette",
    draft: layoutDraft(
      2048,
      512,
      {
        meta: ["editorial", "collage"],
        canvas: "collage",
        palette: ["ivory", "forest"],
        caption: "A three-panel collage.",
      },
      [
        { label: "object", caption: "Left panel.", bbox: [0, 0, 680, 512], tags: ["panel"], palette: ["ivory"] },
        { label: "character", caption: "Center figure.", bbox: [700, 40, 1340, 500], tags: ["portrait"] },
        { label: "text", caption: "Right panel text.", text: "把日常\n过成诗", bbox: [1360.5, 100.25, 2020, 400], tags: ["title"], palette: ["forest"] },
      ],
    ),
  },
  {
    name: "center-zero-box",
    draft: layoutDraft(1024, 1024, { caption: "Centered." }, [
      { label: "object", caption: "Lower-right quadrant.", bbox: [512, 512, 1024, 1024] },
    ]),
  },
  {
    name: "raw-exponent-coordinates",
    text:
      '{\n  "width": 1536,\n  "height": 1024,\n  "bbox_coord_space": "abs",\n' +
      '  "bbox_format": "xyxy",\n  "summary": {"caption": "Exponent coordinates."},\n' +
      '  "items": [{"label": "object", "caption": "Exponent box.", "bbox": [1e2, 2.5e2, 3E2, 4e2]}]\n}\n',
  },
  {
    name: "caption-multiline-unicode",
    draft: { caption: 'An ivory cup marked "茶".\nPreserve this second line. 😀' },
  },
  {
    name: "caption-controls-and-crlf",
    draft: { caption: "line1\r\nline2\rlone\rcarriage\u0001\u007f\u2028end" },
  },
  {
    name: "unicode-tags-and-palette",
    draft: layoutDraft(1024, 1024, { caption: "标签", meta: ["海报"] }, [
      { label: "text", caption: "标题文字", text: "把日常，过成诗。", bbox: [100, 100, 900, 300], tags: ["标题", "中文"], palette: ["墨绿", "象牙白"] },
    ]),
  },
  {
    name: "item-key-order",
    draft: layoutDraft(1536, 1024, { palette: ["ivory"], canvas: "multi_panel", meta: ["poster"], caption: "Order." }, [
      { text: "line1\nline2", bbox: [10.5, 20.25, 100.75, 200.5], caption: "Text item.", label: "text", tags: ["a", "b"], palette: ["#fff"] },
      { label: "character", caption: "Person.", bbox: [0, 0, 1536, 1024] },
    ]),
  },
  {
    name: "boundary-box-1024",
    draft: layoutDraft(1024, 1024, { caption: "Full canvas." }, [
      { label: "object", caption: "Everything.", bbox: [0, 0, 1024, 1024] },
    ]),
  },
  {
    name: "float-half-boundaries",
    draft: layoutDraft(1024, 1024, { caption: "Half pixels." }, [
      { label: "object", caption: "Half-pixel border.", bbox: [0.5, 0.5, 1023.5, 1023.5] },
    ]),
  },
  {
    name: "raw-json-whitespace-and-escapes",
    text:
      ' {\n\t"width" : 1536,\n\t"height": 1024,\n\t"bbox_coord_space": "abs",\n' +
      '\t"bbox_format": "xyxy",\n\t"summary": {"caption": "\\u4e2d\\u6587 caption"},\n' +
      '\t"items": [{"label": "object", "caption": "item", "bbox": [16, 32, 1536, 900]}]\n} \n',
  },
];

test("Python reference: compiled prompts are byte-identical", { skip: pythonSkip }, () => {
  assert.ok(differentialFixtures.length >= 10, "expected at least ten fixtures");
  for (const fixture of differentialFixtures) {
    const sourceText = fixture.text ?? JSON.stringify(fixture.draft);
    const compiled = compileDraftText(sourceText);
    const python = runPythonCompiler(sourceText);
    assert.equal(python.status, 0, fixture.name + ": python failed: " + python.stderr);
    assert.equal(python.stdout, "", fixture.name + ": python stdout should be empty with --output");
    assert.notEqual(python.output, null, fixture.name + ": python wrote no output file");
    assert.equal(
      python.output,
      compiled.prompt + "\n",
      fixture.name + ": compiled prompt differs from the Python reference",
    );
  }
});

test("Python reference: error parity for duplicate keys and non-finite numbers", { skip: pythonSkip }, () => {
  const cases = [
    ['{"caption":"one","caption":"two"}', "Duplicate JSON key: caption"],
    ['{"caption":NaN}', "Invalid JSON number: NaN"],
    ['{"caption":Infinity}', "Invalid JSON number: Infinity"],
    ['{"caption":-Infinity}', "Invalid JSON number: -Infinity"],
  ];
  for (const [sourceText, message] of cases) {
    const python = runPythonCompiler(sourceText);
    assert.equal(python.status, 2, sourceText + ": python exit status must be 2");
    assert.equal(python.output, null, sourceText + ": python must not write output");
    assert.equal(python.stderr.trimEnd(), "Error: " + message, sourceText);
    assert.throws(
      () => parseDraftJson(sourceText),
      (error) => error instanceof CompileError && error.message === message,
      sourceText,
    );
  }
});

test("Python reference: JSON syntax error messages match", { skip: pythonSkip }, () => {
  // Messages/positions that are stable across CPython 3.x (the newer
  // "Illegal trailing comma" wording is covered by the unit test above
  // instead of this Python-version-dependent comparison).
  const cases = ["", "-", "tru", "1.", "01", '{"a":1 "b":2}', "[1 2]", '{"a"}', '{"a":}', '"abc', "{}x", '{"a":1}{"b":2}', "\ufeff{}"];
  for (const sourceText of cases) {
    let jsMessage = null;
    try {
      parseDraftJson(sourceText);
    } catch (error) {
      assert.ok(error instanceof CompileError, JSON.stringify(sourceText));
      jsMessage = error.message;
    }
    assert.notEqual(jsMessage, null, JSON.stringify(sourceText) + ": expected a JS rejection");
    const python = runPythonCompiler(sourceText);
    assert.equal(python.status, 2, JSON.stringify(sourceText) + ": python exit status must be 2");
    assert.equal(
      python.stderr.trimEnd(),
      "Error: " + jsMessage,
      JSON.stringify(sourceText) + ": error message differs from the Python reference",
    );
  }
});
