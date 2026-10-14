/**
 * The re-grade of a flow's stored outputs: for each case, the stored answer of ONE source rep is sent to a judge
 * several times through the recording grader this repository ships, and the answers come back into one file that
 * the importer reads.
 *
 *   node examples/importers/skill-evals/regrade.ts --flow <dir> --variant <name> --cases <cases.json> --reps <n>
 *        --rep <k> --draws <n> --template <file> --criterion <file> --model <judge id> --max-tokens <n>
 *        --thinking <NOT_SENT | JSON object> --effort <NOT_SENT | level> --max-reasks <0 to 3> --base-url <url>
 *        --reading <rule name> --out <file>
 *        [--select <json pointer>] [--system <file>] [--temperature <x>] [--timeout-ms <n>]
 *        [--api-version <v>] [--api-key-env <NAME>] [--go-on-and-count]
 *
 * Every flag outside the brackets is required and has no default; `--base-url` is one of them: the endpoint decides where the
 * key goes, so it is stated, never inherited from the grader's default host. The script does not decide whether a thinking
 * setting or an effort level is allowed: it hands the two to the grader, and the grader decides.
 *
 * `--reading` is the name of the rule each reply is read under, one of the two the shared module names (`READINGS`); it
 * is required and has no default. The script writes it into the header (`reading`), reads every finished reply under
 * it by the importer's own reading (`readSlot` in `../shared.ts`: there is one reading, and this script holds no copy of
 * it), and the importer refuses a file whose header names another rule than the one stated to it, or none. The grader
 * is not told the rule and records none: it reads no reply.
 *
 * `--max-reasks` is the bound of re-asks a slot may be given, an integer from 0 to 3 with no default; 0 asks every
 * slot once. The grader asks a slot again only after an ask that got no reply (a passed deadline, a failed
 * connection, a status 5xx, a status 429) or a reply cut at the output cap, and never after a finished reply.
 *
 * `--reps` is the declared rep count of the flow. `--rep` says which source rep's stored outputs are graded (from 0,
 * below `--reps`), and `--draws` how many times the judge grades each of them. `--reps`, `--draws`, the number of
 * slots (cases times draws) and the number of slots of the flow the reader looks for (cases times `--reps`) are each
 * at most 100000 (`HEADER_COUNT_BOUND`); a larger number is a usage error. In the source each rep of a case is a
 * fresh system output, so reps are not repeated grades of one output; a draw of the file is one more judge call on
 * the same stored output and the same prompt. Only the rep that is graded must be whole: a slot of another rep that
 * has no row, or whose row is not a finished answer, is counted in the output and not refused, and the selector is
 * applied to the graded rep alone (`check.ts` lists each rep's problems). A re-grade of another rep is another
 * measurement; keeping the two apart is the user's to do, since no check here, in the importer or in `judge-change`
 * separates runs by rep (a pair is refused only where the stored outputs differ).
 *
 * The cases file is the user's declaration of what is measured. A case the flow holds and the cases file does not is
 * excluded: it is not graded, and its id is written into the header (`excludedCaseIds`, sorted, with
 * `excludedCaseCount`), so the file says what was left out. A case of the cases file with no finished row in the
 * graded rep refuses.
 *
 * What it does, in this order:
 *   1. It reads and validates the variant (as `check.ts` does), requires the graded rep to be whole, applies the
 *      selector to every slot of that rep, checks the template and the texts, and refuses before any call when
 *      anything is off.
 *   2. It renders one prompt per case by single-pass substitution of `{question}`, `{answer}` and `{criterion}`.
 *   3. It checks that the key's variable is set, builds the grader, and only then creates `--out`, exclusively. A
 *      key that is not set, or a setting the grader refuses, is a usage error and leaves no file. An existing file is
 *      never written over.
 *   4. It makes one grader call per slot (a case and a draw), in a fixed order (case id, then draw). Inside that call
 *      the grader asks the judge once and, within the stated bound, again. When the call returns, the slot's record
 *      holds every ask of the slot. This script itself retries nothing: no resume, no two calls at once.
 *   5. A call that fails (the bound used up with no reply, or a failure that is never asked again) writes that slot's
 *      row with no record and an `error` text, and ends the re-grade with exit 2. The asks of that slot are in no
 *      record: when the slot made more than one, the `error` text lists them, and it is the only place they are; a
 *      slot that failed on its first ask (every failed slot under `--max-reasks 0`) has the failure as it came.
 *      Later slots are not called and get no row. That slot is lost, and `--go-on-and-count` does not change this: no
 *      slot is ever called after a lost one. A slot the importer will refuse ends the re-grade too: the grader's record
 *      of it is read by the importer's own record check (`parseRecord`) and by the importer's own reading of a slot
 *      (`readSlot`: a last ask that stopped with anything but "end_turn", content that is not zero or more thinking
 *      blocks and one text block, or a finished reply that holds no verdict under the rule stated with `--reading`).
 *      The row is written, with its record, the re-grade ends with exit 2, and no later slot is paid for. With
 *      `--go-on-and-count` the re-grade goes on after such a slot instead, every such slot is counted, and it ends
 *      with exit 0: the script prints `slots the importer will refuse: <k>` (with "(the importer will refuse this
 *      file: <labels>)" when k is not 0, and always with the rule the replies were read under) and `slots with no
 *      finished reply: <k>`. The file stays on disk: it is not importable, and this script never deletes or replaces
 *      it. A further re-grade is a new experiment, reported together with the refused one.
 *
 * The file is this script's own declaration of what it read and handed over, as the grader's record is the grader's.
 * The key is read by the grader from the environment; this script never writes it, and refuses to write a line that
 * holds its text. The path given with `--flow` is not written into the file: a path can hold a home directory and a
 * user name, and the file is kept and may be shared.
 *
 * Exit codes, as `check.ts`: 0 written, 2 refused, 64 usage, 65 an input that does not validate, 70 an error the
 * script did not foresee. Never 1.
 *
 * Local imports: `./flow.ts`, `./selector.ts`, `./render.ts`, `../shared.ts`, and the grader file through
 * `createRequire`; `./strict.ts` directly and through the first two. The header lists each of them, and this script, with its
 * sha256.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { NOT_SENT, sha256Hex } from '../../../src/index.ts';
import { gatewayVariableProblem, REASK_CEILING, TIMEOUT_MS_CEILING, decodeUtf8, GRADER_KEY_ENV_NAME, IMPORT_EXIT, ImportInputError, ImportRefusal, ImportUsageError, inputJsonText, isEntryPoint, isObject, judgeStopOf, oneLineIo, parseCasesFileShape, parseFlagList, parseJsonStrict, positiveIntFlag, printFailure, readingFromFlag, READINGS, readOrUsage, readSlot, runImporterAsProcess, typeName, valueTypeProblems, parseRecord } from '../shared.ts';
import type { CasesFile, Io, Reading } from '../shared.ts';
import { byCodeUnit, HEADER_COUNT_BOUND, readFlow, slotLabel, wholeReps, wholeRepSlots } from './flow.ts';
import type { FlowSlot } from './flow.ts';
import { checkTemplate, promptTextOf, renderTemplate } from './render.ts';
import type { Parts } from './render.ts';
import { parsePointer, selectAll, selectorDefinition } from './selector.ts';
import type { SelectorDefinition } from './selector.ts';
import { isWellFormedText, UNPAIRED_SURROGATE } from './strict.ts';

/** The schema of the file this script writes. It is the example's own, not a library contract. */
export const REGRADE_SCHEMA = 'example.skill-evals-regrade/v4';
/** This script, as the header names it: relative to the repository root. */
export const SCRIPT = 'examples/importers/skill-evals/regrade.ts';
/** The recording grader's file, as the header names it. */
export const GRADER_FILE = 'examples/importers/promptfoo/grader-provider.cjs';
/**
 * This script and every local file under `examples/importers/` it imports, directly or through another, the grader
 * file included; relative to the repository root, sorted. A test finds the same list by reading the import statements.
 * The importer reads this constant: a header must list exactly these paths.
 */
export const SCRIPT_FILES = [
  GRADER_FILE,
  'examples/importers/shared.ts',
  'examples/importers/skill-evals/flow.ts',
  SCRIPT,
  'examples/importers/skill-evals/render.ts',
  'examples/importers/skill-evals/selector.ts',
  'examples/importers/skill-evals/strict.ts',
] as const;
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
/** The variable the grader reads the key from when `--api-key-env` is not given. Used here only to keep the key out of the file. */
const DEFAULT_KEY_ENV = 'ANTHROPIC_API_KEY';
const KEY_REMOVED = '[key removed]';
const MAX_ERROR_CHARS = 2000;

export const REQUIRED_FLAGS = ['--flow', '--variant', '--cases', '--reps', '--rep', '--draws', '--template', '--criterion', '--model', '--max-tokens', '--thinking', '--effort', '--max-reasks', '--base-url', '--reading', '--out'] as const;
export const OPTIONAL_FLAGS = ['--select', '--system', '--temperature', '--timeout-ms', '--api-version', '--api-key-env'] as const;
/** A switch takes no value. `--go-on-and-count`: do not stop at the first slot the importer will refuse (its record, its stop, or a reply with no verdict under the stated rule); count them. A lost slot (a call with no record) ends the re-grade with it as without it. */
export const SWITCH_FLAGS = ['--go-on-and-count'] as const;
type RequiredFlag = (typeof REQUIRED_FLAGS)[number];
type OptionalFlag = (typeof OPTIONAL_FLAGS)[number] | (typeof SWITCH_FLAGS)[number];
export type RegradeFlags = Record<RequiredFlag, string> & Partial<Record<OptionalFlag, string>>;

export const USAGE =
  `usage: node examples/importers/skill-evals/regrade.ts --flow <dir> --variant <name> --cases <cases.json> --reps <n> --rep <k> --draws <n> --template <file> --criterion <file> --model <judge id> --max-tokens <n> --thinking <NOT_SENT | JSON object> --effort <NOT_SENT | level> --max-reasks <0 to 3> --base-url <url> --reading <${READINGS.join(' | ')}> --out <file> [--select <json pointer>] [--system <file>] [--temperature <x>] [--timeout-ms <n>] [--api-version <v>] [--api-key-env <NAME>] [--go-on-and-count]`;

// ---------------------------------------------------------------------------------------------------------------
// What is injected
// ---------------------------------------------------------------------------------------------------------------

/** The configuration handed to the grader: the stated settings, and a key only for a flag that was given. */
export type GraderConfig = {
  model: string;
  max_tokens: number;
  thinking: typeof NOT_SENT | Record<string, unknown>;
  effort: string;
  /** The bound of re-asks per slot, stated with `--max-reasks`: 0 to 3, no default. */
  maxReasks: number;
  temperature?: number;
  /** Stated with `--base-url`, never defaulted: the endpoint decides where the key goes. */
  baseUrl: string;
  timeoutMs?: number;
  apiVersion?: string;
  apiKeyEnv?: string;
};
/** The grader as this script drives it: one prompt in (the JSON text of a message list), one result out. */
export type Grader = {
  callApi(prompt: string): Promise<{ output?: unknown; metadata?: unknown; error?: unknown }>;
  /**
   * What the grader checks about the environment and the key before its first call (a certificate check turned off, an
   * environment proxy, a key that is not set or not visible ASCII). Called once, before `--out` is created, so that a
   * refusal with no request leaves no file. Throws when the call would be refused.
   */
  preflight(): void;
};
/** The output file: lines are appended as they are produced, so a stopped re-grade leaves what it had. */
export type OutFile = { write(text: string): void; close(): void };
export type RegradeDeps = {
  /** Builds the grader from its configuration. A configuration the grader refuses throws here, before any call. */
  graderFactory: (config: GraderConfig) => Grader;
  /** The run id of the re-grade. */
  uuid: () => string;
  /** The clock: the header's `startedAt`. */
  now: () => Date;
  /** Creates `--out` exclusively, or throws a usage error when it exists. */
  openOut: (path: string) => OutFile;
  /** The environment, read only to find the key's text so that it is never written. */
  env: Readonly<Record<string, string | undefined>>;
  io: Io;
};

// ---------------------------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------------------------

/**
 * The flags, by the shared flag parser: each at most once, none unknown, every required one given, and each with a
 * value that is not empty. An empty `--select` is a usage error here as in `check.ts`: to show the judge the whole
 * stored answer, leave the flag out.
 */
export function parseRegradeFlags(argv: readonly string[]): RegradeFlags {
  return parseFlagList(argv, USAGE, REQUIRED_FLAGS, OPTIONAL_FLAGS, SWITCH_FLAGS) as RegradeFlags;
}

/** A count: digits only, from 1 (the path's one count reader); with `max`, at most that. */
const positiveInt = (flag: string, text: string, max?: number): number => positiveIntFlag(flag, text, USAGE, max);

/**
 * A plain decimal number in ASCII digits, such as 0, 0.5 or 1: no sign (so no "-0", which reads as a zero), no exponent,
 * no leading zero. Whether it is in range is the grader's to say.
 */
function decimal(flag: string, text: string): number {
  const n = Number(text);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text) || !Number.isFinite(n)) throw new ImportUsageError(`${flag} must be a plain decimal number, found ${JSON.stringify(text)}. ${USAGE}`);
  return n;
}

/** Where a null, or a value JSON cannot hold unchanged, sits in `v`, by the shared module's one walk; undefined when there is none. */
function unwritable(v: unknown, path: string): string | undefined {
  const found: string[] = [];
  valueTypeProblems(v, path, found);
  return found.length === 0 ? undefined : found.join('; ');
}

/**
 * `--thinking`: `NOT_SENT`, or the text of a JSON object, parsed only so that the grader is handed an object. Which
 * objects are allowed is the grader's rule, not this script's.
 */
function thinkingOf(text: string): typeof NOT_SENT | Record<string, unknown> {
  if (text === NOT_SENT) return NOT_SENT;
  const form = `--thinking must be ${NOT_SENT} or the text of a JSON object, such as '{"type":"adaptive"}'`;
  // The path's one strict reader: a key given twice is refused, since the grader would be handed the last one only.
  const parsed = parseJsonStrict(text);
  if ('why' in parsed) throw new ImportUsageError(`${form}; ${parsed.notJson ? `${JSON.stringify(text)} is not JSON` : parsed.why}. ${USAGE}`);
  const value = parsed.value;
  if (!isObject(value)) throw new ImportUsageError(`${form}; found ${typeName(value)}. ${USAGE}`);
  const why = unwritable(value, '--thinking');
  if (why !== undefined) throw new ImportUsageError(`${form}; ${why}. ${USAGE}`);
  return value;
}

/**
 * `--max-reasks`: an integer from 0 to the ceiling, in plain digits (no sign, no leading zero, no fraction), and nothing
 * else. There is no default. The number is compared with the ceiling as a number.
 */
function maxReasksOf(text: string): number {
  const n = Number(text);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(n) || n > REASK_CEILING) {
    throw new ImportUsageError(`--max-reasks must be an integer from 0 to ${REASK_CEILING} (the re-asks one slot may be given; 0 asks every slot once), found ${JSON.stringify(text)}. ${USAGE}`);
  }
  return n;
}

/**
 * `--timeout-ms`: read by the one count reader, from 1 to the grader's longest deadline, and refused in the grader's
 * own words. A larger value is refused here, before the flow is read, as the grader refuses it before any call.
 */
function timeoutMsOf(text: string): number {
  try {
    return positiveInt('--timeout-ms', text, TIMEOUT_MS_CEILING);
  } catch {
    throw new ImportUsageError(`--timeout-ms must be a positive integer of at most ${TIMEOUT_MS_CEILING} (one hour), found ${JSON.stringify(text)}. ${USAGE}`);
  }
}

/** The grader's configuration from the flags: a flag that was not given is a key that is not there. */
function graderConfigOf(a: RegradeFlags): GraderConfig {
  const config: GraderConfig = {
    model: a['--model'],
    max_tokens: positiveInt('--max-tokens', a['--max-tokens']),
    thinking: thinkingOf(a['--thinking']),
    effort: a['--effort'],
    maxReasks: maxReasksOf(a['--max-reasks']),
    baseUrl: a['--base-url'],
  };
  if (a['--temperature'] !== undefined) config.temperature = decimal('--temperature', a['--temperature']);
  if (a['--timeout-ms'] !== undefined) config.timeoutMs = timeoutMsOf(a['--timeout-ms']);
  if (a['--api-version'] !== undefined) config.apiVersion = a['--api-version'];
  const keyEnv = a['--api-key-env'];
  if (keyEnv !== undefined) {
    // The name of a variable, never a key: the configuration is written into the header. The value is not echoed.
    if (!GRADER_KEY_ENV_NAME.test(keyEnv)) throw new ImportUsageError(`--api-key-env must be the name of an environment variable (letters, digits and underscores), never a key. ${USAGE}`);
    config.apiKeyEnv = keyEnv;
  }
  return config;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------

/** A text input, whole and unchanged: UTF-8 with no byte-order mark, and not empty. Nothing is trimmed. */
function readText(flag: string, path: string): string {
  // The path's one decoder. A file cannot decode to an unpaired surrogate, so these texts are well-formed Unicode.
  const decoded = decodeUtf8(readOrUsage(path));
  if ('why' in decoded) throw new ImportInputError([`${flag}: ${path}: ${decoded.why}`]);
  if (decoded.text === '') throw new ImportInputError([`${flag}: ${path}: the file is empty`]);
  return decoded.text;
}

const textAndHash = (text: string): { text: string; sha256: string } => ({ text, sha256: sha256Hex(text) });

/** The sha256 of this script and of every local file it imports, by path from the repository root. */
function scriptFiles(): { path: string; sha256: string }[] {
  return SCRIPT_FILES.map((path) => ({ path, sha256: sha256Hex(new Uint8Array(readFileSync(join(REPO_ROOT, path)))) })).sort((a, b) => byCodeUnit(a.path, b.path));
}

// ---------------------------------------------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------------------------------------------

/** A text with the key and anything in the form of a key taken out, and cut to a bounded length. */
function scrub(text: string, key: string | undefined): string {
  let out = key === undefined ? text : text.split(key).join(KEY_REMOVED);
  out = out.replace(/\b(x-api-key|authorization|api[-_]?key)\b(["']?\s*[:=]?\s*)(bearer\s+)?["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, `$1$2${KEY_REMOVED}`);
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, KEY_REMOVED);
  return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS)} [cut]` : out;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The text of a failed call. A connection that never reached the endpoint is a TypeError with a cause, whose message
 * alone ("fetch failed") says neither what was called nor why: this adds the cause's code and the address tried, as
 * scheme, host and port only (a user name or password in the base URL is never printed), and the likely reason.
 * Any other error keeps its own message.
 */
function callFailureText(e: unknown, baseUrl: string): string {
  if (!(e instanceof TypeError) || e.cause === undefined) return messageOf(e);
  const cause = e.cause as { code?: unknown; errors?: unknown };
  // A host that resolves to several addresses fails as an AggregateError, whose code is on its members.
  const first = Array.isArray(cause.errors) ? (cause.errors[0] as { code?: unknown } | undefined)?.code : undefined;
  const code = typeof cause.code === 'string' && cause.code !== '' ? cause.code : typeof first === 'string' && first !== '' ? first : undefined;
  let address = '';
  try {
    address = ` calling ${new URL(baseUrl).origin}`;
  } catch {
    // The address is unreadable here: it is not guessed at.
  }
  return `${messageOf(e)} (${code === undefined ? 'cause has no code' : `cause ${code}`})${address}; is the endpoint running and listening there?`;
}

// ---------------------------------------------------------------------------------------------------------------
// The re-grade
// ---------------------------------------------------------------------------------------------------------------

/** One call to make: the source slot whose stored output is graded, and which of its repeated grades this is. */
type Prepared = { slot: FlowSlot; draw: number; label: string; parts: Parts; promptSent: string };

/** The grader's record of one call, or why the result holds none that can be written. */
function recordOf(result: unknown): { record: Record<string, unknown> } | { why: string } {
  if (!isObject(result)) return { why: `the grader returned no record (its result is ${typeName(result)})` };
  if (result['error'] !== undefined) return { why: `the grader returned an error: ${typeof result['error'] === 'string' ? result['error'] : typeName(result['error'])}` };
  const metadata = result['metadata'];
  const record = isObject(metadata) ? metadata['graderEvidence'] : undefined;
  if (!isObject(record)) return { why: 'the grader returned no record (no metadata.graderEvidence object)' };
  const why = unwritable(record, 'graderEvidence');
  if (why !== undefined) return { why: `the grader's record cannot be written unchanged: ${why}` };
  return { record };
}

/**
 * Why the importer will refuse the slot this record belongs to, or undefined when it will not: the importer's own record
 * check (`parseRecord`, which refuses a record of the wrong form in a message that opens with the refusal's code) and its own
 * reading of a slot (`readSlot`: a finished reply, and a verdict in it under the stated rule). Both are the importer's,
 * called here, so the script and the importer cannot disagree about a slot, and there is no second reading in this file.
 * A reply that is not well-formed Unicode is refused in the importer's words too. What only the whole file shows (two
 * grader files, two bounds, a call number hole) is not seen from one slot, and stays the importer's.
 */
function importerRefusal(record: Record<string, unknown>, reading: Reading): string | undefined {
  let parsed: ReturnType<typeof parseRecord>;
  try {
    parsed = parseRecord(record, 'graderEvidence', 'promptfoo');
  } catch (e) {
    if (e instanceof ImportRefusal) return e.message;
    throw e;
  }
  if (!isWellFormedText(parsed.reply)) return `the reply in the record: ${UNPAIRED_SURROGATE}`;
  const read = readSlot(parsed, reading);
  return 'why' in read ? read.why : undefined;
}

/** Whether a record's reply thought, by its `contentTypes`; undefined when the record holds no such list. */
function thought(record: Record<string, unknown>): boolean | undefined {
  const types = record['contentTypes'];
  if (!Array.isArray(types) || !types.every((t) => typeof t === 'string')) return undefined;
  return types.includes('thinking') || types.includes('redacted_thinking');
}

/** How many asks a record holds before its last, by its `reask.earlier`; undefined when the record holds no such list. */
function earlierAsks(record: Record<string, unknown>): number | undefined {
  const reask = record['reask'];
  const earlier = isObject(reask) ? reask['earlier'] : undefined;
  return Array.isArray(earlier) ? earlier.length : undefined;
}

/**
 * Runs the re-grade; returns the exit code. Through `deps` come the grader, the run id, the clock, the output file,
 * the environment (read only for the key's text) and the two print functions. The rest is read from the disk
 * directly, not through `deps`: the cases file, the template, the criterion and the system text (`readOrUsage`), the
 * flow (`readFlow`) and this script's own files for their sha256 (`scriptFiles`).
 */
export async function runRegrade(argv: readonly string[], deps: RegradeDeps): Promise<number> {
  // Every line printed holds text of the flow, of the flags or of the endpoint's answer (a case id, a path, a failure's detail): each is one printed line.
  const io = oneLineIo(deps.io);
  let out: OutFile | undefined;
  let key: string | undefined;
  try {
    // -- 1. the flags, the inputs and the whole variant: every refusal here is before any call --------------------
    const a = parseRegradeFlags(argv);
    // Both are bounded: a list is built from each, and a number beyond the bound would end in an exhausted memory or a hang.
    const reps = positiveInt('--reps', a['--reps'], HEADER_COUNT_BOUND);
    const draws = positiveInt('--draws', a['--draws'], HEADER_COUNT_BOUND);
    // The source rep: digits only, from 0, and one of the declared reps.
    const repText = a['--rep'];
    const rep = Number(repText);
    if (!/^(0|[1-9]\d*)$/.test(repText) || !Number.isSafeInteger(rep)) throw new ImportUsageError(`--rep must be a non-negative integer, found ${JSON.stringify(repText)}. ${USAGE}`);
    if (rep >= reps) throw new ImportUsageError(`--rep ${rep} is not one of the ${reps} declared rep(s) of the flow (--reps ${reps}: reps are 0 to ${reps - 1}). ${USAGE}`);
    // Never empty here: the flag parser refuses an empty value. With the flag left out the judge is shown the whole stored answer.
    const pointer = a['--select'];
    if (pointer !== undefined) parsePointer(pointer);
    const goOn = a['--go-on-and-count'] !== undefined;
    // One of the two rule names, or a usage error that lists both: read by the reader the importers read their flag with.
    const reading = readingFromFlag(a['--reading']);
    const config = graderConfigOf(a);
    const gateway = gatewayVariableProblem(deps.env['ANTHROPIC_BASE_URL'], config.baseUrl);
    if (gateway !== undefined) throw new ImportUsageError(gateway);
    const keyText = deps.env[config.apiKeyEnv ?? DEFAULT_KEY_ENV];
    key = keyText === undefined || keyText === '' ? undefined : keyText;

    // The re-grade takes no bar (the importer checks the classes and labels against one): the shape of the file alone.
    // Through the path's strict reader first: UTF-8 with nothing replaced, and no case id or key given twice.
    const cases: CasesFile = parseCasesFileShape(inputJsonText('cases', readOrUsage(a['--cases'])));
    const template = readText('--template', a['--template']);
    const criterion = readText('--criterion', a['--criterion']);
    const system = a['--system'] === undefined ? undefined : readText('--system', a['--system']);
    checkTemplate(template);
    const flow = readFlow(a['--flow'], a['--variant'], cases, reps);
    // Only the rep that is graded must be whole, and only its slots are selected from: one per case, by case id.
    const graded = wholeRepSlots(flow, rep);
    const answers = pointer === undefined ? graded.map((s) => s.answer) : selectAll(graded, pointer);
    const excludedCaseIds = flow.excluded.map((c) => c.caseId);
    const selector: SelectorDefinition | typeof NOT_SENT = pointer === undefined ? NOT_SENT : selectorDefinition(pointer);

    // The slots, as a number, before the list of them is built: one paid call each, and at most the bound.
    if (graded.length * draws > HEADER_COUNT_BOUND) {
      throw new ImportUsageError(`${graded.length} case(s) x --draws ${draws} is ${graded.length * draws} slots, more than the ${HEADER_COUNT_BOUND} a re-grade takes. ${USAGE}`);
    }

    // -- 2. one prompt per case, from the stored output of the chosen source rep; each is graded `draws` times, in the
    //       order case id then draw (the rep's slots are sorted by case id) ----------------------------------------------
    const prepared: Prepared[] = graded.flatMap((slot, i) => {
      const parts: Parts = { question: slot.prompt, answer: answers[i] as string, criterion };
      const promptSent = promptTextOf(system, renderTemplate(template, parts));
      return Array.from({ length: draws }, (_, draw) => ({ slot, draw, label: slotLabel(slot.caseId, draw), parts, promptSent }));
    });

    const header = {
      schema: REGRADE_SCHEMA,
      regradeRunId: deps.uuid(),
      startedAt: deps.now().toISOString(),
      script: SCRIPT,
      rowProfile: flow.rowProfile,
      // The path given with --flow is not written: it can hold a home directory and a user name.
      variant: flow.variant,
      reps: flow.reps,
      sourceRep: rep,
      draws,
      slotCount: prepared.length,
      // The cases the flow holds and the cases file does not, by id: declared here, never graded.
      excludedCaseIds,
      excludedCaseCount: excludedCaseIds.length,
      resultsSha256: flow.resultsSha256,
      stateSha256: flow.stateSha256,
      harnessSha: flow.harnessSha,
      template: textAndHash(template),
      criterion: textAndHash(criterion),
      system: system === undefined ? NOT_SENT : textAndHash(system),
      selector,
      // The rule every reply is read under here; the importer refuses the file under any other.
      reading,
      graderConfig: config,
      scriptFiles: scriptFiles(),
    };
    const headerLine = JSON.stringify(header);
    const rowBase = (p: Prepared): Record<string, unknown> => ({
      caseId: p.slot.caseId,
      draw: p.draw,
      traceSha256: p.slot.traceSha256,
      storedOutputSha256: p.slot.storedOutputSha256,
      storedOutput: p.slot.answer,
      parts: p.parts,
      promptSent: p.promptSent,
    });
    if (key !== undefined) {
      const k = key;
      const holders = [...(headerLine.includes(k) ? ['the header (a flag, the template, the criterion or the system text)'] : []), ...prepared.filter((p) => JSON.stringify(rowBase(p)).includes(k)).map((p) => `slot ${p.label}`)];
      if (holders.length > 0) throw new ImportUsageError(`an input holds the text of the key, which is never written to a file: ${holders.join(', ')}`);
    }

    // -- 3. the key, the grader, then the file: all before the first call ----------------------------------------------
    // The grader reads the key itself, and finds a missing one only at its first call, when the file would exist and
    // hold a row with an error. It is known here, so it is said here: nothing is built and nothing is created.
    if (key === undefined) {
      throw new ImportUsageError(`the environment variable ${config.apiKeyEnv ?? DEFAULT_KEY_ENV} is not set (or is empty); the grader reads the key from it. Nothing was written and no call was made.`);
    }
    let grader: Grader;
    try {
      grader = deps.graderFactory(config);
    } catch (e) {
      throw new ImportUsageError(`the grader refused its configuration: ${scrub(messageOf(e), key)}`);
    }
    // What the grader checks before its first call (the environment, the key's form), now and not at the first call, when the file would exist.
    try {
      grader.preflight();
    } catch (e) {
      throw new ImportUsageError(`the grader refused to start: ${scrub(messageOf(e), key)}. Nothing was written and no call was made.`);
    }
    out = deps.openOut(a['--out']);
    const written: string[] = [];
    const write = (line: string): void => {
      (out as OutFile).write(`${line}\n`);
      written.push(`${line}\n`);
    };
    write(headerLine);

    // -- 4. one grader call per slot (the grader asks again inside it, within the bound); the first failure ends the re-grade
    const records: Record<string, unknown>[] = [];
    // The slots the importer will refuse (a record of the wrong form, a last ask that is not a finished reply, or a reply with no verdict under the rule), by label.
    const refusable: string[] = [];
    for (const [i, p] of prepared.entries()) {
      let failure: string | undefined;
      let stopAt: string | undefined;
      let line = '';
      try {
        const got = recordOf(await grader.callApi(p.promptSent));
        if ('why' in got) failure = got.why;
        else {
          line = JSON.stringify({ ...rowBase(p), graderEvidence: got.record });
          if (key !== undefined && line.includes(key)) failure = "the grader's record holds the text of the key; the record was not written";
          else {
            records.push(got.record);
            const why = importerRefusal(got.record, reading);
            if (why !== undefined) {
              refusable.push(p.label);
              if (!goOn) stopAt = why;
            }
          }
        }
      } catch (e) {
        failure = `the grader's call failed: ${callFailureText(e, config.baseUrl)}`;
      }
      if (failure !== undefined) {
        const error = scrub(failure, key);
        write(JSON.stringify({ ...rowBase(p), error }));
        io.err(`REFUSED the re-grade ended at slot ${p.label} (slot ${i + 1} of ${prepared.length}): ${error}`);
        io.err(`fields: ${p.label}`);
        io.err(`slots graded: ${records.length} of ${prepared.length}`);
        io.err(`${a['--out']} is kept (the header and ${i + 1} row(s), the last with no record). It is not importable, and this script never deletes or replaces it. No later slot was called, with or without --go-on-and-count: that flag counts slots that have a record, and this one has none. A further re-grade is a new experiment: report it together with this refused one.`);
        return IMPORT_EXIT.refused;
      }
      write(line);
      if (stopAt !== undefined) {
        // The row is kept with its record; no later slot is called.
        io.err(`REFUSED the re-grade stopped at slot ${p.label} (slot ${i + 1} of ${prepared.length}): the importer will refuse it: ${scrub(stopAt, key)}`);
        io.err(`fields: ${p.label}`);
        io.err(`slots graded: ${records.length} of ${prepared.length}`);
        io.err(`${a['--out']} is kept (the header and ${i + 1} row(s), the last holding the record the importer will refuse). It is not importable, and this script never deletes or replaces it. No later slot was called; --go-on-and-count goes on instead and counts such slots. A further re-grade is a new experiment: report it together with this refused one.`);
        return IMPORT_EXIT.refused;
      }
    }

    // -- 5. what was written ---------------------------------------------------------------------------------------------
    const thinking = records.map(thought);
    const unstated = thinking.filter((t) => t === undefined).length;
    io.out(`wrote: ${a['--out']}`);
    io.out(`sha256: ${sha256Hex(written.join(''))}`);
    io.out(`re-grade run id: ${header.regradeRunId}`);
    // The asks made: one per slot, and the re-asks the records hold. A cut reply that was asked again is in this count.
    const earlier = records.map(earlierAsks);
    const reasks = earlier.reduce<number>((sum, n) => sum + (n ?? 0), 0);
    const asks = earlier.some((n) => n === undefined) ? 'asks made: not stated (a record holds no list of earlier asks)' : `${records.length + reasks} ask${records.length + reasks === 1 ? '' : 's'} made (${reasks} re-ask${reasks === 1 ? '' : 's'}; at most ${config.maxReasks} per slot)`;
    io.out(`slots graded: ${records.length} of ${prepared.length}, ${asks}, in the order case id then draw (source rep ${rep}, each stored output graded ${draws} time${draws === 1 ? '' : 's'})`);
    // A record is written for a slot whose last ask was cut, or stopped in any way but a finished reply; the importer
    // refuses a file that holds one. Printed with a zero too, so that its absence is never read as "none".
    const unfinished = records.filter((r) => typeof r['stopReason'] !== 'string' || judgeStopOf(r['stopReason']) === undefined).length;
    io.out(`slots with no finished reply: ${unfinished}${unfinished > 0 ? ' (the importer will refuse this file)' : ''}`);
    // Printed with a zero too. Without --go-on-and-count the re-grade stopped at the first such slot, so a count above 0 is reached only with it.
    // The first 20 labels are named; the rest are counted.
    const named = refusable.slice(0, 20).join(', ') + (refusable.length > 20 ? `, and ${refusable.length - 20} more` : '');
    // The line says what was read and under which rule: a record of the wrong form or a last ask that is not a finished reply
    // has no reply to read, and every other reply was read under the stated rule.
    io.out(`slots the importer will refuse: ${refusable.length}${refusable.length > 0 ? ` (the importer will refuse this file: ${named})` : ''}; every reply of a finished, well-formed record was read under the reading rule ${reading}`);
    io.out(`excluded cases (in the flow, not in the cases file; not graded): ${excludedCaseIds.length}${excludedCaseIds.length > 0 ? ` (${excludedCaseIds.join(', ')})` : ''}`);
    const others = wholeReps(flow);
    io.out(`reps of the flow that are whole: ${others.length} of ${flow.reps} (${others.join(', ')}); only rep ${rep} was required to be, and check.ts lists what is wrong with any other`);
    io.out(unstated > 0 ? `replies with a thinking block: not stated (${unstated} of ${records.length} record(s) hold no contentTypes list)` : `replies with a thinking block: ${thinking.filter((t) => t === true).length} of ${records.length}`);
    return IMPORT_EXIT.written;
  } catch (e) {
    return printFailure(io, e, (text) => scrub(text, key));
  } finally {
    out?.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The defaults: the one place that touches the disk for writing, and the one that loads the grader
// ---------------------------------------------------------------------------------------------------------------

/**
 * Creates the output file exclusively: the open itself fails when the path exists, so there is no look before the
 * write for another process to slip into. An existing file is a usage error and is left as it is.
 */
export function openExclusive(path: string): OutFile {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new ImportUsageError(`${path} exists; a re-grade never overwrites --out`);
    throw new ImportUsageError(`cannot create ${path} (${code ?? 'error'})`);
  }
  return {
    write: (text: string): void => {
      const bytes = Buffer.from(text, 'utf8');
      for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
    },
    close: (): void => closeSync(fd),
  };
}

/** The promptfoo path's recording grader: one grader file, one sha256, across the two paths. Loading it makes no call. */
export function loadGraderClass(): new (options: { config: GraderConfig }) => Grader {
  const require = createRequire(import.meta.url);
  return require('../promptfoo/grader-provider.cjs') as new (options: { config: GraderConfig }) => Grader;
}

/** The dependencies of a real run. */
export function defaultDeps(io: Io): RegradeDeps {
  return {
    graderFactory: (config) => new (loadGraderClass())({ config }),
    uuid: randomUUID,
    now: () => new Date(),
    openOut: openExclusive,
    env: process.env,
    io,
  };
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  runImporterAsProcess((argv, io) => runRegrade(argv, defaultDeps(io)), 'regrade');
}
