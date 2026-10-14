import { createHash } from 'node:crypto';
import { InputError, RefusalError } from './errors.ts';

export { RefusalError } from './errors.ts';

/**
 * Explicit marker for a value that exists but is not known: an identity field, or a result withheld
 * because its inputs are incomplete. It blocks whatever depends on it. Never use null or undefined.
 */
export const GAP = 'UNKNOWN';
export type Gap = typeof GAP;

/** Value of `judgeDefinitionHash` for a run that has no judge (outputs are graded by code). */
export const NO_JUDGE = 'NO_JUDGE';
export type NoJudge = typeof NO_JUDGE;

/**
 * The seed of a run whose harness made no random choice: a statement, not a number. A uint32
 * nobody drew could not be told from a real seed, so 0 is never written for it. It says nothing about the
 * provider's sampling, which the call shape records apart (`samplingSeed`). It is not a gap: it is known, and it
 * equals itself. Beside a uint32 seed it never compares, also when `seed` is allowed to differ (assertComparable).
 * A conversion from another tool's file never writes it: what that harness did is unknown there, and stays a gap.
 */
export const NO_SEED = 'NO_SEED';
export type NoSeed = typeof NO_SEED;

export type RunIdentity = {
  caseSetHash: string | Gap;
  rubricHash: string | Gap;
  barHash: string | Gap;
  /** The system under test: the model id asked for and the one the provider reported serving. */
  systemModelRequested: string | Gap;
  systemModelServed: string | Gap;
  /** callShapeHash of the system's call shape (callshape.ts): the settings that shape the call, not the prompt or tools. */
  systemCallShapeHash: string | Gap;
  /** The system prompt and any injected instruction or context files that are not case fields. */
  systemPromptHash: string | Gap;
  /** Tool definitions, skill files and output schemas the system can use; hashOf([]) for none. */
  systemToolsHash: string | Gap;
  systemHarnessVersion: string | Gap;
  /**
   * The judge's prompt, protocol (including a pairwise-order policy and its algorithm version), tool
   * definitions and output schema. Not the rubric, which rubricHash owns.
   */
  judgeDefinitionHash: string | NoJudge | Gap;
  /** The judge, recorded separately so a judge move is never hidden behind an allowed system change. */
  judgeModelRequested: string | NoJudge | Gap;
  judgeModelServed: string | NoJudge | Gap;
  judgeCallShapeHash: string | NoJudge | Gap;
  /** The judge's client or harness: like the system's, it can change what the judge measures. */
  judgeHarnessVersion: string | NoJudge | Gap;
  /** A uint32, or NO_SEED where the harness made no random choice. Never null and never a number nobody drew. */
  seed: number | NoSeed | Gap;
  drawsPerCase: number | Gap;
};

export type IdentityField = keyof RunIdentity;

export const IDENTITY_FIELDS: readonly IdentityField[] = Object.freeze<IdentityField[]>([
  'caseSetHash',
  'rubricHash',
  'barHash',
  'systemModelRequested',
  'systemModelServed',
  'systemCallShapeHash',
  'systemPromptHash',
  'systemToolsHash',
  'systemHarnessVersion',
  'judgeDefinitionHash',
  'judgeModelRequested',
  'judgeModelServed',
  'judgeCallShapeHash',
  'judgeHarnessVersion',
  'seed',
  'drawsPerCase',
]);

/** Fields that describe the judge; all NO_JUDGE exactly when the run has no judge. Internal: not re-exported from index.ts. */
export const JUDGE_FIELDS: readonly IdentityField[] = ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion'];

/**
 * The fields of an `allowDiffer` list that a gate never waives: every judge field, the rubric whenever any of the runs
 * has a judge (a model name is not an identity and the rubric is part of the judge; between runs with no judge it is an
 * ordinary field), and the draw count (the fold is worst-of-N, so a smaller count is a more lenient instrument and
 * moves the verdict on its own). In the order given. The one
 * predicate behind both the gate's own refusal (`gateRuns`) and the ledger's check of a recorded gate
 * (`gateInputsProblems`).
 */
export function gateNeverWaives(allowDiffer: readonly string[], judged: boolean): string[] {
  return allowDiffer.filter((f) => (JUDGE_FIELDS as readonly string[]).includes(f) || (f === 'rubricHash' && judged) || f === DRAW_COUNT_FIELD);
}

/** The identity field that holds the draw count. */
export const DRAW_COUNT_FIELD = 'drawsPerCase' satisfies IdentityField;

const HASH_FIELDS: ReadonlySet<IdentityField> = new Set([
  'caseSetHash',
  'rubricHash',
  'barHash',
  'systemCallShapeHash',
  'systemPromptHash',
  'systemToolsHash',
  'judgeDefinitionHash',
  'judgeCallShapeHash',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;

const GAP_SPELLINGS = new Set(['unknown', 'na', 'none', 'null', 'nil', 'undefined', 'notsent']);

/**
 * True when a free-text value spells a gap ("unknown", "N/A", "none", "not_sent"...). Such a value
 * must be recorded as GAP, or it would compare equal to itself and pass as known.
 */
export function readsAsGap(s: string): boolean {
  return GAP_SPELLINGS.has(s.toLowerCase().replace(/[-_ ./]/g, ''));
}

export function isSha256Hex(s: unknown): s is string {
  return typeof s === 'string' && SHA256_RE.test(s);
}

/** How a string that holds an unpaired surrogate is described, in an error and in a list of problems. */
const ILL_FORMED = 'holds an unpaired surrogate, so it is not well-formed Unicode text and has no UTF-8 bytes of its own to hash';

/**
 * How deep a JSON text may nest objects and lists; a value that stands directly in the top-level
 * object or list is at depth 1. No file this library reads or writes comes near it (a run is under
 * 10 deep, a ledger record of a judge-change report under 20). A text beyond it is invalid input,
 * whatever it holds (parseJsonText): that one rule is what keeps every reader that walks a parsed
 * value by recursion inside the call stack.
 */
export const MAX_JSON_DEPTH = 128;

const TOO_DEEP = `objects and lists are nested more than ${MAX_JSON_DEPTH} deep`;

/** A string for a message: as JSON, where an unpaired surrogate is written as a \uXXXX escape and the message stays printable. */
const quoted = (s: string): string => JSON.stringify(s);

/** A path segment for an object key: the key itself, or its JSON form when the key is not well-formed. */
export const keySegment = (k: string): string => (k.isWellFormed() ? k : quoted(k));

/**
 * Deterministic JSON: object keys sorted (UTF-16 code unit order) at every depth, no whitespace.
 * Rejects undefined, functions, symbols, bigints, non-finite numbers, non-plain objects and cycles,
 * a string value or an object key that holds an unpaired surrogate (it is not text: see
 * findIllFormed), and a value nested more than MAX_JSON_DEPTH deep. Every refusal is a TypeError
 * that names the JSON path.
 */
export function canonicalJson(value: unknown): string {
  const stack = new Set<object>();
  const walk = (v: unknown, path: string): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string':
        if (!v.isWellFormed()) throw new TypeError(`canonicalJson: a string that ${ILL_FORMED}, at ${path}`);
        return JSON.stringify(v);
      case 'boolean':
        return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
        return JSON.stringify(v);
      case 'object':
        break;
      default:
        throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
    }
    const obj = v as object;
    if (stack.has(obj)) throw new TypeError(`canonicalJson: cycle at ${path}`);
    // The rule of parseJsonText, for a value built in code: a value read from a file is never this deep, and one that is gets a name, not a stack overflow.
    if (stack.size >= MAX_JSON_DEPTH) throw new TypeError(`canonicalJson: ${TOO_DEEP}, at ${path}`);
    stack.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) parts.push(walk(obj[i], `${path}[${i}]`));
      out = `[${parts.join(',')}]`;
    } else {
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: non-plain object at ${path}`);
      }
      const rec = obj as Record<string, unknown>;
      const keys = Object.keys(rec).sort();
      for (const k of keys) {
        if (!k.isWellFormed()) throw new TypeError(`canonicalJson: the object key ${quoted(k)} ${ILL_FORMED}, at ${path}`);
      }
      out = `{${keys.map((k) => `${JSON.stringify(k)}:${walk(rec[k], `${path}.${k}`)}`).join(',')}}`;
    }
    stack.delete(obj);
    return out;
  };
  return walk(value, '$');
}

/**
 * Full 64-character lowercase sha256 hex: of the UTF-8 bytes of a string, or of the bytes as given.
 * Throws TypeError for a string that holds an unpaired surrogate: its UTF-8 encoding would put
 * U+FFFD in its place, and the hash would be that of another text. Bytes are never checked.
 */
export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash('sha256');
  if (typeof data === 'string') {
    if (!data.isWellFormed()) throw new TypeError(`sha256Hex: the string ${ILL_FORMED}`);
    h.update(data, 'utf8');
  } else h.update(data);
  return h.digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * The value recorded as an attempt's `outputHash`: sha256 of the UTF-8 text for a string output, of
 * its canonical JSON otherwise. A failed attempt with no output hashes its own failure record (for
 * example `{ failed: reason, detail }`), and a re-judged run carries the same record, so the draw
 * still matches. Throws TypeError for an output that holds an unpaired surrogate (see sha256Hex).
 */
export function outputHashOf(raw: string | Record<string, unknown>): string {
  return typeof raw === 'string' ? sha256Hex(raw) : hashOf(raw);
}

/**
 * The value recorded as an attempt's `packetHash`: what a rater was shown for one item
 * (docs/JUDGE_CHANGE.md). Each named field and the output are hashed as presented, after any
 * selection or truncation, by the rule of outputHashOf. The rater's own instructions and the layout
 * that arranges the fields are not part of the packet.
 */
export function packetHashOf(fields: Readonly<Record<string, string | Record<string, unknown>>>, output: string | Record<string, unknown>): string {
  return hashOf({ fields: Object.fromEntries(Object.entries(fields).map(([name, content]) => [name, outputHashOf(content)])), output: outputHashOf(output) });
}

/**
 * Appends every item of `items` to `out`, one by one. Never `out.push(...items)`: a spread puts every
 * item on the call stack as an argument, and a list as long as an input file is (the problems of a
 * file with 150,000 unknown keys, the draws a refusal names) overflows it. Internal: not re-exported
 * from index.ts.
 */
export function appendAll<T>(out: T[], items: Iterable<T>): void {
  for (const item of items) out.push(item);
}

/** One value still to be read by a walk below: where it stands, and what to say of the key it sits under, if anything. */
type Pending = { v: unknown; path: string; keyProblem: string | undefined };

/**
 * Every value under `v`, a parent before its children and siblings in their own order, with its
 * path. It keeps its own stack, so no depth of `v` can overflow the call stack: a value nested
 * 200,000 deep is walked like any other. `segment` writes an object key into a path; `keyProblem`
 * may give a problem for a key, which is reported before anything under that key.
 */
function walkValue(v: unknown, path: string, out: string[], segment: (k: string) => string, keyProblem: (k: string, at: string) => string | undefined, visit: (v: unknown, at: string) => void): void {
  const todo: Pending[] = [{ v, path, keyProblem: undefined }];
  for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
    if (next.keyProblem !== undefined) out.push(next.keyProblem);
    visit(next.v, next.path);
    const at = next.path;
    const x = next.v;
    // Children are pushed last first, so that they are popped, and reported, in their own order.
    if (Array.isArray(x)) {
      for (let i = x.length - 1; i >= 0; i--) todo.push({ v: x[i], path: `${at}[${i}]`, keyProblem: undefined });
    } else if (typeof x === 'object' && x !== null) {
      const entries = Object.entries(x);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, child] = entries[i] as [string, unknown];
        todo.push({ v: child, path: `${at}.${segment(k)}`, keyProblem: keyProblem(k, at) });
      }
    }
  }
}

/**
 * Appends a problem for every string value and every object key, at any depth of `v`, that holds an
 * unpaired UTF-16 surrogate. Such a string is not text: encoding it as UTF-8 replaces each unpaired
 * surrogate with U+FFFD, so different strings would share bytes and a sha256. The hashing functions
 * refuse it (sha256Hex, canonicalJson); a parser calls this first, so a file that holds one is
 * reported as invalid input with the field named. It does not recurse: any depth is read.
 */
export function findIllFormed(v: unknown, path: string, out: string[]): void {
  walkValue(v, path, out, keySegment, (k, at) => (k.isWellFormed() ? undefined : `${at}: the object key ${quoted(k)} ${ILL_FORMED}`), (x, at) => {
    if (typeof x === 'string' && !x.isWellFormed()) out.push(`${at}: ${ILL_FORMED}`);
  });
}

/** Appends "path: null is not allowed" for every null at any depth of `v`. It does not recurse: any depth is read. */
export function findNulls(v: unknown, path: string, out: string[]): void {
  walkValue(v, path, out, (k) => k, () => undefined, (x, at) => {
    if (x === null) out.push(`${at}: null is not allowed`);
  });
}

/**
 * Why an integer is not read: past 2^53 - 1 a JSON number cannot hold every integer, so a file's
 * 9007199254740993 is read as 9007199254740992, and two different values would hash and compare as one.
 * A field that takes a decimal reads it as it always did, rounding included.
 */
export const INEXACT_INTEGER = `an integer beyond ${Number.MAX_SAFE_INTEGER} (2^53 - 1) cannot be read exactly; two different values would read as one`;

/** `why`, or INEXACT_INTEGER when `v` is an integer too large to be read exactly, which is then the reason it is refused. */
export function integerProblem(v: unknown, why: string): string {
  return Number.isInteger(v) && !Number.isSafeInteger(v) ? INEXACT_INTEGER : why;
}

/**
 * Appends "path: INEXACT_INTEGER" for every number at any depth of `v` that is an integer too large to
 * be read exactly. For a free-form value that is hashed into an identity (a call shape's extras), where
 * no field says whether a number is an integer. A number written as a decimal whose value is so large a
 * whole number (1e300) is refused too: the value read cannot tell how it was written. It does not
 * recurse: any depth is read. `advice` follows the reason; a record the library writes itself takes none.
 */
export function findInexactIntegers(v: unknown, path: string, out: string[], advice = '; record such a value as a string'): void {
  walkValue(v, path, out, (k) => k, () => undefined, (x, at) => {
    if (Number.isInteger(x) && !Number.isSafeInteger(x)) out.push(`${at}: ${INEXACT_INTEGER}${advice}`);
  });
}

/** How a number that is not finite is described: no JSON text holds one, and a number too large to be read becomes one. */
const NOT_FINITE = 'a number that is not finite (a JSON text holds none, and a number too large to be read, such as 1e999, becomes infinity)';

/**
 * Appends a problem for every value under `v` that has no canonical JSON, so that a validator can
 * return it as a problem where canonicalJson would throw: a number that is not finite, a value that
 * is no JSON value at all (undefined, a function, a symbol, a bigint, an object that is not a plain
 * object or a list), an object or list that holds itself, and one nested more than MAX_JSON_DEPTH
 * deep. Nothing under such a value is read. A string that is not text is findIllFormed's to report.
 * It recurses, and never deeper than MAX_JSON_DEPTH, so no value can overflow the call stack.
 */
export function findUnhashable(v: unknown, path: string, out: string[]): void {
  const open = new Set<object>();
  const walk = (x: unknown, at: string): void => {
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) out.push(`${at}: ${NOT_FINITE}`);
      return;
    }
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return;
    if (typeof x !== 'object') {
      out.push(`${at}: ${typeof x === 'undefined' ? 'undefined' : `a ${typeof x}`} is not a JSON value`);
      return;
    }
    const proto: unknown = Object.getPrototypeOf(x);
    if (!Array.isArray(x) && proto !== Object.prototype && proto !== null) {
      out.push(`${at}: an object that is not a plain object is not a JSON value`);
      return;
    }
    if (open.has(x)) {
      out.push(`${at}: the value holds itself, and a JSON value cannot`);
      return;
    }
    // As canonicalJson counts: the objects and lists a value stands in, and the first one inside MAX_JSON_DEPTH of them is too deep.
    if (open.size >= MAX_JSON_DEPTH) {
      out.push(`${at}: ${TOO_DEEP}`);
      return;
    }
    open.add(x);
    if (Array.isArray(x)) for (let i = 0; i < x.length; i++) walk(x[i], `${at}[${i}]`);
    else for (const [k, child] of Object.entries(x)) walk(child, `${at}.${keySegment(k)}`);
    open.delete(x);
  };
  walk(v, path);
}

/** True when a number that is not finite stands anywhere under `v`. A plain loop over a parsed JSON text: no paths are built. */
function holdsNonFinite(v: unknown): boolean {
  const todo: unknown[] = [v];
  while (todo.length > 0) {
    const x = todo.pop();
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) return true;
    } else if (Array.isArray(x)) {
      for (const child of x) todo.push(child);
    } else if (typeof x === 'object' && x !== null) {
      for (const child of Object.values(x)) todo.push(child);
    }
  }
  return false;
}

/** One open object or list of the duplicate-key scan: the keys seen so far and the key being read, or the index reached. */
type ScanFrame = { keys: Set<string> | undefined; wantKey: boolean; key: string; index: number };

const NOT_JSON = 'the text is not JSON';

/**
 * The first key that one object of a JSON text gives twice, with the place of that object as a JSON
 * Pointer (RFC 6901); undefined when no object does. `JSON.parse` keeps the last of two equal keys
 * and says nothing, so the file a person reads and the value a measurement uses can differ. Keys are
 * compared as the strings they spell: "\u0061" and "a" are one key. The same key in two different
 * objects is no repeat.
 *
 * This is a scan of a text that `JSON.parse` accepts, not a parser: call it after the parser, or use
 * parseJsonText, which does. It keeps its own stack, so the depth of the text is no limit. A text it
 * cannot read to the end (a string, an object or a list left open, a key that is no JSON string) is
 * reported as not JSON, never as clean.
 */
export function duplicateKeyProblem(text: string): string | undefined {
  const QUOTE = 0x22;
  const BACKSLASH = 0x5c;
  const stack: ScanFrame[] = [];
  const end = text.length;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      // The end of the string: the next quote that no backslash escapes.
      let j = i + 1;
      while (j < end && text.charCodeAt(j) !== QUOTE) j += text.charCodeAt(j) === BACKSLASH ? 2 : 1;
      if (j >= end) return NOT_JSON;
      const top = stack[stack.length - 1];
      if (top !== undefined && top.keys !== undefined && top.wantKey) {
        // The parser itself decodes the key, so two keys are equal here exactly when they are equal to it.
        let key: unknown;
        try {
          key = JSON.parse(text.slice(i, j + 1));
        } catch {
          return NOT_JSON;
        }
        if (typeof key !== 'string') return NOT_JSON;
        if (top.keys.has(key)) {
          const at = stack
            .slice(0, -1)
            .map((f) => `/${f.keys === undefined ? String(f.index) : f.key.replace(/~/g, '~0').replace(/\//g, '~1')}`)
            .join('');
          return `the key ${quoted(key)} is given twice in ${at === '' ? 'the top-level object' : `the object at ${at}`}`;
        }
        top.keys.add(key);
        top.key = key;
        top.wantKey = false;
      }
      i = j;
    } else if (c === 0x7b) {
      stack.push({ keys: new Set(), wantKey: true, key: '', index: 0 });
    } else if (c === 0x5b) {
      stack.push({ keys: undefined, wantKey: false, key: '', index: 0 });
    } else if (c === 0x7d || c === 0x5d) {
      const closed = stack.pop();
      if (closed === undefined || (closed.keys === undefined) !== (c === 0x5d)) return NOT_JSON;
    } else if (c === 0x2c) {
      const top = stack[stack.length - 1];
      if (top === undefined) return NOT_JSON;
      if (top.keys === undefined) top.index += 1;
      else top.wantKey = true;
    }
  }
  return stack.length === 0 ? undefined : NOT_JSON;
}

/**
 * The problem of a JSON text that nests objects and lists more than MAX_JSON_DEPTH deep, or undefined. Like duplicateKeyProblem
 * it is a scan of a text that `JSON.parse` accepts: it counts the brackets that stand outside
 * strings, with no recursion, and stops at the first one that is too deep.
 */
export function depthProblem(text: string): string | undefined {
  const QUOTE = 0x22;
  const BACKSLASH = 0x5c;
  const end = text.length;
  let depth = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      i += 1;
      while (i < end && text.charCodeAt(i) !== QUOTE) i += text.charCodeAt(i) === BACKSLASH ? 2 : 1;
    } else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) return TOO_DEEP;
    } else if (c === 0x7d || c === 0x5d) depth -= 1;
  }
  return undefined;
}

/**
 * How many bytes a file may hold: 536,870,888, the longest string this runtime can hold (a UTF-8 text
 * has at most one UTF-16 code unit per byte). A longer file is refused by its length, before it is
 * decoded, whatever it holds.
 */
export const MAX_TEXT_BYTES = 0x1fffffe8;

/** Why a file's bytes are not a text this library reads: one of these three, and nothing else. */
export const NOT_UTF8 = 'the bytes are not UTF-8 text';
export const HAS_BYTE_ORDER_MARK = 'the file starts with a byte-order mark';
export const TOO_LONG = `the file is longer than ${MAX_TEXT_BYTES} bytes, the most that is read as one text`;

/**
 * The text of a file's bytes, or the reason they are not one. This is the one decoder: every file
 * the library, its tools and the example importers read goes through it. The decoding is fatal: a
 * byte sequence that is not UTF-8 is a problem and is never replaced by U+FFFD, which would make
 * two different files one text (and, in an identity field, two different runs comparable). A
 * byte-order mark is a problem too, in every reader: the decoder keeps it so that it can be named,
 * and it is never dropped by one reader and handed to the parser by another. Only the decoder's own
 * refusal of the bytes is reported as "not UTF-8": any other error is not this function's to name,
 * and is thrown on.
 */
export function utf8Text(bytes: Uint8Array): { text: string } | { problem: typeof NOT_UTF8 | typeof HAS_BYTE_ORDER_MARK | typeof TOO_LONG } {
  if (bytes.length > MAX_TEXT_BYTES) return { problem: TOO_LONG };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (e) {
    if (e instanceof TypeError && (e as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return { problem: NOT_UTF8 };
    throw e;
  }
  return text.charCodeAt(0) === 0xfeff ? { problem: HAS_BYTE_ORDER_MARK } : { text };
}

/**
 * The value of a JSON text in which no object gives a key twice, nothing is nested more than
 * MAX_JSON_DEPTH deep and every number is finite; or the reason there is none. `notJson` tells the
 * reasons apart: the parser refused the text (the problem is then the parser's own message, behind
 * "invalid JSON: "), or the text is JSON and one of the three rules refuses it. A number too large
 * to be read (1e999) is read by the parser as infinity, which is no JSON value and has no canonical
 * JSON, so no hash: the first such number is named by its path from `$`. Every JSON text the
 * library reads is read through this function; the caller names the file.
 */
export function parseJsonText(text: string): { json: unknown } | { problem: string; notJson: boolean } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { problem: `invalid JSON: ${(e as Error).message}`, notJson: true };
  }
  const deep = depthProblem(text);
  if (deep !== undefined) return { problem: deep, notJson: false };
  const twice = duplicateKeyProblem(text);
  if (twice !== undefined) return { problem: twice, notJson: false };
  if (holdsNonFinite(json)) {
    const found: string[] = [];
    findUnhashable(json, '$', found);
    return { problem: found[0] as string, notJson: false };
  }
  return { json };
}

/**
 * The value of a JSON file's bytes: utf8Text, then parseJsonText. Bytes that are no text are no JSON
 * either (a JSON text is UTF-8 with no byte-order mark, RFC 8259 section 8.1), so their problem
 * reads "invalid JSON: " and the reason, and `notJson` is true.
 */
export function parseJsonBytes(bytes: Uint8Array): { json: unknown } | { problem: string; notJson: boolean } {
  const decoded = utf8Text(bytes);
  return 'problem' in decoded ? { problem: `invalid JSON: ${decoded.problem}`, notJson: true } : parseJsonText(decoded.text);
}

/**
 * The most draws one case may have. Every slot of a case, 0..drawsPerCase-1, is counted one by one
 * (a slot with no record is named as missing), so a file of a few bytes that declares a hundred
 * million draws would otherwise cost the memory of a hundred million slots.
 */
export const MAX_DRAWS_PER_CASE = 10_000;

/** Every problem with a candidate identity; empty when valid. */
export function validateIdentity(x: unknown, prefix = 'identity'): string[] {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return [`${prefix}: must be an object`];
  const rec = x as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(rec)) {
    if (!(IDENTITY_FIELDS as readonly string[]).includes(k)) problems.push(`${prefix}.${keySegment(k)}: unknown field`);
  }
  for (const f of IDENTITY_FIELDS) {
    const v = rec[f];
    const at = `${prefix}.${f}`;
    if (v === undefined) {
      problems.push(`${at}: missing (use "${GAP}" for an unknown value)`);
      continue;
    }
    if (v === null) {
      problems.push(`${at}: null is not allowed (use "${GAP}")`);
      continue;
    }
    if (v === GAP) continue;
    if (f === 'seed') {
      // The sentinel is this exact string and nothing near it: another spelling is not a statement the reader can rely on.
      if (v !== NO_SEED && (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 0xffffffff)) {
        problems.push(`${at}: must be a uint32 integer, "${NO_SEED}" for a harness that makes no random choice, or "${GAP}"`);
      }
    } else if (v === NO_SEED) {
      // Reserved for the seed, as NO_JUDGE is for the judge fields: elsewhere it would read as a statement it is not.
      problems.push(
        f === 'drawsPerCase'
          ? `${at}: must be a positive integer or "${GAP}"`
          : HASH_FIELDS.has(f)
            ? `${at}: must be a full 64-char lowercase sha256 hex or "${GAP}"`
            : `${at}: must be a non-empty string or "${GAP}" ("${NO_JUDGE}" is reserved for the judge fields and "${NO_SEED}" for the seed)`,
      );
    } else if (f === 'drawsPerCase') {
      if (!Number.isInteger(v) || (v as number) < 1) problems.push(`${at}: must be a positive integer or "${GAP}"`);
      else if ((v as number) > MAX_DRAWS_PER_CASE) problems.push(`${at}: at most ${MAX_DRAWS_PER_CASE} draws per case are read`);
    } else if (v === NO_JUDGE && JUDGE_FIELDS.includes(f)) {
      continue;
    } else if (HASH_FIELDS.has(f)) {
      if (!isSha256Hex(v)) problems.push(`${at}: must be a full 64-char lowercase sha256 hex or "${GAP}"`);
    } else if (typeof v !== 'string' || v.length === 0 || v === NO_JUDGE) {
      problems.push(`${at}: must be a non-empty string or "${GAP}" ("${NO_JUDGE}" is reserved for the judge fields and "${NO_SEED}" for the seed)`);
    } else if (readsAsGap(v)) {
      problems.push(`${at}: "${v}" reads as a gap; record an unknown value as "${GAP}"`);
    }
  }
  const noJudge = rec['judgeDefinitionHash'] === NO_JUDGE;
  for (const f of JUDGE_FIELDS) {
    if (f === 'judgeDefinitionHash' || rec[f] === undefined) continue;
    if (noJudge && rec[f] !== NO_JUDGE) problems.push(`${prefix}.${f}: must be "${NO_JUDGE}" when judgeDefinitionHash is "${NO_JUDGE}"`);
    if (!noJudge && rec[f] === NO_JUDGE) problems.push(`${prefix}.${f}: "${NO_JUDGE}" is only allowed when judgeDefinitionHash is "${NO_JUDGE}"`);
  }
  return problems;
}

export function parseIdentity(x: unknown): RunIdentity {
  const problems = validateIdentity(x);
  if (problems.length > 0) throw new InputError('INVALID_ARTIFACT', problems);
  return x as RunIdentity;
}

/** Names of the fields whose values differ. */
export function identityDiff(a: RunIdentity, b: RunIdentity): IdentityField[] {
  return IDENTITY_FIELDS.filter((f) => a[f] !== b[f]);
}

export type ComparableOptions = { allowDiffer?: readonly IdentityField[] };

/** How a refusal says why the no-seed sentinel beside a number is not waived. */
const NO_SEED_NOTE = 'a run that made no random choice is not compared with a seeded run, also when seed is allowed to differ';

/**
 * Throws RefusalError unless every field outside `allowDiffer` is known on both sides and equal.
 * A gap cannot be proven equal, so a gap on a must-match field refuses too. One difference no
 * `allowDiffer` waives: NO_SEED on one side and a uint32 seed on the other. Allowing `seed` to differ
 * declares two draws of one randomised procedure; a run with no random choice and a seeded run are
 * two procedures. Two runs that both declare NO_SEED are equal on the field.
 */
export function assertComparable(a: RunIdentity, b: RunIdentity, opts: ComparableOptions = {}): void {
  const allowed = new Set(opts.allowDiffer ?? []);
  for (const f of allowed) {
    if (!IDENTITY_FIELDS.includes(f)) throw new InputError('INVALID_ARGUMENT', [`allowDiffer: unknown field ${String(f)}`]);
  }
  const mismatched: IdentityField[] = [];
  const gaps: IdentityField[] = [];
  const noSeedBesideNumber = (f: IdentityField): boolean => f === 'seed' && (a.seed === NO_SEED) !== (b.seed === NO_SEED);
  // A gap blocks even on an allowed field: a declared difference must be a known difference.
  for (const f of IDENTITY_FIELDS) {
    if (a[f] === GAP || b[f] === GAP) gaps.push(f);
    else if (a[f] !== b[f] && (!allowed.has(f) || noSeedBesideNumber(f))) mismatched.push(f);
  }
  if (mismatched.length > 0) {
    const detail = mismatched.map((f) => `${f} ${String(a[f])} != ${String(b[f])}${noSeedBesideNumber(f) ? ` (${NO_SEED_NOTE})` : ''}`).join('; ');
    const gapNote = gaps.length > 0 ? `; also unknown: ${gaps.join(', ')}` : '';
    throw new RefusalError('IDENTITY_MISMATCH', [...mismatched, ...gaps], `${detail}${gapNote}`);
  }
  if (gaps.length > 0) {
    throw new RefusalError('IDENTITY_GAP', gaps, `unknown on at least one side: ${gaps.join(', ')}`);
  }
}

/**
 * A string as one printed line: every control character (U+0000 to U+001F, U+007F, and U+0080 to U+009F), the two Unicode
 * line separators (U+2028, U+2029) and the twelve bidirectional controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to
 * U+2069) are written as escapes. A bidirectional control starts no line, but it reorders what a terminal shows of one, and a
 * printed line must read in the order it was written. A text report prints text read from files (a packet source,
 * a case id, a label, a model id, a file name, a failure's detail), and a line feed or a carriage
 * return in such a value would otherwise start what reads as a report line of its own. A backslash
 * is left as it is, so an escape and the same characters typed in a value read alike; neither is a
 * line. The CLI's text reports print through it, and so does a script that prints text it read from a file (the example
 * importers print a refusal through it). JSON output needs none: JSON escapes its own strings. Anything but a string is
 * refused (`INVALID_ARGUMENT`).
 */
export function oneLine(s: string): string {
  if (typeof s !== 'string') throw new InputError('INVALID_ARGUMENT', ['oneLine: takes a string']);
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
}
