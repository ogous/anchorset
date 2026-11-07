/**
 * What both importers share: the typed refusal, the
 * validation of the recording grader's record, the stop map, the two-step skeleton rule with forward rendering,
 * the `cases.json` reader and the writer with its self-check.
 *
 * This file imports from the library's public entry and from Node built-ins, and from nothing else in `src/`: the
 * library's strict JSON reading (`findIllFormed`, `parseJsonText`, `utf8Text`) comes from the entry too.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callShapeHash, EFFORTS, findIllFormed, GAP, hashOf, InputError, isSha256Hex, NOT_SENT, oneLine, parseBarFile, parseJsonText, parseRunArtifact, readsAsGap, sha256Hex, utf8Text, validateCallShape } from '../../src/index.ts';
import type { Attempt, BarFile, Case } from '../../src/index.ts';

// ---------------------------------------------------------------------------------------------------------------
// Refusals and exit codes
// ---------------------------------------------------------------------------------------------------------------

export const IMPORT_REFUSAL_CODES = [
  'IMPORT_TOOL_VERSION',
  'IMPORT_SHAPE',
  'IMPORT_NO_RECORD',
  'IMPORT_EVIDENCE',
  'IMPORT_UNGRADED',
  'IMPORT_LABEL_DISAGREES',
  'IMPORT_MIXED_IDENTITY',
  'IMPORT_HIDDEN_CALLS',
  'IMPORT_DUPLICATE_CALL',
  'IMPORT_CACHE',
  'IMPORT_JUDGE_SELECTION',
  'IMPORT_DERIVATION',
  'IMPORT_PACKET',
  'IMPORT_CASE_ID',
  'IMPORT_CASE_MISSING',
  'IMPORT_DRAW_COUNT',
  'IMPORT_OUTPUTS_DIFFER',
  'IMPORT_BAR',
  'IMPORT_SELF_CHECK',
  // Added for a reader that is neither of the first two importers; no earlier code changed place or meaning.
  /** A stored system output that is not a finished answer. `IMPORT_UNGRADED` stays the judge's grade. */
  'IMPORT_OUTPUT_UNFINISHED',
  /** A path or a symlink the importer will not follow. `IMPORT_SHAPE` stays the shape of a file's content. */
  'IMPORT_PATH',
  /**
   * A record whose earlier asks break the re-ask rules: a finished reply that was asked again, more asks than the
   * stated bound, a reason that contradicts its status, call numbers that do not rise. `IMPORT_EVIDENCE` stays a
   * record that is not of the record's form.
   */
  'IMPORT_REASK',
] as const;
export type ImportRefusalCode = (typeof IMPORT_REFUSAL_CODES)[number];

/** Exit codes of an importer: the library's. */
export const IMPORT_EXIT = { written: 0, refused: 2, usage: 64, invalidInput: 65 } as const;
/** An error the importer did not foresee: never 1, which a caller's script reads as the library's verdict "regression". */
export const IMPORT_EXIT_INTERNAL = 70;

/** A file the importer will not turn into a run. `fields` names the paths, rows or slots that blocked it. */
export class ImportRefusal extends Error {
  readonly code: ImportRefusalCode;
  readonly fields: readonly string[];
  constructor(code: ImportRefusalCode, fields: readonly string[], message: string) {
    super(`${code}: ${message}`);
    this.name = 'ImportRefusal';
    this.code = code;
    this.fields = fields;
  }
}

/** A `cases.json` or a bar file that does not validate. Exit 65, not a refusal. */
export class ImportInputError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`INVALID_INPUT: ${problems.join('; ')}`);
    this.name = 'ImportInputError';
    this.problems = problems;
  }
}

/** A usage error: an existing `--out`, a missing or unknown flag. Exit 64. */
export class ImportUsageError extends Error {
  constructor(message: string) {
    super(`USAGE: ${message}`);
    this.name = 'ImportUsageError';
  }
}

export type ImportTool = 'promptfoo' | 'inspect';
const GRADER_FILES: Record<ImportTool, string> = { promptfoo: 'grader-provider.cjs', inspect: 'recording_grader.py' };

type Obj = Record<string, unknown>;
export const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
export const typeName = (x: unknown): string => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
/** A slot as `<case>#<draw>`, the one way every importer names a slot; a draw that could not be read (a negative number) is the case alone. */
export const slotLabel = (caseId: string, draw: number): string => (draw < 0 ? caseId : `${caseId}#${draw}`);
/** The path before the first colon of a problem text; a text with no colon is the path itself. */
export const problemField = (p: string): string => (p.indexOf(':') < 0 ? p : p.slice(0, p.indexOf(':')));

// Reading helpers shared by both importers: every miss is IMPORT_SHAPE and names the path in the source file.
export const shape = (path: string, expected: string, found: unknown): ImportRefusal => new ImportRefusal('IMPORT_SHAPE', [path], `${path}: expected ${expected}, found ${typeName(found)}`);
export const asObj = (v: unknown, path: string): Obj => (isObject(v) ? v : (() => { throw shape(path, 'object', v); })());
export const asArr = (v: unknown, path: string): unknown[] => (Array.isArray(v) ? v : (() => { throw shape(path, 'array', v); })());
export const asStr = (v: unknown, path: string): string => (typeof v === 'string' ? v : (() => { throw shape(path, 'string', v); })());
export const asBool = (v: unknown, path: string): boolean => (typeof v === 'boolean' ? v : (() => { throw shape(path, 'boolean', v); })());
export const asInt = (v: unknown, path: string): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : (() => { throw shape(path, 'integer', v); })());
/** `o[key]`, or IMPORT_SHAPE naming `<path>/<key>` when the key is missing. */
export const field = (o: Obj, key: string, path: string): unknown => {
  if (!(key in o)) throw new ImportRefusal('IMPORT_SHAPE', [`${path}/${key}`], `${path}/${key}: missing`);
  return o[key];
};
/** The value at `path` below `v`, or undefined when any step is missing. Never throws. */
export const peek = (v: unknown, ...path: (string | number)[]): unknown => {
  let at = v;
  for (const k of path) {
    if (typeof k === 'number' ? !Array.isArray(at) : !isObject(at)) return undefined;
    at = (at as Record<string | number, unknown>)[k];
  }
  return at;
};

// ---------------------------------------------------------------------------------------------------------------
// The grader's own constants, as the importers read them (a test compares them with the two grader files)
// ---------------------------------------------------------------------------------------------------------------

export const GRADER_NAME = 'anchorset-recording-grader';

/** The two wires a grader record can name. A wire name versions how the request is built and how the reply is taken from the response. */
export const WIRE_ANTHROPIC = 'anthropic-messages/v1';
export const WIRE_OPENAI = 'openai-responses/v1';
export const WIRES = [WIRE_ANTHROPIC, WIRE_OPENAI] as const;
export type Wire = (typeof WIRES)[number];
export const isWire = (v: unknown): v is Wire => typeof v === 'string' && (WIRES as readonly string[]).includes(v);

/** What a grader uses for a setting that is not stated, by wire. The OpenAI wire has no `apiVersion`. */
export const GRADER_DEFAULTS: Readonly<Record<Wire, Readonly<{ baseUrl: string; apiVersion?: string; timeoutMs: number }>>> = Object.freeze({
  [WIRE_ANTHROPIC]: Object.freeze({ baseUrl: 'https://api.anthropic.com', apiVersion: '2023-06-01', timeoutMs: 60000 }),
  [WIRE_OPENAI]: Object.freeze({ baseUrl: 'https://api.openai.com/v1', timeoutMs: 60000 }),
});
/**
 * The settings each grader reads and sends, by tool and wire (the key `wire` itself is looked at apart, as the grader looks
 * at it); any other key refuses at the grader and at the importer. The Inspect OpenAI list is the Python
 * grader's own (its `ALLOWED_MODEL_ARGS_OPENAI`), which a test holds equal to this one.
 */
export const GRADER_CONFIG_KEYS: Readonly<Record<ImportTool, Readonly<Record<Wire, readonly string[]>>>> = Object.freeze({
  promptfoo: Object.freeze({
    [WIRE_ANTHROPIC]: ['model', 'max_tokens', 'temperature', 'baseUrl', 'timeoutMs', 'apiVersion', 'apiKeyEnv', 'thinking', 'effort', 'maxReasks'],
    [WIRE_OPENAI]: ['model', 'max_output_tokens', 'temperature', 'baseUrl', 'timeoutMs', 'apiKeyEnv', 'effort', 'verbosity', 'maxReasks'],
  }),
  inspect: Object.freeze({
    [WIRE_ANTHROPIC]: ['timeout_ms', 'api_version', 'api_key_env', 'thinking', 'effort', 'max_reasks'],
    [WIRE_OPENAI]: ['timeout_ms', 'api_key_env', 'effort', 'verbosity', 'max_reasks'],
  }),
});
/** The environment variables that hold a gateway address for each wire; the first is the one the wire's other tools read first. */
export const GATEWAY_VARIABLES: Readonly<Record<Wire, readonly string[]>> = Object.freeze({
  [WIRE_ANTHROPIC]: ['ANTHROPIC_BASE_URL'],
  [WIRE_OPENAI]: ['OPENAI_BASE_URL', 'OPENAI_API_BASE_URL', 'OPENAI_API_HOST', 'OPENAI_HOST'],
});
/** The smallest output cap the OpenAI Responses API accepts. */
export const OPENAI_MIN_OUTPUT_TOKENS = 16;
/** The most re-asks a slot may be given: the stated bound is an integer from 0 to this. Each grader file holds the same number. */
export const REASK_CEILING = 3;
/**
 * The longest deadline of an ask, in ms: one hour. Each grader file holds the same number and refuses a larger one
 * before any call; a record that states a larger one was not written by the shipped graders.
 */
export const TIMEOUT_MS_CEILING = 3600000;
/**
 * The closed list of what an earlier ask of a slot can have ended in: four ways of getting no reply, and a reply cut
 * at the output cap. Each is one of the library's reasons for a judge attempt that measured nothing. A finished reply
 * is never on it, whatever the reply says.
 */
export const REASK_REASONS = ['timeout', 'transport', 'server-error', 'rate-limited', 'truncated'] as const;
export type ReaskReason = (typeof REASK_REASONS)[number];
/** What an ask that got no response records in place of a status. */
export const NO_RESPONSE = 'NO_RESPONSE';
/** The language each shipped grader file is written in, as its record says. */
export const GRADER_LANGUAGE: Readonly<Record<ImportTool, 'js' | 'python'>> = Object.freeze({ promptfoo: 'js', inspect: 'python' });

// ---------------------------------------------------------------------------------------------------------------
// Strict reading: UTF-8 only, no key given twice, counts
// ---------------------------------------------------------------------------------------------------------------

/**
 * The text of a file's bytes, which must be UTF-8 with no byte-order mark; or the reason they are not. This is the
 * library's own decoder (`utf8Text` in `src/identity.ts`) under the importers' name: one implementation, so that an
 * importer and the library cannot disagree on which bytes are text. The mark is kept by the decoder, so it is refused
 * by name in every file, and bytes that are not UTF-8 are never replaced.
 */
export function decodeUtf8(bytes: Uint8Array): { text: string } | { why: string } {
  const decoded = utf8Text(bytes);
  return 'problem' in decoded ? { why: decoded.problem } : decoded;
}

/**
 * The value of a JSON text in which no object holds a key twice and nothing is nested deeper than the library reads
 * (`MAX_JSON_DEPTH`, 128 objects and lists); or why the text is not one. `notJson` says which reason it is: the parser
 * refused the text, or the text is JSON and one of the two rules refuses it. The depth rule is what keeps every reader
 * below that walks a parsed value by recursion inside the call stack, so every JSON text an importer reads comes
 * through here. This is the library's own reader (`parseJsonText` in `src/identity.ts`) under the importers' names and
 * words: one implementation, so that an importer and the library cannot disagree on which text is a JSON value.
 */
export function parseJsonStrict(text: string): { value: unknown } | { why: string; notJson: boolean } {
  const read = parseJsonText(text);
  if ('json' in read) return { value: read.json };
  // The library opens a parser's message with "invalid JSON: "; the importers have always said "not JSON (<message>)".
  return read.notJson ? { why: `not JSON (${read.problem.slice(LIBRARY_NOT_JSON.length)})`, notJson: true } : { why: read.problem, notJson: false };
}
const LIBRARY_NOT_JSON = 'invalid JSON: ';

/**
 * Every string and every object key, at any depth of `value`, that holds an unpaired surrogate: the problems as the
 * library words them, each opening with its JSON path below `$`. A source file can spell such a string with an escape
 * (`"\ud800"`); the library has no hash for it, so a reader refuses the file instead of failing where the text is hashed.
 * The walk is the library's own (`findIllFormed`): one implementation.
 */
export function illFormedProblems(value: unknown): string[] {
  const found: string[] = [];
  findIllFormed(value, '$', found);
  return found;
}

/**
 * The text of a JSON input file of the user (a cases file, a bar): decoded by the one decoder, and refused as an
 * invalid input when an object in it holds a key twice. A text that is not JSON is handed on as it is: the parser of
 * the file says why, in its own words.
 */
export function inputJsonText(what: string, bytes: Uint8Array): string {
  const decoded = decodeUtf8(bytes);
  if ('why' in decoded) throw new ImportInputError([`${what}: ${decoded.why}`]);
  const parsed = parseJsonStrict(decoded.text);
  if ('why' in parsed && !parsed.notJson) throw new ImportInputError([`${what}: ${parsed.why}`]);
  return decoded.text;
}

/** A count: a safe integer from 1. */
export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

/**
 * The value of a flag that is a count: digits only, from 1. Anything else is a usage error that names the flag. With
 * `max`, a count beyond it is a usage error too: a caller that builds a list of that length states the most it takes.
 */
export function positiveIntFlag(flag: string, text: string, usage: string, max?: number): number {
  const n = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(n)) throw new ImportUsageError(`${flag} must be a positive integer, found ${JSON.stringify(text)}. ${usage}`);
  if (max !== undefined && n > max) throw new ImportUsageError(`${flag} must be at most ${max}, found ${text}. ${usage}`);
  return n;
}

/** Whether the module at `moduleUrl` is the script node was started with (`argv1`), through symbolic links. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The source file
// ---------------------------------------------------------------------------------------------------------------

/**
 * Why a grader that is about to be called must not be: the environment variable ANTHROPIC_BASE_URL is set (a gateway the
 * user's other tools honour), and the recording graders never read it, so with no base URL stated, or another one, the
 * key in the key variable (which may be the gateway's credential) would go to the public host. Undefined when the variable
 * is not set or is empty (as an empty key variable is not set), or when the base URL stated is exactly the variable's.
 * The variable is named and its value never is.
 */
export function gatewayVariableProblem(envValue: string | undefined, statedBaseUrl: string | undefined, variable: string): string | undefined {
  if (envValue === undefined || envValue === '') return undefined;
  if (statedBaseUrl === envValue) return undefined;
  const how = statedBaseUrl === undefined ? 'no base URL was stated, so the grader would use its default' : 'the base URL stated differs from it';
  return `the environment variable ${variable} is set, and this grader never reads it: ${how}, and the key would go there instead of to the address your other tools use. ${variable.endsWith('_HOST') ? 'Unset the variable.' : 'State the same address with --base-url, or unset the variable.'} Nothing was written and no call was made.`;
}

/** The first gateway-variable problem of a wire over an environment (all of the wire's variables are looked at), or undefined. */
export function gatewayProblemFor(wire: Wire, env: Readonly<Record<string, string | undefined>>, statedBaseUrl: string | undefined): string | undefined {
  for (const name of GATEWAY_VARIABLES[wire]) {
    const problem = gatewayVariableProblem(env[name], statedBaseUrl, name);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** The text each bare `NaN` of an Inspect log is read as, so that the log can be parsed and the samples that hold one found. */
const BARE_NAN_MARK = '\u0000anchorset: bare NaN';

/**
 * `text` with every bare `NaN` token outside a JSON string replaced by a JSON string that is `BARE_NAN_MARK`. One pass over
 * the character codes, no pattern and no per-character string building: a string (with its escapes) is stepped over whole,
 * and the pieces between the marks are joined once, so a large log is read in one sweep and cannot overflow a regex stack.
 */
function markBareNaNs(text: string): { text: string; count: number } {
  const marker = JSON.stringify(BARE_NAN_MARK);
  const isWord = (c: string | undefined): boolean => c !== undefined && /[\w"]/.test(c);
  const pieces: string[] = [];
  let kept = 0;
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      i++;
      while (i < text.length && text.charCodeAt(i) !== 0x22) i += text.charCodeAt(i) === 0x5c ? 2 : 1;
      i++;
    } else if (c === 0x4e && text.startsWith('NaN', i) && !isWord(text[i - 1]) && !isWord(text[i + 3])) {
      pieces.push(text.slice(kept, i), marker);
      count++;
      i += 3;
      kept = i;
    } else {
      i++;
    }
  }
  pieces.push(text.slice(kept));
  return { text: pieces.join(''), count };
}

const holdsMark = (v: unknown): boolean => (v === BARE_NAN_MARK ? true : Array.isArray(v) ? v.some(holdsMark) : isObject(v) ? Object.values(v).some(holdsMark) : false);
/** How many times the marker text stands in a parsed value, as a string or as an object key's value. */
const countMarks = (v: unknown): number => (v === BARE_NAN_MARK ? 1 : Array.isArray(v) ? v.reduce((n: number, x) => n + countMarks(x), 0) : isObject(v) ? Object.values(v).reduce((n: number, x) => n + countMarks(x), 0) : 0);

/**
 * The slots (`<case>#<draw>`, from each sample's `id` and `epoch`) of the samples of an Inspect log that hold a bare NaN
 * under their `scores`, which the tool writes as the score of a grade it could not read. Empty when the log is not JSON for another reason as well
 * (a key given twice, a text that stops short), when it has no `samples` array, or when no sample holds a NaN: the caller
 * then reports the file as it did before.
 */
function ungradedSlotsOfNaNLog(text: string): { caseId: string; draw: number; reason: string }[] {
  const { text: markedText, count } = markBareNaNs(text);
  const marked = parseJsonStrict(markedText);
  if ('why' in marked || !isObject(marked.value) || !Array.isArray(marked.value['samples'])) return [];
  // A text that held the marker's own words as a string (spelled any way JSON allows) cannot be told from a NaN it replaced: the number of
  // marks found must equal the number of NaNs that were replaced, or nothing is claimed about any sample.
  if (countMarks(marked.value) !== count) return [];
  const reason = 'the log holds a bare NaN as the score of this sample, which the tool writes for a grade it could not read';
  return marked.value['samples'].flatMap((s, i) => {
    // Only the sample's own `scores` count: a NaN anywhere else in a sample (its metadata, its events) is not its grade.
    if (!holdsMark(isObject(s) ? s['scores'] : undefined)) return [];
    const id = isObject(s) ? s['id'] : undefined;
    const epoch = isObject(s) ? s['epoch'] : undefined;
    const named = (typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isSafeInteger(id));
    return typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 1 && named ? [{ caseId: String(id), draw: epoch - 1, reason }] : [{ caseId: `/samples/${i}`, draw: -1, reason }];
  });
}

/**
 * Parses a tool's result file with `JSON.parse` and nothing else. A zip, a `.jsonl` file, a bare `NaN`, any
 * other text that is not JSON, and a JSON text with an object that holds a key twice (at any depth) is `IMPORT_SHAPE`. Returns the parsed value and the sha256 of the bytes.
 */
export function parseSourceFile(bytes: Uint8Array, fileName: string, tool: ImportTool): { json: unknown; sha256: string } {
  const sha256 = sha256Hex(bytes);
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: this is the packed log format; write the log with examples/importers/inspect/regrade.py, or convert it with the tool's own command`);
  }
  if (fileName.toLowerCase().endsWith('.jsonl')) {
    throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: a .jsonl file has no runtime options or metadata and cannot be imported; use the ${tool} .json result file`);
  }
  // The one decoder: a byte-order mark is refused by name, as in a cases file, and bytes that are not UTF-8 are not replaced.
  const decoded = decodeUtf8(bytes);
  if ('why' in decoded) throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: ${decoded.why}`);
  const text = decoded.text;
  // The one strict reader. `JSON.parse` keeps the last of two equal keys without a word, and a reader below would
  // overflow the stack on a text nested without end; a file that holds either is refused.
  const read = parseJsonStrict(text);
  if ('why' in read) {
    // A log with a bare NaN is not JSON. The tool writes one for a grade it could not read, so the samples that hold one are
    // the ungraded slots: they are found by reading the log again with each NaN as a marker text, and refused by name.
    if (read.notJson && tool === 'inspect') {
      const slots = ungradedSlotsOfNaNLog(text);
      if (slots.length > 0) throw ungradedRefusal(slots);
    }
    const nan = read.notJson && tool === 'inspect' && /(?<![\w"])NaN(?![\w"])/.test(text) ? '; the file holds a bare NaN, which this tool writes for a grade it could not read; such a log cannot be imported' : '';
    throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: ${read.why}${nan}`);
  }
  // A text with an unpaired surrogate has no hash, wherever in the file it stands: a stored output, a prompt, a key.
  const illFormed = illFormedProblems(read.value);
  if (illFormed.length > 0) throw new ImportRefusal('IMPORT_SHAPE', illFormed.map(problemField), illFormed.map((p) => `${fileName}: ${p}`).join('; '));
  return { json: read.value, sha256 };
}

// ---------------------------------------------------------------------------------------------------------------
// The tool versions the importers were tested on
// ---------------------------------------------------------------------------------------------------------------

/** The one list of tested tool versions. The two importers, `regrade.py` and `grader-provider.cjs` read it, and no other copy of a version stands in code. */
export const TESTED_VERSIONS_SCHEMA = 'example.tested-versions/v1';
const TESTED_VERSIONS_NAME = 'examples/importers/tested-versions.json';
export type TestedTool = 'inspect_ai' | 'promptfoo';
const TESTED_TOOLS: readonly TestedTool[] = ['inspect_ai', 'promptfoo'];
const TESTED_ENTRY_KEYS = ['version', 'testedOn', 'fixtures', 'badFixtures', 'runtimes', 'gradingPathRead'];
export type TestedEntry = { version: string; testedOn: string; fixtures: string; badFixtures: string; runtimes: string; gradingPathRead: string };
export type TestedSet = { tool: TestedTool; format: number; entries: readonly TestedEntry[]; versions: readonly string[] };

/** The list is a short file: all three readers refuse one over this many bytes. */
const TESTED_VERSIONS_MAX_BYTES = 1024 * 1024;

/** A real calendar date, written YYYY-MM-DD, in the years 0001 to 9999. The same arithmetic stands in the two other readers. */
function isCalendarDate(s: string): boolean {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] as number);
}

/** True when every value of a key `format` is written as a plain positive whole number: `2.0` and `2e0` parse to 2, and the parsed value cannot tell them from it. */
function formatsWrittenPlainly(text: string): boolean {
  let plain = true;
  JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (key === 'format' && typeof value === 'number' && !/^[1-9][0-9]*$/.test(context?.source ?? '')) plain = false;
    return value;
  });
  return plain;
}

/** One tool's tested set, from the file's bytes. Anything malformed, in any tool's part of the file, refuses: `IMPORT_SHAPE`. */
export function parseTestedVersions(bytes: Uint8Array, tool: TestedTool): TestedSet {
  const bad = (what: string): ImportRefusal => new ImportRefusal('IMPORT_SHAPE', [TESTED_VERSIONS_NAME], `${TESTED_VERSIONS_NAME}: ${what}`);
  if (bytes.length > TESTED_VERSIONS_MAX_BYTES) throw bad(`must not be over ${TESTED_VERSIONS_MAX_BYTES} bytes`);
  const decoded = utf8Text(bytes);
  if ('problem' in decoded) throw bad(decoded.problem);
  const text = decoded.text;
  const read = parseJsonStrict(text);
  if ('why' in read) throw bad(read.why);
  const root = read.value;
  const illFormed = illFormedProblems(root);
  if (illFormed.length > 0) throw bad(illFormed.join('; '));
  if (!formatsWrittenPlainly(text)) throw bad('a format must be written as a plain positive whole number');
  if (!isObject(root) || Object.keys(root).sort().join() !== 'schema,tools') throw bad('must be an object with exactly the keys schema and tools');
  if (root['schema'] !== TESTED_VERSIONS_SCHEMA) throw bad(`schema must be ${TESTED_VERSIONS_SCHEMA}`);
  const tools = root['tools'];
  if (!isObject(tools) || Object.keys(tools).sort().join() !== [...TESTED_TOOLS].sort().join()) throw bad(`tools must hold exactly ${TESTED_TOOLS.join(' and ')}`);
  let chosen: TestedSet | undefined;
  for (const name of TESTED_TOOLS) {
    const t = tools[name];
    if (!isObject(t) || Object.keys(t).sort().join() !== 'format,versions') throw bad(`${name} must hold exactly format and versions`);
    const format = t['format'];
    if (typeof format !== 'number' || !Number.isSafeInteger(format) || format < 1) throw bad(`${name}.format must be a positive integer`);
    const list = t['versions'];
    if (!Array.isArray(list) || list.length === 0) throw bad(`${name}.versions must be a non-empty list`);
    const entries = list.map((e: unknown, i: number): TestedEntry => {
      const at = `${name}.versions[${i}]`;
      if (!isObject(e) || Object.keys(e).sort().join() !== [...TESTED_ENTRY_KEYS].sort().join()) throw bad(`${at} must hold exactly ${TESTED_ENTRY_KEYS.join(', ')}`);
      for (const k of TESTED_ENTRY_KEYS) if (typeof e[k] !== 'string' || (e[k] as string).trim() === '') throw bad(`${at}.${k} must be a non-empty string`);
      if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(e['version'] as string)) throw bad(`${at}.version is not a version`);
      if (!isCalendarDate(e['testedOn'] as string)) throw bad(`${at}.testedOn must be a real date, YYYY-MM-DD`);
      return e as TestedEntry;
    });
    const versions = entries.map((e) => e.version);
    if (new Set(versions).size !== versions.length) throw bad(`${name}.versions lists a version twice`);
    if (name === tool) chosen = { tool: name, format, entries, versions };
  }
  return chosen as TestedSet;
}

/** One tool's tested set, read from the file beside this one. */
export function loadTestedVersions(tool: TestedTool): TestedSet {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(new URL('./tested-versions.json', import.meta.url));
  } catch (e) {
    throw new ImportRefusal('IMPORT_SHAPE', [TESTED_VERSIONS_NAME], `${TESTED_VERSIONS_NAME}: cannot be read (${(e as Error).name})`);
  }
  return parseTestedVersions(bytes, tool);
}

/**
 * The refusal of a JSON-lines file in which a line holds a string or an object key with an unpaired surrogate, anywhere
 * in the line: `IMPORT_SHAPE`, every such line in `fields` as `file:line`, every place in the message by its JSON path.
 * Undefined when no line holds one.
 */
export function illFormedLineRefusal(lines: readonly unknown[], fileName: string): ImportRefusal | undefined {
  const found = lines.flatMap((value, i) => illFormedProblems(value).map((why) => ({ at: `${fileName}:${i + 1}`, why })));
  return found.length === 0 ? undefined : new ImportRefusal('IMPORT_SHAPE', [...new Set(found.map((f) => f.at))], found.map((f) => `${f.at}: ${f.why}`).join('; '));
}

/**
 * Reads a JSON-lines source: every line is one JSON value, each line ends with a line feed (so a torn last line is
 * refused), no line is empty, no line holds a carriage return or opens with white space, no object on a line holds a
 * key twice, and the bytes are UTF-8 with no byte-order mark. A zip is refused as `parseSourceFile`
 * refuses it. The file must hold at least one grader record: a line that is a record (its `schema` is a version of
 * the record's) or that has an object `graderEvidence`. A file with none, such as a plain results file, is
 * `IMPORT_NO_RECORD`, with `rerun` as the instruction when given. The records are not validated here (`parseRecord`).
 * `parseSourceFile` still refuses every `.jsonl` name.
 *
 * A line that holds an unpaired surrogate, in any string or key, is `IMPORT_SHAPE` (`illFormedLineRefusal`), checked
 * before the file is said to hold no record. A caller that names such a text more closely itself (its row, its
 * field, its slot) says `'refused by the caller'`, and must then refuse by `illFormedLineRefusal` whatever its own
 * checks let through: no path may reach a hash with such a text.
 */
export function parseJsonlSourceFile(bytes: Uint8Array, fileName: string, rerun?: string, surrogates: 'refused here' | 'refused by the caller' = 'refused here'): { lines: unknown[]; sha256: string } {
  checkInstruction(rerun);
  const sha256 = sha256Hex(bytes);
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: this is a packed (zip) file, not JSON lines`);
  }
  const decoded = decodeUtf8(bytes);
  if ('why' in decoded) throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: ${decoded.why}`);
  const text = decoded.text;
  const lines: unknown[] = [];
  const twice: { at: string; why: string }[] = [];
  if (text !== '') {
    if (!text.endsWith('\n')) throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: the last line does not end with a line feed (a torn file)`);
    const raw = text.slice(0, -1).split('\n');
    raw.forEach((line, i) => {
      if (line === '') throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: line ${i + 1} is empty`);
      // The place of a refusal below is `file:line`. A raw carriage return cannot stand inside a JSON string, so one anywhere is a line that does not end with a line feed alone.
      const at = `${fileName}:${i + 1}`;
      if (line.includes('\r')) throw new ImportRefusal('IMPORT_SHAPE', [at], `${at}: the line ends with a carriage return; every line ends with a line feed alone`);
      if (/^[ \t]/.test(line)) throw new ImportRefusal('IMPORT_SHAPE', [at], `${at}: the line starts with white space; a line starts with its JSON value`);
      const read = parseJsonStrict(line);
      if ('why' in read) {
        if (read.notJson) throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: line ${i + 1} is ${read.why}`);
        // Every line that holds a key twice is named, not the first only.
        twice.push({ at, why: read.why });
        lines.push(undefined);
        return;
      }
      lines.push(read.value);
    });
  }
  if (twice.length > 0) throw new ImportRefusal('IMPORT_SHAPE', twice.map((t) => t.at), twice.map((t) => `${t.at}: ${t.why}`).join('; '));
  if (surrogates === 'refused here') {
    const illFormed = illFormedLineRefusal(lines, fileName);
    if (illFormed !== undefined) throw illFormed;
  }
  const holdsRecord = (v: unknown): boolean => isObject(v) && ((typeof v['schema'] === 'string' && v['schema'].startsWith(RECORD_SCHEMA_PREFIX)) || isObject(v['graderEvidence']));
  if (!lines.some(holdsRecord)) throw noRecordRefusal('promptfoo', fileName, rerun);
  return { lines, sha256 };
}

// ---------------------------------------------------------------------------------------------------------------
// The stop map (closed)
// ---------------------------------------------------------------------------------------------------------------

/** The one raw stop reason of each wire that maps to a completing stop. Every other word refuses the file. */
export const STOP_MAP: Readonly<Record<Wire, Readonly<Record<string, 'end'>>>> = Object.freeze({
  [WIRE_ANTHROPIC]: Object.freeze({ end_turn: 'end' as const }),
  [WIRE_OPENAI]: Object.freeze({ completed: 'end' as const }),
});
/**
 * What an OpenAI `incomplete` response maps to, by its reason. `max_output_tokens` is a cut (asked again within the bound,
 * else ungraded); `content_filter` maps to the library's `content-filter` stop and is final. Any other reason has no mapping.
 */
export const OPENAI_INCOMPLETE_MAP: Readonly<Record<string, 'cut' | 'content-filter'>> = Object.freeze({ max_output_tokens: 'cut', content_filter: 'content-filter' });

/**
 * The library's judge stop for a recorded stop, by wire, or undefined when it is not one a finished reply has. On the
 * Anthropic wire `end_turn` maps to `end`. On the OpenAI wire `completed` maps to `end` (with no tools and no stop sequences
 * sent, it is the natural end), and `incomplete` with `content_filter` maps to `content-filter`. A cut (`max_tokens`; `incomplete`
 * with `max_output_tokens`) has no judge stop here: it is asked again, or ungraded. The two wires' `end` is one mapped value
 * for two different events.
 */
export function judgeStopOf(wire: Wire, stopReason: string, incompleteReason?: string): 'end' | 'content-filter' | undefined {
  const table = STOP_MAP[wire];
  if (Object.hasOwn(table, stopReason)) return table[stopReason];
  if (wire === WIRE_OPENAI && stopReason === 'incomplete' && incompleteReason !== undefined && Object.hasOwn(OPENAI_INCOMPLETE_MAP, incompleteReason) && OPENAI_INCOMPLETE_MAP[incompleteReason] === 'content-filter') return 'content-filter';
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The recording grader's record (docs/IMPORTERS.md)
// ---------------------------------------------------------------------------------------------------------------

export const RECORD_SCHEMA = 'example.grader-evidence/v8';
const RECORD_SCHEMA_PREFIX = 'example.grader-evidence/';
/** The version before the record named its wire. A record of it is refused with the instruction to grade again, not as "no record" and not read as Anthropic. */
export const RECORD_SCHEMA_PREVIOUS = 'example.grader-evidence/v7';
/** The earlier versions of the record: each is refused with the instruction to re-grade, not as "no record". */
/** Every version number below the current one, v1 included: whether it was ever committed does not matter, a record of it is not "no record". */
function isEarlierRecordSchema(schema: string): boolean {
  const m = /^example\.grader-evidence\/v([1-9][0-9]*)$/.exec(schema);
  return m !== null && Number(m[1]) < Number(RECORD_SCHEMA.slice(RECORD_SCHEMA.lastIndexOf('/v') + 2));
}

/** The first named rule: the reply is one JSON object with a boolean `pass`. */
export const READING_JSON_OBJECT = 'one-json-object-boolean-pass/v1';
/** The second named rule: that object bare, or inside exactly one `json` code fence. */
export const READING_JSON_OBJECT_OR_FENCE = 'one-json-object-boolean-pass-or-json-fence/v1';
/** The two named rules by which a promptfoo reply is read. The importer is told one (`--reading`); no grader records it. */
export const READINGS = [READING_JSON_OBJECT, READING_JSON_OBJECT_OR_FENCE] as const;
export type Reading = (typeof READINGS)[number];

/** The request's top-level `thinking`, as the graders send it: one of these objects, or NOT_SENT. */
export type ThinkingSent = typeof NOT_SENT | { type: 'adaptive' } | { type: 'between_tools' } | { type: 'disabled' } | { type: 'enabled'; budget_tokens: number };
/** The request's `output_config`, as the graders send it: `{ effort }` or NOT_SENT. */
export type OutputConfigSent = typeof NOT_SENT | { effort: string };
/** The efforts the graders send; the library's list holds two more words, `none` and `minimal`, which are not sent. */
export const SENT_EFFORTS = EFFORTS.filter((e) => e !== 'none' && e !== 'minimal');

/** The token usage of one response as it stated it, or ABSENT when it stated neither counter. */
export type RecordedUsage = 'ABSENT' | { input_tokens: number; output_tokens: number };
/** An ask of a slot before its last one, in one of two closed forms told apart by `reason`. */
export type EarlierAsk =
  /** No reply: a passed deadline or a failed connection (`httpStatus` is NO_RESPONSE), a status 5xx, a status 429. */
  | { reason: 'timeout' | 'transport' | 'server-error' | 'rate-limited'; callSeq: number; callId: string; httpStatus: number | typeof NO_RESPONSE; detail: string }
  /**
   * A reply cut at the output cap. Its text is not in the record; the sha256 of that text (the text blocks joined, as
   * UTF-8) and the number of its UTF-8 bytes are, so that one cut reply can be told from another, and an empty one
   * from one that held text.
   */
  | { reason: 'truncated'; callSeq: number; callId: string; httpStatus: 200; responseId: string; servedModel: string; stopReason: string; incompleteReason?: string; contentTypes: string[]; thinkingTokens: number | 'ABSENT'; usage: RecordedUsage; replySha256: string; replyUtf8Bytes: number };

/**
 * The record of one slot. Every key but `reask` describes the slot's LAST ask, which is the one the tool saw;
 * `reask.earlier` lists the asks before it, in the order made. `sent`, `promptSha256` and `callShape` are stated once:
 * every ask of a slot sent the same request.
 *
 * `promptSha256` is the sha256 of the prompt as the tool handed it to the grader, so what it is over depends on the
 * tool. promptfoo (and the re-grade script of skill-evals, which calls the same grader) hands one text, the JSON text
 * of a message list, and the hash is over that text. Inspect hands one user message and no such text, and the hash is
 * over that message's content, equal to `sent.user`. Each importer checks the field against its own source file only;
 * nothing compares it between two records, and it is not written into a run file.
 */
type RecordCommon = {
  schema: typeof RECORD_SCHEMA;
  grader: { name: string; language: 'js' | 'python'; sha256: string; runtime: string };
  graderRunId: string;
  callSeq: number;
  callId: string;
  promptSha256: string;
  requestedModel: string;
  servedModel: string;
  responseId: string;
  stopReason: string;
  contentTypes: string[];
  thinkingTokens: number | 'ABSENT';
  usage: RecordedUsage;
  reply: string;
  callShape: Record<string, unknown>;
  reask: { max: number; earlier: EarlierAsk[] };
};
/** An Anthropic record is the version 7 record plus `schema` v8 and `wire`. */
export type AnthropicRecord = RecordCommon & {
  wire: typeof WIRE_ANTHROPIC;
  sent: { system: string; user: string; thinking: ThinkingSent; output_config: OutputConfigSent };
};
/** The request's `reasoning`, as the OpenAI grader sends it: `{ effort }` or NOT_SENT. */
export type ReasoningSent = typeof NOT_SENT | { effort: string };
/** The request's `text`, as the OpenAI grader sends it: `{ verbosity }` or NOT_SENT. */
export type TextSent = typeof NOT_SENT | { verbosity: string };
/**
 * An OpenAI record has its own closed set of keys: `sent` holds `reasoning`, `text`, `store` and `truncation` in place of
 * `thinking` and `output_config`, and `incompleteReason` is the response's `incomplete_details.reason`, or "ABSENT" with `completed`.
 */
export type OpenAIRecord = RecordCommon & {
  wire: typeof WIRE_OPENAI;
  sent: { system: string; user: string; reasoning: ReasoningSent; text: TextSent; store: false; truncation: 'disabled' };
  incompleteReason: string;
};
export type GraderRecord = AnthropicRecord | OpenAIRecord;

/** The call-shape keys the recording graders never send. */
const NOT_SENT_KEYS = ['toolChoice', 'toolChoiceName', 'strictTools', 'parallelToolUse', 'stopSequences', 'responseFormat', 'stream', 'betaFlags', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty', 'samplingSeed'];

const RECORD_KEYS_ANTHROPIC = ['schema', 'wire', 'grader', 'graderRunId', 'callSeq', 'callId', 'promptSha256', 'sent', 'requestedModel', 'servedModel', 'responseId', 'stopReason', 'contentTypes', 'thinkingTokens', 'usage', 'reply', 'callShape', 'reask'];
const RECORD_KEYS_OPENAI = ['schema', 'wire', 'grader', 'graderRunId', 'callSeq', 'callId', 'promptSha256', 'sent', 'requestedModel', 'servedModel', 'responseId', 'stopReason', 'incompleteReason', 'contentTypes', 'thinkingTokens', 'usage', 'reply', 'callShape', 'reask'];
/** The keys of an earlier ask that got no reply, and of one whose reply was cut, as the graders write them. */
const NO_REPLY_ASK_KEYS = ['reason', 'callSeq', 'callId', 'httpStatus', 'detail'];
const CUT_ASK_KEYS_ANTHROPIC = ['reason', 'callSeq', 'callId', 'httpStatus', 'responseId', 'servedModel', 'stopReason', 'contentTypes', 'thinkingTokens', 'usage', 'replySha256', 'replyUtf8Bytes'];
/** An earlier cut ask of the OpenAI wire also states why the response was incomplete (the reply is cut only for `max_output_tokens`). */
const CUT_ASK_KEYS_OPENAI = ['reason', 'callSeq', 'callId', 'httpStatus', 'responseId', 'servedModel', 'stopReason', 'incompleteReason', 'contentTypes', 'thinkingTokens', 'usage', 'replySha256', 'replyUtf8Bytes'];
const CUT_ASK_KEYS: Readonly<Record<Wire, readonly string[]>> = { [WIRE_ANTHROPIC]: CUT_ASK_KEYS_ANTHROPIC, [WIRE_OPENAI]: CUT_ASK_KEYS_OPENAI };
const EARLIER_ASK_KEYS = [...new Set([...NO_REPLY_ASK_KEYS, ...CUT_ASK_KEYS_ANTHROPIC, ...CUT_ASK_KEYS_OPENAI])];
/** The raw stop of a reply cut at the output cap: the one stop (the Anthropic wire) after which a slot is asked again. */
const CUT_STOP = 'max_tokens';
/** The OpenAI cut: the status "incomplete" with exactly this reason. */
const OPENAI_CUT_STATUS = 'incomplete';
const OPENAI_CUT_REASON = 'max_output_tokens';
/** The two statuses the OpenAI grader records. */
const OPENAI_STATUSES: readonly string[] = ['completed', 'incomplete'];
/** The words the OpenAI grader records for an `incomplete_details.reason` that a `completed` response lacks. */
const INCOMPLETE_ABSENT = 'ABSENT';
/** Whether a recorded stop is a cut at the output cap on a wire (a stop for the Anthropic wire; a status and a reason for the OpenAI wire). */
export function isCutStop(wire: Wire, stopReason: string, incompleteReason: string | undefined): boolean {
  return wire === WIRE_OPENAI ? stopReason === OPENAI_CUT_STATUS && incompleteReason === OPENAI_CUT_REASON : stopReason === CUT_STOP;
}

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isCounter = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** Whether a value is a recorded usage: ABSENT, or exactly the two counters. */
const isRecordedUsage = (v: unknown): boolean => v === 'ABSENT' || (isObject(v) && Object.keys(v).sort().join() === 'input_tokens,output_tokens' && isCounter(v['input_tokens']) && isCounter(v['output_tokens']));
const USAGE_FORM = 'must be { "input_tokens": <non-negative integer>, "output_tokens": <non-negative integer> } with no other key, or "ABSENT" when the response stated neither';
const THINKING_TOKENS_FORM = 'must be a non-negative integer, or "ABSENT" when the response had no counter';
/**
 * A call id, a response id and a served model id are copied into an attempt's `detail` or into a run's identity, and
 * printed from there: each is held to visible ASCII with no space, at most 200 characters, so that none can carry a
 * line feed or another control character into a report.
 */
const isPlainId = (v: unknown): boolean => typeof v === 'string' && /^[\x21-\x7e]{1,200}$/.test(v);
const PLAIN_ID_FORM = 'must be 1 to 200 visible ASCII characters with no space (no control character, no line feed)';
/** The sha256 of the empty text: what a cut reply of no bytes hashes to. */
const EMPTY_TEXT_SHA256 = sha256Hex('');

/** A setting of a config or of model arguments as it reads in a message: its JSON, or "not set" when the key is not there (a `null` is shown as null). */
export function shown(o: Record<string, unknown>, key: string): string {
  return Object.hasOwn(o, key) ? JSON.stringify(o[key]) : JSON.stringify('not set');
}

/**
 * What the call shape says for a `thinking` value of the closed forms, or undefined when the value is none of them.
 * `disabled` is "off", `enabled` is "budgeted", `between_tools` is "between-tools".
 */
export function thinkingShapeOf(v: unknown): { mode: string; budget: number | typeof NOT_SENT } | undefined {
  if (v === NOT_SENT) return { mode: NOT_SENT, budget: NOT_SENT };
  if (!isObject(v)) return undefined;
  const keys = Object.keys(v).sort().join();
  const type = v['type'];
  if (keys === 'type') {
    if (type === 'adaptive') return { mode: 'adaptive', budget: NOT_SENT };
    if (type === 'between_tools') return { mode: 'between-tools', budget: NOT_SENT };
    if (type === 'disabled') return { mode: 'off', budget: NOT_SENT };
    return undefined;
  }
  const budget = v['budget_tokens'];
  if (keys === 'budget_tokens,type' && type === 'enabled' && typeof budget === 'number' && Number.isSafeInteger(budget) && budget > 0) return { mode: 'budgeted', budget };
  return undefined;
}

/** The call shape's `effort` for an `output_config` of the closed forms, or undefined when it is none of them. */
export function effortShapeOf(v: unknown): string | undefined {
  if (v === NOT_SENT) return NOT_SENT;
  if (!isObject(v) || Object.keys(v).join() !== 'effort') return undefined;
  const e = v['effort'];
  return typeof e === 'string' && (SENT_EFFORTS as readonly string[]).includes(e) ? e : undefined;
}

/** The call shape's `effort` for a `reasoning` value of the OpenAI wire's closed forms (NOT_SENT, or `{ effort }` with one of the seven words), or undefined. */
export function reasoningEffortOf(v: unknown): string | undefined {
  if (v === NOT_SENT) return NOT_SENT;
  if (!isObject(v) || Object.keys(v).join() !== 'effort') return undefined;
  const e = v['effort'];
  return typeof e === 'string' && (EFFORTS as readonly string[]).includes(e) ? e : undefined;
}

/** The words of `text.verbosity` the OpenAI grader sends. */
export const VERBOSITIES = ['low', 'medium', 'high'] as const;

/** The verbosity a `text` value of the OpenAI wire's closed forms states (NOT_SENT, or `{ verbosity }` with one of three words), or undefined when it is none of them. */
export function verbosityOf(v: unknown): string | undefined {
  if (v === NOT_SENT) return NOT_SENT;
  if (!isObject(v) || Object.keys(v).join() !== 'verbosity') return undefined;
  const e = v['verbosity'];
  return typeof e === 'string' && (VERBOSITIES as readonly string[]).includes(e) ? e : undefined;
}

/** Nulls, non-finite numbers, integers beyond 2^53 and values JSON does not hold (a hole of a list among them), anywhere in a value. */
export function valueTypeProblems(v: unknown, path: string, out: string[]): void {
  if (v === null) out.push(`${path}: null is not allowed`);
  else if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(`${path}: must be a finite number`);
    else if (Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) out.push(`${path}: integer beyond 2^53`);
  } else if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') out.push(`${path}: unsupported value type`);
  else if (Array.isArray(v)) {
    // By index: a hole of a list reads as undefined, which JSON would write as null.
    for (let i = 0; i < v.length; i++) valueTypeProblems(v[i], `${path}[${i}]`, out);
  } else if (isObject(v)) for (const [k, x] of Object.entries(v)) valueTypeProblems(x, `${path}.${k}`, out);
}

/** Why a base URL or endpoint is not acceptable (user information, a query, a fragment), or undefined. */
export function endpointProblem(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string' || endpoint === '') return 'must be a non-empty string';
  if (endpoint.includes('?') || endpoint.includes('#')) return 'holds a query or a fragment';
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return 'is not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'is not http or https';
  if (u.username !== '' || u.password !== '' || /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(endpoint)) return 'holds user information';
  return undefined;
}

/**
 * The hosts the graders take plain http for, and the form of the name of the variable that holds its key: the grader file's own two constants.
 * The hosts are the two literal loopback addresses. The name `localhost` is not one: it is whatever the machine's resolver says it is.
 */
export const GRADER_LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', '[::1]']);
export const GRADER_KEY_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The host of a base URL, as the graders hold it: the grader files' own three forms and their `plainHost`.
const GRADER_HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const GRADER_IPV4_PART = /^(0|[1-9][0-9]{0,2})$/;
const GRADER_PORT_FORM = /^[1-9][0-9]{0,4}$/;

function graderPlainHost(host: string): boolean {
  if (host === '[::1]') return true;
  if (host.length > 253) return false;
  const labels = host.split('.');
  if (labels.every((l) => /^[0-9]+$/.test(l))) return labels.length === 4 && labels.every((l) => GRADER_IPV4_PART.test(l) && Number(l) <= 255);
  return labels.every((l) => GRADER_HOST_LABEL.test(l) && l.slice(2, 4) !== '--') && /^[a-z]/.test(labels[labels.length - 1]!);
}

/**
 * Why the graders refuse a base URL when they are built (`parseBaseUrl` in `promptfoo/grader-provider.cjs`,
 * `parse_base_url` in `inspect/recording_grader.py`), or undefined for one they take. The address must be one a URL
 * parser leaves as written: everything `endpointProblem` names is refused, and so is white space, an "@" or a
 * backslash anywhere; an address that is not written as a scheme, "//", a host and a path; a scheme that is not
 * `https` or `http` in lower case; a host that is not a name of lower-case labels (letters, digits and hyphens, the
 * last one opening with a letter), four decimal numbers with dots, or `[::1]`; a port that is not 1 to 65535 with no
 * leading zero, or that is the scheme's own; plain http to a host that is not `127.0.0.1` or `[::1]`; a path that is not
 * plain segments (letters, digits, ".", "_", "~" and "-", no "." or ".." segment, no empty one; closing slashes are
 * dropped); and an address the platform's parser would write in another way. A grader that ran was built, so a
 * configuration that holds such a URL is not the one of the grader that wrote the record. The URL is never in the
 * words: it may hold a credential.
 */
export function graderBaseUrlProblem(baseUrl: unknown): string | undefined {
  const general = endpointProblem(baseUrl);
  if (general !== undefined) return general;
  const url = baseUrl as string;
  if (/[ \t\n\r\f\v@\\]/.test(url)) return 'holds white space, an "@" or a backslash';
  const plain = 'is not written in its plain form';
  const written = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]+)(\/[^]*)?$/.exec(url);
  if (written === null) return 'is not a URL';
  const scheme = written[1]!;
  const authority = written[2]!;
  if (scheme !== 'https' && scheme !== 'http') return plain;
  // The port is what follows the first colon outside the brackets of [::1].
  const colon = authority.startsWith('[') ? authority.indexOf(':', authority.indexOf(']') + 1) : authority.indexOf(':');
  const host = colon === -1 ? authority : authority.slice(0, colon);
  if (!graderPlainHost(host)) return plain;
  if (colon !== -1) {
    const port = authority.slice(colon + 1);
    if (!GRADER_PORT_FORM.test(port) || Number(port) > 65535 || Number(port) === (scheme === 'https' ? 443 : 80)) return plain;
  }
  if (scheme === 'http' && !GRADER_LOOPBACK_HOSTS.includes(host)) return 'is plain http to a host that is not 127.0.0.1 or [::1]';
  const writtenPath = written[3] ?? '';
  const path = writtenPath.replace(/\/+$/, '');
  if (path !== '' && (!/^(\/[A-Za-z0-9._~-]+)+$/.test(path) || path.split('/').some((s) => s === '.' || s === '..'))) return 'has a path that is not plain segments';
  const u = new URL(url);
  if (!/^[\x21-\x7e]+$/.test(url) || u.href !== (writtenPath === '' ? `${url}/` : url) || u.origin !== `${scheme}://${authority}`) return plain;
  return undefined;
}

/** `value` a non-empty string that does not read as a gap and is not NOT_SENT. */
function knownString(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '' && !readsAsGap(v) && v !== NOT_SENT;
}

/** The longest a free-text field of a record may be. */
export const RECORD_LINE_MAX = 200;
const PRINTABLE_LINE = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
/** The form every free-text field of a record is held to, in the words of a refusal. */
export const PRINTABLE_LINE_FORM = `one printable line: visible ASCII, single spaces between words, at most ${RECORD_LINE_MAX} characters`;
/**
 * Whether a string is one printable line: visible ASCII (no line feed, no carriage return, no control or escape
 * character, no tab, nothing outside ASCII), single spaces between runs, none at either end, at most 200
 * characters. This is the one place a record's free text is held to it, where the record is admitted
 * (`parseRecord`); a print site does not sanitise again, because a field that is not one line never gets there.
 */
export function isPrintableLine(v: unknown): v is string {
  return typeof v === 'string' && v.length <= RECORD_LINE_MAX && PRINTABLE_LINE.test(v);
}

/**
 * The record of one grader call, fully validated. A missing record, or one of another schema, is
 * `IMPORT_NO_RECORD` and the message names the example grader. Anything else wrong is `IMPORT_EVIDENCE`,
 * with every problem path in `fields`. `where` is the path of the record in the source file.
 */
export function parseRecord(raw: unknown, where: string, tool: ImportTool, rerun?: string): GraderRecord {
  checkInstruction(rerun);
  if (isObject(raw) && typeof raw['schema'] === 'string' && isEarlierRecordSchema(raw['schema'])) {
    throw new ImportRefusal('IMPORT_EVIDENCE', [`${where}.schema`], `${where}.schema: this record is of version ${raw['schema']}, an earlier version than ${RECORD_SCHEMA}; ${rerun ?? `re-grade with the current grader (examples/importers/${tool}/${GRADER_FILES[tool]}, schema ${RECORD_SCHEMA})`}`);
  }
  if (!isObject(raw) || raw['schema'] !== RECORD_SCHEMA) throw noRecordRefusal(tool, where, rerun);
  // The reading rule is never the grader's: no grader records it, and a record that holds the key was not written by the current grader.
  // It is stated to the importer (promptfoo), or at the re-grade and again at import (skill-evals, in the header of the re-grade file);
  // the Inspect importer has one rule.
  // A caller that gives its own instruction text has no `--reading` flag to point at: the neutral parenthetical is used.
  if ('reading' in raw) {
    throw new ImportRefusal('IMPORT_EVIDENCE', [`${where}.reading`], `${where}.reading: a record holds no reading rule ${tool === 'promptfoo' && rerun === undefined ? '(the rule is stated to the importer with --reading, not recorded)' : '(no grader records one)'}; ${rerun ?? `re-grade with the current grader (examples/importers/${tool}/${GRADER_FILES[tool]}, schema ${RECORD_SCHEMA})`}`);
  }
  const problems: string[] = [];
  const bad = (path: string, what: string): void => {
    problems.push(`${where}.${path}: ${what}`);
  };
  // One schema, one closed set of keys for each wire. A record that names no wire, or one that is not on the list, is not read under either.
  const wire = raw['wire'];
  if (!isWire(wire)) bad('wire', `must be one of ${WIRES.map((w) => JSON.stringify(w)).join(', ')}${'wire' in raw ? `; found ${typeof wire === 'string' ? JSON.stringify(wire.slice(0, 60)) : typeName(wire)}` : ''}`);
  const openai = wire === WIRE_OPENAI;
  const recordKeys = openai ? RECORD_KEYS_OPENAI : RECORD_KEYS_ANTHROPIC;
  for (const k of Object.keys(raw)) if (!recordKeys.includes(k)) bad(k, 'unknown key');
  for (const k of recordKeys) if (!(k in raw)) bad(k, 'missing');
  const nulls: string[] = [];
  valueTypeProblems(raw, where, nulls);
  problems.push(...nulls);

  const g = raw['grader'];
  if (isObject(g)) {
    for (const k of Object.keys(g)) if (!['name', 'language', 'sha256', 'runtime'].includes(k)) bad(`grader.${k}`, 'unknown key');
    if (!knownString(g['name'])) bad('grader.name', 'must be a known, non-empty string');
    if (g['language'] !== 'js' && g['language'] !== 'python') bad('grader.language', 'must be "js" or "python"');
    if (!isSha256Hex(g['sha256'])) bad('grader.sha256', 'must be a full 64-character sha256');
    if (!knownString(g['runtime'])) bad('grader.runtime', 'must be a known, non-empty string');
    // Free text that is printed and written into a run's identity: held to one printable line here, once.
    for (const k of ['name', 'runtime']) if (knownString(g[k]) && !isPrintableLine(g[k])) bad(`grader.${k}`, `must be ${PRINTABLE_LINE_FORM}`);
  } else if ('grader' in raw) bad('grader', `expected object, found ${typeName(g)}`);

  for (const k of ['graderRunId', 'callId', 'requestedModel', 'servedModel', 'responseId', 'stopReason']) {
    if (k in raw && !knownString(raw[k])) bad(k, 'must be a known, non-empty string (not "UNKNOWN", not null)');
  }
  for (const k of ['callId', 'servedModel', 'responseId']) if (knownString(raw[k]) && !isPlainId(raw[k])) bad(k, PLAIN_ID_FORM);
  for (const k of ['graderRunId', 'requestedModel', 'stopReason']) if (knownString(raw[k]) && !isPrintableLine(raw[k])) bad(k, `must be ${PRINTABLE_LINE_FORM}`);
  const seq = raw['callSeq'];
  if ('callSeq' in raw && !isPositiveInt(seq)) bad('callSeq', 'must be a positive integer');
  if ('promptSha256' in raw && !isSha256Hex(raw['promptSha256'])) bad('promptSha256', 'must be a full 64-character sha256');
  const sent = raw['sent'];
  let sentThinking: ReturnType<typeof thinkingShapeOf>;
  let sentEffort: string | undefined;
  let sentVerbosity: string | undefined;
  if (isObject(sent)) {
    const sentKeys = openai ? ['system', 'user', 'reasoning', 'text', 'store', 'truncation'] : ['system', 'user', 'thinking', 'output_config'];
    for (const k of Object.keys(sent)) if (!sentKeys.includes(k)) bad(`sent.${k}`, 'unknown key');
    if (sent['system'] !== NOT_SENT && !isSha256Hex(sent['system'])) bad('sent.system', `must be a sha256 or "${NOT_SENT}"`);
    if (!isSha256Hex(sent['user'])) bad('sent.user', 'must be a full 64-character sha256');
    if (openai) {
      if (!('reasoning' in sent)) bad('sent.reasoning', 'missing');
      else {
        sentEffort = reasoningEffortOf(sent['reasoning']);
        if (sentEffort === undefined) bad('sent.reasoning', `must be "${NOT_SENT}" or {"effort": one of ${EFFORTS.join(', ')}}, with no other key`);
      }
      if (!('text' in sent)) bad('sent.text', 'missing');
      else {
        sentVerbosity = verbosityOf(sent['text']);
        if (sentVerbosity === undefined) bad('sent.text', `must be "${NOT_SENT}" or {"verbosity": one of ${VERBOSITIES.join(', ')}}, with no other key`);
      }
      // Every OpenAI request sends both; a record that says otherwise was not written by the shipped graders.
      if (!('store' in sent)) bad('sent.store', 'missing');
      else if (sent['store'] !== false) bad('sent.store', 'must be false: a request that stores the response is outside the one request the importer reads');
      if (!('truncation' in sent)) bad('sent.truncation', 'missing');
      else if (sent['truncation'] !== 'disabled') bad('sent.truncation', 'must be "disabled": a request that lets the server cut its input is outside the one request the importer reads');
    } else {
      if (!('thinking' in sent)) bad('sent.thinking', 'missing');
      else {
        sentThinking = thinkingShapeOf(sent['thinking']);
        if (sentThinking === undefined) bad('sent.thinking', `must be "${NOT_SENT}" or one of {"type":"adaptive"}, {"type":"between_tools"}, {"type":"disabled"}, {"type":"enabled","budget_tokens":<positive integer>}, with no other key`);
      }
      if (!('output_config' in sent)) bad('sent.output_config', 'missing');
      else {
        sentEffort = effortShapeOf(sent['output_config']);
        if (sentEffort === undefined) bad('sent.output_config', `must be "${NOT_SENT}" or {"effort": one of ${SENT_EFFORTS.join(', ')}}, with no other key`);
      }
    }
  } else if ('sent' in raw) bad('sent', `expected object, found ${typeName(sent)}`);
  const ct = raw['contentTypes'];
  if ('contentTypes' in raw && !(Array.isArray(ct) && ct.every((x) => typeof x === 'string'))) bad('contentTypes', 'must be an array of strings');
  const tt = raw['thinkingTokens'];
  if ('thinkingTokens' in raw && !(tt === 'ABSENT' || isCounter(tt))) bad('thinkingTokens', THINKING_TOKENS_FORM);
  if ('usage' in raw && !isRecordedUsage(raw['usage'])) bad('usage', USAGE_FORM);
  if ('reply' in raw && typeof raw['reply'] !== 'string') bad('reply', `expected string, found ${typeName(raw['reply'])}`);
  if (openai) {
    // The status is one of the two the grader accepts (any other is a malformed body, which leaves no record), and the reason goes with it.
    const status = raw['stopReason'];
    if (knownString(status) && !OPENAI_STATUSES.includes(status as string)) bad('stopReason', `must be "completed" or "incomplete" on this wire; found ${JSON.stringify(typeof status === 'string' ? status.slice(0, 60) : status)}`);
    const why = raw['incompleteReason'];
    if ('incompleteReason' in raw) {
      if (why === INCOMPLETE_ABSENT) {
        if (status === 'incomplete') bad('incompleteReason', `"${INCOMPLETE_ABSENT}" with the status "incomplete": an incomplete response states why`);
      } else if (!(knownString(why) && isPrintableLine(why))) bad('incompleteReason', `must be ${PRINTABLE_LINE_FORM}, or "${INCOMPLETE_ABSENT}" with the status "completed"`);
      else if (status === 'completed') bad('incompleteReason', 'a "completed" response states no reason; it must be "ABSENT"');
    }
  }

  // The asks before the last: the form and the type of every key here; what the asks may say is `reaskProblems`, below.
  const reask = raw['reask'];
  if (isObject(reask)) {
    for (const k of Object.keys(reask)) if (k !== 'max' && k !== 'earlier') bad(`reask.${k}`, 'unknown key');
    for (const k of ['max', 'earlier']) if (!(k in reask)) bad(`reask.${k}`, 'missing');
    const max = reask['max'];
    if ('max' in reask && !(typeof max === 'number' && Number.isSafeInteger(max) && max >= 0 && max <= REASK_CEILING)) bad('reask.max', `must be an integer from 0 to ${REASK_CEILING}`);
    const earlier = reask['earlier'];
    if (Array.isArray(earlier)) {
      earlier.forEach((a, i) => {
        const at = `reask.earlier[${i}]`;
        if (!isObject(a)) {
          bad(at, `expected object, found ${typeName(a)}`);
          return;
        }
        for (const k of Object.keys(a)) if (!EARLIER_ASK_KEYS.includes(k)) bad(`${at}.${k}`, 'unknown key');
        for (const k of ['reason', 'callSeq', 'callId', 'httpStatus']) if (!(k in a)) bad(`${at}.${k}`, 'missing');
        if ('reason' in a && typeof a['reason'] !== 'string') bad(`${at}.reason`, `expected string, found ${typeName(a['reason'])}`);
        if ('callSeq' in a && !isPositiveInt(a['callSeq'])) bad(`${at}.callSeq`, 'must be a positive integer');
        const status = a['httpStatus'];
        if ('httpStatus' in a && !(status === NO_RESPONSE || (typeof status === 'number' && Number.isSafeInteger(status)))) bad(`${at}.httpStatus`, `must be an integer status, or "${NO_RESPONSE}" for an ask that got no response`);
        if ('detail' in a && !(typeof a['detail'] === 'string' && a['detail'] !== '')) bad(`${at}.detail`, 'must be a non-empty string');
        for (const k of ['callId', 'responseId', 'servedModel', 'stopReason', 'incompleteReason']) {
          if (k in a && !knownString(a[k])) bad(`${at}.${k}`, 'must be a known, non-empty string (not "UNKNOWN", not null)');
          else if (k in a && k !== 'stopReason' && k !== 'incompleteReason' && !isPlainId(a[k])) bad(`${at}.${k}`, PLAIN_ID_FORM);
        }
        const types = a['contentTypes'];
        if ('contentTypes' in a && !(Array.isArray(types) && types.every((x) => typeof x === 'string'))) bad(`${at}.contentTypes`, 'must be an array of strings');
        if ('thinkingTokens' in a && !(a['thinkingTokens'] === 'ABSENT' || isCounter(a['thinkingTokens']))) bad(`${at}.thinkingTokens`, THINKING_TOKENS_FORM);
        if ('usage' in a && !isRecordedUsage(a['usage'])) bad(`${at}.usage`, USAGE_FORM);
        if ('replySha256' in a && !isSha256Hex(a['replySha256'])) bad(`${at}.replySha256`, 'must be a full 64-character sha256');
        if ('replyUtf8Bytes' in a && !isCounter(a['replyUtf8Bytes'])) bad(`${at}.replyUtf8Bytes`, 'must be a non-negative integer');
      });
    } else if ('earlier' in reask) bad('reask.earlier', `expected array, found ${typeName(earlier)}`);
  } else if ('reask' in raw) bad('reask', `expected object, found ${typeName(reask)}`);

  if ('callShape' in raw) {
    const cs = raw['callShape'];
    if (nulls.length === 0) {
      const csProblems = validateCallShape(cs, `${where}.callShape`);
      problems.push(...csProblems);
      const gapped = csProblems.length === 0 && callShapeHash(cs as never) === GAP;
      if (gapped) bad('callShape', 'hashes to "UNKNOWN": a gap in any key');
      if (isObject(cs)) {
        const e = endpointProblem(cs['endpoint']);
        if (e !== undefined) bad('callShape.endpoint', e);
        if (typeof cs['apiVersion'] === 'string' && !isPrintableLine(cs['apiVersion'])) bad('callShape.apiVersion', `must be ${PRINTABLE_LINE_FORM}`);
        if (csProblems.length === 0 && !gapped) {
          // The one request the graders send sends no tool, no stop sequence, no format, no stream; it
          // sends thinking (reasoning) and effort only as stated in `sent`. A record that says otherwise contradicts the constants
          // the importers write for the judge.
          for (const k of NOT_SENT_KEYS) {
            if (cs[k] !== NOT_SENT) bad(`callShape.${k}`, `must be "${NOT_SENT}": a request with this set is outside the one request the importer reads`);
          }
          if (openai) {
            // The OpenAI request has no thinking object, no API version and no beta flag.
            for (const k of ['apiVersion', 'thinkingMode', 'thinkingBudgetTokens']) {
              if (cs[k] !== NOT_SENT) bad(`callShape.${k}`, `must be "${NOT_SENT}": the OpenAI request has no such setting`);
            }
          }
          // Thinking and effort: the call shape must say what `sent` shows was sent, and nothing else.
          if (sentThinking !== undefined) {
            if (cs['thinkingMode'] !== sentThinking.mode) bad('callShape.thinkingMode', `must be "${sentThinking.mode}", which is what sent.thinking shows; found ${JSON.stringify(cs['thinkingMode'])}`);
            if (cs['thinkingBudgetTokens'] !== sentThinking.budget) bad('callShape.thinkingBudgetTokens', `must be ${JSON.stringify(sentThinking.budget)}, which is what sent.thinking shows; found ${JSON.stringify(cs['thinkingBudgetTokens'])}`);
          }
          if (sentEffort !== undefined && cs['effort'] !== sentEffort) bad('callShape.effort', `must be "${sentEffort}", which is what sent.${openai ? 'reasoning' : 'output_config'} shows; found ${JSON.stringify(cs['effort'])}`);
          // `none` is the context policy of a request that lets the server cut nothing; on the OpenAI wire it holds only together with sent.truncation "disabled" (checked above).
          if (cs['contextPolicy'] !== 'none') bad('callShape.contextPolicy', 'must be "none": a request with a context policy is outside the one request the importer reads');
          if (openai) {
            const cap = cs['maxOutputTokens'];
            if (!(typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= OPENAI_MIN_OUTPUT_TOKENS)) bad('callShape.maxOutputTokens', `must be an integer of at least ${OPENAI_MIN_OUTPUT_TOKENS} on the ${WIRE_OPENAI} wire; found ${JSON.stringify(cap)}`);
            const ep = cs['endpoint'];
            if (typeof ep === 'string' && !/\/responses$/.test(ep)) bad('callShape.endpoint', 'must end with "/responses" on the OpenAI wire');
          }
          const t = cs['timeoutMs'];
          if (!(typeof t === 'number' && Number.isSafeInteger(t) && t >= 1 && t <= TIMEOUT_MS_CEILING)) bad('callShape.timeoutMs', `must be an integer from 1 to ${TIMEOUT_MS_CEILING}, the longest deadline the shipped graders take; found ${JSON.stringify(t)}`);
          if (openai) {
            // What `sent` implies: store false always, and the verbosity when it was sent. `truncation` is an alias of contextPolicy and is not an extra.
            const expected: Record<string, unknown> = { 'openai.store': false, ...(sentVerbosity === undefined || sentVerbosity === NOT_SENT ? {} : { 'openai.verbosity': sentVerbosity }) };
            if (sentVerbosity !== undefined && !isObject(cs['extras'])) bad('callShape.extras', 'must be an object');
            else if (sentVerbosity !== undefined && hashOf(cs['extras']) !== hashOf(expected)) bad('callShape.extras', `must be ${JSON.stringify(expected)}, which is what sent implies; found ${JSON.stringify(cs['extras'])}`);
          } else if (!isObject(cs['extras']) || Object.keys(cs['extras']).length > 0) bad('callShape.extras', 'must be {}: a request with extras is outside the one request the importer reads');
        }
      }
    }
  }
  if (problems.length > 0) throw new ImportRefusal('IMPORT_EVIDENCE', [...new Set(problems.map(problemField))], problems.join('; '));
  const rec = raw as unknown as GraderRecord;
  // The re-ask rules, on a record of the right form: the importer's guard against a file that kept the best of several asks.
  const reasked = reaskProblems(rec, where);
  if (reasked.length > 0) {
    throw new ImportRefusal('IMPORT_REASK', [...new Set(reasked.map(problemField))], `${reasked.join('; ')}. The shipped graders write no such record: grade again with the shipped grader, and do not edit result files`);
  }
  return rec;
}

/**
 * The problems of a record's earlier asks under the re-ask rules, each opening with its path; empty when there is none.
 * The record must be of the record's form already (`parseRecord` calls this last). The rules:
 *
 *   - an earlier ask ended in one of the five reasons, and holds exactly the keys of that reason's form;
 *   - a cut ask is a status 200 whose stop is exactly "max_tokens" (the OpenAI wire: the status "incomplete" with the reason
 *     "max_output_tokens"): any other stop is a finished reply that was asked again;
 *   - a cut ask states the sha256 and the UTF-8 length of the reply that was cut, and the two do not contradict each other;
 *   - a deadline or a failed connection has no status; a server error has a status from 500 to 599; a rate limit has 429;
 *   - there are no more earlier asks than the stated bound;
 *   - the call numbers rise through the asks of the slot, the last ask's included.
 */
export function reaskProblems(rec: GraderRecord, where: string): string[] {
  const problems: string[] = [];
  const { max, earlier } = rec.reask;
  if (earlier.length > max) problems.push(`${where}.reask.earlier: ${earlier.length} earlier ask(s), more than the bound of ${max} re-ask(s) the record states`);
  let before = 0;
  earlier.forEach((ask, i) => {
    const at = `${where}.reask.earlier[${i}]`;
    const a = ask as unknown as Obj;
    const reason = a['reason'] as string;
    if (!(REASK_REASONS as readonly string[]).includes(reason)) {
      problems.push(`${at}.reason: ${JSON.stringify(reason)} is not one of the reasons a slot is asked again for (${REASK_REASONS.join(', ')}); a finished reply is never asked again`);
    } else {
      const form = reason === 'truncated' ? CUT_ASK_KEYS[rec.wire] : NO_REPLY_ASK_KEYS;
      const lacks = form.filter((k) => !(k in a));
      const extra = Object.keys(a).filter((k) => !form.includes(k));
      if (lacks.length > 0 || extra.length > 0) {
        problems.push(`${at}: not the form of a "${reason}" ask${lacks.length > 0 ? `; it lacks ${lacks.join(', ')}` : ''}${extra.length > 0 ? `; it holds ${extra.join(', ')}` : ''}`);
      }
      const status = a['httpStatus'];
      if (reason === 'truncated') {
        if (status !== 200) problems.push(`${at}.httpStatus: ${JSON.stringify(status)} with the reason "truncated"; a cut reply is a status 200`);
        if (rec.wire === WIRE_OPENAI) {
          // The cut form of the OpenAI wire is the status "incomplete" with the reason "max_output_tokens", and no other.
          if ('stopReason' in a && a['stopReason'] !== OPENAI_CUT_STATUS) problems.push(`${at}.stopReason: ${JSON.stringify(a['stopReason'])}, not "${OPENAI_CUT_STATUS}"; a reply that was not cut at the output cap was asked again`);
          if ('incompleteReason' in a && a['incompleteReason'] !== OPENAI_CUT_REASON) problems.push(`${at}.incompleteReason: ${JSON.stringify(a['incompleteReason'])}, not "${OPENAI_CUT_REASON}"; a reply that was not cut at the output cap was asked again`);
        } else if ('stopReason' in a && a['stopReason'] !== CUT_STOP) problems.push(`${at}.stopReason: ${JSON.stringify(a['stopReason'])}, not "${CUT_STOP}"; a reply that was not cut at the output cap was asked again`);
        // The one relation between the two that can be checked without the text: no bytes, and the hash of no bytes.
        if ('replySha256' in a && 'replyUtf8Bytes' in a && (a['replyUtf8Bytes'] === 0) !== (a['replySha256'] === EMPTY_TEXT_SHA256)) {
          problems.push(`${at}.replySha256: the sha256 and replyUtf8Bytes ${JSON.stringify(a['replyUtf8Bytes'])} contradict each other; a cut reply of 0 bytes, and no other, has the sha256 of the empty text`);
        }
      } else if (reason === 'timeout' || reason === 'transport') {
        if (status !== NO_RESPONSE) problems.push(`${at}.httpStatus: ${JSON.stringify(status)} with the reason "${reason}"; an ask that got no response has "${NO_RESPONSE}"`);
      } else if (reason === 'server-error') {
        if (!(typeof status === 'number' && status >= 500 && status <= 599)) problems.push(`${at}.httpStatus: ${JSON.stringify(status)} with the reason "server-error"; a server error is a status from 500 to 599`);
      } else if (status !== 429) problems.push(`${at}.httpStatus: ${JSON.stringify(status)} with the reason "rate-limited"; a rate limit is the status 429`);
    }
    if (ask.callSeq <= before) problems.push(`${at}.callSeq: ${ask.callSeq} does not rise above the ask before it (${before})`);
    before = ask.callSeq;
  });
  if (earlier.length > 0 && rec.callSeq <= before) problems.push(`${where}.callSeq: the last ask's ${rec.callSeq} does not rise above the earlier ask before it (${before})`);
  return problems;
}

/**
 * Every setting of a grader's configuration equal to what the record and its call shape state, and no other key.
 * `settings` is the configuration object where the tool or the file recorded it; `prefix` is the JSON Pointer of that
 * object, and opens every field and message. Throws `IMPORT_EVIDENCE` naming every setting that differs.
 */
export function checkGraderConfig(settings: Obj, record: GraderRecord, prefix: string): void {
  const problems = graderConfigProblems(settings, record, prefix);
  if (problems.length > 0) throw new ImportRefusal('IMPORT_EVIDENCE', [...new Set(problems.map(problemField))], problems.join('; '));
}

/** The four settings of a grader that decide where a call goes and under what deadline; a setting that is not set is `undefined`. */
export type EndpointSettings = { timeoutMs: unknown; apiVersion: unknown; apiKeyEnv: unknown; baseUrl: unknown };

/**
 * The problems of the four endpoint settings against the call shape a record states, each opening with the place of
 * the setting in `at` (a JSON Pointer in the tool's own file, with the tool's own key name). The one comparison both
 * tools use; the tools differ in the names and places of the keys only. A setting is "not set" only when it is
 * `undefined`: a `null`, or a value of a type the grader does not take, is a value, and the grader refuses it when
 * it is built. Neither the base URL nor the name of the key's variable is echoed.
 */
export function endpointSettingProblems(given: EndpointSettings, cs: Record<string, unknown>, at: { timeoutMs: string; apiVersion: string; apiKeyEnv: string; baseUrl: string }, wire: Wire): string[] {
  const problems: string[] = [];
  const defaults = GRADER_DEFAULTS[wire];
  const timeoutMs = given.timeoutMs === undefined ? defaults.timeoutMs : given.timeoutMs;
  if (timeoutMs !== cs['timeoutMs']) problems.push(`${at.timeoutMs}: ${JSON.stringify(timeoutMs)} but the record says ${JSON.stringify(cs['timeoutMs'])}`);
  if (wire === WIRE_OPENAI) {
    // The OpenAI request has no API version: a value stated is not a setting of the wire.
    if (given.apiVersion !== undefined) problems.push(`${at.apiVersion}: not a setting of the ${wire} wire`);
  } else {
    const apiVersion = given.apiVersion === undefined ? defaults.apiVersion : given.apiVersion;
    if (apiVersion !== cs['apiVersion']) problems.push(`${at.apiVersion}: ${JSON.stringify(apiVersion)} but the record says ${JSON.stringify(cs['apiVersion'])}`);
  }
  // Nothing in a record says which variable held the key; a value that is not a variable's name is not one the grader takes.
  if (given.apiKeyEnv !== undefined && !(typeof given.apiKeyEnv === 'string' && GRADER_KEY_ENV_NAME.test(given.apiKeyEnv))) {
    problems.push(`${at.apiKeyEnv}: not the name of an environment variable (letters, digits and underscores, not opening with a digit); the value is not shown`);
  }
  const baseUrl = given.baseUrl === undefined ? defaults.baseUrl : given.baseUrl;
  const urlWhy = graderBaseUrlProblem(baseUrl);
  if (urlWhy !== undefined) problems.push(`${at.baseUrl}: ${urlWhy}; the grader refuses such a base URL`);
  else {
    const u = new URL(baseUrl as string);
    const posted = `${u.origin}${u.pathname.replace(/\/+$/, '')}${wire === WIRE_OPENAI ? '/responses' : '/v1/messages'}`;
    if (posted !== cs['endpoint']) problems.push(`${at.baseUrl}: posts to ${JSON.stringify(posted)} but the record says ${JSON.stringify(cs['endpoint'])}`);
  }
  return problems;
}

/**
 * The problems `checkGraderConfig` refuses for, each opening with `<prefix>/<setting>: `; empty when there is none.
 *
 * A setting is "not set" only when its key is absent. A `null`, or a value of a type the grader does not take, is a
 * value: the grader refuses it when it is built, so it is never read here as the default. The base URL and the name
 * of the key's variable are held to the grader's own rules (`graderBaseUrlProblem`, `GRADER_KEY_ENV_NAME`): the
 * comparison of endpoints alone would not see user information, a query or a fragment, which a URL drops when the
 * address posted to is made from it. Neither value is echoed.
 */
export function graderConfigProblems(settings: Obj, record: GraderRecord, prefix: string): string[] {
  const given = settings;
  const rec = record;
  const cs = rec.callShape;
  const problems: string[] = [];
  // The wire is stated, with no default, and is the record's. Its settings are the wire's own: a key of the other wire is not one.
  if (given['wire'] !== rec.wire) problems.push(`${prefix}/wire: ${shown(given, 'wire')} but the record says ${JSON.stringify(rec.wire)}`);
  const allowed = GRADER_CONFIG_KEYS.promptfoo[rec.wire];
  for (const k of Object.keys(given)) if (k !== 'wire' && !allowed.includes(k)) problems.push(`${prefix}/${k}: not a setting the grader sends on the ${rec.wire} wire`);
  if (given['model'] !== rec.requestedModel) problems.push(`${prefix}/model: ${JSON.stringify(given['model'])} but the record says ${JSON.stringify(rec.requestedModel)}`);
  const capKey = rec.wire === WIRE_OPENAI ? 'max_output_tokens' : 'max_tokens';
  if (given[capKey] !== cs['maxOutputTokens']) problems.push(`${prefix}/${capKey}: ${JSON.stringify(given[capKey])} but the record says ${JSON.stringify(cs['maxOutputTokens'])}`);
  const t = given['temperature'];
  if (t === undefined ? cs['temperature'] !== NOT_SENT : !(typeof t === 'number' && typeof cs['temperature'] === 'number' && t === cs['temperature'])) {
    problems.push(`${prefix}/temperature: ${JSON.stringify(t ?? 'not set')} but the record says ${JSON.stringify(cs['temperature'])}`);
  }
  if (rec.wire === WIRE_OPENAI) {
    // Reasoning effort and verbosity are stated in the config and must be the ones the record shows.
    const recEffort = rec.sent.reasoning === NOT_SENT ? NOT_SENT : rec.sent.reasoning.effort;
    if (given['effort'] !== recEffort) problems.push(`${prefix}/effort: ${shown(given, 'effort')} but the record says ${JSON.stringify(recEffort)}`);
    const recVerbosity = rec.sent.text === NOT_SENT ? NOT_SENT : rec.sent.text.verbosity;
    if (given['verbosity'] !== recVerbosity) problems.push(`${prefix}/verbosity: ${shown(given, 'verbosity')} but the record says ${JSON.stringify(recVerbosity)}`);
  } else {
    // Thinking and effort are stated in the config and must be the ones the record shows.
    if (!('thinking' in given) || hashOf(given['thinking']) !== hashOf(rec.sent.thinking)) problems.push(`${prefix}/thinking: ${shown(given, 'thinking')} but the record says it sent ${JSON.stringify(rec.sent.thinking)}`);
    const recEffort = rec.sent.output_config === NOT_SENT ? NOT_SENT : rec.sent.output_config.effort;
    if (given['effort'] !== recEffort) problems.push(`${prefix}/effort: ${shown(given, 'effort')} but the record says ${JSON.stringify(recEffort)}`);
  }
  // The bound is stated too, with no default: a config without it is not the one of the grader that wrote the record.
  if (given['maxReasks'] !== rec.reask.max) problems.push(`${prefix}/maxReasks: ${shown(given, 'maxReasks')} but the record says the bound was ${rec.reask.max} re-ask(s)`);
  problems.push(...endpointSettingProblems({ timeoutMs: given['timeoutMs'], apiVersion: given['apiVersion'], apiKeyEnv: given['apiKeyEnv'], baseUrl: given['baseUrl'] }, cs, { timeoutMs: `${prefix}/timeoutMs`, apiVersion: `${prefix}/apiVersion`, apiKeyEnv: `${prefix}/apiKeyEnv`, baseUrl: `${prefix}/baseUrl` }, rec.wire));
  return problems;
}

/** A per-caller instruction text (what to run again) is a non-empty string with a visible character, or absent. */
function checkInstruction(rerun: string | undefined): void {
  if (rerun !== undefined && (typeof rerun !== 'string' || rerun.trim() === '')) throw new Error('the instruction text (what to re-run) must be a non-empty string');
}

/**
 * `IMPORT_NO_RECORD`: the message names the example grader of the tool. `rerun`, when given, is the caller's own
 * instruction text and replaces the sentence that names the tool's grader and the README.
 */
export function noRecordRefusal(tool: ImportTool, where: string, rerun?: string): ImportRefusal {
  checkInstruction(rerun);
  return new ImportRefusal(
    'IMPORT_NO_RECORD',
    [where],
    `${where}: this file was not graded through the recording grader. This importer reads the recording grader's record of each call, and this file holds none. ${rerun ?? `Grade the stored outputs again through examples/importers/${tool}/${GRADER_FILES[tool]} (see examples/importers/README.md)`}`,
  );
}

/** The two block types that may stand before the text block. Nothing depends on what such a block says. */
const THINKING_BLOCKS: readonly string[] = ['thinking', 'redacted_thinking'];
/** The label the OpenAI grader gives a reasoning item. */
const OPENAI_REASONING = 'reasoning';
/** The label of an OpenAI reply that can be read: a message item that is completed and has no phase, with one output_text part. */
const OPENAI_ANSWER = 'message/output_text';
/** The other readable label: the same message item with `phase` exactly "final_answer". Any other phase is a different label and is not readable. */
const OPENAI_ANSWER_FINAL = 'message[phase=final_answer]/output_text';

/** Whether a content-type label of the OpenAI wire is a refusal part, bracketed (`message[status=x]/refusal`) or not. */
const isRefusalLabel = (t: string): boolean => t.endsWith('/refusal');

/**
 * Whether the content types are readable: on the Anthropic wire zero or more thinking blocks, then exactly one text block,
 * last; on the OpenAI wire zero or more reasoning items, then exactly one `message/output_text` or `message[phase=final_answer]/output_text`, last. A label with `/refusal`
 * is never readable, so a refusal beside a readable-looking part never makes a reply. An empty list is never readable.
 * (An empty `output` is a valid body on the OpenAI wire: a completed response with it is unreadable, and an incomplete
 * one with `max_output_tokens` is a cut. On the Anthropic wire empty `content` is a malformed body and leaves no record.)
 */
export function contentIsReadable(wire: Wire, contentTypes: readonly string[]): boolean {
  const last = contentTypes.length - 1;
  if (last < 0) return false;
  if (wire === WIRE_OPENAI) return (contentTypes[last] === OPENAI_ANSWER || contentTypes[last] === OPENAI_ANSWER_FINAL) && contentTypes.slice(0, last).every((t) => t === OPENAI_REASONING);
  return contentTypes[last] === 'text' && contentTypes.slice(0, last).every((t) => THINKING_BLOCKS.includes(t));
}

/** Whether a list of content types holds a reasoning item (OpenAI) or a thinking or redacted-thinking block (Anthropic). */
const holdsReasoning = (wire: Wire, contentTypes: readonly string[]): boolean => contentTypes.some((t) => (wire === WIRE_OPENAI ? t === OPENAI_REASONING : THINKING_BLOCKS.includes(t)));

/**
 * Why a record is not a clean, finished grade, or undefined when it is. The order is fixed, and the status comes before the
 * content: an `incomplete` response whose message item is completed carries the readable-looking label `message/output_text`,
 * so a content check first would read a cut or filtered reply as a finished one. Stop first, then refusal, then the shape of the
 * content; the reply's text is read by nobody here. The reason is in the record's own words.
 */
export function ungradedReason(rec: GraderRecord): string | undefined {
  const { max, earlier } = rec.reask;
  const openai = rec.wire === WIRE_OPENAI;
  const incompleteReason = openai ? rec.incompleteReason : undefined;
  if (isCutStop(rec.wire, rec.stopReason, incompleteReason) && earlier.length > 0) {
    const asks = earlier.length + 1;
    // Every ask of the slot was cut and the bound is used up: the words say so, and name no cure.
    if (earlier.length === max && earlier.every((a) => a.reason === 'truncated')) return `the judge's reply was cut at the output cap on each of ${asks} asks; the bound of ${max} re-asks is used up`;
    const cut = earlier.filter((a) => a.reason === 'truncated').length + 1;
    return `the judge's reply was cut at the output cap on the last of ${asks} asks (${cut} cut, ${asks - cut} with no reply); the record states a bound of ${max} re-asks`;
  }
  if (judgeStopOf(rec.wire, rec.stopReason, incompleteReason) !== 'end') {
    if (openai) return `the judge stopped with status "${rec.stopReason}"${rec.stopReason === 'incomplete' ? ` (${rec.incompleteReason})` : ''}, not "completed"`;
    return `the judge stopped with "${rec.stopReason}", not "end_turn"`;
  }
  // A refusal part anywhere in a completed response makes the slot ungraded, whatever text stands beside it.
  if (openai && rec.contentTypes.some(isRefusalLabel)) return `the response holds a refusal part (content types ${JSON.stringify(rec.contentTypes)}); a refusal is never graded, whatever text stands beside it`;
  if (!contentIsReadable(rec.wire, rec.contentTypes)) {
    return openai
      ? `the reply holds content of type ${JSON.stringify(rec.contentTypes)}, not zero or more reasoning items followed by exactly one completed message with one output_text part`
      : `the reply holds content of type ${JSON.stringify(rec.contentTypes)}, not zero or more thinking blocks followed by exactly one text block`;
  }
  return undefined;
}

/**
 * The reasoning line printed on every success: how many of the asks that got a reply held reasoning (a reasoning item, a thinking or
 * redacted-thinking block), and the provider's own counter over those asks. Every ask that got a reply is counted, the cut ones that
 * were asked again included. The median is the lower median of the asks that have a counter (for an even count, the smaller of the
 * two middle values), as an integer; `-` stands in for every figure when no ask has a counter. The counters are each provider's own,
 * in that provider's own tokens. These are counts, never a rate.
 */
export function reasoningLine(records: readonly GraderRecord[]): string {
  const replied = records.flatMap((r) => [
    { wire: r.wire, contentTypes: r.contentTypes, tokens: r.thinkingTokens },
    ...r.reask.earlier.flatMap((a) => (a.reason === 'truncated' ? [{ wire: r.wire, contentTypes: a.contentTypes, tokens: a.thinkingTokens }] : [])),
  ]);
  const k = replied.filter((a) => holdsReasoning(a.wire, a.contentTypes)).length;
  const counted = replied.flatMap((a) => (typeof a.tokens === 'number' ? [a.tokens] : [])).sort((x, y) => x - y);
  const absent = replied.length - counted.length;
  const figures = counted.length === 0 ? 'total -, median -, max -' : `total ${counted.reduce((x, y) => x + y, 0)}, median ${counted[Math.floor((counted.length - 1) / 2)]}, max ${counted[counted.length - 1]}`;
  return `replies with reasoning: ${k} of ${replied.length} asks; reasoning tokens (the provider's own count): ${figures}; counter absent on ${absent}`;
}

/**
 * What is printed about the served id, a statement and never a count (a file holds one requested and one served model).
 * When the two are the same text the run file cannot show which version graded; the statement says so.
 */
export function servedModelStatement(requested: string, served: string): string {
  return served === requested
    ? `judge model served: "${served}", the same text as the model requested. The provider's reply named no more specific version, so this run file cannot show which version of the model graded it. A change of model behind this name would leave judgeModelServed unchanged.`
    : `judge model served: "${served}" (requested "${requested}"), as the provider's reply named it; not checked.`;
}

/**
 * The re-asks line printed on every success, zero included, so that its absence is never read as "none":
 * `re-asks: <k> on <m> of <n> slots (truncated <a>, timeout <b>, transport <c>, server-error <d>, rate-limited <e>); at most <max> per slot`.
 * A cut reply is counted apart from the four ways of getting no reply. The bound is the one the records state
 * (`checkRecordSet` has refused a file with two).
 */
export function reasksLine(records: readonly GraderRecord[]): string {
  const earlier = records.flatMap((r) => r.reask.earlier);
  const count = (reason: ReaskReason): number => earlier.filter((a) => a.reason === reason).length;
  const reasked = records.filter((r) => r.reask.earlier.length > 0).length;
  const bounds = [...new Set(records.map((r) => r.reask.max))];
  if (bounds.length !== 1) throw new ImportRefusal('IMPORT_MIXED_IDENTITY', ['reask.max'], `reask.max: ${bounds.length} distinct values`);
  return `re-asks: ${earlier.length} on ${reasked} of ${records.length} slots (truncated ${count('truncated')}, timeout ${count('timeout')}, transport ${count('transport')}, server-error ${count('server-error')}, rate-limited ${count('rate-limited')}); at most ${bounds[0]} per slot`;
}

/** The graded attempt an importer writes as a slot's outcome: the system side is never known to it. */
export type ImportedGrade = { kind: 'graded'; label: string; outputHash: string; systemStop: typeof GAP; judgeStop: 'end'; packetHash: string };

/** A recorded usage in a detail text. */
const usageWords = (u: RecordedUsage): string => (u === 'ABSENT' ? 'usage ABSENT' : `usage input ${u.input_tokens} output ${u.output_tokens}`);

/**
 * The one function that turns a slot's record into its attempt list: one judge attempt that measured nothing for each
 * earlier ask the grader recorded, in the order asked, then the graded attempt, last. An earlier attempt carries the
 * graded attempt's output hash and packet hash, since every ask of a slot sent the same request, and an unknown
 * system stop, as every imported attempt does. Its `detail` is built from the record's own fields and from nothing
 * else: the ask's number, its reason, its status, the response id and served model where there was a response, the
 * call number and call id, and for a cut reply the usage, the thinking tokens and the sha256 and length of the cut
 * text. The grader's own `detail` text is not copied. Equal bytes in give equal bytes out.
 */
export function attemptsOf(record: GraderRecord, graded: ImportedGrade): Attempt[] {
  // OpenAI wire: the detail text reads `stop "incomplete" (max_output_tokens)`; Anthropic: `stop "max_tokens"`.
  const asks = record.reask.earlier.length + 1;
  const earlier: Attempt[] = record.reask.earlier.map((a, i) => {
    const head = `judge ask ${i + 1} of ${asks}`;
    const tail = `callSeq ${a.callSeq}, call id ${a.callId}`;
    const detail =
      a.reason === 'truncated'
        ? `${head}: the reply was cut at the output cap (${record.wire === WIRE_OPENAI ? `stop "${a.stopReason}" (${a.incompleteReason})` : `stop "${a.stopReason}"`}), status ${a.httpStatus}, response ${a.responseId}, served model ${a.servedModel}; ${tail}; ${usageWords(a.usage)}; thinking tokens ${a.thinkingTokens}; cut reply sha256:${a.replySha256} (${a.replyUtf8Bytes} UTF-8 bytes)`
        : `${head}: no reply (${a.reason}), status ${a.httpStatus}; ${tail}`;
    return { kind: 'unmeasured', role: 'judge', reason: a.reason, detail, outputHash: graded.outputHash, systemStop: GAP, packetHash: graded.packetHash };
  });
  return [...earlier, graded];
}

const NOT_A_VERDICT = 'not exactly one JSON object with a boolean "pass"';

/**
 * Reads a reply under a named rule: `{ pass, reason }`, or a string saying why the reply is not a verdict under it.
 * The first rule is one JSON object with a boolean `pass`, white space (space, tab, carriage return, line feed) around it allowed. The second is that object
 * bare or inside exactly one code fence whose opening line is three backticks and `json` and whose closing line is
 * three backticks, with nothing but that white space outside the fence. Both fence lines are exact: no indent, no trailing character.
 * Under either rule the object is read by the strict reader (`parseJsonStrict`): a key given twice, nesting beyond the
 * library's depth, or a text with an unpaired surrogate is "not a verdict".
 */
export function readUnderRule(rule: Reading, reply: string): { pass: boolean; reason: unknown } | string {
  if (!(READINGS as readonly string[]).includes(rule)) throw new Error(`unknown reading rule ${JSON.stringify(rule)}`);
  // No trim: the fence lines are exact, and the JSON grammar owns the white space around an object (space, tab, CR, LF only).
  let body = reply;
  if (rule === READING_JSON_OBJECT_OR_FENCE) {
    const fenced = /^(?:[ \t\r]*\n)*```json\n([\s\S]*)\n```(?:\n[ \t\r]*)*$/.exec(reply);
    if (fenced !== null) body = fenced[1] as string;
  }
  // The one strict reader: a reply that gives a key twice (`{"pass":true,"pass":false}`, where the plain parser keeps
  // the last and says nothing), that nests deeper than the library reads, or that holds a text with an unpaired
  // surrogate is not a verdict, as a reply that is not JSON is not.
  const read = parseJsonStrict(body);
  if ('why' in read || illFormedProblems(read.value).length > 0) return NOT_A_VERDICT;
  const v = read.value;
  if (!isObject(v) || typeof v['pass'] !== 'boolean') return NOT_A_VERDICT;
  return { pass: v['pass'], reason: v['reason'] };
}

/**
 * The words added to an unreadable slot's reason when the reply is readable under the other rule. Nothing when the reply is
 * readable under the stated rule, or under neither. It names no command and chooses nothing.
 */
export function readableUnderOtherRule(stated: Reading, reply: string): string | undefined {
  const other = READINGS.find((r) => r !== stated);
  if (other === undefined || typeof readUnderRule(stated, reply) !== 'string') return undefined;
  return typeof readUnderRule(other, reply) === 'string' ? undefined : `readable under ${other}; that rule is a different judge definition`;
}

/**
 * The one reading of a slot: its record must be a clean, finished grade (`ungradedReason`), and its reply must hold a verdict
 * under the stated rule (`readUnderRule`). It returns the verdict, or where the slot fails and why: `at` is '' for the record
 * itself (its stop or its content) and '/reply' for a finished reply with no verdict under the rule, whose words name the
 * rule and say when the other rule would read the reply (`readableUnderOtherRule`). The two promptfoo-reply importers and
 * the skill-evals re-grade all read a slot through this function, so a slot one of them stops at is a slot the others refuse,
 * in the same words.
 */
export function readSlot(record: GraderRecord, rule: Reading): { pass: boolean; reason: unknown } | { at: '' | '/reply'; why: string } {
  if (!(READINGS as readonly string[]).includes(rule)) throw new Error(`unknown reading rule ${JSON.stringify(rule)}`);
  const stop = ungradedReason(record);
  if (stop !== undefined) return { at: '', why: stop };
  const v = readUnderRule(rule, record.reply);
  if (typeof v !== 'string') return v;
  const note = readableUnderOtherRule(rule, record.reply);
  return { at: '/reply', why: `${v}, under the reading rule ${rule} that was stated${note === undefined ? '' : `; ${note}`}` };
}

/**
 * `IMPORT_UNGRADED` over every slot that holds no clean grade. The closing sentence points at the document
 * (`docs/IMPORTERS.md`) and at no section of it. `closing`, when given, is the caller's own closing text and replaces
 * that whole sentence, pointer included.
 */
export function ungradedRefusal(slots: readonly { caseId: string; draw: number; reason: string }[], closing?: string): ImportRefusal {
  checkInstruction(closing);
  const each = slots.map((s) => `${slotLabel(s.caseId, s.draw)} (${s.reason})`).join('; ');
  return new ImportRefusal(
    'IMPORT_UNGRADED',
    slots.map((s) => slotLabel(s.caseId, s.draw)),
    `${slots.length} slot(s) hold no finished, readable grade: ${each}. Nothing was written. ${closing ?? 'Keep this file: the measurement planned on this re-grade is aborted, and a further re-grade is a new experiment that reports this one (docs/IMPORTERS.md)'}`,
  );
}

export type RecordedSlot = { caseId: string; draw: number; record: GraderRecord };

/**
 * The consistency checks of the recorded calls over the whole file: one grader process, `callSeq` exactly 1 to the
 * number of asks (the slots plus the re-asks their records hold), no two asks with the same call id or response id,
 * and one value of every identity field, the re-ask bound among them. The slot count is the number of records given.
 * These are consistency checks of the recorded calls and nothing more: they find an interior hole and a duplicate,
 * and cannot find a trailing ask that nobody recorded.
 */
export function checkRecordSet(slots: readonly RecordedSlot[]): void {
  const n = slots.length;
  const runIds = new Set(slots.map((s) => s.record.graderRunId));
  if (runIds.size > 1) {
    throw new ImportRefusal('IMPORT_HIDDEN_CALLS', ['graderRunId'], `graderRunId: two grader processes wrote this file (${runIds.size} distinct run ids)`);
  }
  // Every ask of the file: each slot's earlier asks, then its last. An ask that got no response has no response id.
  type Ask = { slot: string; label: string; callSeq: number; callId: string; responseId: string | undefined };
  const asks: Ask[] = slots.flatMap((s) => {
    const slot = slotLabel(s.caseId, s.draw);
    return [
      ...s.record.reask.earlier.map((a, i) => ({ slot, label: `${slot} (ask ${i + 1})`, callSeq: a.callSeq, callId: a.callId, responseId: a.reason === 'truncated' ? a.responseId : undefined })),
      { slot, label: slot, callSeq: s.record.callSeq, callId: s.record.callId, responseId: s.record.responseId },
    ];
  });
  const total = asks.length;
  const seqs = asks.map((a) => a.callSeq).sort((a, b) => a - b);
  if (!seqs.every((v, i) => v === i + 1)) {
    const over = total === n ? '' : ` over every ask (${n} slot(s) and ${total - n} recorded re-ask(s))`;
    throw new ImportRefusal('IMPORT_HIDDEN_CALLS', ['callSeq'], `callSeq: callSeq values${over} are not 1 to ${total}, each once: ${seqs.join(', ')}`);
  }
  for (const field of ['callId', 'responseId'] as const) {
    const seen = new Map<string, Ask[]>();
    for (const a of asks) {
      const key = a[field];
      if (key !== undefined) { const list = seen.get(key); if (list === undefined) seen.set(key, [a]); else list.push(a); }
    }
    const dups = [...seen.values()].filter((l) => l.length > 1);
    if (dups.length > 0) {
      throw new ImportRefusal('IMPORT_DUPLICATE_CALL', [...new Set(dups.flat().map((a) => a.slot))], `${field}: shared by slots ${dups.map((l) => l.map((a) => a.label).join(' and ')).join('; ')}`);
    }
  }
  const mixed: [string, (r: GraderRecord) => unknown][] = [
    // One file holds one wire: two wires are two request builders and two reply readers.
    ['wire', (r) => r.wire],
    ['grader.name', (r) => r.grader.name],
    ['grader.language', (r) => r.grader.language],
    ['grader.sha256', (r) => r.grader.sha256],
    ['grader.runtime', (r) => r.grader.runtime],
    ['requestedModel', (r) => r.requestedModel],
    ['callShape', (r) => r.callShape],
    // The bound is part of how the judge was run: one file, one bound.
    ['reask.max', (r) => r.reask.max],
  ];
  for (const [field, get] of mixed) oneValue(field, slots.map((s) => get(s.record)));
  // One served model over every ask that got a response, the cut ones included.
  oneValue('servedModel', slots.flatMap((s) => [s.record.servedModel, ...s.record.reask.earlier.flatMap((a) => (a.reason === 'truncated' ? [a.servedModel] : []))]));
}

/** The one value of a field over all rows (by canonical JSON), or `IMPORT_MIXED_IDENTITY` naming how many differ. */
export function oneValue<T>(field: string, values: readonly T[]): T {
  const first = values[0];
  if (first === undefined) throw new ImportRefusal('IMPORT_MIXED_IDENTITY', [field], `${field}: no value to read`);
  const distinct = new Set(values.map((v) => hashOf(v)));
  if (distinct.size > 1) throw new ImportRefusal('IMPORT_MIXED_IDENTITY', [field], `${field}: ${distinct.size} distinct values`);
  return first;
}

/**
 * The `judgeHarnessVersion` string of a run: the tool, its version, the grader that declared the calls, its runtime,
 * and the stated bound of re-asks per slot (`; max-reasks <n>`): the bound decides which slots end graded and which
 * refuse the file, so it is part of how the judge was run, and two runs under two bounds are two harness strings. Then
 * the wire (`; wire <name>`): a second wire is a second client (another request builder, another reply reader, another
 * readability rule), and a different client is a harness change, so a switch of provider moves this string.
 * A caller whose request was shaped by script files may pass `scriptFilesSha256`, the sha256 of the canonical JSON of
 * the list of those files; it must be a full lowercase sha256 (else `IMPORT_EVIDENCE`) and is appended as the sixth and
 * last component, `; script-files sha256:<hash>`, after the wire. Without it the string has five components.
 */
export function judgeHarnessVersion(toolLabel: string, toolVersion: string, rec: GraderRecord, scriptFilesSha256?: string): string {
  const base = `${toolLabel} ${toolVersion}; ${rec.grader.name} ${rec.grader.language} sha256:${rec.grader.sha256}; ${rec.grader.runtime}; max-reasks ${rec.reask.max}; wire ${rec.wire}`;
  if (scriptFilesSha256 === undefined) return base;
  if (!isSha256Hex(scriptFilesSha256)) throw new ImportRefusal('IMPORT_EVIDENCE', ['scriptFilesSha256'], 'scriptFilesSha256: must be a full 64-character lowercase sha256');
  return `${base}; script-files sha256:${scriptFilesSha256}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The skeleton rule: fix it on strict rows, then render forward on every row
// ---------------------------------------------------------------------------------------------------------------

export type Component = { name: string; value: string };
/** A message is a list of fixed texts and slots, in order. */
export type Segment = string | { slot: string };
export type Skeleton = readonly (readonly Segment[])[];
export type SkeletonRow = { label: string; contents: readonly string[]; components: readonly Component[] };

/** How often `needle` occurs in `hay`, overlapping occurrences included. */
function occurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  if (needle === '') return at;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/** The number of occurrences of each component in the whole message list. */
export function componentCounts(contents: readonly string[], components: readonly Component[]): Record<string, number> {
  return Object.fromEntries(components.map((c) => [c.name, contents.reduce((n, m) => n + occurrences(m, c.value).length, 0)]));
}

/**
 * Step 1: the skeleton of one row, by replacement, when the strict rule holds: each component non-empty,
 * occurring exactly once in the whole list, and no occurrence overlapping or inside another. Otherwise undefined.
 */
export function defineSkeleton(contents: readonly string[], components: readonly Component[]): Skeleton | undefined {
  if (components.some((c) => c.value === '')) return undefined;
  const spans: { msg: number; start: number; end: number; name: string }[] = [];
  for (const c of components) {
    const found: { msg: number; start: number }[] = [];
    contents.forEach((m, msg) => occurrences(m, c.value).forEach((start) => found.push({ msg, start })));
    if (found.length !== 1) return undefined;
    const f = found[0];
    if (f === undefined) return undefined;
    spans.push({ msg: f.msg, start: f.start, end: f.start + c.value.length, name: c.name });
  }
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (a !== undefined && b !== undefined && a.msg === b.msg && a.start < b.end && b.start < a.end) return undefined;
    }
  }
  return contents.map((m, msg) => {
    const here = spans.filter((s) => s.msg === msg).sort((a, b) => a.start - b.start);
    const segs: Segment[] = [];
    let at = 0;
    for (const s of here) {
      segs.push(m.slice(at, s.start), { slot: s.name });
      at = s.end;
    }
    segs.push(m.slice(at));
    return segs;
  });
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * The single-pass template check: `undefined` when the template holds, as braces, only the plain tokens `{<name>}` of
 * `tokens`, else a fixed sentence naming what is not allowed. The names must be distinct identifiers (letters, digits and
 * underscore, not opening with a digit); any other list is a programming error and throws.
 */
export function templateProblem(template: string, tokens: readonly string[]): string | undefined {
  if (tokens.length === 0 || tokens.some((t) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) || new Set(tokens).size !== tokens.length) {
    throw new Error('templateProblem: the token names must be a non-empty list of distinct identifiers');
  }
  const rest = template.replace(new RegExp(`\\{(?:${tokens.join('|')})\\}`, 'g'), '');
  if (rest.search(/[{}]/) === -1) return undefined;
  // One name is "the one plain token", not "one of the one plain tokens".
  const allowed = tokens.length === 1 ? 'the one plain token' : `one of the ${NUMBER_WORDS[tokens.length] ?? String(tokens.length)} plain tokens`;
  return `a brace that is not ${allowed} ${tokens.map((t) => `{${t}}`).join(', ')} (a doubled brace, a format specification, a conversion, an index, or another name)`;
}

/** The skeleton that is a template with `{name}` placeholders, in one message. Names not listed stay as text. */
export function skeletonFromTemplate(template: string, slots: readonly string[]): Skeleton {
  const segs: Segment[] = [];
  const re = new RegExp(`\\{(${slots.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\}`, 'g');
  let at = 0;
  for (const m of template.matchAll(re)) {
    segs.push(template.slice(at, m.index), { slot: m[1] as string });
    at = (m.index as number) + m[0].length;
  }
  segs.push(template.slice(at));
  return [segs];
}

/** The skeleton with each slot's value put in. A slot with no value is an error: nothing is guessed. */
export function renderSkeleton(skeleton: Skeleton, values: Readonly<Record<string, string>>): string[] {
  return skeleton.map((segs) =>
    segs
      .map((s) => {
        if (typeof s === 'string') return s;
        const v = values[s.slot];
        if (v === undefined) throw new Error(`renderSkeleton: no value for slot "${s.slot}"`);
        return v;
      })
      .join(''),
  );
}

const skeletonKey = (s: Skeleton): string => JSON.stringify(s);

/** `message <i>, position <n>` of the first difference between two message lists. */
export function firstDifference(expected: readonly string[], actual: readonly string[]): string {
  if (expected.length !== actual.length) return `message count ${actual.length}, skeleton has ${expected.length}`;
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i] as string;
    const a = actual[i] as string;
    if (e === a) continue;
    let p = 0;
    while (p < e.length && p < a.length && e[p] === a[p]) p++;
    return `message ${i}, position ${p}`;
  }
  return 'none';
}

/**
 * Step 2 alone: every row, rendered forward under `skeleton`, must equal the prompt the judge was sent, byte for
 * byte. Every differing row is listed, with the first differing position.
 */
export function checkForward(skeleton: Skeleton, rows: readonly SkeletonRow[]): void {
  const off: string[] = [];
  const detail: string[] = [];
  for (const row of rows) {
    const values = Object.fromEntries(row.components.map((c) => [c.name, c.value]));
    const rendered = renderSkeleton(skeleton, values);
    const same = rendered.length === row.contents.length && rendered.every((m, i) => m === row.contents[i]);
    if (!same) {
      off.push(row.label);
      detail.push(`${row.label}: the prompt differs from the skeleton filled with this row's parts, at ${firstDifference(rendered, row.contents)}`);
    }
  }
  if (off.length > 0) throw new ImportRefusal('IMPORT_PACKET', off, detail.join('; '));
}

/**
 * Both steps over a file's rows. At least one row must define a skeleton, every row that defines one must define
 * the same, and every row must then render forward to the prompt it was sent. Returns the skeleton.
 */
export function agreeSkeleton(rows: readonly SkeletonRow[]): Skeleton {
  const defining: { label: string; skeleton: Skeleton }[] = [];
  for (const row of rows) {
    const s = defineSkeleton(row.contents, row.components);
    if (s !== undefined) defining.push({ label: row.label, skeleton: s });
  }
  const first = defining[0];
  if (first === undefined) {
    const names = [...new Set(rows.flatMap((r) => r.components.map((c) => c.name)))];
    const parts = names.map((n) => {
      const counts = [...new Set(rows.map((r) => componentCounts(r.contents, r.components)[n] ?? 0))].sort((a, b) => a - b);
      return `${n} occurs ${counts.join(' or ')} times`;
    });
    throw new ImportRefusal('IMPORT_PACKET', names, `no row fixes the prompt's skeleton: on every row ${parts.join('; ')}`);
  }
  const keys = new Map<string, string[]>();
  for (const d of defining) { const list = keys.get(skeletonKey(d.skeleton)); if (list === undefined) keys.set(skeletonKey(d.skeleton), [d.label]); else list.push(d.label); }
  if (keys.size > 1) {
    const groups = [...keys.values()];
    throw new ImportRefusal('IMPORT_PACKET', groups.flat(), `${keys.size} different skeletons: rows ${groups.map((g) => g.join(', ')).join(' | ')}`);
  }
  checkForward(first.skeleton, rows);
  return first.skeleton;
}

// ---------------------------------------------------------------------------------------------------------------
// cases.json, the bar and the roster
// ---------------------------------------------------------------------------------------------------------------

export type StatedCase = { klass: string; expect: string };
export type CasesFile = Record<string, StatedCase>;

/** The bar, parsed. A bar that does not validate is an input error (exit 65), with the library's problems. */
export function loadBar(text: string): BarFile {
  const read = parseJsonStrict(text);
  if ('why' in read) throw new ImportInputError([`bar: ${read.why}`]);
  const json = read.value;
  try {
    return parseBarFile(json);
  } catch (e) {
    if (e instanceof InputError) throw new ImportInputError(e.problems);
    throw e;
  }
}

/**
 * Validates `cases.json`: `{ "<case id>": { "klass": "<class of the bar>", "expect": "<label of the bar>" } }`. No
 * other key, no null, a non-empty roster, every class and label in the bar. Throws an input error listing every problem.
 */
export function parseCasesFile(text: string, bar: BarFile): CasesFile {
  return parseCases(text, bar);
}

/**
 * The shape check of `cases.json` alone, for a caller with no bar: everything `parseCasesFile` checks except that a
 * class is a class of the bar and a label is a label of the bar. Throws an input error listing every problem.
 */
export function parseCasesFileShape(text: string): CasesFile {
  return parseCases(text, undefined);
}

function parseCases(text: string, bar: BarFile | undefined): CasesFile {
  const read = parseJsonStrict(text);
  if ('why' in read) throw new ImportInputError([`cases: ${read.why}`]);
  const json = read.value;
  if (!isObject(json)) throw new ImportInputError([`cases: expected object, found ${typeName(json)}`]);
  const problems: string[] = [];
  const ids = Object.keys(json);
  if (ids.length === 0) problems.push('cases: must hold at least one case');
  const out: CasesFile = {};
  for (const id of ids) {
    const v = json[id];
    const at = `cases[${JSON.stringify(id)}]`;
    if (id === '') problems.push('cases: a case id must not be empty');
    if (id === '__proto__') problems.push('cases: a case id must not be "__proto__"');
    if (!isObject(v)) {
      problems.push(`${at}: expected object, found ${typeName(v)}`);
      continue;
    }
    for (const k of Object.keys(v)) if (k !== 'klass' && k !== 'expect') problems.push(`${at}.${k}: unknown field`);
    const { klass, expect } = v;
    if (typeof klass !== 'string' || klass === '') problems.push(`${at}.klass: must be a non-empty string${klass === null ? ' (null is not allowed)' : ''}`);
    else if (bar !== undefined && !Object.hasOwn(bar.classes, klass)) problems.push(`${at}.klass: "${klass}" is not a class of the bar`);
    if (typeof expect !== 'string' || expect === '') problems.push(`${at}.expect: must be a non-empty string${expect === null ? ' (null is not allowed)' : ''}`);
    else if (bar !== undefined && !bar.labels.includes(expect)) problems.push(`${at}.expect: "${expect}" is not a label of the bar`);
    if (typeof klass === 'string' && typeof expect === 'string' && id !== '__proto__') out[id] = { klass, expect };
  }
  if (problems.length > 0) throw new ImportInputError(problems);
  return out;
}

/**
 * The roster check: the ids found in the file must equal the ids of `cases.json`, as a set. Returns the library's
 * `Case` list (sorted by id), with each case's input read from the file and its class and label stated.
 */
export function buildCases(cases: CasesFile, found: ReadonlyMap<string, unknown>): Case[] {
  const missing = Object.keys(cases).filter((id) => !found.has(id));
  const extra = [...found.keys()].filter((id) => !Object.hasOwn(cases, id));
  if (missing.length > 0 || extra.length > 0) {
    throw new ImportRefusal(
      'IMPORT_CASE_MISSING',
      [...missing, ...extra],
      `${missing.length > 0 ? `in cases.json but not in the file: ${missing.join(', ')}` : ''}${missing.length > 0 && extra.length > 0 ? '; ' : ''}${extra.length > 0 ? `in the file but not in cases.json: ${extra.join(', ')}` : ''}`,
    );
  }
  return Object.keys(cases)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => {
      const stated = cases[id] as StatedCase;
      return { id, klass: stated.klass, input: found.get(id), expect: stated.expect };
    });
}

/** `IMPORT_BAR`: every label the importer writes must be a label of the bar. */
export function assertBarHasLabels(bar: BarFile, written: Iterable<string>): void {
  const missing = [...new Set(written)].filter((l) => !bar.labels.includes(l));
  if (missing.length > 0) throw new ImportRefusal('IMPORT_BAR', missing, `the bar has no label ${missing.map((l) => JSON.stringify(l)).join(', ')}, which the file's grades hold; judge-change would refuse the run later as an unknown label`);
}

// ---------------------------------------------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------------------------------------------

/** Fails with a usage error when `outPath` exists. Call it first, so no work is done for nothing. */
export function assertOutFree(outPath: string): void {
  if (existsSync(outPath)) throw new ImportUsageError(`${outPath} exists; an importer never overwrites --out`);
}

/**
 * Self-checks the run through the library's parser, on the exact text that will be written, and writes it. Every
 * graded label must be in the bar (IMPORT_BAR). A parser problem is IMPORT_SELF_CHECK and nothing is written.
 * `--out` is never overwritten: the file is created exclusively. Returns the sha256 of the bytes written.
 */
export function writeRun(run: unknown, bar: BarFile, outPath: string): { sha256: string; text: string } {
  assertOutFree(outPath);
  const text = `${JSON.stringify(run, null, 2)}\n`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ImportRefusal('IMPORT_SELF_CHECK', ['run'], `run: not serialisable (${(e as Error).message})`);
  }
  try {
    parseRunArtifact(parsed);
  } catch (e) {
    if (e instanceof InputError) throw new ImportRefusal('IMPORT_SELF_CHECK', e.problems.map(problemField), e.problems.join('; '));
    throw e;
  }
  const labels: string[] = [];
  const draws = isObject(parsed) && Array.isArray(parsed['draws']) ? parsed['draws'] : [];
  for (const d of draws) {
    if (isObject(d) && Array.isArray(d['attempts'])) for (const a of d['attempts']) if (isObject(a) && a['kind'] === 'graded' && typeof a['label'] === 'string') labels.push(a['label']);
  }
  assertBarHasLabels(bar, labels);
  writeExclusive(outPath, text);
  return { sha256: sha256Hex(text), text };
}

/**
 * The one exclusive write of the importers: the file is created, never overwritten. A path that exists is a usage
 * error, and so is any other failed write that the platform names with a code. `writeRun` and the stored-answers
 * script both write through it.
 */
export function writeExclusive(outPath: string, text: string): void {
  try {
    writeFileSync(outPath, text, { flag: 'wx' });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new ImportUsageError(`${outPath} exists; an importer never overwrites --out`);
    if (typeof code === 'string') throw new ImportUsageError(`cannot write ${outPath} (${code})`);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The command: one flag parser, one printer, one runner for both importers
// ---------------------------------------------------------------------------------------------------------------

export type Io = { out: (s: string) => void; err: (s: string) => void };

/**
 * Runs an importer script's command as this process: its lines go to stdout and stderr, and its return value (or the
 * value its promise resolves to) is the exit code. This is the write guard of the library's command line (`runAsProcess`
 * in src/cli.ts), here for a command that may be asynchronous: a write that fails never ends the process on its own,
 * since an uncaught error is exit 1 with a stack trace and exit 1 is the library's verdict "regression", which no
 * importer ever returns.
 *
 * A reader that closed its end of a pipe (`... | head -n 1`) is not a failure: nothing more is written to that stream and
 * the exit code is the command's own. Any other failed write is exit 70 with one line on stderr where stderr still takes
 * one. A stream reports a failed write by throwing or by an 'error' event after the command has returned; both end here.
 */
export function runImporterAsProcess(command: (argv: readonly string[], io: Io) => number | Promise<number>, tool: string): void {
  const closed = new Set<NodeJS.WriteStream>();
  let lost = false;
  const write = (stream: NodeJS.WriteStream, s: string): void => {
    if (closed.has(stream)) return;
    try {
      stream.write(`${s}\n`);
    } catch (e) {
      failed(stream, e);
    }
  };
  const failed = (stream: NodeJS.WriteStream, e: unknown): void => {
    closed.add(stream);
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') return;
    lost = true;
    process.exitCode = IMPORT_EXIT_INTERNAL;
    if (stream !== process.stderr) write(process.stderr, `${tool}: internal error: cannot write to stdout: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ')}`);
  };
  process.stdout.on('error', (e) => failed(process.stdout, e));
  process.stderr.on('error', (e) => failed(process.stderr, e));
  const io: Io = { out: (s) => write(process.stdout, s), err: (s) => write(process.stderr, s) };
  void new Promise<number>((resolve) => resolve(command(process.argv.slice(2), io))).then(
    (code) => {
      process.exitCode = lost ? IMPORT_EXIT_INTERNAL : code;
    },
    (e: unknown) => {
      // The commands catch every error they foresee; one that still gets here is an internal error, and never exit 1.
      write(process.stderr, `${tool}: internal error: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ')}`);
      process.exitCode = IMPORT_EXIT_INTERNAL;
    },
  );
}
/**
 * The one optional flag of every importer: the sha256 of the user's own grader file. A record from a grader that is not the
 * shipped one is refused unless the user states, with this flag, the sha256 of the grader they ran (`graderAdmission`).
 */
export const GRADER_SHA_FLAG = '--grader-sha256';
/** The four flags of every importer, all required. */
export const IMPORT_FLAGS = ['--in', '--cases', '--bar', '--out'] as const;
export type ImportFlags = Record<(typeof IMPORT_FLAGS)[number], string>;

/** The rule names a promptfoo import can be told with `--reading`, as the message lists them. */
const readingNames = (): string => READINGS.join(', ');

/**
 * The general flag parser: the required flags and the optional flags a tool takes. Each flag at most once, none unknown,
 * none with an empty value or a value that is a flag, every required one present. Returns the values by flag name; an
 * optional flag that is absent is absent from the result (no default, no null). A `switch` is a flag that takes no value:
 * it is in the result, as "true", only when it was given. Exit 64 (`ImportUsageError`) otherwise.
 */
export function parseFlagList(argv: readonly string[], usage: string, required: readonly string[], optional: readonly string[] = [], switches: readonly string[] = []): Record<string, string> {
  const known = [...required, ...optional, ...switches];
  const got = new Map<string, string>();
  for (let k = 0; k < argv.length; k += switches.includes(argv[k] as string) ? 1 : 2) {
    const flag = argv[k] as string;
    if (!known.includes(flag)) throw new ImportUsageError(`unknown argument ${JSON.stringify(flag)}. ${usage}`);
    if (got.has(flag)) throw new ImportUsageError(`${flag} given twice. ${usage}`);
    if (switches.includes(flag)) {
      got.set(flag, 'true');
      continue;
    }
    const value = argv[k + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new ImportUsageError(`${flag} needs a value. ${usage}`);
    got.set(flag, value);
  }
  const missing = required.filter((f) => !got.has(f));
  if (missing.length > 0) throw new ImportUsageError(`missing ${missing.join(', ')}. ${usage}`);
  return Object.fromEntries(got);
}

/** The flags `--in --cases --bar --out`: each once, none unknown, none with an empty value or a value that is a flag. Exit 64 otherwise. */
export function parseImporterFlags(argv: readonly string[], usage: string): ImportFlags {
  return parseFlagList(argv, usage, IMPORT_FLAGS) as ImportFlags;
}

/** The flags each importer takes: the four every importer needs, and one more for promptfoo, which is told the reading rule at import. Inspect takes no `--reading`: given there, it is an unknown flag. */
export const IMPORTER_FLAGS: Readonly<Record<ImportTool, { required: readonly string[]; optional: readonly string[] }>> = Object.freeze({
  promptfoo: { required: [...IMPORT_FLAGS, '--reading'], optional: [GRADER_SHA_FLAG] },
  inspect: { required: [...IMPORT_FLAGS], optional: [GRADER_SHA_FLAG] },
});

/**
 * The value of `--reading`: one of the two rule names, or a usage error that lists both. There is no default.
 */
export function readingFromFlag(value: string | undefined): Reading {
  if (value === undefined || !(READINGS as readonly string[]).includes(value)) {
    throw new ImportUsageError(`--reading must be one of ${readingNames()}${value === undefined ? '' : `; found ${JSON.stringify(value)}`}`);
  }
  return value as Reading;
}

/** Reads a file; a file that cannot be read is a usage error naming the path and the code, never the stack. */
export function readOrUsage(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    throw new ImportUsageError(`cannot read ${path} (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}

/** What an importer reports about a converted run: the judge block, the three hashes, the draws and the grader. */
export type ImportSummary = {
  judge: Record<string, string>;
  barHash: string;
  caseSetHash: string;
  drawsPerCase: number;
  grader: { name: string; language: string; runtime: string; sha256: string };
  /** The wire the records name (`wire: <name>` is printed on every success). */
  wire: Wire;
  /** The model requested and the model the provider's reply named; the served-id statement is printed on every success (`servedModelStatement`). */
  requestedModel: string;
  servedModel: string;
  /** The reasoning counts of the asks that got a reply (`reasoningLine`). */
  reasoning: string;
  /** The re-asks the records hold, by reason, and the bound (`reasksLine`). Printed on every success. */
  reasks: string;
  /** The reading rule the replies were read under, when the importer is told one (promptfoo): printed as `reading rule: <name>`. */
  readingRule?: string;
};

export type ImporterSpec = {
  tool: ImportTool;
  /** The one-line usage text, printed with every usage error. */
  usage: string;
  /** The required and optional flags of the tool; absent means the four flags of every importer. `--grader-sha256` is optional on every importer and is not listed here. */
  flags?: { required: readonly string[]; optional?: readonly string[] };
  /** Checks the flag values before any file is read; throws `ImportUsageError`. */
  checkFlags?: (flags: Readonly<Record<string, string>>) => void;
  /** The shipped grader file of the tool, read to say whether the record names it. */
  graderPath: string;
  /** Lines this importer adds to a success, printed after the shared ones and before the run file's sha256 and the next-step line. Called once, after the conversion. */
  extraLines?: () => string[];
  /** The pure conversion: bytes of the tool's file, the stated cases and the bar, to a run and its summary. Writes nothing. */
  convert: (bytes: Uint8Array, fileName: string, cases: CasesFile, bar: BarFile, flags: Readonly<Record<string, string>>) => { run: Record<string, unknown>; summary: ImportSummary };
};

/** The one next-step line an importer prints last, after the run file's sha256: where the hash goes and what runs next. */
export const NEXT_STEP_LINE = 'next: paste the run file sha256 above into your plan as systems.<name>.old or .new, then run judge-change (docs/JUDGE_CHANGE.md describes the plan)';

/**
 * The text printed on success: the plan fragment, the grader line and whether the record names the shipped grader
 * (name, language and sha256 all equal), then the system-side line, then the wire, then the served-id statement, then the
 * reasoning counts, then how many re-asks were made, then the reading rule where the importer is told one, then any lines `extra` the importer
 * adds, and last two lines in this order: the run file's sha256 and the next-step line (so a reader who looks at the end of
 * the output finds the value to paste and what to do with it). `shippedSha256` is `undefined` when the shipped file cannot
 * be read.
 */
export function successLines(tool: ImportTool, summary: ImportSummary, runSha256: string, shippedSha256: string | undefined, extra: readonly string[] = [], statedSha256?: string): string[] {
  const g = summary.grader;
  // A runtime string may already open with the language ("python 3.13.1"); it is never printed twice.
  const runtime = g.runtime.startsWith(`${g.language} `) ? g.runtime : `${g.language} ${g.runtime}`;
  const shipped = shippedSha256 !== undefined && g.sha256 === shippedSha256 && g.name === GRADER_NAME && g.language === GRADER_LANGUAGE[tool];
  const stated = statedSha256 !== undefined && g.sha256 === statedSha256 && g.language === GRADER_LANGUAGE[tool];
  return [
    JSON.stringify(
      {
        barHash: summary.barHash,
        caseSetHash: summary.caseSetHash,
        drawsPerCase: summary.drawsPerCase,
        judge: summary.judge,
        systems: { '<system name>': { '<old or new>': runSha256 } },
      },
      null,
      2,
    ),
    `grader: ${g.name} ${runtime} sha256:${g.sha256}`,
    shipped
      ? "the record reports the shipped grader's sha256"
      : stated
        ? `the record reports the grader sha256 you stated with ${GRADER_SHA_FLAG}, which is not the shipped grader: the record is that grader's own account, and nothing here checks it`
        : 'the record does not match the shipped grader (name, language or sha256), or the shipped file could not be read',
    'system side and seed: UNKNOWN (this run can enter judge-change only under "system-side-not-compared"; `gate` refuses it)',
    `wire: ${summary.wire}`,
    servedModelStatement(summary.requestedModel, summary.servedModel),
    summary.reasoning,
    summary.reasks,
    ...(summary.readingRule === undefined ? [] : [`reading rule: ${summary.readingRule}`]),
    ...extra,
    `run file sha256: ${runSha256}`,
    NEXT_STEP_LINE,
  ];
}

/**
 * Whether the grader a record names may be read: it is the shipped grader of the tool (name, language and sha256 all equal), or its
 * sha256 is the one the user stated with `--grader-sha256` (the user's own grader; its name is the user's, its language must still be
 * the tool's). Anything else, and the shipped file being unreadable with no hash stated, is `IMPORT_EVIDENCE` naming the fields: the
 * record is the grader's own account, and the importer has no ground to read it as the account of a grader it was not told of.
 * Returns which of the two held. The user's flag does not widen what the record may hold: `parseRecord` has already held it.
 */
export function graderAdmission(tool: ImportTool, grader: ImportSummary['grader'], shippedSha256: string | undefined, statedSha256: string | undefined): 'shipped' | 'stated' {
  const file = `examples/importers/${tool}/${GRADER_FILES[tool]}`;
  if (statedSha256 !== undefined && grader.sha256 !== statedSha256) {
    throw new ImportRefusal('IMPORT_EVIDENCE', ['grader.sha256'], `grader.sha256: the record's grader file is sha256:${grader.sha256}, not the sha256 stated with ${GRADER_SHA_FLAG} (sha256:${statedSha256})`);
  }
  if (grader.language !== GRADER_LANGUAGE[tool]) {
    throw new ImportRefusal('IMPORT_EVIDENCE', ['grader.language'], `grader.language: ${JSON.stringify(grader.language)}, not "${GRADER_LANGUAGE[tool]}", the language of the ${tool} grader`);
  }
  if (shippedSha256 !== undefined && grader.sha256 === shippedSha256 && grader.name === GRADER_NAME) return 'shipped';
  if (statedSha256 !== undefined) return 'stated';
  const differs = [
    ...(shippedSha256 === undefined ? [] : grader.sha256 === shippedSha256 ? [] : ['grader.sha256']),
    ...(grader.name === GRADER_NAME ? [] : ['grader.name']),
  ];
  const why = shippedSha256 === undefined ? `the shipped grader (${file}) could not be read, so the record cannot be shown to come from it` : `the record is not from the shipped grader (${file}): ${differs.join(' and ')} differ${differs.length === 1 ? 's' : ''} (name ${JSON.stringify(grader.name)}, sha256:${grader.sha256})`;
  throw new ImportRefusal(
    'IMPORT_EVIDENCE',
    differs.length > 0 ? differs : ['grader.sha256'],
    `${differs[0] ?? 'grader.sha256'}: ${why}. If you graded with a grader of your own, state its file's sha256 with ${GRADER_SHA_FLAG} <64 hexadecimal characters>; the record is then read as that grader's own account, which nothing here checks`,
  );
}

/**
 * Runs an importer and returns its exit code: 0 written, 2 refused, 64 usage (an unreadable file, an unwritable or existing
 * `--out`), 65 a cases file or bar that does not validate, 70 an error the importer did not foresee. Never 1.
 */
export function runImporter(argv: readonly string[], io: Io, spec: ImporterSpec): number {
  try {
    const args = parseFlagList(argv, spec.usage, spec.flags?.required ?? IMPORT_FLAGS, [...(spec.flags?.optional ?? []), GRADER_SHA_FLAG]) as Record<string, string> & ImportFlags;
    const stated = args[GRADER_SHA_FLAG];
    if (stated !== undefined && !isSha256Hex(stated)) throw new ImportUsageError(`${GRADER_SHA_FLAG} must be a full 64-character sha256 in lower-case hexadecimal, the sha256 of your own grader's file. ${spec.usage}`);
    spec.checkFlags?.(args);
    assertOutFree(args['--out']);
    const inBytes = readOrUsage(args['--in']);
    const bar = loadBar(inputJsonText('bar', readOrUsage(args['--bar'])));
    const cases = parseCasesFile(inputJsonText('cases', readOrUsage(args['--cases'])), bar);
    const { run, summary } = spec.convert(inBytes, args['--in'], cases, bar, args);
    let shipped: string | undefined;
    try {
      shipped = sha256Hex(readFileSync(spec.graderPath));
    } catch {
      shipped = undefined;
    }
    // Before anything is written: a record from a grader that is not the shipped one, and not stated, is refused.
    graderAdmission(spec.tool, summary.grader, shipped, stated);
    const written = writeRun(run, bar, args['--out']);
    // Every printed line goes through the one-line escaper, as a refusal does: a success line can hold text the user gave (a
    // path). The plan fragment (the first entry) is JSON on several lines, printed in one call as before: JSON writes a line
    // feed inside a string as an escape, so its line feeds are its own, and each of its lines is escaped by itself.
    const lines = successLines(spec.tool, summary, written.sha256, shipped, spec.extraLines?.() ?? [], stated);
    lines.forEach((line, i) => io.out(i === 0 ? line.split('\n').map(oneLine).join('\n') : oneLine(line)));
    return IMPORT_EXIT.written;
  } catch (e) {
    return printFailure(io, e);
  }
}

/** A printer whose every call is one line, whatever the text holds: for a command that prints text of the files it read (ids, file names, a failure's detail). */
export const oneLineIo = (io: Io): Io => ({ out: (s) => io.out(oneLine(s)), err: (s) => io.err(oneLine(s)) });

/**
 * What a command of this folder prints when it ends without its result, and the exit code: a refusal as two lines (its
 * code and reason, then the fields it names), a usage error, an input error and an error it did not foresee as one line
 * each. Every line goes through the library's one-line escaper: a message or a field can hold text of the tool's file
 * that no record check admitted (a version text, a sample id, a case id, a file name), and a carriage return, an escape
 * sequence or a line feed in it would otherwise erase or forge a line on a terminal. `scrub` takes a key out of the
 * text of an error that was not foreseen.
 */
export function printFailure(io: Io, e: unknown, scrub: (text: string) => string = (text) => text): number {
  if (e instanceof ImportRefusal) {
    io.err(oneLine(`REFUSED ${e.message}`));
    io.err(oneLine(`fields: ${e.fields.join(', ')}`));
    return IMPORT_EXIT.refused;
  }
  if (e instanceof ImportUsageError) {
    io.err(oneLine(e.message));
    return IMPORT_EXIT.usage;
  }
  if (e instanceof ImportInputError) {
    io.err(oneLine(e.message));
    return IMPORT_EXIT.invalidInput;
  }
  io.err(oneLine(`internal error: ${scrub(e instanceof Error ? e.message : String(e))}`));
  return IMPORT_EXIT_INTERNAL;
}
