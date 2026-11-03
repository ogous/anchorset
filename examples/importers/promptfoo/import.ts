/**
 * The promptfoo importer.
 *
 *   node examples/importers/promptfoo/import.ts --in <result.json> --cases <cases.json> --bar <bar.json> --out <run.json> --reading <rule name>
 *
 * It turns a promptfoo result file, of a version in `tested-versions.json`, written by a re-grade through the example recording grader, into an
 * `anchorset.run/v3` run file. Every judge field comes from the grader's record or from bytes in the file. The system
 * side and the seed are always "UNKNOWN". The machine's architecture and the output path in the source file are
 * never copied. The reading rule is stated to the importer (`--reading`, no default), not recorded by the grader. A file in which
 * any slot's last ask is not a clean, finished grade that is readable under that rule is refused whole. Every slot's
 * outcome is a graded attempt; before it stands one judge attempt that measured nothing for each earlier ask of the
 * slot that the grader recorded (`attemptsOf` in ../shared.ts).
 *
 * It imports only from `../shared.ts`, the library's public entry and Node built-ins.
 */
import { join } from 'node:path';
import { barHash, callShapeHash, caseSetHash, GAP, hashOf, NOT_SENT, outputHashOf, packetHashOf, RUN_SCHEMA, sha256Hex } from '../../../src/index.ts';
import type { BarFile, CallShape, Draw } from '../../../src/index.ts';
import {
  agreeSkeleton,
  asArr,
  asBool,
  asInt,
  asObj,
  asStr,
  assertBarHasLabels,
  attemptsOf,
  buildCases,
  checkRecordSet,
  field,
  checkGraderConfig,
  illFormedProblems,
  IMPORTER_FLAGS,
  ImportRefusal,
  isEntryPoint,
  isObject,
  judgeHarnessVersion,
  loadTestedVersions,
  noRecordRefusal,
  parseJsonStrict,
  parseRecord,
  parseSourceFile,
  peek,
  readingFromFlag,
  readSlot,
  READINGS,
  reasksLine,
  runImporter,
  runImporterAsProcess,
  shape,
  thinkingRepliesLine,
  typeName,
  ungradedRefusal,
  valueTypeProblems,
} from '../shared.ts';
import type { CasesFile, GraderRecord, Io, Reading, RecordedSlot, SkeletonRow, TestedSet } from '../shared.ts';

const GRADER_FILE = 'grader-provider.cjs';
const STORED_SCHEMA = 'example.stored-output/v1';

type Obj = Record<string, unknown>;

// The reading rule is the one the caller states (`--reading`; `readSlot` and `readUnderRule` in ../shared.ts): the grader neither reads nor records it.

/** The first line of the tool's own error text, without anything that looks like a path. */
function errorWords(row: Obj): string {
  const e = row['error'];
  if (typeof e !== 'string') return '';
  const first = e.split('\n')[0] ?? '';
  return first.split(/\s+/).map((w) => (/[\\/]/.test(w) ? '<path>' : w)).join(' ').slice(0, 200);
}

// ---------------------------------------------------------------------------------------------------------------
// The conversion
// ---------------------------------------------------------------------------------------------------------------

type Row = {
  i: number;
  path: string;
  caseId: string;
  vars: Obj;
  output: string;
  repeatIndex: number;
  testIdx: number;
  storedCaseId: string;
  storedSha: string;
  assertion: { type: string; value: string };
  pass: boolean;
  reason: string;
  rendered: string;
  record: GraderRecord;
  evPath: string;
  label: string;
};

export type ConvertResult = {
  run: Record<string, unknown>;
  judge: { judgeDefinitionHash: string; judgeModelRequested: string; judgeModelServed: string; judgeCallShapeHash: string; judgeHarnessVersion: string; rubricHash: string };
  barHash: string;
  caseSetHash: string;
  drawsPerCase: number;
  grader: { name: string; language: string; runtime: string; sha256: string };
  sourceSha256: string;
  thinkingReplies: string;
  reasks: string;
  readingRule: Reading;
};

/** The pure conversion: bytes of a promptfoo result file, the stated cases and the bar, to a run. Writes nothing. */
export function convertPromptfoo(bytes: Uint8Array, fileName: string, cases: CasesFile, bar: BarFile, readingRule: Reading, tested: TestedSet = loadTestedVersions('promptfoo')): ConvertResult {
  // No default: a missing or unknown name is a usage error, before any byte of the file is read.
  const reading = readingFromFlag(readingRule);
  const { json, sha256: sourceSha256 } = parseSourceFile(bytes, fileName, 'promptfoo');

  // -- the tool version and the format ------------------------------------------------------------------------
  const foundVersion = peek(json, 'metadata', 'promptfooVersion');
  const foundFormat = peek(json, 'results', 'version');
  if (typeof foundVersion !== 'string' || !tested.versions.includes(foundVersion) || foundFormat !== tested.format) {
    throw new ImportRefusal(
      'IMPORT_TOOL_VERSION',
      ['/metadata/promptfooVersion', '/results/version'],
      `this importer was tested on promptfoo ${tested.versions.join(', ')} (format ${tested.format}); the file says version ${JSON.stringify(foundVersion ?? 'missing')}, format ${JSON.stringify(foundFormat ?? 'missing')}`,
    );
  }
  const root = asObj(json, '/');
  const results = asObj(root['results'], '/results');
  const rows = asArr(results['results'], '/results/results');
  if (rows.length === 0) throw shape('/results/results', 'a non-empty array', rows);
  const runtime = asObj(root['runtimeOptions'], '/runtimeOptions');
  const config = asObj(root['config'], '/config');

  // -- one prompt, one system provider ------------------------------------------------------------------------
  const nPrompts = asArr(field(config, 'prompts', '/config'), '/config/prompts').length;
  const nProviders = asArr(field(config, 'providers', '/config'), '/config/providers').length;
  const nResultPrompts = asArr(field(results, 'prompts', '/results'), '/results/prompts').length;
  const promptIdx = new Set(rows.map((r) => peek(r, 'promptIdx')));
  if (nPrompts !== 1 || nProviders !== 1 || nResultPrompts !== 1 || promptIdx.size > 1) {
    throw new ImportRefusal(
      'IMPORT_JUDGE_SELECTION',
      ['/config/prompts', '/config/providers', '/results/prompts'],
      `this file compares ${Math.max(nPrompts, nProviders, nResultPrompts, promptIdx.size)} prompts or providers; an import needs one stored output per case`,
    );
  }

  // -- slots the tool itself marked as not graded ---------------------------------------------------------------
  const marked: { caseId: string; draw: number; reason: string }[] = [];
  rows.forEach((raw, i) => {
    const path = `/results/results/${i}`;
    const row = asObj(raw, path);
    const comp0 = peek(row, 'gradingResult', 'componentResults', 0);
    const words: string[] = [];
    // A judge's verdict of fail is failureReason 1 with the reason in `error` (seen in the fixtures); that is a graded
    // fail. Any `error` with another failure reason, and any failure reason but 0 or 1, is a slot the tool marked as not graded.
    const fr = row['failureReason'];
    if (row['error'] !== undefined && fr !== 1) words.push(`the tool recorded an error: ${errorWords(row) || 'no text'}`);
    if (fr !== 0 && fr !== 1) words.push(`failureReason ${JSON.stringify(fr ?? 'missing')} (an error or unknown)`);
    if (!isObject(row['gradingResult'])) words.push('gradingResult is empty');
    else if (peek(comp0, 'metadata', 'graderError') === true) words.push('graderError: the grader returned no usable result');
    if (words.length > 0) {
      const caseId = peek(row, 'vars', 'case_id');
      const draw = peek(row, 'metadata', 'storedOutput', 'repeatIndex');
      marked.push({ caseId: typeof caseId === 'string' ? caseId : `row ${i}`, draw: typeof draw === 'number' && Number.isInteger(draw) ? draw : -1, reason: `${path}: ${words.join('; ')}` });
    }
  });
  if (marked.length > 0) throw ungradedRefusal(marked);

  // -- the record must be there ---------------------------------------------------------------------------------
  const compPath = (i: number): string => `/results/results/${i}/gradingResult/componentResults/0`;
  const evOf = (i: number): unknown => peek(rows[i], 'gradingResult', 'componentResults', 0, 'metadata', 'graderEvidence');
  if (rows.every((_, i) => evOf(i) === undefined)) throw noRecordRefusal('promptfoo', `${compPath(0)}/metadata/graderEvidence`);

  // -- the cache -------------------------------------------------------------------------------------------------
  if (runtime['cache'] !== false) {
    throw new ImportRefusal('IMPORT_CACHE', ['/runtimeOptions/cache'], `the file does not show the response cache was off (/runtimeOptions/cache is ${JSON.stringify(runtime['cache'] ?? 'missing')}); run with --no-cache`);
  }
  const cached = rows.map((_, i) => i).filter((i) => {
    const c = peek(rows[i], 'gradingResult', 'componentResults', 0, 'metadata', 'cachedResponse');
    return c !== undefined && c !== false;
  });
  if (cached.length > 0) {
    throw new ImportRefusal('IMPORT_CACHE', cached.map((i) => `${compPath(i)}/metadata/cachedResponse`), `the file does not show the response cache was off: the tool marks ${cached.length} grade(s) as cached; run with --no-cache`);
  }

  // -- every row: structure, judge selection, derivation, the record ---------------------------------------------
  const table: Row[] = rows.map((raw, i) => {
    const path = `/results/results/${i}`;
    const row = asObj(raw, path);
    const vars = asObj(field(row, 'vars', path), `${path}/vars`);
    const caseId = vars['case_id'];
    if (typeof caseId !== 'string' || caseId === '') throw new ImportRefusal('IMPORT_CASE_ID', [`${path}/vars/case_id`], `${path}/vars/case_id: a case id must be a non-empty string, found ${typeName(caseId)}`);
    // Everything copied into the run meets the record's value-type rule: no null, no number the parser rounded.
    const badVars = Object.entries(vars).flatMap(([k, x]) => {
      const out: string[] = [];
      valueTypeProblems(x, `${path}/vars/${k}`, out);
      return out.length > 0 ? [{ field: `${path}/vars/${k}`, out }] : [];
    });
    if (badVars.length > 0) throw new ImportRefusal('IMPORT_SHAPE', badVars.map((b) => b.field), badVars.flatMap((b) => b.out).join('; '));
    const response = asObj(field(row, 'response', path), `${path}/response`);
    const output = asStr(field(response, 'output', `${path}/response`), `${path}/response/output`);
    const meta = asObj(field(row, 'metadata', path), `${path}/metadata`);
    const soPath = `${path}/metadata/storedOutput`;
    const so = asObj(field(meta, 'storedOutput', `${path}/metadata`), soPath);
    if (so['schema'] !== STORED_SCHEMA) throw new ImportRefusal('IMPORT_SHAPE', [`${soPath}/schema`], `${soPath}/schema: expected ${STORED_SCHEMA}`);
    const storedCaseId = asStr(field(so, 'caseId', soPath), `${soPath}/caseId`);
    const repeatIndex = asInt(field(so, 'repeatIndex', soPath), `${soPath}/repeatIndex`);
    const storedSha = asStr(field(so, 'outputSha256', soPath), `${soPath}/outputSha256`);
    const testIdx = asInt(field(row, 'testIdx', path), `${path}/testIdx`);

    const gr = asObj(row['gradingResult'], `${path}/gradingResult`);
    const comps = asArr(field(gr, 'componentResults', `${path}/gradingResult`), `${path}/gradingResult/componentResults`);
    if (comps.length !== 1) throw new ImportRefusal('IMPORT_JUDGE_SELECTION', [`${path}/gradingResult/componentResults`], `${path}: ${comps.length} assertion results on one row; an import needs exactly one llm-rubric assertion per row`);
    const cp = compPath(i);
    const comp = asObj(comps[0], cp);
    const assertion = asObj(field(comp, 'assertion', cp), `${cp}/assertion`);
    const type = asStr(field(assertion, 'type', `${cp}/assertion`), `${cp}/assertion/type`);
    if (type !== 'llm-rubric') throw new ImportRefusal('IMPORT_JUDGE_SELECTION', [`${cp}/assertion/type`], `${cp}/assertion/type: found ${JSON.stringify(type)}; an import needs one llm-rubric assertion per row`);
    for (const k of Object.keys(assertion)) {
      if (k !== 'type' && k !== 'value') throw new ImportRefusal('IMPORT_DERIVATION', [`${cp}/assertion/${k}`], `${cp}/assertion/${k}: this importer cannot name how the label was derived`);
    }
    const value = asStr(field(assertion, 'value', `${cp}/assertion`), `${cp}/assertion/value`);
    const cmeta = asObj(field(comp, 'metadata', cp), `${cp}/metadata`);
    if (cmeta['renderedAssertionValue'] !== undefined) {
      throw new ImportRefusal('IMPORT_DERIVATION', [`${cp}/metadata/renderedAssertionValue`], `${cp}/metadata/renderedAssertionValue: the rubric is templated, so it differs per item and is not one rubric; this importer cannot name how the label was derived`);
    }
    const pass = asBool(field(comp, 'pass', cp), `${cp}/pass`);
    const reason = asStr(field(comp, 'reason', cp), `${cp}/reason`);
    const rendered = asStr(field(cmeta, 'renderedGradingPrompt', `${cp}/metadata`), `${cp}/metadata/renderedGradingPrompt`);
    const evPath = `${cp}/metadata/graderEvidence`;
    const evRaw = cmeta['graderEvidence'];
    if (evRaw === undefined) throw new ImportRefusal('IMPORT_EVIDENCE', [evPath], `${evPath}: missing on this row while other rows carry a record`);
    const record = parseRecord(evRaw, evPath, 'promptfoo');
    return { i, path, caseId, vars, output, repeatIndex, testIdx, storedCaseId, storedSha, assertion: { type, value }, pass, reason, rendered, record, evPath, label: `${caseId}#${repeatIndex}` };
  });

  // -- the grader is the JavaScript one: a record that says another language is not this grader's ---------------------
  const notJs = table.filter((r) => r.record.grader.language !== 'js');
  if (notJs.length > 0) {
    throw new ImportRefusal('IMPORT_EVIDENCE', notJs.map((r) => `${r.evPath}.grader.language`), `${notJs.map((r) => r.label).join(', ')}: the record says the grader is written in ${JSON.stringify(notJs[0]?.record.grader.language)}, not "js"; this importer reads the JavaScript grader's records only`);
  }

  // -- slots with no clean grade: the record's stop and content, and the strict reading ------------------------------
  // One reading rule for the whole file, stated by the caller: two runs read under different rules are two judges.
  const ungraded: { caseId: string; draw: number; reason: string }[] = [];
  const strict = new Map<number, { pass: boolean; reason: unknown }>();
  for (const r of table) {
    // The one reading of a slot (`readSlot` in ../shared.ts): the record's stop and content, then the reply under the stated rule.
    const v = readSlot(r.record, reading);
    if ('why' in v) {
      ungraded.push({ caseId: r.caseId, draw: r.repeatIndex, reason: `${r.evPath}${v.at}: ${v.why}` });
      continue;
    }
    strict.set(r.i, v);
  }
  if (ungraded.length > 0) throw ungradedRefusal(ungraded);

  const disagree = table.filter((r) => strict.get(r.i)?.pass !== r.pass);
  if (disagree.length > 0) {
    throw new ImportRefusal(
      'IMPORT_LABEL_DISAGREES',
      disagree.map((r) => `${r.path}/gradingResult/componentResults/0/pass`),
      disagree.map((r) => `${r.label}: the reply says ${String(strict.get(r.i)?.pass)}, the tool wrote ${String(r.pass)}`).join('; '),
    );
  }
  const reasonOff = table.filter((r) => strict.get(r.i)?.reason !== r.reason);
  if (reasonOff.length > 0) {
    throw new ImportRefusal('IMPORT_EVIDENCE', reasonOff.map((r) => `${r.path}/gradingResult/componentResults/0/reason`), `${reasonOff.map((r) => r.label).join(', ')}: the tool's reason is not the reason of the recorded reply`);
  }

  // -- the prompt the judge was sent, against the record -------------------------------------------------------------
  const contentsOf = new Map<number, string[]>();
  for (const r of table) {
    const where = `${r.path}/gradingResult/componentResults/0/metadata/renderedGradingPrompt`;
    if (sha256Hex(r.rendered) !== r.record.promptSha256) throw new ImportRefusal('IMPORT_EVIDENCE', [where, `${r.evPath}/promptSha256`], `${where}: the sha256 of the rendered prompt is not the record's promptSha256`);
    // The one strict reader. The prompt is a JSON text inside a string of the file, so it can spell with an escape what
    // the file's own text does not hold: an unpaired surrogate, which has no hash, is refused here and names the prompt.
    const read = parseJsonStrict(r.rendered);
    if ('why' in read) throw shape(where, 'the JSON text of a message list', r.rendered);
    const list = read.value;
    const illFormed = illFormedProblems(list);
    if (illFormed.length > 0) throw new ImportRefusal('IMPORT_SHAPE', [where], illFormed.map((p) => `${where}: ${p}`).join('; '));
    const msgs = asArr(list, where);
    const roles = msgs.map((m) => peek(m, 'role')).join();
    if (!(roles === 'user' || roles === 'system,user')) throw new ImportRefusal('IMPORT_EVIDENCE', [where], `${where}: the prompt must be [system, user] or [user]`);
    const contents = msgs.map((m, k) => asStr(peek(m, 'content'), `${where}[${k}]/content`));
    const user = contents[contents.length - 1] as string;
    const system = contents.length === 2 ? (contents[0] as string) : NOT_SENT;
    const sentSystem = system === NOT_SENT ? NOT_SENT : sha256Hex(system);
    if (sha256Hex(user) !== r.record.sent.user || sentSystem !== r.record.sent.system) {
      throw new ImportRefusal('IMPORT_EVIDENCE', [where, `${r.evPath}/sent`], `${where}: the texts of the rendered prompt are not the ones the record says were sent`);
    }
    contentsOf.set(r.i, contents);
  }

  // -- the roster -------------------------------------------------------------------------------------------------------
  const idOff = table.filter((r) => r.storedCaseId !== r.caseId);
  if (idOff.length > 0) {
    throw new ImportRefusal('IMPORT_CASE_ID', idOff.map((r) => `${r.path}/metadata/storedOutput/caseId`), `${idOff.map((r) => `${r.path}: storedOutput.caseId ${JSON.stringify(r.storedCaseId)} but vars.case_id ${JSON.stringify(r.caseId)}`).join('; ')}`);
  }
  const byCase = new Map<string, Row[]>();
  for (const r of table) { const list = byCase.get(r.caseId); if (list === undefined) byCase.set(r.caseId, [r]); else list.push(r); }
  const found = new Map<string, unknown>();
  for (const [id, group] of byCase) {
    const inputs = new Set(group.map((r) => hashOf(r.vars)));
    if (inputs.size > 1) throw new ImportRefusal('IMPORT_CASE_ID', group.map((r) => `${r.path}/vars`), `${id}: the variables differ between the rows of one case (${inputs.size} distinct)`);
    found.set(id, (group[0] as Row).vars);
  }
  const roster = buildCases(cases, found);

  // -- the draw count ---------------------------------------------------------------------------------------------------
  const repeat = runtime['repeat'];
  if (typeof repeat !== 'number' || !Number.isSafeInteger(repeat) || repeat < 1) {
    throw new ImportRefusal('IMPORT_DRAW_COUNT', ['/runtimeOptions/repeat'], `/runtimeOptions/repeat: the repeat count is missing or not a positive integer (found ${JSON.stringify(repeat ?? 'missing')})`);
  }
  const countProblems: string[] = [];
  for (const [id, group] of byCase) {
    const idx = group.map((r) => r.repeatIndex).sort((a, b) => a - b);
    const exact = idx.length === repeat && idx.every((v, k) => v === k);
    if (!exact) {
      countProblems.push(`${id}: ${group.length} of ${repeat} rows, repeat indexes [${idx.join(', ')}] (each of 0 to ${repeat - 1} must occur once)`);
      continue;
    }
    const byTest = [...group].sort((a, b) => a.testIdx - b.testIdx);
    const strictlyOrdered = byTest.every((r, k) => k === 0 || r.testIdx > (byTest[k - 1] as Row).testIdx);
    if (!strictlyOrdered || !byTest.every((r, k) => r.repeatIndex === k)) countProblems.push(`${id}: the order of the rows by testIdx contradicts the recorded repeat indexes`);
  }
  if (countProblems.length > 0) throw new ImportRefusal('IMPORT_DRAW_COUNT', [...byCase.keys()].filter((id) => countProblems.some((p) => p.startsWith(`${id}:`))), countProblems.join('; '));

  // -- one output per case ------------------------------------------------------------------------------------------
  const outputProblems: string[] = [];
  const outputCases: string[] = [];
  for (const [id, group] of byCase) {
    const distinct = new Set(group.map((r) => outputHashOf(r.output)));
    if (distinct.size > 1) {
      outputProblems.push(`${id}: ${distinct.size} distinct outputs`);
      outputCases.push(id);
    } else if (group.some((r) => outputHashOf(r.output) !== r.storedSha)) {
      outputProblems.push(`${id}: the output's hash differs from the stored-outputs provider's`);
      outputCases.push(id);
    }
  }
  if (outputProblems.length > 0) throw new ImportRefusal('IMPORT_OUTPUTS_DIFFER', outputCases, outputProblems.join('; '));

  // -- the recorded calls ---------------------------------------------------------------------------------------------
  const slots: RecordedSlot[] = table.map((r) => ({ caseId: r.caseId, draw: r.repeatIndex, record: r.record }));
  checkRecordSet(slots);
  const rec0 = (table[0] as Row).record;

  // -- the rubric: one value over all rows --------------------------------------------------------------------------------
  const rubricValues = new Set(table.map((r) => hashOf({ type: r.assertion.type, value: r.assertion.value })));
  if (rubricValues.size > 1) throw new ImportRefusal('IMPORT_MIXED_IDENTITY', ['rubric'], `rubric: ${rubricValues.size} distinct values`);
  const rubric = (table[0] as Row).assertion;

  // -- the grader named in the config, with the settings the record shows -------------------------------------------------
  checkNamedGrader(config, rec0);

  // -- the packet: the skeleton, then every row rendered forward --------------------------------------------------------------
  const skeletonRows: SkeletonRow[] = table.map((r) => ({
    label: r.label,
    contents: contentsOf.get(r.i) as string[],
    components: [
      { name: 'output', value: r.output },
      { name: 'rubric', value: r.assertion.value },
    ],
  }));
  const skeleton = agreeSkeleton(skeletonRows);

  // -- the run -----------------------------------------------------------------------------------------------------------------
  const callShape = rec0.callShape;
  const systemShape: Record<string, unknown> = {};
  for (const k of Object.keys(callShape)) systemShape[k] = k === 'schema' ? callShape[k] : GAP;
  const draws: Draw[] = [...table]
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : a.repeatIndex - b.repeatIndex))
    .map((r) => ({
      caseId: r.caseId,
      drawIndex: r.repeatIndex,
      // The graded attempt is the slot's last ask; the earlier asks the record holds stand before it, unmeasured.
      attempts: attemptsOf(r.record, {
        kind: 'graded',
        label: (strict.get(r.i) as { pass: boolean }).pass ? 'pass' : 'fail',
        outputHash: outputHashOf(r.output),
        systemStop: GAP,
        judgeStop: 'end',
        packetHash: packetHashOf({}, r.output),
      }),
    }));
  const judge = {
    judgeDefinitionHash: hashOf({ tool: 'promptfoo', version: foundVersion, assertion: 'llm-rubric', skeleton, tools: [], reading, maxReasks: rec0.reask.max }),
    judgeModelRequested: rec0.requestedModel,
    judgeModelServed: rec0.servedModel,
    judgeCallShapeHash: callShapeHash(callShape as CallShape),
    judgeHarnessVersion: judgeHarnessVersion('promptfoo', foundVersion, rec0),
    rubricHash: hashOf({ tool: 'promptfoo', type: rubric.type, value: rubric.value }),
  };
  const caseSet = caseSetHash(roster);
  const barDigest = barHash(bar);
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
      drawsPerCase: repeat,
    },
    callShapes: { system: systemShape, judge: callShape },
    cases: roster,
    draws,
    packetBasis: 'declared',
    packetSource: `computed at import from promptfoo ${foundVersion} result file sha256:${sourceSha256}: the output slot of the rendered grading prompt; no system log`,
  };
  assertBarHasLabels(bar, draws.flatMap((d) => d.attempts.flatMap((a) => (a.kind === 'graded' ? [a.label] : []))));
  return { run, judge, barHash: barDigest, caseSetHash: caseSet, drawsPerCase: repeat, grader: rec0.grader, sourceSha256, thinkingReplies: thinkingRepliesLine(table.map((r) => r.record)), reasks: reasksLine(table.map((r) => r.record)), readingRule: reading };
}

/** The grader named in the config as `{ id, config }`, and every setting there equal to what the record shows. */
function checkNamedGrader(config: Obj, rec: GraderRecord): void {
  const where = '/config/defaultTest/options/provider';
  const named = peek(config, 'defaultTest', 'options', 'provider');
  const notNamed = (what: string): ImportRefusal =>
    new ImportRefusal('IMPORT_EVIDENCE', [where], `${where}: ${what}. The grader must be named in the config as the provider of the llm-rubric assertion, never by --grader, which leaves no trace in the file (examples/importers/promptfoo/${GRADER_FILE})`);
  if (!isObject(named) || typeof named['id'] !== 'string' || !isObject(named['config'])) throw notNamed('the config does not name the grader as { id, config }');
  if (!new RegExp(`(^|[/:])${GRADER_FILE.replace('.', '\\.')}$`).test(named['id'])) throw notNamed(`the grader's id is ${JSON.stringify(named['id'])}, not ${GRADER_FILE}`);
  checkGraderConfig(named['config'], rec, `${where}/config`);
}

// ---------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------

export type { Io };
const USAGE = `usage: node examples/importers/promptfoo/import.ts --in <result.json> --cases <cases.json> --bar <bar.json> --out <run.json> --reading <rule name> [--grader-sha256 <sha256 of your own grader file>]   (the first five required; --reading is one of ${READINGS.join(' | ')})`;

/** Runs the importer; returns the exit code: 0 written, 2 refused, 64 usage, 65 a cases file or a bar that does not validate, 70 an unexpected error. */
export function main(argv: readonly string[], io: Io): number {
  return runImporter(argv, io, {
    tool: 'promptfoo',
    usage: USAGE,
    flags: IMPORTER_FLAGS.promptfoo,
    checkFlags: (flags) => void readingFromFlag(flags['--reading']),
    graderPath: join(import.meta.dirname, GRADER_FILE),
    convert: (bytes, fileName, cases, bar, flags) => {
      const r = convertPromptfoo(bytes, fileName, cases, bar, readingFromFlag(flags['--reading']));
      return { run: r.run, summary: r };
    },
  });
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  runImporterAsProcess(main, 'promptfoo import');
}
