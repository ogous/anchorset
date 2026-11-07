/**
 * The third importer: a re-grade file written by `regrade.ts` to an `anchorset.run/v3` run file.
 *
 *   node examples/importers/skill-evals/import.ts --in <regrade.jsonl> --cases <cases.json> --bar <bar.json> --out <run.json>
 *        --reading <rule name> --flow <dir>
 *
 * It reads the re-grade file, the cases file, the bar and the flow. The re-grade file is the re-grade script's own
 * declaration of what it read and handed to the judge, as the grader's record on each row is the grader's. Every
 * judge field of the run comes from those records or from texts in the file, and each text is checked forward: the
 * prompt on a row must be the header's template filled with that row's parts, and its hashes must be the record's.
 * The system side, the seed and every system stop are always "UNKNOWN". The source's own grades are never read.
 *
 * A case of the run is a case of the flow, and its draws are the repeated grades of ONE stored output: the output of
 * the source rep the re-grade names. The rows of one case must therefore hold one stored output, one trace, one set of
 * parts and one prompt; a file in which they differ is refused. A run made from another source rep is another
 * measurement. `packetSource` names the rep, and that is all: no check here or in `judge-change` keeps two runs of
 * different reps apart, and such a pair is refused only where the stored outputs differ.
 *
 * `--reading` is the name of the rule the replies are read under. It is required and has no default. The re-grade
 * script takes the same flag, reads every reply under it and writes the name into the header (`reading`); the grader
 * neither reads a reply nor records a rule. The rule stated here must be the header's: a file whose header names
 * another rule is refused, and so is a header that names none. The name is part of the judge's definition, so the
 * same stored outputs re-graded under the two rules give runs of two judges.
 *
 * The header also declares the cases the flow held and the cases file left out (`excludedCaseIds`, sorted, with
 * `excludedCaseCount`). A header without the two fields is refused: there is no default. The run's `packetSource`
 * names the count, so a run says that it measures fewer cases than its flow held. A `stateSha256` of "UNKNOWN" is a
 * flow that held no `_state.json`; its `harnessSha` is then "UNKNOWN" too. A `harnessSha` is 64 lowercase hexadecimal
 * characters or "UNKNOWN", and nothing else: it goes into the run's `packetSource`, which a report prints.
 *
 * `--flow <dir>` is required, and has no default: the flow is read again from disk and the import is refused on any
 * difference in `results.jsonl`, in `_state.json` (there or not there), in the excluded cases, or in the trace or the
 * stored output of the source rep, which must be whole; what is wrong with another rep is not looked at. Without it the
 * question of each case, the stored outputs and the list of excluded cases would stand on the script's declaration
 * alone, and a file edited after the re-grade could not be told from one that was not: the importer refuses to run (64).
 * The run's `packetSource` says `flow read again: yes`.
 *
 * A file in which any slot is not a clean, finished grade that is readable under the stated reading rule is refused
 * whole, with every such slot listed. A file that is not a re-grade file (a plain `results.jsonl` of the source, for
 * example) is refused with a message that names `regrade.ts`.
 *
 * Exit codes: 0 written, 2 refused, 64 usage, 65 a cases file or a bar that does not validate, 70 an error the
 * importer did not foresee. Never 1.
 *
 * It imports only from `../shared.ts`, `./flow.ts`, `./render.ts`, `./selector.ts`, `./strict.ts` (the check of a
 * well-formed text), `./regrade.ts` (constants only), the library's public entry and Node built-ins.
 */
import { join } from 'node:path';
import { barHash, callShapeHash, caseSetHash, GAP, hashOf, isSha256Hex, NOT_SENT, outputHashOf, packetHashOf, RUN_SCHEMA, sha256Hex } from '../../../src/index.ts';
import type { BarFile, CallShape, Draw } from '../../../src/index.ts';
import {
  assertBarHasLabels,
  buildCases,
  graderConfigProblems,
  checkRecordSet,
  decodeUtf8,
  IMPORT_FLAGS,
  illFormedLineRefusal,
  ImportInputError,
  ImportRefusal,
  ImportUsageError,
  isCount,
  isEntryPoint,
  isObject,
  judgeHarnessVersion,
  attemptsOf,
  reasksLine,
  noRecordRefusal,
  parseJsonlSourceFile,
  parseJsonStrict,
  parseRecord,
  problemField,
  readingFromFlag,
  readSlot,
  READINGS,
  runImporter,
  runImporterAsProcess,
  reasoningLine,
  typeName,
  ungradedRefusal,
  valueTypeProblems,
} from '../shared.ts';
import type { CasesFile, GraderRecord, ImportRefusalCode, Io, Reading, RecordedSlot, Wire } from '../shared.ts';
import { byCodeUnit, flowSlotCount, flowSlotsWords, HEADER_COUNT_BOUND, isPathSafeId, readFlow, ROW_PROFILE, slotLabel, variantNameProblem, wholeRepSlots } from './flow.ts';
import type { FlowRead } from './flow.ts';
import { GRADER_FILE, REGRADE_SCHEMA, SCRIPT, SCRIPT_FILES } from './regrade.ts';
import { promptTextOf, renderTemplate, templateProblems } from './render.ts';
import { parsePointer, SELECTOR_SYNTAX, selectorLabel, trySelect, WHOLE_TURN } from './selector.ts';
import { isWellFormedText, UNPAIRED_SURROGATE } from './strict.ts';

/** The tool's name, as the run names it. */
export const TOOL = 'skill-evals';
/** What the importer says of the row profile: the source states no version, so the profile is the importer's own pin. */
export const ROW_PROFILE_NOTE = 'pinned by the importer; written against CLI 2.1.288; no version is read';
// The most this importer takes for a count stated in a header (`draws`, `slotCount`, `reps`) is the path's one bound,
// which the flow reader holds and the re-grade script applies to its own flags.
export { HEADER_COUNT_BOUND };
/** The bound for `draws` and `slotCount` of a file that holds `rowsPresent` rows: never below the rows that are really there. */
export const headerCountBound = (rowsPresent: number): number => Math.max(HEADER_COUNT_BOUND, rowsPresent);

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------
// Refusals of this file
// ---------------------------------------------------------------------------------------------------------------

/**
 * What to run again, in this path's words: the instruction the shared module puts into its no-record refusal and into
 * its refusal of a record of another version. The file to make is the one `regrade.ts` writes.
 */
const RERUN = `Grade the stored outputs again with ${SCRIPT} and import the file it writes: a header of schema ${REGRADE_SCHEMA} and, on every row, the recording grader's record of one call. A results.jsonl written by the source's own runner holds neither, and its grades are never read`;

type Problem = { code: ImportRefusalCode; field: string; message: string };
/** One refusal over every problem found by one group of checks: the code of the first, every field once. */
function refuseAll(problems: readonly Problem[]): void {
  const first = problems[0];
  if (first === undefined) return;
  throw new ImportRefusal(first.code, [...new Set(problems.map((p) => p.field))], problems.map((p) => p.message).join('; '));
}


// ---------------------------------------------------------------------------------------------------------------
// The file: a header line, then one line per slot
// ---------------------------------------------------------------------------------------------------------------

type TextAndHash = { text: string; sha256: string };
type Header = {
  rowProfile: string;
  variant: string;
  /** The declared rep count of the flow. */
  reps: number;
  /** The source rep whose stored outputs were graded. */
  sourceRep: number;
  /** How many times each stored output was graded: the run's draws per case. */
  draws: number;
  slotCount: number;
  /** The cases the flow held and the cases file left out, as the script declares them: sorted, each once. */
  excludedCaseIds: string[];
  resultsSha256: string;
  /** The sha256 of the flow's `_state.json`, or "UNKNOWN" when the flow held none. */
  stateSha256: string;
  /** `harness_sha` of the flow's `_state.json` as the script read it (64 lowercase hexadecimal characters), or "UNKNOWN". */
  harnessSha: string;
  template: TextAndHash;
  criterion: TextAndHash;
  system: TextAndHash | typeof NOT_SENT;
  selector: { syntax: string; pointer: string } | typeof NOT_SENT;
  /** The reading rule the re-grade read every reply under (`--reading` at the re-grade): one of the two names. */
  reading: Reading;
  graderConfig: Obj;
  scriptFiles: { path: string; sha256: string }[];
};
type Row = {
  line: number;
  label: string;
  caseId: string;
  draw: number;
  traceSha256: string;
  storedOutputSha256: string;
  storedOutput: string;
  parts: { question: string; answer: string; criterion: string };
  promptSent: string;
  evidence: unknown;
  error: unknown;
  hasEvidence: boolean;
  hasError: boolean;
};

const HEADER_KEYS = ['schema', 'regradeRunId', 'startedAt', 'script', 'rowProfile', 'variant', 'reps', 'sourceRep', 'draws', 'slotCount', 'excludedCaseIds', 'excludedCaseCount', 'resultsSha256', 'stateSha256', 'harnessSha', 'template', 'criterion', 'system', 'selector', 'reading', 'graderConfig', 'scriptFiles'];
const ROW_KEYS = ['caseId', 'draw', 'traceSha256', 'storedOutputSha256', 'storedOutput', 'parts', 'promptSent'];

/** Whether a text is a JSON Pointer, by the selector module's own rule. */
function isPointer(text: string): boolean {
  try {
    parsePointer(text);
    return true;
  } catch {
    return false;
  }
}

const isHeader = (v: unknown): v is Obj => isObject(v) && v['schema'] === REGRADE_SCHEMA;

/**
 * The refusal of a file whose first line is the header of an EARLIER version of the re-grade file: `IMPORT_EVIDENCE`
 * with the instruction to re-grade with the current script, not "this is not a re-grade file". Nothing is converted.
 * Undefined for any other first line.
 */
function earlierHeaderRefusal(first: unknown, fileName: string): ImportRefusal | undefined {
  const schema = isObject(first) ? first['schema'] : undefined;
  if (typeof schema !== 'string') return undefined;
  const m = /^example\.skill-evals-regrade\/v([1-9][0-9]*)$/.exec(schema);
  if (m === null || Number(m[1]) >= Number(REGRADE_SCHEMA.slice(REGRADE_SCHEMA.lastIndexOf('/v') + 2))) return undefined;
  return new ImportRefusal('IMPORT_EVIDENCE', ['header/schema'], `${fileName}:1: schema: this re-grade file is of version ${schema}, an earlier version than ${REGRADE_SCHEMA}; re-grade with the current script (${SCRIPT})`);
}

/**
 * The refusal of a file whose first line is the header of a LATER version of the re-grade file: still "no record this
 * importer reads" (`IMPORT_NO_RECORD`, the file named), but in words that do not send the user back to this
 * importer's own, older, script. Undefined for any other first line.
 */
function laterHeaderRefusal(first: unknown, fileName: string): ImportRefusal | undefined {
  const schema = isObject(first) ? first['schema'] : undefined;
  if (typeof schema !== 'string') return undefined;
  const m = /^example\.skill-evals-regrade\/v([1-9][0-9]*)$/.exec(schema);
  if (m === null || Number(m[1]) <= Number(REGRADE_SCHEMA.slice(REGRADE_SCHEMA.lastIndexOf('/v') + 2))) return undefined;
  return new ImportRefusal('IMPORT_NO_RECORD', [fileName], `${fileName}:1: schema: this re-grade file is of version ${schema}, written by a later version of the script than this importer reads (${REGRADE_SCHEMA}); import it with the importer of that version`);
}

/**
 * The lines of the file as JSON values, through the shared JSON-lines reader (UTF-8 with no byte-order mark, every
 * line ended by a line feed, no empty line, every line JSON); the first must be the header of a re-grade file.
 *
 * One local step is kept. The shared reader gives the no-record refusal to any file in which no line holds a record,
 * and so to the file a re-grade leaves when its FIRST call fails: a header and one row with an `error`. That file is
 * a re-grade file, and its refusal is the list of its ungraded slots, not "this is not a re-grade file". So when the
 * shared reader says "no record" and the first line is a re-grade header, the lines are taken as they are: the shared
 * reader has by then checked the bytes, the line feeds and that every line is JSON, and nothing is checked again here.
 *
 * A key given twice in one object (in the header, in a row, in a record) and a line nested too deep are refused by
 * the shared reader, which reads every line through the path's one strict reader; nothing is scanned again here.
 *
 * A text with an unpaired surrogate is named by this path's own checks, more closely than the shared reader can name
 * it: by its row, its field and its slot. So the shared reader is told to leave such a text to the caller, and its
 * refusal for the lines comes back as `illFormed`: `convertRegrade` gives it whenever those checks let a line through.
 */
function readLines(bytes: Uint8Array, fileName: string): { header: Obj; rows: { line: number; value: Obj }[]; illFormed: ImportRefusal | undefined } {
  let lines: unknown[];
  try {
    lines = parseJsonlSourceFile(bytes, fileName, RERUN, 'refused by the caller').lines;
  } catch (e) {
    if (!(e instanceof ImportRefusal) || e.code !== 'IMPORT_NO_RECORD') throw e;
    // The shared reader says "no record" only after it has read every line: the bytes are UTF-8 and each line is a
    // JSON value under the strict reader, so both reads below give a value.
    const decoded = decodeUtf8(bytes);
    const texts = 'text' in decoded ? decoded.text.split('\n').slice(0, -1) : [];
    const all = texts.map((l) => {
      const read = parseJsonStrict(l);
      return 'value' in read ? read.value : undefined;
    });
    const earlier = earlierHeaderRefusal(all[0], fileName) ?? laterHeaderRefusal(all[0], fileName);
    if (earlier !== undefined) throw earlier;
    if (!isHeader(all[0])) throw e;
    lines = all;
  }
  const [first, ...rest] = lines;
  const earlierVersion = earlierHeaderRefusal(first, fileName) ?? laterHeaderRefusal(first, fileName);
  if (earlierVersion !== undefined) throw earlierVersion;
  // A file that holds records and no header of this schema (another script's file, or another version of this one's).
  if (!isHeader(first)) throw noRecordRefusal('promptfoo', fileName, RERUN);
  const rows: { line: number; value: Obj }[] = [];
  const problems: Problem[] = [];
  rest.forEach((value, i) => {
    const at = `${fileName}:${i + 2}`;
    if (!isObject(value)) problems.push({ code: 'IMPORT_SHAPE', field: at, message: `${at}: expected a JSON object, found ${typeName(value)}` });
    else rows.push({ line: i + 2, value });
  });
  refuseAll(problems);
  return { header: first, rows, illFormed: illFormedLineRefusal(lines, fileName) };
}

/** The header, with every key of the script's form present and typed, and no other key. */
function readHeader(h: Obj, fileName: string): Header {
  const at = `${fileName}:1`;
  const problems: Problem[] = [];
  const bad = (key: string, what: string, code: ImportRefusalCode = 'IMPORT_SHAPE'): void => {
    problems.push({ code, field: `header/${key}`, message: `${at}: ${key}: ${what}` });
  };
  const nulls: string[] = [];
  valueTypeProblems(h, 'header', nulls);
  for (const n of nulls) problems.push({ code: 'IMPORT_SHAPE', field: problemField(n).replace(/^header\./, 'header/'), message: `${at}: ${n}` });
  for (const k of Object.keys(h)) if (!HEADER_KEYS.includes(k)) bad(k, 'a key the re-grade script does not write');
  // A header with no reading rule is never read as "the rule stated at import": the re-grade states its rule, and says so.
  for (const k of HEADER_KEYS) if (!(k in h)) bad(k, k === 'reading' ? `missing: the header of a re-grade names the reading rule its replies were read under (--reading at the re-grade). ${RERUN}` : 'missing');
  refuseAll(problems);

  const str = (key: string): string => {
    const v = h[key];
    if (typeof v !== 'string' || v === '') bad(key, `expected a non-empty string, found ${typeof v === 'string' ? 'an empty one' : typeName(v)}`);
    return typeof v === 'string' ? v : '';
  };
  const hex = (key: string): string => {
    const v = h[key];
    if (!isSha256Hex(v)) bad(key, 'expected a full 64-character sha256');
    return typeof v === 'string' ? v : '';
  };
  const count = (key: string): number => {
    const v = h[key];
    if (!isCount(v)) bad(key, `expected a positive integer, found ${typeof v === 'number' ? String(v) : typeName(v)}`);
    return isCount(v) ? v : 0;
  };
  const textAndHash = (key: string, v: unknown): TextAndHash => {
    if (!isObject(v) || Object.keys(v).sort().join() !== 'sha256,text' || typeof v['text'] !== 'string' || v['text'] === '' || !isSha256Hex(v['sha256'])) {
      bad(key, 'expected { text, sha256 } with a non-empty text and a full sha256, and no other key');
      return { text: '', sha256: '' };
    }
    // The sha256 beside such a text is also the sha256 of another text, so it would show nothing.
    if (!isWellFormedText(v['text'])) bad(key, UNPAIRED_SURROGATE);
    return { text: v['text'], sha256: v['sha256'] as string };
  };

  str('regradeRunId');
  str('startedAt');
  if (str('script') !== SCRIPT && typeof h['script'] === 'string') bad('script', `${JSON.stringify(h['script'])} is not ${SCRIPT}, the one script whose file this importer reads`);
  const rowProfile = str('rowProfile');
  const variant = str('variant');
  const nameProblem = variant === '' ? undefined : variantNameProblem(variant);
  if (nameProblem !== undefined) bad('variant', nameProblem);
  const reps = count('reps');
  const draws = count('draws');
  const rep = h['sourceRep'];
  const sourceRep = typeof rep === 'number' && Number.isSafeInteger(rep) && rep >= 0 ? rep : -1;
  if (sourceRep < 0) bad('sourceRep', `expected an integer from 0, found ${typeof rep === 'number' ? String(rep) : typeName(rep)}`);
  else if (reps > 0 && sourceRep >= reps) bad('sourceRep', `${sourceRep} is not one of the ${reps} declared rep(s) of the flow (reps are 0 to ${reps - 1})`);
  const slotCount = count('slotCount');
  // The excluded cases: a list of path-safe ids in the one order of this path, each once, and its length beside it.
  // Both keys must be there (checked above with every other key): a file without them is never read as "none excluded".
  const excludedCaseIds: string[] = [];
  const listed = h['excludedCaseIds'];
  if (!Array.isArray(listed) || !listed.every((x) => typeof x === 'string' && isPathSafeId(x))) bad('excludedCaseIds', 'expected a list of path-safe case ids (word characters, dots and hyphens, 1 to 129 of them)');
  else if (listed.some((x, i) => i > 0 && byCodeUnit(listed[i - 1] as string, x as string) >= 0)) bad('excludedCaseIds', 'the ids are not sorted with each id once, as the script writes them');
  else excludedCaseIds.push(...(listed as string[]));
  const excludedCount = h['excludedCaseCount'];
  if (!(typeof excludedCount === 'number' && Number.isSafeInteger(excludedCount) && excludedCount >= 0)) bad('excludedCaseCount', `expected an integer from 0, found ${typeof excludedCount === 'number' ? String(excludedCount) : typeName(excludedCount)}`);
  else if (Array.isArray(listed) && excludedCount !== listed.length) bad('excludedCaseCount', `${excludedCount} is not the number of ids in excludedCaseIds, ${listed.length}`, 'IMPORT_EVIDENCE');
  const resultsSha256 = hex('resultsSha256');
  // A full sha256, or exactly the gap marker: the flow held no state file. Never an empty text, never another word.
  const stateSha256 = h['stateSha256'] === GAP ? GAP : hex('stateSha256');
  // As the script read it from the flow's state file, or the gap marker. Its form is held, since it goes into the
  // run's `packetSource` and is printed from there: 64 lowercase hexadecimal characters, or exactly the gap marker.
  // What it is the hash of is never checked.
  const harnessSha = h['harnessSha'] === GAP ? GAP : hex('harnessSha');
  // With no state file there is no harness_sha to have read: a header that states one was not written by the script.
  if (stateSha256 === GAP && isSha256Hex(h['harnessSha'])) bad('harnessSha', `a value is stated, but stateSha256 is "${GAP}" (the flow held no _state.json), so there was no file to read it from`, 'IMPORT_EVIDENCE');
  const template = textAndHash('template', h['template']);
  const criterion = textAndHash('criterion', h['criterion']);
  const system = h['system'] === NOT_SENT ? NOT_SENT : textAndHash('system', h['system']);

  let selector: Header['selector'] = NOT_SENT;
  const sel = h['selector'];
  if (sel !== NOT_SENT) {
    if (!isObject(sel) || Object.keys(sel).sort().join() !== 'pointer,syntax' || typeof sel['pointer'] !== 'string') bad('selector', `expected "${NOT_SENT}" or { syntax, pointer }, with no other key`);
    else if (sel['syntax'] !== SELECTOR_SYNTAX) bad('selector', `the syntax is ${JSON.stringify(sel['syntax'])}, not ${SELECTOR_SYNTAX}, the one selection rule this importer applies`);
    else if (sel['pointer'] === WHOLE_TURN || !isPointer(sel['pointer'])) bad('selector', `the pointer ${JSON.stringify(sel['pointer'])} is not a non-empty JSON Pointer (RFC 6901); the whole turn is "${NOT_SENT}"`);
    else selector = { syntax: SELECTOR_SYNTAX, pointer: sel['pointer'] };
  }

  // The reading rule: exactly one of the two names. Whether it is the rule stated at import is checked by the conversion.
  const named = h['reading'];
  const headerReading = (READINGS as readonly unknown[]).includes(named) ? (named as Reading) : undefined;
  if (headerReading === undefined) bad('reading', `expected one of ${READINGS.join(', ')}, found ${typeof named === 'string' ? JSON.stringify(named) : typeName(named)}`);

  const graderConfig = isObject(h['graderConfig']) ? h['graderConfig'] : {};
  if (!isObject(h['graderConfig'])) bad('graderConfig', `expected object, found ${typeName(h['graderConfig'])}`);

  // The list of script files: what is CHECKED and what is only DECLARED.
  //   Checked here: the shape of every entry ({ path, sha256 }, a full sha256, no other key); that the paths are
  //   sorted and each is there once; and that the set of paths is exactly `SCRIPT_FILES`, the list the re-grade
  //   script writes (a test holds that list to the script's import statements), so the script itself, the grader
  //   file and every file between them are named, and no other file is.
  //   Checked later, against the records: the sha256 listed for the grader file is the grader's sha256 in every record.
  //   Declared, not checked: every other sha256. The importer reads no script file, so it cannot say that a listed
  //   sha256 is the file that ran; it carries the list into `judgeHarnessVersion` as the script wrote it. A header
  //   rewritten consistently (another sha256 for the script, say) imports, and the run then names another harness.
  const scriptFiles: { path: string; sha256: string }[] = [];
  const files = h['scriptFiles'];
  if (!Array.isArray(files) || files.length === 0) bad('scriptFiles', 'expected a non-empty list of { path, sha256 }');
  else {
    for (const f of files) {
      if (!isObject(f) || Object.keys(f).sort().join() !== 'path,sha256' || typeof f['path'] !== 'string' || f['path'] === '' || !isSha256Hex(f['sha256'])) {
        bad('scriptFiles', 'every entry must be { path, sha256 } with a non-empty path and a full sha256, and no other key');
        break;
      }
      scriptFiles.push({ path: f['path'], sha256: f['sha256'] as string });
    }
    if (scriptFiles.length === files.length) {
      const paths = scriptFiles.map((f) => f.path);
      if (new Set(paths).size !== paths.length) bad('scriptFiles', 'a path is listed twice');
      else if (paths.some((p, i) => i > 0 && byCodeUnit(paths[i - 1] as string, p) > 0)) bad('scriptFiles', 'the paths are not sorted, as the script writes them');
      const known: readonly string[] = SCRIPT_FILES;
      for (const p of known) if (!paths.includes(p)) bad('scriptFiles', `${p} is not listed`);
      for (const p of [...new Set(paths)]) if (!known.includes(p)) bad('scriptFiles', `${JSON.stringify(p)} is listed, and is not a file the re-grade script imports`);
    }
  }
  refuseAll(problems);

  // The source states no version: what is pinned is this importer's own row profile.
  if (rowProfile !== ROW_PROFILE) {
    throw new ImportRefusal('IMPORT_TOOL_VERSION', ['header/rowProfile'], `this importer reads row profile ${ROW_PROFILE} (${ROW_PROFILE_NOTE}); the file says ${JSON.stringify(rowProfile)}`);
  }
  // The three texts against their hashes, and the template against the narrow form the renderer takes.
  const texts: [string, TextAndHash | typeof NOT_SENT][] = [['template', template], ['criterion', criterion], ['system', system]];
  for (const [key, t] of texts) {
    if (t !== NOT_SENT && sha256Hex(t.text) !== t.sha256) bad(key, 'the sha256 is not the hash of the text beside it', 'IMPORT_EVIDENCE');
  }
  const form = templateProblems(template.text);
  if (form.length > 0) bad('template', `the template is outside the form the renderer takes: ${form.join('; ')}`, 'IMPORT_PACKET');
  refuseAll(problems);
  // After `refuseAll`: a header whose rule is not one of the two names was refused above, so the rule is one of them here.
  return { rowProfile, variant, reps, sourceRep, draws, slotCount, excludedCaseIds, resultsSha256, stateSha256, harnessSha, template, criterion, system, selector, reading: headerReading as Reading, graderConfig, scriptFiles };
}

/** Every row, typed. A row is named by its slot once its case id and draw can be read, else by its line. */
function readRows(raw: readonly { line: number; value: Obj }[], fileName: string): Row[] {
  const problems: Problem[] = [];
  const rows: Row[] = [];
  for (const { line, value: r } of raw) {
    const at = `${fileName}:${line}`;
    const caseId = r['caseId'];
    const draw = r['draw'];
    const idOk = typeof caseId === 'string' && caseId !== '';
    const drawOk = typeof draw === 'number' && Number.isSafeInteger(draw) && draw >= 0;
    const label = idOk && drawOk ? slotLabel(caseId, draw) : at;
    const before = problems.length;
    const bad = (key: string, what: string, code: ImportRefusalCode = 'IMPORT_SHAPE'): void => {
      problems.push({ code, field: label, message: `${at}: ${key}: ${what}` });
    };
    const nulls: string[] = [];
    valueTypeProblems(r, 'row', nulls);
    // A null or a number that is not finite inside the grader's record is a record that is not of the record's form,
    // under the same code as on the other two paths; anywhere else on the row it is the shape of the row.
    for (const n of nulls) problems.push({ code: /^row\.graderEvidence[.[]/.test(n) ? 'IMPORT_EVIDENCE' : 'IMPORT_SHAPE', field: label, message: `${at}: ${n}` });
    if (!idOk) bad('caseId', `a case id must be a non-empty string, found ${typeof caseId === 'string' ? 'an empty one' : typeName(caseId)}`, 'IMPORT_CASE_ID');
    if (!drawOk) bad('draw', `expected an integer from 0, found ${typeof draw === 'number' ? String(draw) : typeName(draw)}`);
    for (const k of Object.keys(r)) if (!ROW_KEYS.includes(k) && k !== 'graderEvidence' && k !== 'error') bad(k, 'a key the re-grade script does not write');
    for (const k of ROW_KEYS) if (!(k in r)) bad(k, 'missing');
    for (const k of ['traceSha256', 'storedOutputSha256']) if (k in r && !isSha256Hex(r[k])) bad(k, 'expected a full 64-character sha256');
    // Every text of a row that is hashed, or that a hashed text is made from, must be well-formed Unicode: the hash
    // of a text with an unpaired surrogate is also the hash of another text.
    if (idOk && !isWellFormedText(caseId)) bad('caseId', UNPAIRED_SURROGATE, 'IMPORT_CASE_ID');
    for (const k of ['storedOutput', 'promptSent']) {
      const v = r[k];
      if (k in r && typeof v !== 'string') bad(k, `expected string, found ${typeName(v)}`);
      else if (typeof v === 'string' && !isWellFormedText(v)) bad(k, UNPAIRED_SURROGATE);
    }
    const parts = r['parts'];
    if ('parts' in r && !(isObject(parts) && Object.keys(parts).sort().join() === 'answer,criterion,question' && Object.values(parts).every((v) => typeof v === 'string'))) {
      bad('parts', 'expected { question, answer, criterion }, each a string, and no other key');
    } else if (isObject(parts)) {
      for (const [k, v] of Object.entries(parts)) if (typeof v === 'string' && !isWellFormedText(v)) bad(`parts.${k}`, UNPAIRED_SURROGATE);
    }
    if (problems.length > before || !idOk || !drawOk) continue;
    rows.push({
      line,
      label,
      caseId,
      draw,
      traceSha256: r['traceSha256'] as string,
      storedOutputSha256: r['storedOutputSha256'] as string,
      storedOutput: r['storedOutput'] as string,
      parts: parts as Row['parts'],
      promptSent: r['promptSent'] as string,
      evidence: r['graderEvidence'],
      error: r['error'],
      hasEvidence: 'graderEvidence' in r,
      hasError: 'error' in r,
    });
  }
  refuseAll(problems);
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// The reading rule and the grader's settings
// ---------------------------------------------------------------------------------------------------------------

/**
 * The name of the reading rule the caller states (`--reading`, no default): one of the two named rules. The re-grade
 * script states the same rule in the header's own field `reading`, and the conversion refuses a file whose header
 * names another. The grader states none: a header's `graderConfig` or a record that holds one is refused where each is read.
 */
function readingRuleOf(stated: string | undefined): Reading {
  return readingFromFlag(stated);
}

/**
 * Every setting of the header's `graderConfig` equal to what the record and its call shape state, and no other key:
 * that rule is the shared module's `graderConfigProblems` (the same grader, the same settings, the same record as the
 * promptfoo path), called with the place of the settings in a re-grade file. It holds the base URL and the name of the
 * key's variable to the grader's own rules too, and echoes neither value. One check is this path's own, since the
 * shared rule does not make it: a `reading` key is named as what it is, a rule that is the header's own field and is never handed to the grader,
 * with what to run again. It is not handed on, so the shared rule does not also call it an unknown setting. One
 * refusal names every problem of both.
 */
function checkHeaderGraderConfig(given: Obj, rec: GraderRecord): void {
  const where = 'header/graderConfig';
  const own: string[] = [];
  if (Object.hasOwn(given, 'reading')) own.push(`${where}/reading: the grader's configuration holds a reading rule; the rule is the header's own field (reading), and the grader is not told one. Re-grade with the current ${SCRIPT}`);
  const shared = graderConfigProblems(Object.fromEntries(Object.entries(given).filter(([k]) => k !== 'reading')), rec, where);
  const all = [...own, ...shared];
  if (all.length > 0) throw new ImportRefusal('IMPORT_EVIDENCE', [...new Set(all.map(problemField))], all.join('; '));
}

/** The closing sentence of this path's `IMPORT_UNGRADED`: what to do, in full, with no pointer to a document. */
const UNGRADED_CLOSING = 'Keep this file as it is, and do not delete or replace it: the measurement planned on this re-grade is aborted, and a further re-grade is a new experiment that is reported together with this refused one';

// ---------------------------------------------------------------------------------------------------------------
// The conversion
// ---------------------------------------------------------------------------------------------------------------

/** Reads the flow again: the variant, the cases and the rep count are the re-grade file's and the user's. */
export type FlowAgain = (variant: string, cases: CasesFile, reps: number) => FlowRead;

export type ConvertResult = {
  run: Record<string, unknown>;
  judge: { judgeDefinitionHash: string; judgeModelRequested: string; judgeModelServed: string; judgeCallShapeHash: string; judgeHarnessVersion: string; rubricHash: string };
  barHash: string;
  caseSetHash: string;
  drawsPerCase: number;
  grader: { name: string; language: string; runtime: string; sha256: string };
  /** The sha256 of the re-grade file's bytes. */
  sourceSha256: string;
  /** The sha256 of the `results.jsonl` and of the `_state.json` the re-grade read, as its header declares them. */
  resultsSha256: string;
  stateSha256: string;
  /** The flow's `harness_sha` as the re-grade read it, or "UNKNOWN". */
  harnessSha: string;
  /** The source rep whose stored outputs were graded, and the flow's declared rep count. */
  sourceRep: number;
  reps: number;
  /** The cases the flow held and the cases file left out, as the re-grade declares them. */
  excludedCaseIds: string[];
    wire: Wire;
    requestedModel: string;
    servedModel: string;
    reasoning: string;
  reasks: string;
  /** The reading rule the replies were read under, as stated by the caller. */
  readingRule: Reading;
};

/**
 * The pure conversion: the bytes of a re-grade file, the stated cases, the bar and the stated reading rule, to a run.
 * Writes nothing and reads nothing but what it is handed; `flowAgain` is the reader of the flow for the second look, and it
 * is required: no run is made from a re-grade file whose flow was not read again.
 */
export function convertRegrade(bytes: Uint8Array, fileName: string, cases: CasesFile, bar: BarFile, readingRule: string | undefined, flowAgain: FlowAgain): ConvertResult {
  // Before anything of the file is read: a rule that is missing or is not one of the two names is a usage error.
  const reading = readingRuleOf(readingRule);
  // Held at run time too, for a caller that is not type-checked: no default, and nothing is written without the second look.
  if (typeof flowAgain !== 'function') throw new ImportUsageError(`missing --flow: the flow must be read again, and there is no import without it. ${USAGE}`);
  const sourceSha256 = sha256Hex(bytes);
  const lines = readLines(bytes, fileName);
  if (lines.illFormed === undefined) return convertLines(lines, sourceSha256, reading, fileName, cases, bar, flowAgain);
  // A line holds an unpaired surrogate. The checks of the conversion name it by its row and its field wherever they
  // read that text, and their refusal stands. Wherever they do not (a key, a field nothing reads), the file is
  // refused all the same: no run is written from it, and an error from the hash of such a text is this refusal.
  try {
    convertLines(lines, sourceSha256, reading, fileName, cases, bar, flowAgain);
  } catch (e) {
    if (e instanceof ImportRefusal || e instanceof ImportUsageError || e instanceof ImportInputError) throw e;
  }
  throw lines.illFormed;
}

/** The conversion of the lines `readLines` returned: everything `convertRegrade` does after the file is split into its header and rows. */
function convertLines(lines: ReturnType<typeof readLines>, sourceSha256: string, reading: Reading, fileName: string, cases: CasesFile, bar: BarFile, flowAgain: FlowAgain): ConvertResult {
  const header = readHeader(lines.header, fileName);
  // The re-grade read every reply under the rule its header names, and stopped or counted by it. A file is imported under
  // that rule and no other: the rule stated here must be the header's, and this is refused before any reply is read.
  if (header.reading !== reading) {
    throw new ImportRefusal('IMPORT_EVIDENCE', ['header/reading'], `${fileName}:1: reading: the header names the reading rule ${header.reading}, and --reading states ${reading}; a re-grade file is imported under the rule its header declares, and another rule is a different judge definition`);
  }
  const rows = readRows(lines.rows, fileName);
  const system = header.system === NOT_SENT ? undefined : header.system.text;
  const pointer = header.selector === NOT_SENT ? undefined : header.selector.pointer;

  // -- the header's counts, as numbers, before anything is built whose size one of them sets ------------------------
  // A count in a header is the script's declaration, and a file can state any number. One beyond the bound is refused
  // at once: a list of that length is never built, so a crafted header ends in a refusal, not in an exhausted memory.
  const bound = headerCountBound(rows.length);
  const sizes: Problem[] = [];
  const sizeBad = (key: 'draws' | 'slotCount' | 'reps', what: string): void => {
    sizes.push({ code: 'IMPORT_DRAW_COUNT', field: `header/${key}`, message: `${fileName}:1: ${key}: ${what}` });
  };
  for (const key of ['draws', 'slotCount'] as const) {
    if (header[key] > bound) sizeBad(key, `${header[key]} is beyond ${HEADER_COUNT_BOUND}, the most this importer takes for a count of the header (or the number of rows in the file, ${rows.length}, when that is more)`);
  }
  // The rep count of the flow has nothing to do with the rows of the file: the plain bound, which the flow reader holds too.
  if (header.reps > HEADER_COUNT_BOUND) sizeBad('reps', `${header.reps} is beyond ${HEADER_COUNT_BOUND}, the most this importer takes for the declared rep count of a flow`);
  // Nor the slots of the flow that the reader would look for with --flow (the cases times the reps): the re-grade
  // script refuses such a count before it reads the flow, so a header that states one was not written by it.
  else if (flowSlotCount(Object.keys(cases).length, header.reps) > HEADER_COUNT_BOUND) sizeBad('reps', flowSlotsWords(Object.keys(cases).length, header.reps));
  refuseAll(sizes);
  // Every case holds `draws` slots, so there are never more draws than slots; and a file never holds more rows than slots.
  if (header.draws > header.slotCount) sizeBad('draws', `${header.draws} is more than the header's slotCount ${header.slotCount}`);
  if (rows.length > header.slotCount) sizeBad('slotCount', `the file holds ${rows.length} rows, more than the header's slotCount ${header.slotCount}`);
  refuseAll(sizes);
  // A case cannot be both measured and excluded: the header was then written under another cases file.
  const both = header.excludedCaseIds.filter((id) => Object.hasOwn(cases, id));
  if (both.length > 0) {
    throw new ImportRefusal('IMPORT_EVIDENCE', ['header/excludedCaseIds'], `${fileName}:1: excludedCaseIds: ${both.map((id) => JSON.stringify(id)).join(', ')} ${both.length === 1 ? 'is' : 'are'} in cases.json; the re-grade was made with a cases file that left ${both.length === 1 ? 'it' : 'them'} out`);
  }
  // The slots the stated cases and the header's draws give, in the fixed order. The list is built only when its
  // length is the header's slotCount, which is within the bound; when the two differ it stays empty, the difference
  // is refused below as a number, and no slot is named from a count the roster contradicts.
  const caseIds = Object.keys(cases).sort(byCodeUnit);
  const product = caseIds.length * header.draws;
  const expected = product === header.slotCount ? caseIds.flatMap((id) => Array.from({ length: header.draws }, (_, k) => ({ caseId: id, draw: k }))) : [];

  // -- slots with no record: a failed call, a row without a record, a slot the re-grade never reached ----------------
  const noRecord: { caseId: string; draw: number; reason: string }[] = [];
  for (const r of rows) {
    const at = `${fileName}:${r.line}`;
    if (r.hasError) noRecord.push({ caseId: r.caseId, draw: r.draw, reason: `${at}: the re-grade recorded a failed call: ${typeof r.error === 'string' ? r.error.slice(0, 300) : typeName(r.error)}` });
    else if (!r.hasEvidence) noRecord.push({ caseId: r.caseId, draw: r.draw, reason: `${at}: the row holds no graderEvidence` });
  }
  if (rows.length < header.slotCount) {
    const present = new Set(rows.map((r) => r.label));
    const missing = expected.filter((s) => !present.has(slotLabel(s.caseId, s.draw)));
    const short = header.slotCount - rows.length;
    for (const s of missing) noRecord.push({ ...s, reason: 'no row: the re-grade ended before this slot was graded' });
    // When the stated cases do not account for the missing rows, the count is still said.
    if (missing.length !== short) noRecord.push({ caseId: `${short} row(s) fewer than the header's slotCount ${header.slotCount}`, draw: -1, reason: 'the re-grade did not finish' });
  }
  if (noRecord.length > 0) throw ungradedRefusal(noRecord, UNGRADED_CLOSING);

  // -- one stored output per case: the draws of a case are repeated grades of it, so its rows hold one output, one
  //    trace, one set of parts and one prompt. Each row is compared with the first row of its case. ------------------
  const found = new Map<string, unknown>();
  const firstOf = new Map<string, Row>();
  const split: Problem[] = [];
  for (const r of rows) {
    const first = firstOf.get(r.caseId);
    if (first === undefined) {
      firstOf.set(r.caseId, r);
      found.set(r.caseId, { question: r.parts.question });
      continue;
    }
    const off = (code: ImportRefusalCode, what: string): void => {
      split.push({ code, field: r.label, message: `${r.label}: ${what} of ${first.label}; the draws of a case are repeated grades of one stored output` });
    };
    if (r.storedOutput !== first.storedOutput || r.storedOutputSha256 !== first.storedOutputSha256) off('IMPORT_OUTPUTS_DIFFER', 'the stored output is not that');
    if (r.traceSha256 !== first.traceSha256) off('IMPORT_EVIDENCE', 'the trace sha256 is not that');
    if (hashOf(r.parts) !== hashOf(first.parts)) off('IMPORT_PACKET', 'the parts shown to the judge are not those');
    if (r.promptSent !== first.promptSent) off('IMPORT_PACKET', 'the prompt sent is not that');
  }
  // A case whose outputs differ is named under that code first, whatever else differs with it.
  refuseAll([...split.filter((p) => p.code === 'IMPORT_OUTPUTS_DIFFER'), ...split.filter((p) => p.code !== 'IMPORT_OUTPUTS_DIFFER')]);

  // -- the roster, the draws of each case and the order of the rows --------------------------------------------------
  const roster = buildCases(cases, found);

  const counts: Problem[] = [];
  const countBad = (field: string, message: string): void => {
    counts.push({ code: 'IMPORT_DRAW_COUNT', field, message });
  };
  if (header.slotCount !== product) countBad('header/slotCount', `the header's slotCount is ${header.slotCount}, but cases.json x the header's draws is ${roster.length} x ${header.draws} = ${product}`);
  const bySlot = new Map<string, Row[]>();
  for (const r of rows) { const list = bySlot.get(r.label); if (list === undefined) bySlot.set(r.label, [r]); else list.push(r); }
  for (const [label, group] of bySlot) if (group.length > 1) countBad(label, `${label}: the same slot ${group.length} times, on lines ${group.map((r) => r.line).join(' and ')}`);
  for (const r of rows) if (r.draw >= header.draws) countBad(r.label, `${r.label}: draw ${r.draw} is beyond the header's draws ${header.draws} (draws are 0 to ${header.draws - 1})`);
  for (const s of expected) if (!bySlot.has(slotLabel(s.caseId, s.draw))) countBad(slotLabel(s.caseId, s.draw), `${slotLabel(s.caseId, s.draw)}: expected (cases.json x ${header.draws} draws), but no row holds it`);
  if (counts.length === 0) {
    // The script writes the rows in one fixed order, case id then draw, which is also the order of its calls.
    rows.forEach((r, i) => {
      const want = expected[i] as { caseId: string; draw: number };
      if (r.label !== slotLabel(want.caseId, want.draw)) countBad(r.label, `${r.label}: on line ${r.line}, where the fixed order (case id, then draw) has ${slotLabel(want.caseId, want.draw)}`);
    });
  }
  refuseAll(counts);

  // -- the record of every row -----------------------------------------------------------------------------------------
  const table = rows.map((r) => {
    // No colon in the path: the shared module reads a problem's field as the text before the first colon.
    const where = `line ${r.line}/graderEvidence`;
    // The re-grade script drives the JavaScript recording grader, so its records are read as that grader's. What is
    // not a record, a record of an earlier version and a record that holds a reading rule are refused there, with
    // this path's instruction.
    return { ...r, where, record: parseRecord(r.evidence, where, 'promptfoo', RERUN) };
  });
  const notJs = table.filter((r) => r.record.grader.language !== 'js');
  if (notJs.length > 0) {
    throw new ImportRefusal('IMPORT_EVIDENCE', notJs.map((r) => r.label), `${notJs.map((r) => r.label).join(', ')}: the record says the grader is written in ${JSON.stringify(notJs[0]?.record.grader.language)}, not "js"; the re-grade script drives the JavaScript grader only`);
  }

  // The reply, from which the label is read, must be well-formed Unicode as every other text of the file.
  const unpaired = table.filter((r) => !isWellFormedText(r.record.reply));
  if (unpaired.length > 0) {
    throw new ImportRefusal('IMPORT_EVIDENCE', unpaired.map((r) => r.label), unpaired.map((r) => `${r.label}: the reply in the record: ${UNPAIRED_SURROGATE}`).join('; '));
  }

  // -- slots with no clean grade: the record's stop and content, and the reading under the stated rule --------------
  const ungraded: { caseId: string; draw: number; reason: string }[] = [];
  const verdict = new Map<string, boolean>();
  for (const r of table) {
    // The one reading of a slot (`readSlot` in ../shared.ts), which the promptfoo importer and the re-grade script call too:
    // a reply the other rule reads is named so, and nothing is chosen for the user.
    const v = readSlot(r.record, reading);
    if ('why' in v) {
      ungraded.push({ caseId: r.caseId, draw: r.draw, reason: `${r.where}${v.at}: ${v.why}` });
      continue;
    }
    verdict.set(r.label, v.pass);
  }
  if (ungraded.length > 0) throw ungradedRefusal(ungraded, UNGRADED_CLOSING);

  // -- forward, on every row: the stored output, the selection, the rendering, and the record's hashes --------------
  const forward: Problem[] = [];
  for (const r of table) {
    const off = (code: ImportRefusalCode, what: string): void => {
      forward.push({ code, field: r.label, message: `${r.label}: ${what}` });
    };
    if (outputHashOf(r.storedOutput) !== r.storedOutputSha256) off('IMPORT_EVIDENCE', 'storedOutputSha256 is not the sha256 of the stored output on the row');
    if (pointer === undefined) {
      if (r.parts.answer !== r.storedOutput) off('IMPORT_PACKET', 'with no selector the answer shown to the judge must be the whole stored output, and it is not');
    } else {
      const selected = trySelect(r.storedOutput, pointer);
      if ('why' in selected) off('IMPORT_PACKET', `${selectorLabel(pointer)} cannot be applied to the stored output: ${selected.why}`);
      else if (selected.value !== r.parts.answer) off('IMPORT_PACKET', `the answer shown to the judge is not what ${selectorLabel(pointer)} selects from the stored output`);
    }
    if (r.parts.criterion !== header.criterion.text) off('IMPORT_PACKET', "the criterion on the row is not the header's criterion text");
    const empty = (['question', 'answer', 'criterion'] as const).filter((k) => r.parts[k] === '');
    if (empty.length > 0) {
      off('IMPORT_PACKET', `${empty.join(', ')}: the text is empty`);
      continue;
    }
    const user = renderTemplate(header.template.text, r.parts);
    if (r.promptSent !== promptTextOf(system, user)) off('IMPORT_PACKET', "the prompt on the row is not the header's template filled with this row's parts (and the header's system text)");
    if (sha256Hex(r.promptSent) !== r.record.promptSha256) off('IMPORT_EVIDENCE', "the sha256 of the prompt on the row is not the record's promptSha256");
    if (r.record.sent.user !== sha256Hex(user)) off('IMPORT_EVIDENCE', 'the record says another user text was sent than the rendered one (sent.user)');
    if (r.record.sent.system !== (system === undefined ? NOT_SENT : sha256Hex(system))) off('IMPORT_EVIDENCE', "the record says another system text was sent than the header's (sent.system)");
  }
  refuseAll(forward);

  // -- the recorded calls ------------------------------------------------------------------------------------------------
  const slots: RecordedSlot[] = table.map((r) => ({ caseId: r.caseId, draw: r.draw, record: r.record }));
  checkRecordSet(slots);
  // The re-grade makes one grader call at a time, in the order of the rows, so the asks of a slot (its earlier asks,
  // then its last) take the next numbers in a row: any other order is a file this script did not write.
  let next = 1;
  const outOfSeq: { label: string; own: number[] }[] = [];
  for (const r of table) {
    const own = [...r.record.reask.earlier.map((a) => a.callSeq), r.record.callSeq];
    if (!own.every((v, k) => v === next + k)) outOfSeq.push({ label: r.label, own });
    next += own.length;
  }
  if (outOfSeq.length > 0) {
    throw new ImportRefusal('IMPORT_HIDDEN_CALLS', outOfSeq.map((r) => r.label), `callSeq: the calls were not made in the order of the rows (the asks of one slot, then those of the next; case id then draw): ${outOfSeq.map((r) => `${r.label} has callSeq ${r.own.join(', ')}`).join('; ')}`);
  }
  const rec0 = (table[0] as { record: GraderRecord }).record;
  const graderListed = header.scriptFiles.find((f) => f.path === GRADER_FILE);
  if (graderListed === undefined || graderListed.sha256 !== rec0.grader.sha256) {
    throw new ImportRefusal('IMPORT_EVIDENCE', ['header/scriptFiles'], `header/scriptFiles: the sha256 listed for ${GRADER_FILE} is not the grader's sha256 in the records`);
  }
  checkHeaderGraderConfig(header.graderConfig, rec0);

  // -- the second look at the flow ----------------------------------------------------------------------------------------
  {
    const flow = flowAgain(header.variant, cases, header.reps);
    const diff: Problem[] = [];
    const flowBad = (code: ImportRefusalCode, field: string, message: string): void => {
      diff.push({ code, field, message: `--flow: ${message}` });
    };
    if (flow.resultsSha256 !== header.resultsSha256) flowBad('IMPORT_EVIDENCE', 'header/resultsSha256', `results.jsonl of variant ${header.variant} is not the file the re-grade read (its sha256 differs)`);
    if (flow.stateSha256 !== header.stateSha256) {
      const gone = flow.stateSha256 === GAP ? 'the flow holds no _state.json, and the re-grade read one' : header.stateSha256 === GAP ? 'the flow holds a _state.json, and the re-grade read none' : '_state.json is not the file the re-grade read (its sha256 differs)';
      flowBad('IMPORT_EVIDENCE', 'header/stateSha256', gone);
    }
    // The excluded cases, computed again from the flow and the stated cases, against the header's declaration.
    const excludedNow = flow.excluded.map((c) => c.caseId);
    if (excludedNow.length !== header.excludedCaseIds.length || excludedNow.some((id, i) => id !== header.excludedCaseIds[i])) {
      const only = (a: readonly string[], b: readonly string[]): string => a.filter((id) => !b.includes(id)).map((id) => JSON.stringify(id)).join(', ') || 'none';
      flowBad('IMPORT_EVIDENCE', 'header/excludedCaseIds', `the cases the flow holds and cases.json does not are not the header's excludedCaseIds (in the flow only: ${only(excludedNow, header.excludedCaseIds)}; in the header only: ${only(header.excludedCaseIds, excludedNow)})`);
    }
    if (flow.harnessSha !== header.harnessSha) flowBad('IMPORT_EVIDENCE', 'header/harnessSha', `harness_sha of _state.json is not the value the re-grade wrote in its header`);
    // The source rep's slot of each case: the one trace and stored output every row of that case must hold. The
    // source rep must be whole in the flow as it is now (a refusal that lists its problems); no other rep need be.
    const onDisk = new Map(wholeRepSlots(flow, header.sourceRep).map((s) => [s.caseId, s]));
    const source = (id: string): string => `rep ${header.sourceRep} of ${id}`;
    for (const r of table) {
      const s = onDisk.get(r.caseId);
      if (s === undefined) {
        flowBad('IMPORT_DRAW_COUNT', r.label, `${r.label}: the flow holds no ${source(r.caseId)}`);
        continue;
      }
      if (s.traceSha256 !== r.traceSha256) flowBad('IMPORT_EVIDENCE', r.label, `${r.label}: the trace of ${source(r.caseId)} is not the file the re-grade read (its sha256 differs)`);
      if (s.answer !== r.storedOutput) flowBad('IMPORT_OUTPUTS_DIFFER', r.label, `${r.label}: the stored output in the trace of ${source(r.caseId)} is not the one on the row`);
      if (s.prompt !== r.parts.question) flowBad('IMPORT_PACKET', r.label, `${r.label}: the question of ${source(r.caseId)} in the flow is not the one on the row`);
    }
    refuseAll(diff);
  }

  // -- the run ------------------------------------------------------------------------------------------------------------
  const callShape = rec0.callShape;
  const systemShape: Record<string, unknown> = {};
  for (const k of Object.keys(callShape)) systemShape[k] = k === 'schema' ? callShape[k] : GAP;
  const draws: Draw[] = table.map((r) => ({
    caseId: r.caseId,
    drawIndex: r.draw,
    // The graded attempt is the slot's last ask; the earlier asks the record holds stand before it, unmeasured.
    attempts: attemptsOf(r.record, {
      kind: 'graded',
      label: verdict.get(r.label) === true ? 'pass' : 'fail',
      // Over the whole stored assistant turn, whatever a selector picks from it.
      outputHash: outputHashOf(r.storedOutput),
      systemStop: GAP,
      judgeStop: 'end',
      // The packet: the question, and the text the judge was shown as the answer. The template is not in it.
      packetHash: packetHashOf({ question: r.parts.question }, r.parts.answer),
    }),
  }));
  const scriptFilesHash = hashOf(header.scriptFiles);
  const judge = {
    judgeDefinitionHash: hashOf({
      tool: TOOL,
      rowProfile: header.rowProfile,
      template: header.template.text,
      system: system ?? NOT_SENT,
      selector: header.selector,
      tools: [],
      reading,
      maxReasks: rec0.reask.max,
    }),
    judgeModelRequested: rec0.requestedModel,
    judgeModelServed: rec0.servedModel,
    judgeCallShapeHash: callShapeHash(callShape as CallShape),
    judgeHarnessVersion: judgeHarnessVersion(TOOL, header.rowProfile, rec0, scriptFilesHash),
    rubricHash: hashOf({ tool: TOOL, criterion: header.criterion.text }),
  };
  const caseSet = caseSetHash(roster);
  const barDigest = barHash(bar);
  const shownAs = pointer === undefined ? 'the whole assistant turn' : `the value at JSON Pointer ${JSON.stringify(pointer)} of the assistant turn`;
  const run: Record<string, unknown> = {
    schema: RUN_SCHEMA,
    identity: {
      caseSetHash: caseSet,
      rubricHash: judge.rubricHash,
      barHash: barDigest,
      systemModelRequested: GAP,
      systemModelServed: GAP,
      systemCallShapeHash: GAP,
      systemPromptHash: GAP,
      systemToolsHash: GAP,
      systemHarnessVersion: GAP,
      judgeDefinitionHash: judge.judgeDefinitionHash,
      judgeModelRequested: judge.judgeModelRequested,
      judgeModelServed: judge.judgeModelServed,
      judgeCallShapeHash: judge.judgeCallShapeHash,
      judgeHarnessVersion: judge.judgeHarnessVersion,
      seed: GAP,
      drawsPerCase: header.draws,
    },
    callShapes: { system: systemShape, judge: callShape },
    cases: roster,
    draws,
    packetBasis: 'declared',
    packetSource: `computed at import from a ${TOOL} re-grade file sha256:${sourceSha256} (sourceVersion: ${GAP}; rowProfile: ${header.rowProfile}, ${ROW_PROFILE_NOTE}; source rep ${header.sourceRep} of ${header.reps}; results.jsonl sha256:${header.resultsSha256}; _state.json sha256:${header.stateSha256}; harness_sha: ${header.harnessSha}; cases of the flow excluded by the cases file: ${header.excludedCaseIds.length}; flow read again: yes): the question, and ${shownAs} as the answer`,
  };
  assertBarHasLabels(bar, draws.flatMap((d) => d.attempts.flatMap((a) => (a.kind === 'graded' ? [a.label] : []))));
  return {
    run,
    judge,
    barHash: barDigest,
    caseSetHash: caseSet,
    drawsPerCase: header.draws,
    grader: rec0.grader,
    sourceSha256,
    resultsSha256: header.resultsSha256,
    stateSha256: header.stateSha256,
    harnessSha: header.harnessSha,
    sourceRep: header.sourceRep,
    reps: header.reps,
    excludedCaseIds: [...header.excludedCaseIds],
    wire: rec0.wire,
    requestedModel: rec0.requestedModel,
    servedModel: rec0.servedModel,
    reasoning: reasoningLine(table.map((r) => r.record)),
    reasks: reasksLine(table.map((r) => r.record)),
    readingRule: reading,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------

export type { Io };
export const USAGE = `usage: node examples/importers/skill-evals/import.ts --in <regrade.jsonl> --cases <cases.json> --bar <bar.json> --out <run.json> --reading <rule name> --flow <dir> [--grader-sha256 <sha256 of your own grader file>]   (the first six required, none with a default; --reading is one of ${READINGS.join(' | ')})`;

/** Runs the importer; returns the exit code: 0 written, 2 refused, 64 usage, 65 a cases file or a bar that does not validate, 70 an unexpected error. */
export function main(argv: readonly string[], io: Io): number {
  let done: ConvertResult | undefined;
  let flowDir: string | undefined;
  return runImporter(argv, io, {
    // The records are the JavaScript recording grader's, which the shared module knows under the first path's name.
    tool: 'promptfoo',
    usage: USAGE,
    graderPath: join(import.meta.dirname, '..', 'promptfoo', 'grader-provider.cjs'),
    flags: { required: [...IMPORT_FLAGS, '--reading', '--flow'], optional: [] },
    checkFlags: (flags) => {
      // Before any file is read: a missing or unknown rule name is a usage error that lists both names. The shared
      // runner reads the cases file and the bar through the path's strict reader itself.
      readingRuleOf(flags['--reading']);
    },
    extraLines: () => {
      const d = done as ConvertResult;
      return [
        `re-grade file sha256: ${d.sourceSha256}`,
        // Only what the code enforces is said as a fact. The source rep and the sha256 of results.jsonl are printed for
        // the reader to compare between two runs: no check here or in `judge-change` pairs or separates runs by either.
        `source rep: ${d.sourceRep} of the flow's ${d.reps} declared; each stored output graded ${d.drawsPerCase} time${d.drawsPerCase === 1 ? '' : 's'} (shown for the reader: nothing checks that two runs were made from the same rep, and judge-change refuses a pair only where their stored outputs differ)`,
        `results.jsonl sha256: ${d.resultsSha256} (checked against the flow that was read again; shown for the reader to compare between the two re-grades of one comparison: nothing checks that the two values are equal)`,
        `_state.json sha256: ${d.stateSha256}${d.stateSha256 === GAP ? ' (the flow held no _state.json)' : ''}`,
        `excluded cases: ${d.excludedCaseIds.length}${d.excludedCaseIds.length > 0 ? ` (${d.excludedCaseIds.join(', ')})` : ''} (cases the flow held and the cases file left out; computed again from the flow and found equal; the run measures the cases of the cases file only)`,
        `harness_sha: ${d.harnessSha} (as the flow's _state.json states it; its form is held, 64 hexadecimal characters or UNKNOWN, and what it is the hash of is not checked)`,
        `flow: read again from ${flowDir}; results.jsonl, _state.json, the excluded cases and the trace and stored output of the source rep of every case are the ones the re-grade read`,
        `source version: ${GAP}; row profile ${ROW_PROFILE} (${ROW_PROFILE_NOTE})`,
      ];
    },
    convert: (bytes, fileName, cases, bar, flags) => {
      const flow = flags['--flow'] as string;
      flowDir = flow;
      const r = convertRegrade(bytes, fileName, cases, bar, flags['--reading'], (variant, stated, reps) => readFlow(flow, variant, stated, reps));
      done = r;
      return { run: r.run, summary: r };
    },
  });
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  runImporterAsProcess(main, 'skill-evals import');
}
