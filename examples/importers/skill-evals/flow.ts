/**
 * The reader of a flow directory, as an outside eval-building skill's runner leaves it on disk:
 *
 *   <flow>/_state.json
 *   <flow>/<variant>/results.jsonl            one JSON object per line, appended as cases finish, in no order
 *   <flow>/<variant>/errors.jsonl             optional; append-only across resumes
 *   <flow>/<variant>/traces/<id>_rep<k>.json  a JSON list of turns
 *
 * The source states no version, so this file pins its own row profile, `skill-evals/1`: five keys of a row with
 * strict types, every other key ignored, and a trace that is exactly `[system?, user, assistant]`. A flow outside the
 * profile is refused whole, with every offending slot listed. Each rep of a case is one fresh system output, so the
 * reps of a case are not repeated grades of one output and are never a run's draws: a re-grade picks one source rep
 * and grades its stored output several times (`regrade.ts`). A slot here is a case and a source rep. The source's own
 * grades are never read.
 *
 * Three things are listed and not refused, since a flow can hold a failed or a cut case:
 *   - a slot of a stated case that has no row, or whose row is not a finished answer, makes its REP not whole. The
 *     reader says so per rep (`notWhole`); only the rep that is graded must be whole (`wholeRepSlots`);
 *   - a row or an error line of a case that is not in the cases file: the cases file is the user's declaration of
 *     what is measured, so such a case is excluded and listed (`excluded`). Its rows must still read under the row
 *     profile; its traces are not read;
 *   - a `_state.json` that is not there: its sha256 and `harness_sha` are then the gap marker.
 * `harness_sha`, where the file states one, is 64 lowercase hexadecimal characters: it is carried into a re-grade
 * file's header and a run's `packetSource`, and printed from there, so no other text is taken.
 * A stated case with no row at all, and everything else outside the profile, in any rep, refuses the flow.
 *
 * `validateFlow` is pure: it takes the files as bytes. `readFlowFiles` is the one function here that touches the
 * disk; it follows no symlink and writes nothing. This file imports only from `../shared.ts`, `./strict.ts`, the
 * library's public entry and Node built-ins.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { GAP, isSha256Hex, outputHashOf, sha256Hex } from '../../../src/index.ts';
import { decodeUtf8, ImportRefusal, ImportUsageError, isCount, isObject, parseJsonStrict, slotLabel, typeName } from '../shared.ts';
import type { CasesFile, ImportRefusalCode } from '../shared.ts';
import { isWellFormedText, UNPAIRED_SURROGATE } from './strict.ts';

/** The row profile this reader pins. It is the importer's, not a fact the source states. */
export const ROW_PROFILE = 'skill-evals/1';
/** The only names a variant directory has in the source. */
const VARIANT_NAME = /^(baseline|v[1-9]\d*)$/;
/** A path-safe case id, as the source's runner writes it: word characters, dots and hyphens, at most 129 of them. */
const PATH_SAFE_ID = /^[\w.-]{1,129}$/;
const STATE_FILE = '_state.json';
/**
 * The most this path takes for a count: the declared reps of a flow (`--reps`), the draws of a re-grade (`--draws`),
 * the slots of a re-grade, and each count a re-grade file's header states. A re-grade makes one grader call per slot,
 * one after another, so a real count is far below it. It bounds every list this path builds from a stated number.
 */
export const HEADER_COUNT_BOUND = 100000;

/**
 * The declared rep count: a positive integer of at most the bound, else a usage error. So is a count whose slots of
 * the flow (the cases of the cases file times the declared reps) are beyond the bound: the reader looks for each of
 * those slots, and lists each one that is missing, so their number is held before any loop over them is entered.
 */
function checkDeclaredReps(reps: number, cases: CasesFile): void {
  if (!isCount(reps)) throw new ImportUsageError(`--reps must be a positive integer, found ${String(reps)}`);
  if (reps > HEADER_COUNT_BOUND) throw new ImportUsageError(`--reps must be at most ${HEADER_COUNT_BOUND}, found ${reps}`);
  const caseCount = Object.keys(cases).length;
  if (flowSlotCount(caseCount, reps) > HEADER_COUNT_BOUND) throw new ImportUsageError(flowSlotsWords(caseCount, reps));
}

/** The slots of a flow that the reader looks for: the cases of the cases file times the declared reps. */
export const flowSlotCount = (caseCount: number, reps: number): number => caseCount * reps;

/** Why a cases file and a declared rep count are refused together: the one wording, in the reader and in the importer. */
export const flowSlotsWords = (caseCount: number, reps: number): string =>
  `${caseCount} case(s) of the cases file x ${reps} declared rep(s) is ${flowSlotCount(caseCount, reps)} slots of the flow, more than the ${HEADER_COUNT_BOUND} this path takes`;

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/** What was found at a path that is not the regular file or directory expected there. */
export type NotRead = 'missing' | 'symlink' | 'other';
/** The bytes of a regular file, or why it was not read. */
export type FileRead = Uint8Array | NotRead;
/** The files of one variant of a flow, as read from disk with no symlink followed. */
export type FlowFiles = {
  flowDir: 'dir' | NotRead;
  variantDir: 'dir' | NotRead;
  tracesDir: 'dir' | NotRead;
  /** `<flow>/_state.json`. */
  state: FileRead;
  /** `<flow>/<variant>/results.jsonl`. */
  results: FileRead;
  /** `<flow>/<variant>/errors.jsonl`; `'missing'` is the usual case. */
  errors: FileRead;
  /** Every entry of `<flow>/<variant>/traces`, by file name. */
  traces: ReadonlyMap<string, FileRead>;
};

/** One validated slot: a case, a rep, the question the system was asked and the whole assistant turn it answered. */
export type FlowSlot = {
  caseId: string;
  /** The source rep's number, from 0. The field keeps its first name; it is not a draw of a run. */
  draw: number;
  prompt: string;
  /** The content of the one assistant turn of the slot's trace, whole. */
  answer: string;
  /** The sha256 of the trace file's bytes. */
  traceSha256: string;
  /** The sha256 of `answer`: over the whole assistant turn, whatever a selector later picks from it. */
  storedOutputSha256: string;
};

/** A line of `errors.jsonl` for a slot of a stated case that also has a row: a failed attempt a later one replaced. */
export type SupersededError = { caseId: string; draw: number; line: number };

/** A rep that is not whole, with every reason: a slot of a stated case with no row, or with a row that is not a finished answer. */
export type RepProblems = { rep: number; problems: FlowProblem[] };

/**
 * A case the flow holds and the cases file does not: excluded by the user's declaration. Its rows are listed with
 * whether each reads as a finished answer; its traces are not read, and nothing of it is graded.
 */
export type ExcludedCase = {
  caseId: string;
  /** The rows of `results.jsonl` that hold this id, in file order. */
  rows: { line: number; rep: number; finished: boolean }[];
  /** The lines of `errors.jsonl` that hold this id, in file order. */
  errorLines: number[];
};

export type FlowRead = {
  rowProfile: typeof ROW_PROFILE;
  variant: string;
  reps: number;
  /** The ids of the cases file, in the one order of this path: the cases a whole rep holds a slot for. */
  statedCases: string[];
  /** Every finished slot of a stated case, with its trace read. In a fixed order: case id, then rep. */
  slots: FlowSlot[];
  /** The reps that are not whole, by rep; a rep that is not here holds a finished slot for every stated case. */
  notWhole: RepProblems[];
  /** The cases the flow holds and the cases file does not, by case id. */
  excluded: ExcludedCase[];
  /** In the order of the lines of `errors.jsonl`. */
  superseded: SupersededError[];
  resultsSha256: string;
  /** The sha256 of `_state.json`, or the gap marker "UNKNOWN" when the flow holds no such file. */
  stateSha256: string;
  /**
   * `harness_sha` of `_state.json` as read, when the file holds one: 64 lowercase hexadecimal characters. The gap
   * marker "UNKNOWN" otherwise (no such key, or no such file). It is the source's own declaration (one value per
   * flow, replaced on each approval): its form is held, and what it is the hash of is never checked.
   */
  harnessSha: string;
  /** Entries of the traces directory that no slot names; they were not validated and bind nothing. */
  unusedTraces: string[];
};

/** One reason a flow is refused. `field` is the slot (`<case>#<rep>`) when it is known, else a file or a line of one. */
export type FlowProblem = { code: ImportRefusalCode; field: string; message: string };

/**
 * A flow this reader will not hand on. It lists every problem found, in the order of the checks; `code` is the code
 * of the first, and `fields` names every offending slot, file or line once.
 */
export class FlowRefusal extends ImportRefusal {
  readonly problems: readonly FlowProblem[];
  constructor(problems: readonly FlowProblem[], where = 'the flow') {
    const first = problems[0];
    if (first === undefined) throw new Error('FlowRefusal: no problem given');
    super(first.code, [...new Set(problems.map((p) => p.field))], `${problems.length} problem(s) in ${where} (row profile ${ROW_PROFILE}): ${problems.map((p) => p.message).join('; ')}`);
    this.name = 'FlowRefusal';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
// How this path names a slot in a message and in a refusal's fields, `<case>#<number>`, is the shared module's one way.
export { slotLabel };
const traceName = (caseId: string, draw: number): string => `${caseId}_rep${draw}.json`;
/** The one order of this path's lists (case ids, file names, paths): by UTF-16 code unit, whatever the locale. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A symlink is a path this reader will not follow (`IMPORT_PATH`); a file that is missing or of another kind is a flow of another shape. */
const notReadCode = (kind: NotRead): ImportRefusalCode => (kind === 'symlink' ? 'IMPORT_PATH' : 'IMPORT_SHAPE');
const NOT_READ_WORDS: Record<NotRead, string> = { missing: 'missing', symlink: 'a symlink, which this reader never follows', other: 'not a regular file' };

/** Whether a text is a path-safe case id, as the source's runner writes one. */
export const isPathSafeId = (text: string): boolean => PATH_SAFE_ID.test(text);

/** What a user can do about a case that failed or was cut: said in every refusal that such a case causes. */
const WAY_OUT = 'to measure without this case, leave it out of cases.json: it is then listed as excluded';

/** Why `name` is not a variant's name, or undefined when it is `baseline` or `v<N>`. */
export function variantNameProblem(name: string): string | undefined {
  return VARIANT_NAME.test(name) ? undefined : `variant: ${JSON.stringify(name)} is not "baseline" or "v<N>" (N from 1, no leading zero), the only names a variant directory has`;
}

/** The lines of a `.jsonl` text that hold anything, with their 1-based line numbers. */
function jsonLines(text: string): { line: number; text: string }[] {
  return text.split('\n').map((t, i) => ({ line: i + 1, text: t })).filter((l) => l.text.trim() !== '');
}

// Every file of a flow is decoded by the path's one decoder (`decodeUtf8`), and every JSON text in it (the state file,
// a row, an error line, a trace) is read by the path's one strict reader (`parseJsonStrict`): a key given twice in
// one object refuses the text, where the plain parser would keep the last and say nothing. A question or a stored
// output that holds an unpaired surrogate (which a JSON escape can spell) is refused too: the library hashes such a
// text as it hashes another, so two different stored outputs would be one to every later check.

/** `attachments` is acceptable only when the key is absent or holds an empty list. */
const noAttachments = (o: Obj): boolean => !('attachments' in o) || (Array.isArray(o['attachments']) && o['attachments'].length === 0);

// ---------------------------------------------------------------------------------------------------------------
// The trace of one slot
// ---------------------------------------------------------------------------------------------------------------

const TURN_KEYS = ['role', 'content', 'name', 'attachments'];
const TRACE_SHAPE = '[system?, user, assistant]';

/** The assistant turn of a trace that is exactly `[system?, user, assistant]`, or every reason it is not one. */
function readTrace(bytes: Uint8Array, slot: string, where: string, prompt: string): { answer: string } | { problems: FlowProblem[] } {
  const one = (code: ImportRefusalCode, what: string): { problems: FlowProblem[] } => ({ problems: [{ code, field: slot, message: `${where}: ${what}` }] });
  const decoded = decodeUtf8(bytes);
  if ('why' in decoded) return one('IMPORT_SHAPE', decoded.why);
  const parsed = parseJsonStrict(decoded.text);
  if ('why' in parsed) return one('IMPORT_SHAPE', parsed.why);
  const turns = parsed.value;
  if (!Array.isArray(turns)) return one('IMPORT_SHAPE', `expected a JSON list of turns ${TRACE_SHAPE}, found ${typeName(turns)}`);

  const problems: FlowProblem[] = [];
  const bad = (code: ImportRefusalCode, what: string): void => {
    problems.push({ code, field: slot, message: `${where}: ${what}` });
  };
  const roles = turns.map((t) => (isObject(t) ? (typeof t['role'] === 'string' ? t['role'] : '(no role)') : '(not an object)'));
  const outside = roles.map((role, i) => ({ role, i })).filter((r) => !['system', 'user', 'assistant', '(no role)', '(not an object)'].includes(r.role));
  for (const r of outside) bad('IMPORT_PACKET', `turn ${r.i}: role ${JSON.stringify(r.role)}: a tool turn, or any role but system, user and assistant, is outside the single-turn text this reader takes`);
  const order = roles.join(', ');
  if (outside.length === 0 && order !== 'user, assistant' && order !== 'system, user, assistant') {
    bad('IMPORT_SHAPE', `the turns are [${order}], not exactly ${TRACE_SHAPE}`);
  }
  turns.forEach((t, i) => {
    if (!isObject(t)) return;
    if ('thinking' in t) bad('IMPORT_PACKET', `turn ${i}: thinking: a turn with thinking is refused; the judge would not be shown what the system produced`);
    if (!noAttachments(t)) bad('IMPORT_PACKET', `turn ${i}: attachments: a turn with attachments is refused; the judge would see less than the system saw`);
    for (const k of Object.keys(t)) if (!TURN_KEYS.includes(k) && k !== 'thinking') bad('IMPORT_SHAPE', `turn ${i}: ${k}: a key outside role, content, name and attachments`);
    if ('name' in t && typeof t['name'] !== 'string') bad('IMPORT_SHAPE', `turn ${i}: name: expected string, found ${typeName(t['name'])}`);
    const content = t['content'];
    if (typeof content !== 'string') bad('IMPORT_SHAPE', `turn ${i}: content: expected string, found ${'content' in t ? typeName(content) : 'nothing'}`);
    // The system turn is not used (the judge is never shown it, and nothing of it is hashed), so its text may be empty.
    else if (content === '' && t['role'] !== 'system') bad('IMPORT_SHAPE', `turn ${i}: content: the text is empty`);
    // The two turns whose text is hashed as text: the question and the stored output. (A file's own hash is over its bytes.)
    else if ((t['role'] === 'user' || t['role'] === 'assistant') && !isWellFormedText(content)) bad('IMPORT_SHAPE', `turn ${i}: content: ${UNPAIRED_SURROGATE}`);
  });
  if (problems.length > 0) return { problems };

  const user = turns[turns.length - 2] as Obj;
  const assistant = turns[turns.length - 1] as Obj;
  if (user['content'] !== prompt) return one('IMPORT_PACKET', `the user turn differs from the row's prompt; the question the system was asked is then not known`);
  return { answer: assistant['content'] as string };
}

// ---------------------------------------------------------------------------------------------------------------
// The validation (pure)
// ---------------------------------------------------------------------------------------------------------------

/** `ok`: the row reads under the profile. `finished`: its status and stop say the stored output is a finished answer. */
type Row = { line: number; caseId: string; draw: number; prompt: string; ok: boolean; finished: boolean };
type ErrorLine = { line: number; caseId: string; draw: number };

/**
 * Validates the files of one variant against the row profile, the stated cases and the declared rep count, and
 * returns the finished slots in a fixed order (case id, then rep), the reps that are not whole and the excluded
 * cases. Throws `FlowRefusal` listing every problem that refuses the flow whatever rep is graded. Pure.
 *
 * It does not say that any rep is whole: a caller that grades a rep takes its slots through `wholeRepSlots`.
 *
 * `reps` is the user's declaration: completeness rests on it, never on the rows seen, since a flow stopped evenly
 * early looks complete. A declared count that is not a positive integer, or is beyond `HEADER_COUNT_BOUND`, is a
 * usage error, and so is one that, times the cases of the cases file, is beyond it. A `_state.json` whose own rep
 * count is not the declared one refuses the flow before any slot of the declared reps is looked for: nothing is
 * counted against a declaration the flow contradicts.
 */
export function validateFlow(files: FlowFiles, variant: string, cases: CasesFile, reps: number): FlowRead {
  checkDeclaredReps(reps, cases);
  const nameProblem = variantNameProblem(variant);
  if (nameProblem !== undefined) throw new FlowRefusal([{ code: 'IMPORT_PATH', field: 'variant', message: nameProblem }]);
  if (files.flowDir !== 'dir') {
    throw new FlowRefusal([{ code: notReadCode(files.flowDir), field: 'flow', message: `flow: the flow path is ${files.flowDir === 'symlink' ? 'a symlink, which this reader never follows' : files.flowDir === 'missing' ? 'missing' : 'not a directory'}` }]);
  }

  const problems: FlowProblem[] = [];
  const bad = (code: ImportRefusalCode, field: string, message: string): void => {
    problems.push({ code, field, message });
  };
  const resultsFile = `${variant}/results.jsonl`;
  const errorsFile = `${variant}/errors.jsonl`;
  const tracesPath = `${variant}/traces`;

  // -- the state file: an object; a rep count in it, where one is present, must be the declared one ------------------
  // A flow can be without the file (the source writes it at an approval). Then nothing of it is known, and both values
  // are the explicit gap marker. A file that is there and is a symlink, another kind of file or malformed still refuses.
  let stateSha256: string = GAP;
  let harnessSha: string = GAP;
  let repsContradicted = false;
  if (files.state === 'missing') {
    // Accepted: the gap marker stands for both values.
  } else if (typeof files.state === 'string') bad(notReadCode(files.state), STATE_FILE, `${STATE_FILE}: ${NOT_READ_WORDS[files.state]}`);
  else {
    stateSha256 = sha256Hex(files.state);
    const decoded = decodeUtf8(files.state);
    const parsed = 'why' in decoded ? decoded : parseJsonStrict(decoded.text);
    if ('why' in parsed) bad('IMPORT_SHAPE', STATE_FILE, `${STATE_FILE}: ${parsed.why}`);
    else if (!isObject(parsed.value)) bad('IMPORT_SHAPE', STATE_FILE, `${STATE_FILE}: expected a JSON object, found ${typeName(parsed.value)}`);
    else {
      if ('reps' in parsed.value) {
        const stated = parsed.value['reps'];
        if (!isCount(stated)) bad('IMPORT_DRAW_COUNT', STATE_FILE, `${STATE_FILE}: reps is ${JSON.stringify(stated)}, not a positive integer; the declared count is ${reps}`);
        else if (stated !== reps) bad('IMPORT_DRAW_COUNT', STATE_FILE, `${STATE_FILE}: reps is ${stated}, the declared count is ${reps}`);
        repsContradicted = stated !== reps;
      }
      // A key that is there must hold 64 lowercase hexadecimal characters: never a null, a number, a gap word or free
      // text. The value goes into a header, a run's `packetSource` and a printed report, so its form is held here.
      // What is shown of a value that is refused is its JSON, cut short: a line feed in it is shown as an escape.
      if ('harness_sha' in parsed.value) {
        const sha = parsed.value['harness_sha'];
        if (!isSha256Hex(sha)) {
          bad('IMPORT_SHAPE', STATE_FILE, `${STATE_FILE}: harness_sha is ${typeof sha === 'string' ? JSON.stringify(sha.slice(0, 40)) : typeName(sha)}, not 64 lowercase hexadecimal characters; leave the key out when there is none`);
        } else harnessSha = sha as string;
      }
    }
  }

  // -- the variant's directory and its files -------------------------------------------------------------------------
  if (files.variantDir !== 'dir') {
    bad(notReadCode(files.variantDir), variant, `${variant}: the variant directory is ${files.variantDir === 'other' ? 'not a directory' : NOT_READ_WORDS[files.variantDir]}`);
    throw new FlowRefusal(problems);
  }
  if (typeof files.results === 'string') {
    bad(notReadCode(files.results), resultsFile, `${resultsFile}: ${NOT_READ_WORDS[files.results]}`);
    throw new FlowRefusal(problems);
  }
  const resultsSha256 = sha256Hex(files.results);
  const resultsText = decodeUtf8(files.results);
  if ('why' in resultsText) {
    bad('IMPORT_SHAPE', resultsFile, `${resultsFile}: ${resultsText.why}`);
    throw new FlowRefusal(problems);
  }
  const lines = jsonLines(resultsText.text);
  if (lines.length === 0) {
    bad('IMPORT_SHAPE', resultsFile, `${resultsFile}: the file holds no row`);
    throw new FlowRefusal(problems);
  }
  const tracesUsable = files.tracesDir === 'dir';
  if (!tracesUsable) bad(notReadCode(files.tracesDir as NotRead), tracesPath, `${tracesPath}: the traces directory is ${files.tracesDir === 'other' ? 'not a directory' : NOT_READ_WORDS[files.tracesDir as NotRead]}; a slot's stored output is read from its trace`);

  // -- every row: the five keys of the profile, attachments, a finished answer ----------------------------------------
  const roster = Object.keys(cases).sort(byCodeUnit);
  const inRoster = (id: string): boolean => Object.hasOwn(cases, id);
  // What makes a rep not whole, by rep: listed, and a refusal only for the rep that is graded.
  const byRep = new Map<number, FlowProblem[]>();
  const repBad = (rep: number, code: ImportRefusalCode, field: string, message: string): void => {
    const list = byRep.get(rep);
    if (list === undefined) byRep.set(rep, [{ code, field, message }]);
    else list.push({ code, field, message });
  };
  const rows: Row[] = [];
  for (const l of lines) {
    const at = `${resultsFile}:${l.line}`;
    const parsed = parseJsonStrict(l.text);
    if ('why' in parsed || !isObject(parsed.value)) {
      bad('IMPORT_SHAPE', at, `${at}: ${'why' in parsed ? parsed.why : `expected a JSON object, found ${typeName(parsed.value)}`}`);
      continue;
    }
    const row = parsed.value;
    const idWhy = ((): string | undefined => {
      const spelled = ['id', 'case_id'].filter((k) => k in row);
      const id = row['prompt_id'];
      if (!('prompt_id' in row)) {
        const other = spelled[0];
        return other === undefined ? 'missing' : `missing; the case id is spelled ${JSON.stringify(other)}, and this profile reads prompt_id only`;
      }
      if (typeof id !== 'string') return `expected string, found ${typeName(id)}`;
      if (!PATH_SAFE_ID.test(id)) return `${JSON.stringify(id.slice(0, 40))} is not a path-safe id (word characters, dots and hyphens, 1 to 129 of them); its trace would not be a file of this flow`;
      return undefined;
    })();
    const rep = row['rep'];
    const repWhy = !('rep' in row) ? 'missing' : typeof rep === 'number' && Number.isSafeInteger(rep) && rep >= 0 ? undefined : `expected an integer from 0, found ${typeof rep === 'number' ? String(rep) : typeName(rep)}`;
    // The slot is named only when both its id and its rep can be read; else the line is.
    const named = idWhy === undefined && repWhy === undefined;
    const caseId = named ? (row['prompt_id'] as string) : '';
    const draw = named ? (rep as number) : -1;
    const field = named ? slotLabel(caseId, draw) : at;
    const before = problems.length;
    if (idWhy !== undefined) bad('IMPORT_CASE_ID', field, `${at}: prompt_id: ${idWhy} (row profile ${ROW_PROFILE})`);
    else {
      const also = ['id', 'case_id'].filter((k) => k in row);
      if (also.length > 0) bad('IMPORT_CASE_ID', field, `${at}: ${also.join(', ')}: the row holds a second spelling of the case id beside prompt_id; this profile reads prompt_id only and will not choose between them`);
    }
    if (repWhy !== undefined) bad('IMPORT_SHAPE', field, `${at}: rep: ${repWhy} (row profile ${ROW_PROFILE})`);
    const prompt = row['prompt'];
    if (!('prompt' in row)) bad('IMPORT_SHAPE', field, `${at}: prompt: missing (row profile ${ROW_PROFILE})`);
    else if (typeof prompt !== 'string') bad('IMPORT_SHAPE', field, `${at}: prompt: expected string, found ${typeName(prompt)}`);
    else if (prompt === '') bad('IMPORT_SHAPE', field, `${at}: prompt: the text is empty`);
    else if (!isWellFormedText(prompt)) bad('IMPORT_SHAPE', field, `${at}: prompt: ${UNPAIRED_SURROGATE}`);
    for (const key of ['status', 'stop_reason']) {
      if (!(key in row)) bad('IMPORT_SHAPE', field, `${at}: ${key}: missing (row profile ${ROW_PROFILE})`);
      else if (typeof row[key] !== 'string') bad('IMPORT_SHAPE', field, `${at}: ${key}: expected string, found ${typeName(row[key])}`);
    }
    if (!noAttachments(row)) bad('IMPORT_PACKET', field, `${at}: attachments: the row holds attachments (or a value that is not an empty list); the judge would see less than the system saw`);
    const ok = problems.length === before;
    // A value read to refuse, never written as identity: the stored output must be a finished answer. Where the row
    // is a slot of a stated case within the declared reps, an unfinished answer makes that rep not whole; where the
    // row is of a case outside the cases file, it is only noted; anywhere else it refuses the flow.
    const unfinished: string[] = [];
    if (typeof row['status'] === 'string' && row['status'] !== 'ok') unfinished.push(`${at}: status ${JSON.stringify(row['status'])}, not "ok": the stored output is not a finished answer`);
    if (typeof row['stop_reason'] === 'string' && row['stop_reason'] !== 'end_turn') unfinished.push(`${at}: stop_reason ${JSON.stringify(row['stop_reason'])}, not "end_turn": the stored output is not a finished answer`);
    for (const message of unfinished) {
      if (!named) bad('IMPORT_OUTPUT_UNFINISHED', field, message);
      else if (!inRoster(caseId)) continue;
      else if (draw < reps) repBad(draw, 'IMPORT_OUTPUT_UNFINISHED', field, `${message}; ${WAY_OUT}`);
      else bad('IMPORT_OUTPUT_UNFINISHED', field, message);
    }
    if (named) rows.push({ line: l.line, caseId, draw, prompt: typeof prompt === 'string' ? prompt : '', ok, finished: unfinished.length === 0 });
  }

  // -- errors.jsonl: read before the roster, so a missing slot can name its failed attempts ---------------------------
  const errorLines: ErrorLine[] = [];
  if (files.errors !== 'missing') {
    if (typeof files.errors === 'string') bad(notReadCode(files.errors), errorsFile, `${errorsFile}: ${NOT_READ_WORDS[files.errors]}`);
    else {
      const decoded = decodeUtf8(files.errors);
      if ('why' in decoded) bad('IMPORT_SHAPE', errorsFile, `${errorsFile}: ${decoded.why}`);
      else {
        for (const l of jsonLines(decoded.text)) {
          const at = `${errorsFile}:${l.line}`;
          const parsed = parseJsonStrict(l.text);
          const v = 'why' in parsed ? undefined : parsed.value;
          if (!isObject(v) || typeof v['prompt_id'] !== 'string' || !(typeof v['rep'] === 'number' && Number.isSafeInteger(v['rep']) && v['rep'] >= 0)) {
            bad('IMPORT_SHAPE', at, `${at}: ${'why' in parsed ? parsed.why : 'not an object with a string prompt_id and an integer rep'}; which slot failed cannot be read`);
            continue;
          }
          errorLines.push({ line: l.line, caseId: v['prompt_id'], draw: v['rep'] });
        }
      }
    }
  }

  // -- the roster times the reps: a stated case holds some row; each of its slots at most once and within the reps ------
  // The flow's own rep count is not the declared one: refused here, with what was found so far, before any slot of
  // the declared reps is looked for.
  if (repsContradicted) throw new FlowRefusal(problems);
  const bySlot = new Map<string, Row[]>();
  for (const r of rows) {
    const group = bySlot.get(slotLabel(r.caseId, r.draw));
    if (group === undefined) bySlot.set(slotLabel(r.caseId, r.draw), [r]);
    else group.push(r);
  }
  for (const r of rows) {
    if (inRoster(r.caseId) && r.draw >= reps) bad('IMPORT_DRAW_COUNT', slotLabel(r.caseId, r.draw), `${resultsFile}:${r.line}: ${slotLabel(r.caseId, r.draw)}: rep ${r.draw} is beyond the declared count ${reps} (reps are 0 to ${reps - 1})`);
  }
  for (const [slot, group] of bySlot) {
    if (inRoster((group[0] as Row).caseId) && group.length > 1) bad('IMPORT_DRAW_COUNT', slot, `${slot}: the same slot ${group.length} times, on ${resultsFile} lines ${group.map((r) => r.line).join(' and ')}`);
  }
  const seenCases = new Set(rows.map((r) => r.caseId));
  // The failed attempts by slot, so that a missing slot finds its own in one look, not by a pass over every error line.
  const failedBySlot = new Map<string, number[]>();
  for (const e of errorLines) {
    const slot = slotLabel(e.caseId, e.draw);
    const list = failedBySlot.get(slot);
    if (list === undefined) failedBySlot.set(slot, [e.line]);
    else list.push(e.line);
  }
  for (const id of roster) {
    if (!seenCases.has(id)) {
      // No rep of this case can be graded, so no rep of the flow is whole under this cases file: a refusal of the flow.
      const failed = errorLines.filter((e) => e.caseId === id).map((e) => e.line);
      bad('IMPORT_CASE_MISSING', id, `${id}: in cases.json, but no row holds this id${failed.length > 0 ? ` (errors.jsonl line ${failed.join(', ')} records ${failed.length > 1 ? 'failed attempts' : 'a failed attempt'} at it)` : ''}; a case id is the row's prompt_id (the path-safe id), never meta.original_id; ${WAY_OUT}`);
      continue;
    }
    for (let k = 0; k < reps; k++) {
      const slot = slotLabel(id, k);
      if (bySlot.has(slot)) continue;
      const failed = failedBySlot.get(slot) ?? [];
      repBad(k, 'IMPORT_DRAW_COUNT', slot, `${slot}: expected (cases.json x ${reps} reps), but no row holds it${failed.length > 0 ? `; errors.jsonl line ${failed.join(', ')} records a failed attempt at it` : ''}; ${WAY_OUT}`);
    }
  }
  // An error line of a stated case names a rep the declaration does not hold: the declared count is then in doubt.
  for (const e of errorLines) {
    if (inRoster(e.caseId) && e.draw >= reps) bad('IMPORT_CASE_MISSING', `${errorsFile}:${e.line}`, `${errorsFile}:${e.line}: a failed attempt at ${slotLabel(e.caseId, e.draw)}, a rep beyond the declared count ${reps} (reps are 0 to ${reps - 1})`);
  }

  // -- the cases the flow holds and the cases file does not: excluded by the user's declaration, and listed ------------
  const excludedById = new Map<string, ExcludedCase>();
  const excludedOf = (id: string): ExcludedCase => {
    const known = excludedById.get(id);
    if (known !== undefined) return known;
    const made: ExcludedCase = { caseId: id, rows: [], errorLines: [] };
    excludedById.set(id, made);
    return made;
  };
  for (const r of rows) if (!inRoster(r.caseId)) excludedOf(r.caseId).rows.push({ line: r.line, rep: r.draw, finished: r.finished });
  for (const e of errorLines) {
    if (inRoster(e.caseId)) continue;
    // The id goes into a re-grade file's header as an excluded case: it is held to the form of a row's id.
    if (!isPathSafeId(e.caseId)) bad('IMPORT_CASE_ID', `${errorsFile}:${e.line}`, `${errorsFile}:${e.line}: prompt_id: ${JSON.stringify(e.caseId.slice(0, 40))} is not a path-safe id (word characters, dots and hyphens, 1 to 129 of them)`);
    else excludedOf(e.caseId).errorLines.push(e.line);
  }

  // -- the trace of every row that stands so far ------------------------------------------------------------------------
  const slots: FlowSlot[] = [];
  const used = new Set<string>();
  for (const r of rows) used.add(traceName(r.caseId, r.draw));
  if (tracesUsable) {
    for (const r of rows) {
      const slot = slotLabel(r.caseId, r.draw);
      // Not read: the trace of a row that is not a finished answer, and the trace of an excluded case.
      if (!r.ok || !r.finished || !inRoster(r.caseId) || r.draw >= reps || (bySlot.get(slot) ?? []).length !== 1) continue;
      const where = `${tracesPath}/${traceName(r.caseId, r.draw)}`;
      const found = files.traces.get(traceName(r.caseId, r.draw)) ?? 'missing';
      if (typeof found === 'string') {
        bad(notReadCode(found), slot, `${where}: ${found === 'missing' ? 'no trace for this row' : NOT_READ_WORDS[found]}`);
        continue;
      }
      const trace = readTrace(found, slot, where, r.prompt);
      if ('problems' in trace) problems.push(...trace.problems);
      else slots.push({ caseId: r.caseId, draw: r.draw, prompt: r.prompt, answer: trace.answer, traceSha256: sha256Hex(found), storedOutputSha256: outputHashOf(trace.answer) });
    }
  }

  if (problems.length > 0) throw new FlowRefusal(problems);
  slots.sort((a, b) => byCodeUnit(a.caseId, b.caseId) || a.draw - b.draw);
  return {
    rowProfile: ROW_PROFILE,
    variant,
    reps,
    statedCases: roster,
    slots,
    notWhole: [...byRep].map(([rep, list]) => ({ rep, problems: list })).sort((a, b) => a.rep - b.rep),
    excluded: [...excludedById.values()].sort((a, b) => byCodeUnit(a.caseId, b.caseId)),
    // An error line of a stated slot that holds a row; one of a slot with no row is named where that slot is listed.
    superseded: errorLines.filter((e) => inRoster(e.caseId) && bySlot.has(slotLabel(e.caseId, e.draw))).map((e) => ({ caseId: e.caseId, draw: e.draw, line: e.line })),
    resultsSha256,
    stateSha256,
    harnessSha,
    unusedTraces: [...files.traces.keys()].filter((name) => !used.has(name)).sort(byCodeUnit),
  };
}

/** Whether the flow held no `_state.json`: its sha256 is then the gap marker. */
export const hasNoStateFile = (flow: FlowRead): boolean => flow.stateSha256 === GAP;

/** The reps of a flow that are whole: every stated case holds a finished slot in them. In order. */
export function wholeReps(flow: FlowRead): number[] {
  const not = new Set(flow.notWhole.map((r) => r.rep));
  return Array.from({ length: flow.reps }, (_, k) => k).filter((k) => !not.has(k));
}

/**
 * The slots of one rep, in the order of the case ids: the one way a caller that grades a rep, or compares one,
 * obtains them. Refuses (`FlowRefusal`, every problem of that rep listed) when the rep is not whole; what is wrong
 * with any other rep is not looked at. A rep that is not one of the declared reps is a usage error. Pure.
 */
export function wholeRepSlots(flow: FlowRead, rep: number): FlowSlot[] {
  if (!Number.isSafeInteger(rep) || rep < 0 || rep >= flow.reps) throw new ImportUsageError(`rep ${String(rep)} is not one of the ${flow.reps} declared rep(s) of the flow (reps are 0 to ${flow.reps - 1})`);
  const found = flow.notWhole.find((r) => r.rep === rep);
  if (found !== undefined) throw new FlowRefusal(found.problems, `rep ${rep} of the flow, which is not whole`);
  const slots = flow.slots.filter((s) => s.draw === rep);
  // What "whole" means, held once more on what is handed on: one slot for each stated case, and no other.
  if (slots.length !== flow.statedCases.length || slots.some((s, i) => s.caseId !== flow.statedCases[i])) {
    throw new Error(`wholeRepSlots: rep ${rep} is not listed as not whole, but its slots are not the stated cases`);
  }
  return slots;
}

// ---------------------------------------------------------------------------------------------------------------
// The one reader (I/O)
// ---------------------------------------------------------------------------------------------------------------

function kindOf(path: string): 'dir' | 'file' | NotRead {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) return 'missing';
  if (st.isSymbolicLink()) return 'symlink';
  return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
}
const dirKind = (path: string): 'dir' | NotRead => {
  const k = kindOf(path);
  return k === 'file' ? 'other' : k;
};

/** The bytes of a regular file, opened without following a symlink; or what is there instead. */
function readNoFollow(path: string): FileRead {
  const kind = kindOf(path);
  if (kind === 'dir') return 'other';
  if (kind !== 'file') return kind;
  let fd: number;
  try {
    // O_NOFOLLOW closes the gap between the look above and the open; where the platform has no such flag it is 0.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return 'symlink';
    if (code === 'ENOENT') return 'missing';
    throw e;
  }
  try {
    return fstatSync(fd).isFile() ? new Uint8Array(readFileSync(fd)) : 'other';
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the files of one variant from disk: the one function of this file that touches it. It follows no symlink,
 * reads nothing outside `<flow>` and writes nothing. A variant name that is not `baseline` or `v<N>` is refused
 * before the first look at the disk, so a name can never lead out of the flow.
 */
export function readFlowFiles(flowDir: string, variant: string): FlowFiles {
  const nameProblem = variantNameProblem(variant);
  if (nameProblem !== undefined) throw new FlowRefusal([{ code: 'IMPORT_PATH', field: 'variant', message: nameProblem }]);
  // A trailing separator makes the look below follow a symlink at the end of the path: strip it first.
  let flow = flowDir;
  while (flow.length > 1 && (flow.endsWith('/') || flow.endsWith(sep))) flow = flow.slice(0, -1);
  // So does a last segment of "." or "..": the look is then at a directory behind the link, never at the link.
  const last = basename(flow);
  if (last === '.' || last === '..') {
    throw new FlowRefusal([{ code: 'IMPORT_PATH', field: 'flow', message: `flow: the flow path ends in "${last}"; name the flow directory itself, so that a symlink at the end of the path is seen and not followed` }]);
  }
  const none: FlowFiles = { flowDir: 'missing', variantDir: 'missing', tracesDir: 'missing', state: 'missing', results: 'missing', errors: 'missing', traces: new Map() };
  try {
    const flowKind = dirKind(flow);
    if (flowKind !== 'dir') return { ...none, flowDir: flowKind };
    const state = readNoFollow(join(flow, STATE_FILE));
    const vdir = join(flow, variant);
    const variantKind = dirKind(vdir);
    if (variantKind !== 'dir') return { ...none, flowDir: 'dir', state, variantDir: variantKind };
    const tdir = join(vdir, 'traces');
    const tracesKind = dirKind(tdir);
    const traces = new Map<string, FileRead>();
    if (tracesKind === 'dir') for (const name of readdirSync(tdir).sort(byCodeUnit)) traces.set(name, readNoFollow(join(tdir, name)));
    return { flowDir: 'dir', variantDir: 'dir', tracesDir: tracesKind, state, results: readNoFollow(join(vdir, 'results.jsonl')), errors: readNoFollow(join(vdir, 'errors.jsonl')), traces };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === 'string') throw new ImportUsageError(`cannot read the flow ${flowDir} (${code})`);
    throw e;
  }
}

/**
 * Reads and validates one variant of a flow: the finished slots in a fixed order, the reps that are not whole, the
 * excluded cases, the superseded error lines and the sha256 of `results.jsonl` and `_state.json`; or a `FlowRefusal`
 * that lists every offending slot. A flow directory that is not there is a usage error.
 */
export function readFlow(flowDir: string, variant: string, cases: CasesFile, reps: number): FlowRead {
  checkDeclaredReps(reps, cases);
  const files = readFlowFiles(flowDir, variant);
  if (files.flowDir === 'missing') throw new ImportUsageError(`cannot read the flow ${flowDir} (ENOENT)`);
  return validateFlow(files, variant, cases, reps);
}
