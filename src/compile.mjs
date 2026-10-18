/**
 * MOSS-Image prompt compiler.
 *
 * Strict ESM port of the MOSS-Image skill's upstream tool
 * scripts/compile_prompt.py (see D:\dsh\research\upstream-skill\scripts).
 * No third-party dependencies: this module only uses the JavaScript language
 * built-ins (BigInt/DataView/JSON) and has no imports.
 *
 * Public API (contract shared with the rest of the plugin):
 *   CompileError      - thrown for every rejected draft/JSON input
 *   parseDraftJson    - strict JSON parsing with duplicate-key and
 *                       NaN/Infinity rejection, mirroring Python's
 *                       json.loads(..., object_pairs_hook=..., parse_constant=...)
 *   compilePrompt     - validate a parsed draft and compile it,
 *                       returning { kind: "caption" | "layout", prompt }
 *   compileDraftText  - parseDraftJson + compilePrompt
 *
 * Known deviations from the Python reference (also documented in
 * tests/compile.test.mjs):
 *   1. JavaScript numbers cannot distinguish JSON integers from integral
 *      floats, so a 1024.0 width/height is accepted here while Python's
 *      type(value) is int check rejects it.
 *   2. The Python tool keeps arbitrary-precision ints. Coordinates/widths
 *      beyond Number.MAX_SAFE_INTEGER (2**53-1) lose precision or overflow
 *      to Infinity here (e.g. a huge integer width is rejected instead of
 *      being checked exactly).
 *   3. Python's CLI writes files in text mode, which translates "\n" to the
 *      platform line separator on Windows. The library returns strings; the
 *      differential test normalizes CRLF when comparing against the CLI.
 *   4. Python json.dumps(ensure_ascii=False) writes lone surrogate escapes
 *      verbatim, while JSON.stringify escapes unpaired surrogates as
 *      \uD800-style sequences (invalid UTF-8 drafts are not a supported use
 *      case).
 */

const CAPTION_DRAFT_FIELDS = ["caption"];
const LAYOUT_ROOT_FIELDS = ["width", "height", "bbox_coord_space", "bbox_format", "summary", "items"];
const SUMMARY_FIELDS = ["caption", "meta", "canvas", "palette"];
const ITEM_FIELDS = ["label", "caption", "bbox", "text", "tags", "palette"];
const ITEM_LABELS = ["object", "character", "text"];
const SUMMARY_CANVAS_VALUES = ["single", "multi_panel", "collage"];

/**
 * Raised for every invalid draft, malformed JSON document or unserializable
 * value. The message mirrors the Python reference's ValueError text where
 * that is observable (duplicate keys, NaN/Infinity, schema errors, JSON
 * syntax positions).
 */
export class CompileError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompileError";
  }
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new CompileError(message);
  }
}

/** Python's isinstance(value, dict) for JSON-shaped values. */
function isPlainObjectLike(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/* ------------------------------------------------------------------------ */
/* Python-compatible string helpers                                          */
/* ------------------------------------------------------------------------ */

/**
 * Python's str.isspace() set: ASCII \t\n\v\f\r, C0 separators 0x1c-0x1f,
 * U+0085, every Unicode Zs separator, and U+2028/U+2029 (Zl/Zp).
 */
function isPythonWhitespaceCode(code) {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x1f) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Equivalent of Python's str.strip() (not String.prototype.trim(), which
 *  differs for e.g. U+001C or U+FEFF). */
function pythonStrip(value) {
  let start = 0;
  let end = value.length;
  while (start < end && isPythonWhitespaceCode(value.charCodeAt(start))) start += 1;
  while (end > start && isPythonWhitespaceCode(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/** Compare strings the way Python's sorted() does (by Unicode code point). */
function compareCodePoints(a, b) {
  const left = Array.from(a, (character) => character.codePointAt(0));
  const right = Array.from(b, (character) => character.codePointAt(0));
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}

/** Python 3 repr() for a single string (used in schema error messages). */
const UNICODE_NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function isPythonPrintable(character) {
  return character === " " || !UNICODE_NON_PRINTABLE.test(character);
}

function pythonReprString(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let result = quote;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === quote) {
      result += "\\" + quote;
    } else if (character === "\\") {
      result += "\\\\";
    } else if (character === "\t") {
      result += "\\t";
    } else if (character === "\n") {
      result += "\\n";
    } else if (character === "\r") {
      result += "\\r";
    } else if (code < 0x20 || code === 0x7f) {
      result += "\\x" + code.toString(16).padStart(2, "0");
    } else if (code < 0x7f) {
      result += character;
    } else if (isPythonPrintable(character)) {
      result += character;
    } else if (code < 0x100) {
      result += "\\x" + code.toString(16).padStart(2, "0");
    } else if (code < 0x10000) {
      result += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      result += "\\U" + code.toString(16).padStart(8, "0");
    }
  }
  return result + quote;
}

/** Python's repr() for the sorted field lists, e.g. ['a', 'b']. */
function pythonListRepr(values) {
  return "[" + values.map(pythonReprString).join(", ") + "]";
}

/* ------------------------------------------------------------------------ */
/* Schema validation (mirrors fields()/text()/strings() in the Python tool)  */
/* ------------------------------------------------------------------------ */

function fields(value, allowed, required, location) {
  requireCondition(isPlainObjectLike(value), location + " must be an object");
  const keys = Object.keys(value);
  const allowedSet = new Set(allowed);
  const unknown = keys.filter((key) => !allowedSet.has(key)).sort(compareCodePoints);
  const present = new Set(keys);
  const missing = required.filter((key) => !present.has(key)).sort(compareCodePoints);
  requireCondition(unknown.length === 0, location + ": unknown fields " + pythonListRepr(unknown));
  requireCondition(missing.length === 0, location + ": missing fields " + pythonListRepr(missing));
}

function text(value, location) {
  requireCondition(
    typeof value === "string" && pythonStrip(value).length > 0,
    location + " must be nonempty text",
  );
}

function strings(value, location) {
  requireCondition(Array.isArray(value), location + " must be an array");
  value.forEach((item, index) => text(item, location + "[" + index + "]"));
}

/* ------------------------------------------------------------------------ */
/* Python round(x, 9), floor/ceil and box centering                          */
/* ------------------------------------------------------------------------ */

const FLOAT64_VIEW = new DataView(new ArrayBuffer(8));

/**
 * CPython's round(x, ndigits) is a correctly rounded decimal conversion with
 * round-half-even. Reproduce it exactly: decompose the IEEE-754 double into
 * mantissa * 2**exponent, scale by 10**9 as an exact rational, round the
 * integer half-even, then parse the exact decimal string back to a double
 * (the same operation CPython's strtod performs).
 */
function pythonRound9(value) {
  requireCondition(
    Number.isFinite(value),
    "Out of range float values are not JSON compliant",
  );

  FLOAT64_VIEW.setFloat64(0, value, false);
  const high = FLOAT64_VIEW.getUint32(0, false);
  const low = FLOAT64_VIEW.getUint32(4, false);
  const negative = (high >>> 31) === 1;
  const exponentBits = (high >>> 20) & 0x7ff;
  const mantissaBits = (BigInt(high & 0xfffff) << 32n) | BigInt(low);

  let mantissa;
  let exponent;
  if (exponentBits === 0) {
    mantissa = mantissaBits;
    exponent = -1074;
  } else {
    mantissa = (1n << 52n) | mantissaBits;
    exponent = exponentBits - 1075;
  }

  let numerator = mantissa * 1000000000n;
  let denominator = 1n;
  if (exponent >= 0) {
    numerator <<= BigInt(exponent);
  } else {
    denominator = 1n << BigInt(-exponent);
  }

  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = remainder * 2n;
  if (doubled > denominator || (doubled === denominator && (quotient & 1n) === 1n)) {
    quotient += 1n;
  }
  if (negative) quotient = -quotient;

  const absolute = quotient < 0n ? -quotient : quotient;
  let digits = absolute.toString();
  if (digits.length <= 9) {
    digits = "0." + "0".repeat(9 - digits.length) + digits;
  } else {
    digits = digits.slice(0, -9) + "." + digits.slice(-9);
  }
  return Number((quotient < 0n ? "-" : "") + digits);
}

/** Python floor division width // 2 for validated positive integer widths. */
function halfSize(size) {
  return Math.floor(size / 2);
}

function centeredBox(box, width, height, location) {
  requireCondition(
    Array.isArray(box) && box.length === 4,
    location + " must be [x1,y1,x2,y2]",
  );
  requireCondition(
    box.every((value) => typeof value === "number" && Number.isFinite(value)),
    location + " must contain four finite numbers",
  );
  const [x1, y1, x2, y2] = box;
  requireCondition(x1 < x2 && y1 < y2, location + " must have positive width and height");
  requireCondition(
    0 <= x1 && x1 < x2 && x2 <= width && 0 <= y1 && y1 < y2 && y2 <= height,
    location + " exceeds the " + width + "x" + height + " canvas",
  );
  // Enclose in pixel edges before centering, as in Echidna generation export.
  const result = [
    Math.floor(pythonRound9(y1)) - halfSize(height),
    Math.floor(pythonRound9(x1)) - halfSize(width),
    Math.ceil(pythonRound9(y2)) - halfSize(height),
    Math.ceil(pythonRound9(x2)) - halfSize(width),
  ];
  requireCondition(
    result[0] < result[2] && result[1] < result[3],
    location + " is too small at export precision",
  );
  return result;
}

/* ------------------------------------------------------------------------ */
/* Python json.dumps(..., ensure_ascii=False, separators=(",", ":"),        */
/*                    allow_nan=False)                                      */
/* ------------------------------------------------------------------------ */

/** Python float.__repr__ (used only if a non-integer number ever reaches the
 *  serializer; the compiled schema only emits integers). */
function pythonFloatRepr(value) {
  if (Object.is(value, -0)) return "-0.0";
  const [mantissaPart, exponentPart] = value.toExponential().split("e");
  let digits = mantissaPart.replace(".", "");
  let negative = false;
  if (digits.startsWith("-")) {
    negative = true;
    digits = digits.slice(1);
  }
  const exponent = Number(exponentPart);
  let body;
  if (exponent >= -4 && exponent < 16) {
    if (exponent + 1 >= digits.length) {
      body = digits + "0".repeat(exponent + 1 - digits.length) + ".0";
    } else if (exponent >= 0) {
      body = digits.slice(0, exponent + 1) + "." + digits.slice(exponent + 1);
    } else {
      body = "0." + "0".repeat(-exponent - 1) + digits;
    }
  } else {
    const mantissa = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits[0];
    const sign = exponent < 0 ? "-" : "+";
    body = mantissa + "e" + sign + Math.abs(exponent).toString().padStart(2, "0");
  }
  return (negative ? "-" : "") + body;
}

function formatJsonNumber(value) {
  if (!Number.isFinite(value)) {
    throw new CompileError("Out of range float values are not JSON compliant");
  }
  if (Number.isInteger(value)) {
    // Python ints print in full decimal notation, even past 1e21.
    return BigInt(value).toString();
  }
  return pythonFloatRepr(value);
}

function writeJsonValue(value, chunks) {
  if (value === null) {
    chunks.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      // For well-formed strings this is byte-identical to Python's
      // ensure_ascii=False encoder (\b \f \n \r \t, \u00XX for other C0,
      // raw DEL/U+2028/non-ASCII).
      chunks.push(JSON.stringify(value));
      return;
    case "number":
      chunks.push(formatJsonNumber(value));
      return;
    case "boolean":
      chunks.push(value ? "true" : "false");
      return;
    case "object": {
      if (Array.isArray(value)) {
        chunks.push("[");
        value.forEach((item, index) => {
          if (index > 0) chunks.push(",");
          writeJsonValue(item, chunks);
        });
        chunks.push("]");
        return;
      }
      chunks.push("{");
      let first = true;
      for (const key of Object.keys(value)) {
        if (!first) chunks.push(",");
        first = false;
        chunks.push(JSON.stringify(key), ":");
        writeJsonValue(value[key], chunks);
      }
      chunks.push("}");
      return;
    }
    default:
      throw new CompileError(
        "Object of type " + typeof value + " is not JSON serializable",
      );
  }
}

function pythonJsonDumps(value) {
  const chunks = [];
  writeJsonValue(value, chunks);
  return chunks.join("");
}

/* ------------------------------------------------------------------------ */
/* Strict JSON parser                                                       */
/* ------------------------------------------------------------------------ */

/**
 * A strict JSON (RFC 8259) recursive-descent parser matching Python's
 * json.loads behaviour and error positions:
 *   - object_pairs_hook duplicate key rejection ("Duplicate JSON key: x"),
 *     raised once the enclosing object is complete, innermost object first;
 *   - parse_constant rejection for NaN / Infinity / -Infinity
 *     ("Invalid JSON number: NaN");
 *   - no trailing commas, comments, single quotes, leading zeros or raw
 *     control characters in strings;
 *   - Python-style "Message: line L column C (char P)" syntax errors.
 */
class DraftJsonParser {
  constructor(source) {
    this.source = source;
    this.length = source.length;
    this.position = 0;
  }

  parseDocument() {
    if (this.source.charCodeAt(0) === 0xfeff) {
      this.syntaxError("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
    }
    this.skipWhitespace();
    if (this.position >= this.length) this.syntaxError("Expecting value", this.position);
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.position < this.length) this.syntaxError("Extra data", this.position);
    return value;
  }

  syntaxError(message, position) {
    let line = 1;
    let lastNewline = -1;
    for (let index = 0; index < position; index += 1) {
      if (this.source.charCodeAt(index) === 0x0a) {
        line += 1;
        lastNewline = index;
      }
    }
    const column = position - lastNewline;
    throw new CompileError(
      message + ": line " + line + " column " + column + " (char " + position + ")",
    );
  }

  skipWhitespace() {
    while (this.position < this.length) {
      const code = this.source.charCodeAt(this.position);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        this.position += 1;
      } else {
        break;
      }
    }
  }

  parseValue() {
    this.skipWhitespace();
    if (this.position >= this.length) this.syntaxError("Expecting value", this.position);
    const character = this.source[this.position];
    switch (character) {
      case "{":
        return this.parseObject();
      case "[":
        return this.parseArray();
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      case "N":
        if (this.source.startsWith("NaN", this.position)) {
          throw new CompileError("Invalid JSON number: NaN");
        }
        break;
      case "I":
        if (this.source.startsWith("Infinity", this.position)) {
          throw new CompileError("Invalid JSON number: Infinity");
        }
        break;
      case "-":
        if (this.source.startsWith("-Infinity", this.position)) {
          throw new CompileError("Invalid JSON number: -Infinity");
        }
        return this.parseNumber();
      default:
        if (character >= "0" && character <= "9") return this.parseNumber();
        break;
    }
    this.syntaxError("Expecting value", this.position);
  }

  parseLiteral(literal, value) {
    if (!this.source.startsWith(literal, this.position)) {
      this.syntaxError("Expecting value", this.position);
    }
    this.position += literal.length;
    return value;
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.position),
    );
    if (match === null) this.syntaxError("Expecting value", this.position);
    this.position += match[0].length;
    // Deviation 2: Python keeps exact arbitrary-precision ints; Number is
    // the only JSON-representable numeric type available here.
    return Number(match[0]);
  }

  parseString() {
    const start = this.position;
    this.position += 1;
    let result = "";
    for (;;) {
      if (this.position >= this.length) {
        this.syntaxError("Unterminated string starting at", start);
      }
      const character = this.source[this.position];
      if (character === '"') {
        this.position += 1;
        return result;
      }
      if (character === "\\") {
        result += this.parseEscape(start);
        continue;
      }
      if (this.source.charCodeAt(this.position) < 0x20) {
        this.syntaxError("Invalid control character at", this.position);
      }
      result += character;
      this.position += 1;
    }
  }

  parseEscape(stringStart) {
    const escapeStart = this.position;
    this.position += 1;
    if (this.position >= this.length) {
      this.syntaxError("Unterminated string starting at", stringStart);
    }
    const escape = this.source[this.position];
    switch (escape) {
      case '"':
        this.position += 1;
        return '"';
      case "\\":
        this.position += 1;
        return "\\";
      case "/":
        this.position += 1;
        return "/";
      case "b":
        this.position += 1;
        return "\b";
      case "f":
        this.position += 1;
        return "\f";
      case "n":
        this.position += 1;
        return "\n";
      case "r":
        this.position += 1;
        return "\r";
      case "t":
        this.position += 1;
        return "\t";
      case "u": {
        const hex = this.source.slice(this.position + 1, this.position + 5);
        if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.syntaxError("Invalid \\uXXXX escape", this.position);
        }
        this.position += 5;
        // Lone surrogates are kept as-is; Python's json decoder stores them
        // the same way (paired escapes simply become a surrogate pair here).
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        this.syntaxError("Invalid \\escape", escapeStart);
    }
  }

  parseObject() {
    this.position += 1;
    this.skipWhitespace();
    const pairs = [];
    if (this.source[this.position] === "}") {
      this.position += 1;
      return this.buildObject(pairs);
    }
    for (;;) {
      this.skipWhitespace();
      if (this.source[this.position] !== '"') {
        this.syntaxError("Expecting property name enclosed in double quotes", this.position);
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.source[this.position] !== ":") {
        this.syntaxError("Expecting ':' delimiter", this.position);
      }
      this.position += 1;
      const value = this.parseValue();
      pairs.push([key, value]);
      this.skipWhitespace();
      const character = this.source[this.position];
      if (character === ",") {
        const commaPosition = this.position;
        this.position += 1;
        this.skipWhitespace();
        if (this.source[this.position] === "}") {
          this.syntaxError("Illegal trailing comma before end of object", commaPosition);
        }
        continue;
      }
      if (character === "}") {
        this.position += 1;
        return this.buildObject(pairs);
      }
      this.syntaxError("Expecting ',' delimiter", this.position);
    }
  }

  buildObject(pairs) {
    const result = {};
    for (const [key, value] of pairs) {
      if (hasOwn(result, key)) {
        throw new CompileError("Duplicate JSON key: " + key);
      }
      // defineProperty keeps "__proto__" as an ordinary data property.
      Object.defineProperty(result, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }

  parseArray() {
    this.position += 1;
    this.skipWhitespace();
    const result = [];
    if (this.source[this.position] === "]") {
      this.position += 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const character = this.source[this.position];
      if (character === ",") {
        const commaPosition = this.position;
        this.position += 1;
        this.skipWhitespace();
        if (this.source[this.position] === "]") {
          this.syntaxError("Illegal trailing comma before end of array", commaPosition);
        }
        continue;
      }
      if (character === "]") {
        this.position += 1;
        return result;
      }
      this.syntaxError("Expecting ',' delimiter", this.position);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Parse the UTF-8 draft text exactly like the Python tool:
 * json.loads(text, object_pairs_hook=unique_object, parse_constant=reject_constant).
 *
 * @param {string} text
 * @returns {unknown} parsed JSON value (objects keep their insertion order)
 * @throws {CompileError} for syntax errors, duplicate keys, NaN/Infinity
 */
export function parseDraftJson(text) {
  requireCondition(typeof text === "string", "Draft JSON text must be a string");
  return new DraftJsonParser(text).parseDocument();
}

/**
 * Validate a parsed draft and compile it into a ready-to-paste prompt.
 *
 * @param {unknown} draft parsed caption or Layout draft
 * @returns {{ kind: "caption" | "layout", prompt: string }}
 * @throws {CompileError} when the draft does not match the schema
 */
export function compilePrompt(draft) {
  requireCondition(isPlainObjectLike(draft), "Draft must be a JSON object");

  if (hasOwn(draft, "caption")) {
    fields(draft, CAPTION_DRAFT_FIELDS, CAPTION_DRAFT_FIELDS, "Caption draft");
    text(draft.caption, "caption");
    return { kind: "caption", prompt: draft.caption };
  }

  fields(draft, LAYOUT_ROOT_FIELDS, LAYOUT_ROOT_FIELDS, "Layout draft");

  const width = draft.width;
  const height = draft.height;
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ]) {
    requireCondition(
      typeof value === "number" && Number.isInteger(value) && value > 0 && value % 16 === 0,
      name + " must be a positive integer multiple of 16",
    );
  }
  requireCondition(draft.bbox_coord_space === "abs", "Draft bbox_coord_space must be abs");
  requireCondition(draft.bbox_format === "xyxy", "Draft bbox_format must be xyxy");

  const summary = draft.summary;
  fields(summary, SUMMARY_FIELDS, ["caption"], "summary");
  text(summary.caption, "summary.caption");
  if (hasOwn(summary, "canvas")) {
    requireCondition(
      SUMMARY_CANVAS_VALUES.includes(summary.canvas),
      "summary.canvas must be single, multi_panel or collage",
    );
  }
  for (const key of ["meta", "palette"]) {
    if (hasOwn(summary, key)) strings(summary[key], "summary." + key);
  }

  const items = draft.items;
  requireCondition(
    Array.isArray(items) && items.length > 0,
    "items must be a nonempty flat array",
  );

  const compiledItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const location = "items[" + index + "]";
    const item = items[index];
    fields(item, ITEM_FIELDS, ["label", "caption", "bbox"], location);
    requireCondition(
      typeof item.label === "string" && ITEM_LABELS.includes(item.label),
      location + ".label must be object, character or text",
    );
    text(item.caption, location + ".caption");
    if (item.label === "text") {
      requireCondition(hasOwn(item, "text"), location + ": text items require literal text");
    }
    if (hasOwn(item, "text")) text(item.text, location + ".text");
    for (const key of ["tags", "palette"]) {
      if (hasOwn(item, key)) strings(item[key], location + "." + key);
    }
    // Preserve the draft's key order; replace bbox in place.
    const compiledItem = {};
    for (const key of Object.keys(item)) {
      compiledItem[key] =
        key === "bbox"
          ? centeredBox(item.bbox, width, height, location + ".bbox")
          : item[key];
    }
    compiledItems.push(compiledItem);
  }

  const result = {
    summary,
    items: compiledItems,
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
  };
  return { kind: "layout", prompt: pythonJsonDumps(result) };
}

/**
 * Parse and compile a caption or Layout draft serialized as JSON text.
 *
 * @param {string} text
 * @returns {{ kind: "caption" | "layout", prompt: string }}
 * @throws {CompileError} for invalid JSON or schema errors
 */
export function compileDraftText(text) {
  return compilePrompt(parseDraftJson(text));
}
