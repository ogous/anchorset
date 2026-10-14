/**
 * The Inspect importer.
 *
 *   node examples/importers/inspect/import.ts --in <log.json> --cases <cases.json> --bar <bar.json> --out <run.json>
 *
 * It reads one JSON-format Inspect log of inspect_ai 0.3.275 (log version 2) that `regrade.py` wrote through the
 * recording grader, and writes an `anchorset.run/v3` file. It refuses, and writes nothing, when any slot is not a
 * clean, finished, strictly readable grade, or when the fields it reads do not agree with one another and with the grader's record.
 *
 * The record is read from the sample's score, never from an event. An event string that is an `attachment://`
 * reference is resolved through the sample's attachments; a reference inside a score refuses. The system side
 * and the seed are always "UNKNOWN". The forward rendering of the grader's prompt is a single pass of plain
 * substitution of the four `{name}` tokens of the logged template, and refuses what the tool would rewrite.
 *
 * This file imports only from `../shared.ts`, the library's public entry and Node built-ins.
 */
import { join } from 'node:path';
import { barHash, callShapeHash, caseSetHash, GAP, hashOf, NOT_SENT, outputHashOf, packetHashOf, RUN_SCHEMA, sha256Hex } from '../../../src/index.ts';
import type { BarFile } from '../../../src/index.ts';
import {
  shown,
  templateProblem,
  asArr,
  asObj,
  asStr,
  assertBarHasLabels,
  attemptsOf,
  buildCases,
  checkForward,
  checkRecordSet,
  endpointSettingProblems,
  GRADER_CONFIG_KEYS,
  isEntryPoint,
  isObject,
  ImportRefusal,
  judgeHarnessVersion,
  noRecordRefusal,
  parseRecord,
  parseSourceFile,
  reasksLine,
  runImporter,
  runImporterAsProcess,
  shape,
  skeletonFromTemplate,
  thinkingRepliesLine,
  typeName,
  ungradedReason,
  ungradedRefusal,
} from '../shared.ts';
import type { CasesFile, GraderRecord, Io, RecordedSlot, SkeletonRow } from '../shared.ts';

export const TESTED_VERSION = '0.3.275';
export const TESTED_LOG_VERSION = 2;
const SCORER = 'model_graded_qa';
const SLOTS = ['question', 'answer', 'criterion', 'instructions'] as const;
const DATA_MARKER = /\[(?:begin|end) data\]/i;
export const MODEL_ARG_KEYS = GRADER_CONFIG_KEYS.inspect;

/** The keys the tool writes on the grader's prompt message and on its reply message. Any other key refuses. */
const PROMPT_MESSAGE_KEYS = ['id', 'content', 'role', 'source'];
const REPLY_MESSAGE_KEYS = ['id', 'content', 'source', 'metadata', 'role', 'model'];

type J = Record<string, unknown>;

/** Every string under `v` that begins with `attachment://`, as paths. */
function attachmentPaths(v: unknown, path: string, out: string[]): void {
  if (typeof v === 'string') {
    if (v.startsWith('attachment://')) out.push(path);
  } else if (Array.isArray(v)) v.forEach((x, i) => attachmentPaths(x, `${path}/${i}`, out));
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) attachmentPaths(x, `${path}/${k}`, out);
}

/** A copy of `v` in which every `attachment://<key>` string is replaced by the sample's attachment of that key. */
function resolveDeep(v: unknown, attachments: J, path: string): unknown {
  if (typeof v === 'string') {
    if (!v.startsWith('attachment://')) return v;
    const key = v.slice('attachment://'.length);
    const got = Object.hasOwn(attachments, key) ? attachments[key] : undefined;
    if (typeof got !== 'string') throw new ImportRefusal('IMPORT_SHAPE', [path], `${path}: the reference ${v} has no entry among the sample's attachments`);
    return got;
  }
  if (Array.isArray(v)) return v.map((x, i) => resolveDeep(x, attachments, `${path}/${i}`));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveDeep(x, attachments, `${path}/${k}`)]));
  return v;
}

/** The strict reading of a reply: its last non-empty line must be exactly `GRADE: ` and one capital letter. */
export function strictGrade(reply: string): string | undefined {
  const lines = reply.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    return /^GRADE: ([A-Z])$/.exec(line)?.[1];
  }
  return undefined;
}

type Pending = {
  path: string;
  label: string;
  caseId: string;
  rawId: string | number;
  draw: number;
  s: J;
  input: string;
  target: string;
};
type Row = Pending & { score: J; g1: J; value: string; answer: string; prompt: string; reply: string; g: GraderRecord; gPath: string; output: string };

export type InspectSummary = {
  judge: { judgeDefinitionHash: string; judgeModelRequested: string; judgeModelServed: string; judgeCallShapeHash: string; judgeHarnessVersion: string; rubricHash: string };
  barHash: string;
  caseSetHash: string;
  drawsPerCase: number;
  grader: { name: string; language: string; runtime: string; sha256: string };
  slots: number;
  thinkingReplies: string;
  reasks: string;
};

/**
 * The whole import, from the log's bytes. Throws `ImportRefusal` and writes nothing. Pure: no file is read or written.
 */
export function buildInspectRun(bytes: Uint8Array, fileName: string, stated: CasesFile, bar: BarFile): { run: Record<string, unknown>; summary: InspectSummary } {
  if (fileName.toLowerCase().endsWith('.eval')) {
    throw new ImportRefusal('IMPORT_SHAPE', [fileName], `${fileName}: this is the packed log format; write the log with examples/importers/inspect/regrade.py, or convert it with the tool's own command (inspect log convert)`);
  }
  const { json, sha256: sourceSha } = parseSourceFile(bytes, fileName, 'inspect');
  const root = asObj(json, '/');

  // ---- versions --------------------------------------------------------------------------------------------------
  const evalBlock = asObj(root['eval'], '/eval');
  const packages = isObject(evalBlock['packages']) ? evalBlock['packages'] : {};
  const toolVersion = packages['inspect_ai'];
  if (root['version'] !== TESTED_LOG_VERSION || toolVersion !== TESTED_VERSION) {
    throw new ImportRefusal(
      'IMPORT_TOOL_VERSION',
      ['/version', '/eval/packages/inspect_ai'],
      `this importer was tested on inspect_ai ${TESTED_VERSION} (format ${TESTED_LOG_VERSION}); the file says inspect_ai ${typeof toolVersion === 'string' ? toolVersion : 'nothing'}, format ${typeof root['version'] === 'number' ? root['version'] : 'nothing'}`,
    );
  }
  if (root['status'] !== 'success') {
    throw new ImportRefusal('IMPORT_UNGRADED', ['/status'], `/status: the log's status is ${JSON.stringify(root['status'] ?? 'missing')}, not "success". Nothing was written. Keep this file: the measurement planned on this re-grade is aborted, and a further re-grade is a new experiment that reports this one (docs/IMPORTERS.md)`);
  }

  if (root['invalidated'] !== undefined && root['invalidated'] !== false) {
    throw new ImportRefusal('IMPORT_UNGRADED', ['/invalidated'], `/invalidated: the tool marks this log as having invalidated samples (${JSON.stringify(root['invalidated'])}); a sample the tool says is not to be used is not imported`);
  }

  // ---- one scorer, one sample list -------------------------------------------------------------------------------
  const scorers = asArr(evalBlock['scorers'], '/eval/scorers');
  if (scorers.length !== 1) throw new ImportRefusal('IMPORT_JUDGE_SELECTION', ['/eval/scorers'], `/eval/scorers: found ${scorers.length} scorers; an import needs exactly one, ${SCORER}`);
  const scorer = asObj(scorers[0], '/eval/scorers/0');
  if (scorer['name'] !== SCORER) throw new ImportRefusal('IMPORT_JUDGE_SELECTION', ['/eval/scorers/0/name'], `/eval/scorers/0/name: the scorer is ${JSON.stringify(scorer['name'])}, not ${SCORER}`);
  const options = asObj(scorer['options'], '/eval/scorers/0/options');
  const samples = asArr(root['samples'], '/samples');
  if (samples.length === 0) throw shape('/samples', 'a non-empty array', samples);

  // ---- pass 1: ids, plain strings, errors, the score key ---------------------------------------------------------
  const ungraded: { caseId: string; draw: number; reason: string }[] = [];
  const pending: Pending[] = [];
  samples.forEach((raw, i) => {
    const path = `/samples/${i}`;
    const s = asObj(raw, path);
    const rawId = s['id'];
    if (!((typeof rawId === 'string' && rawId !== '') || (typeof rawId === 'number' && Number.isSafeInteger(rawId)))) {
      throw new ImportRefusal('IMPORT_CASE_ID', [`${path}/id`], `${path}/id: a case id must be a non-empty string or an integer, found ${typeof rawId === 'number' ? `the number ${rawId}` : typeName(rawId)}`);
    }
    const epoch = s['epoch'];
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) throw shape(`${path}/epoch`, 'a positive integer', epoch);
    const caseId = String(rawId);
    const p: Pending = { path, label: `${caseId}#${epoch - 1}`, caseId, rawId, draw: epoch - 1, s, input: asStr(s['input'], `${path}/input`), target: asStr(s['target'], `${path}/target`) };
    const retries = asArr(s['error_retries'], `${path}/error_retries`);
    const why: string[] = [];
    if (s['error'] !== undefined && s['error'] !== null) why.push('the sample has an error');
    if (s['invalidation'] !== undefined && s['invalidation'] !== null) why.push('the tool marked the sample invalidated (it holds an invalidation)');
    if (retries.length > 0) why.push(`the sample was retried by the tool (${retries.length} error retries)`);
    const scores = s['scores'];
    if (scores === undefined || scores === null || (isObject(scores) && Object.keys(scores).length === 0)) why.push('the sample has no score');
    else {
      const keys = Object.keys(asObj(scores, `${path}/scores`));
      const other = keys.filter((k) => k !== SCORER);
      if (other.length > 0) throw new ImportRefusal('IMPORT_JUDGE_SELECTION', [`${path}/scores`], `${path}/scores: the score key(s) ${other.map((k) => JSON.stringify(k)).join(', ')} are not exactly ${SCORER}; a suffixed key shows a second scoring of the sample`);
    }
    if (why.length > 0) ungraded.push({ caseId, draw: p.draw, reason: why.join('; ') });
    else pending.push(p);
  });

  // ---- pass 2: the score and its record --------------------------------------------------------------------------
  const records: { p: Pending; score: J; g0: J; g1: J; value: string; answer: string; raw: unknown; gPath: string }[] = [];
  for (const p of pending) {
    const sp = `${p.path}/scores/${SCORER}`;
    const score = asObj(asObj(p.s['scores'], `${p.path}/scores`)[SCORER], sp);
    const stray: string[] = [];
    attachmentPaths(score, sp, stray);
    if (stray.length > 0) throw new ImportRefusal('IMPORT_SHAPE', stray, `${stray.join(', ')}: a score holds an attachment reference, which this importer does not resolve`);
    const value = asStr(score['value'], `${sp}/value`);
    const answer = asStr(score['answer'], `${sp}/answer`);
    const meta = asObj(score['metadata'], `${sp}/metadata`);
    const grading = asArr(meta['grading'], `${sp}/metadata/grading`);
    if (grading.length !== 2) throw new ImportRefusal('IMPORT_SHAPE', [`${sp}/metadata/grading`], `${sp}/metadata/grading: expected 2 messages (the prompt and the reply), found ${grading.length}`);
    const g0 = asObj(grading[0], `${sp}/metadata/grading/0`);
    const g1 = asObj(grading[1], `${sp}/metadata/grading/1`);
    for (const [m, allowed, at] of [[g0, PROMPT_MESSAGE_KEYS, 0], [g1, REPLY_MESSAGE_KEYS, 1]] as const) {
      const extra = Object.keys(m).filter((k) => !allowed.includes(k));
      if (extra.length > 0) throw new ImportRefusal('IMPORT_SHAPE', extra.map((k) => `${sp}/metadata/grading/${at}/${k}`), `${sp}/metadata/grading/${at}: keys ${extra.join(', ')} are not among the keys the tool writes for this message (${allowed.join(', ')}); they could carry a call this importer does not read`);
    }
    const g1meta = g1['metadata'] === undefined ? {} : asObj(g1['metadata'], `${sp}/metadata/grading/1/metadata`);
    records.push({ p, score, g0, g1, value, answer, raw: g1meta['graderEvidence'], gPath: `${sp}/metadata/grading/1/metadata/graderEvidence` });
  }
  const absent = records.filter((r) => r.raw === undefined);
  if (records.length > 0 && absent.length === records.length) throw noRecordRefusal('inspect', (records[0] as (typeof records)[number]).gPath);
  if (absent.length > 0) {
    throw new ImportRefusal('IMPORT_EVIDENCE', absent.map((r) => r.gPath), `${absent.length} slot(s) carry no grader record while others do: ${absent.map((r) => r.p.label).join(', ')}`);
  }
  const rows: Row[] = [];
  const disagree: string[] = [];
  const disagreePaths: string[] = [];
  for (const r of records) {
    const gp = `${r.gPath.slice(0, r.gPath.indexOf('/metadata/grading/1/'))}/metadata/grading`;
    if (r.g0['role'] !== 'user') throw new ImportRefusal('IMPORT_SHAPE', [`${gp}/0/role`], `${gp}/0/role: expected "user", found ${typeof r.g0['role'] === 'string' ? JSON.stringify(r.g0['role']) : typeName(r.g0['role'])}`);
    const prompt = asStr(r.g0['content'], `${gp}/0/content`);
    if (r.g1['role'] !== 'assistant') throw new ImportRefusal('IMPORT_SHAPE', [`${gp}/1/role`], `${gp}/1/role: expected "assistant", found ${typeof r.g1['role'] === 'string' ? JSON.stringify(r.g1['role']) : typeName(r.g1['role'])}`);
    const reply = asStr(r.g1['content'], `${gp}/1/content`);
    const g = parseRecord(r.raw, r.gPath, 'inspect');
    if (g.grader.language !== 'python') throw new ImportRefusal('IMPORT_EVIDENCE', [`${r.gPath}.grader.language`], `${r.gPath}.grader.language: an Inspect log is graded by the Python recording grader, found ${JSON.stringify(g.grader.language)}`);
    const stop = ungradedReason(g);
    if (stop !== undefined) {
      ungraded.push({ caseId: r.p.caseId, draw: r.p.draw, reason: stop });
      continue;
    }
    const read = strictGrade(g.reply);
    if (read === undefined) {
      ungraded.push({ caseId: r.p.caseId, draw: r.p.draw, reason: 'the reply has no strict reading: its last non-empty line is not exactly "GRADE: " and one capital letter' });
      continue;
    }
    if (read !== r.value) {
      disagree.push(`${r.p.label}: the reply says ${read}, the tool wrote ${r.value}`);
      disagreePaths.push(r.p.label);
    }
    rows.push({ ...r.p, score: r.score, g1: r.g1, value: r.value, answer: r.answer, prompt, reply, g, gPath: r.gPath, output: '' });
  }
  if (ungraded.length > 0) throw ungradedRefusal(ungraded);
  if (disagree.length > 0) throw new ImportRefusal('IMPORT_LABEL_DISAGREES', disagreePaths, disagree.join('; '));

  assertBarHasLabels(bar, rows.map((r) => r.value));

  // ---- the scorer's options --------------------------------------------------------------------------------------
  for (const k of Object.keys(options)) {
    if (k !== 'model' && k !== 'instructions' && k !== 'template') {
      throw new ImportRefusal('IMPORT_DERIVATION', [`/eval/scorers/0/options/${k}`], `/eval/scorers/0/options/${k}: this importer cannot name how the label was derived with this option`);
    }
  }
  for (const k of ['instructions', 'template'] as const) {
    if (typeof options[k] !== 'string') {
      throw new ImportRefusal('IMPORT_DERIVATION', [`/eval/scorers/0/options/${k}`], `/eval/scorers/0/options/${k}: missing or not text; this importer cannot name how the label was derived without it`);
    }
  }
  const template = options['template'] as string;
  const instructions = options['instructions'] as string;

  // ---- the recorded calls of the whole file ----------------------------------------------------------------------
  const slots: RecordedSlot[] = rows.map((r) => ({ caseId: r.caseId, draw: r.draw, record: r.g }));
  checkRecordSet(slots);
  const first = (rows[0] as Row).g;

  // ---- the model option -----------------------------------------------------------------------------------------
  const modelOpt = options['model'];
  const optModel = isObject(modelOpt) ? modelOpt['model'] : modelOpt;
  if (optModel !== `recording/${first.requestedModel}`) {
    throw new ImportRefusal('IMPORT_EVIDENCE', ['/eval/scorers/0/options/model'], `/eval/scorers/0/options/model: names ${JSON.stringify(optModel)}, the record says recording/${first.requestedModel}`);
  }
  const argsPath = '/eval/scorers/0/options/model/model_args';
  const args = isObject(modelOpt) && modelOpt['model_args'] !== undefined ? asObj(modelOpt['model_args'], argsPath) : {};
  const badArgs = Object.keys(args).filter((k) => !MODEL_ARG_KEYS.includes(k));
  if (badArgs.length > 0) throw new ImportRefusal('IMPORT_EVIDENCE', badArgs.map((k) => `${argsPath}/${k}`), `${argsPath}: keys ${badArgs.join(', ')} are not documented settings of the grader`);
  // Thinking and effort are stated, with no default: the log must show the two arguments, and they must be the ones the record shows.
  const recEffort = first.sent.output_config === NOT_SENT ? NOT_SENT : first.sent.output_config.effort;
  const argProblems: string[] = [];
  if (!('thinking' in args) || hashOf(args['thinking']) !== hashOf(first.sent.thinking)) argProblems.push(`${argsPath}/thinking: ${shown(args, 'thinking')} but the record says it sent ${JSON.stringify(first.sent.thinking)}`);
  if (args['effort'] !== recEffort) argProblems.push(`${argsPath}/effort: ${shown(args, 'effort')} but the record says ${JSON.stringify(recEffort)}`);
  // The bound of re-asks is stated too, with no default: the log must show the argument, equal to the record's.
  if (args['max_reasks'] !== first.reask.max) argProblems.push(`${argsPath}/max_reasks: ${shown(args, 'max_reasks')} but the record says the bound was ${first.reask.max} re-ask(s)`);
  // Where a call went and under what deadline: the base URL (a sibling of model_args in the scorer's model), the deadline, the API version and
  // the key variable, through the one comparison the promptfoo path uses, with this tool's key names. A setting not stated is the grader's default.
  argProblems.push(
    ...endpointSettingProblems(
      { timeoutMs: args['timeout_ms'], apiVersion: args['api_version'], apiKeyEnv: args['api_key_env'], baseUrl: isObject(modelOpt) ? modelOpt['base_url'] : undefined },
      first.callShape,
      { timeoutMs: `${argsPath}/timeout_ms`, apiVersion: `${argsPath}/api_version`, apiKeyEnv: `${argsPath}/api_key_env`, baseUrl: '/eval/scorers/0/options/model/base_url' },
    ),
  );
  if (argProblems.length > 0) throw new ImportRefusal('IMPORT_EVIDENCE', argProblems.map((p) => p.slice(0, p.indexOf(':'))), argProblems.join('; '));

  // ---- per slot: the stored output, the prompt, the events -------------------------------------------------------
  const cs = first.callShape;
  for (const r of rows) {
    const { s, path, g, gPath } = r;
    const out = asObj(s['output'], `${path}/output`);
    const choices = asArr(out['choices'], `${path}/output/choices`);
    if (choices.length !== 1) throw new ImportRefusal('IMPORT_SHAPE', [`${path}/output/choices`], `${path}/output/choices: expected exactly one choice, found ${choices.length}`);
    const msg = asObj(asObj(choices[0], `${path}/output/choices/0`)['message'], `${path}/output/choices/0/message`);
    const content = asStr(msg['content'], `${path}/output/choices/0/message/content`);
    const completion = asStr(out['completion'], `${path}/output/completion`);
    if (content !== completion) throw new ImportRefusal('IMPORT_SHAPE', [`${path}/output/completion`], `${path}/output/completion: differs from the output message's content`);
    r.output = content;
    if (r.answer !== content) throw new ImportRefusal('IMPORT_PACKET', [r.label], `${r.label}: the score's answer differs from the stored output, so the judge was not shown the stored output`);
    const promptSha = sha256Hex(r.prompt);
    if (promptSha !== g.promptSha256 || promptSha !== g.sent.user) {
      throw new ImportRefusal('IMPORT_EVIDENCE', [`${gPath}.promptSha256`, `${gPath}.sent.user`], `${r.label}: the sha256 of the grader's message is ${promptSha}, the record says promptSha256 ${g.promptSha256} and sent.user ${g.sent.user}`);
    }
    if (g.sent.system !== NOT_SENT) throw new ImportRefusal('IMPORT_EVIDENCE', [`${gPath}.sent.system`], `${r.label}: the record says a system text was sent; the Inspect grader sends one user message only`);
    if (r.reply !== g.reply) throw new ImportRefusal('IMPORT_EVIDENCE', [`${gPath}.reply`], `${r.label}: the grader's reply message differs from the record's reply`);
    if (r.g1['model'] !== g.servedModel || r.g1['id'] !== g.responseId) {
      throw new ImportRefusal('IMPORT_EVIDENCE', [`${r.path}/scores/${SCORER}/metadata/grading/1`], `${r.label}: the reply message's model or id differs from the record's servedModel or responseId`);
    }
    checkEvents(r, cs);
  }

  // ---- cases, draws, roster --------------------------------------------------------------------------------------
  const epochs = asObj(evalBlock['config'], '/eval/config')['epochs'];
  if (typeof epochs !== 'number' || !Number.isSafeInteger(epochs) || epochs < 1) {
    throw new ImportRefusal('IMPORT_DRAW_COUNT', ['/eval/config/epochs'], `/eval/config/epochs: the repeat count is missing or not a positive integer (found ${typeof epochs === 'number' ? epochs : typeName(epochs)})`);
  }
  const byCase = new Map<string, Row[]>();
  for (const r of rows) { const list = byCase.get(r.caseId); if (list === undefined) byCase.set(r.caseId, [r]); else list.push(r); }
  for (const [id, list] of byCase) {
    if (new Set(list.map((r) => typeof r.rawId)).size > 1) throw new ImportRefusal('IMPORT_CASE_ID', [id], `${id}: two ids are equal as strings but differ as values`);
    if (new Set(list.map((r) => hashOf({ input: r.input, target: r.target }))).size > 1) throw new ImportRefusal('IMPORT_CASE_ID', [id], `${id}: the input or the target differs between its epochs`);
  }
  const found = new Map<string, unknown>([...byCase].map(([id, list]) => [id, { input: (list[0] as Row).input, target: (list[0] as Row).target }]));
  const cases = buildCases(stated, found);
  const countProblems: string[] = [];
  for (const [id, list] of byCase) {
    const draws = list.map((r) => r.draw).sort((a, b) => a - b);
    const ok = draws.length === epochs && draws.every((d, i) => d === i);
    if (!ok) countProblems.push(`${id}: ${draws.length} of ${epochs} (epochs found: ${list.map((r) => r.draw + 1).sort((a, b) => a - b).join(', ')})`);
  }
  if (countProblems.length > 0) throw new ImportRefusal('IMPORT_DRAW_COUNT', [...byCase.keys()].filter((id) => countProblems.some((p) => p.startsWith(`${id}:`))), countProblems.join('; '));
  const differing = [...byCase].filter(([, list]) => new Set(list.map((r) => r.output)).size > 1);
  if (differing.length > 0) {
    throw new ImportRefusal('IMPORT_OUTPUTS_DIFFER', differing.map(([id]) => id), differing.map(([id, list]) => `${id}: ${new Set(list.map((r) => r.output)).size} distinct outputs`).join('; '));
  }

  // ---- what the judge was shown: the logged template, rendered forward -------------------------------------------
  const tp = templateProblem(template, SLOTS);
  if (tp !== undefined) throw new ImportRefusal('IMPORT_PACKET', ['/eval/scorers/0/options/template'], `/eval/scorers/0/options/template: holds ${tp}; this importer renders the four tokens by plain substitution only`);
  const marked: string[] = [];
  for (const r of rows) {
    const parts = [r.input, r.output, r.target].some((t) => DATA_MARKER.test(t));
    if (parts) marked.push(r.label);
  }
  if (marked.length > 0) {
    throw new ImportRefusal('IMPORT_PACKET', marked, `${marked.join(', ')}: the question, answer or criterion holds a data marker ([BEGIN DATA] or [END DATA]), which the tool rewrites before filling its template; this importer does not copy that rewriting`);
  }
  const skeleton = skeletonFromTemplate(template, SLOTS);
  const skeletonRows: SkeletonRow[] = rows.map((r) => ({
    label: r.label,
    contents: [r.prompt],
    components: [
      { name: 'question', value: r.input },
      { name: 'answer', value: r.output },
      { name: 'criterion', value: r.target },
      { name: 'instructions', value: instructions },
    ],
  }));
  checkForward(skeleton, skeletonRows);

  // ---- the run ---------------------------------------------------------------------------------------------------
  const unknownShape: Record<string, unknown> = Object.fromEntries(Object.keys(cs).map((k) => [k, GAP]));
  unknownShape['schema'] = cs['schema'];
  const judgeShapeHash = callShapeHash(cs as never);
  const rubricHash = hashOf({ tool: 'inspect_ai', scorer: SCORER, instructions });
  const judgeDefinitionHash = hashOf({ tool: 'inspect_ai', version: TESTED_VERSION, scorer: SCORER, template, tools: [], reading: 'last-line-grade-letter/v1' });
  const harness = judgeHarnessVersion('inspect_ai', TESTED_VERSION, first);
  const barH = barHash(bar);
  const caseSetH = caseSetHash(cases);
  const sortKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const draws = [...rows]
    .sort((a, b) => sortKey(a.caseId, b.caseId) || a.draw - b.draw)
    .map((r) => ({
      caseId: r.caseId,
      drawIndex: r.draw,
      // The graded attempt is the slot's last ask; the earlier asks the record holds stand before it, unmeasured.
      attempts: attemptsOf(r.g, {
        kind: 'graded',
        label: r.value,
        outputHash: outputHashOf(r.output),
        systemStop: GAP,
        judgeStop: 'end',
        packetHash: packetHashOf({ input: r.input, target: r.target }, r.output),
      }),
    }));
  const run = {
    schema: RUN_SCHEMA,
    identity: {
      caseSetHash: caseSetH,
      rubricHash,
      barHash: barH,
      systemModelRequested: GAP,
      systemModelServed: GAP,
      systemCallShapeHash: GAP,
      systemPromptHash: GAP,
      systemToolsHash: GAP,
      systemHarnessVersion: GAP,
      judgeDefinitionHash,
      judgeModelRequested: first.requestedModel,
      judgeModelServed: first.servedModel,
      judgeCallShapeHash: judgeShapeHash,
      judgeHarnessVersion: harness,
      seed: GAP,
      drawsPerCase: epochs,
    },
    callShapes: { system: unknownShape, judge: cs },
    cases,
    draws,
    packetBasis: 'declared',
    packetSource: `computed at import from inspect_ai ${TESTED_VERSION} log sha256:${sourceSha}: the question, answer and criterion slots of the grader's message`,
  };
  return {
    run,
    summary: {
      judge: { judgeDefinitionHash, judgeModelRequested: first.requestedModel, judgeModelServed: first.servedModel, judgeCallShapeHash: judgeShapeHash, judgeHarnessVersion: harness, rubricHash },
      barHash: barH,
      caseSetHash: caseSetH,
      drawsPerCase: epochs,
      grader: { name: first.grader.name, language: first.grader.language, runtime: first.grader.runtime, sha256: first.grader.sha256 },
      slots: rows.length,
      thinkingReplies: thinkingRepliesLine(rows.map((r) => r.g)),
      reasks: reasksLine(rows.map((r) => r.g)),
    },
  };
}

/** The events of one slot: one scorer span, one model event, one score event, no cache, and the cross-checks against the record. */
function checkEvents(r: Row, cs: Record<string, unknown>): void {
  const { s, path, g, label } = r;
  const evPath = `${path}/events`;
  const events = asArr(s['events'], evPath).map((e, i) => asObj(e, `${evPath}/${i}`));
  const attachments = s['attachments'] === undefined ? {} : asObj(s['attachments'], `${path}/attachments`);
  const spans = events.filter((e) => e['event'] === 'span_begin' && e['type'] === 'scorer');
  if (spans.length === 0) throw new ImportRefusal('IMPORT_UNGRADED', [label], `${label}: the sample holds no scorer span`);
  if (spans.length > 1) throw new ImportRefusal('IMPORT_DUPLICATE_CALL', [label], `${label}: ${spans.length} scorer spans in one sample (the tool scored it more than once)`);
  const span = spans[0] as J;
  if (span['name'] !== SCORER) throw new ImportRefusal('IMPORT_JUDGE_SELECTION', [label], `${label}: the scorer span is named ${JSON.stringify(span['name'])}, not ${SCORER}`);
  const spanId = span['id'];
  const models = events.filter((e) => e['event'] === 'model');
  for (const m of models) {
    if (Object.hasOwn(m, 'cache')) throw new ImportRefusal('IMPORT_CACHE', [label], `${label}: a model event holds a cache key; the file does not show the response cache was off`);
  }
  const inSpan = models.filter((e) => e['span_id'] === spanId);
  if (models.length > 1 || inSpan.length > 1) {
    throw new ImportRefusal('IMPORT_DUPLICATE_CALL', [label], `${label}: ${models.length} model events in one sample (${inSpan.length} in the scorer span); a second one is the tool's own retry or a call outside the grader`);
  }
  if (inSpan.length === 0) throw new ImportRefusal('IMPORT_UNGRADED', [label], `${label}: the scorer span holds no model event`);
  const scoreEvents = events.filter((e) => e['event'] === 'score');
  if (scoreEvents.length > 1) throw new ImportRefusal('IMPORT_DUPLICATE_CALL', [label], `${label}: ${scoreEvents.length} score events in one sample (the tool scored it more than once)`);
  const scoreEvent = scoreEvents[0];
  if (scoreEvent === undefined || scoreEvent['span_id'] !== spanId) throw new ImportRefusal('IMPORT_UNGRADED', [label], `${label}: the scorer span holds no score event`);
  const model = inSpan[0] as J;
  if (model['retries'] !== undefined && model['retries'] !== null && model['retries'] !== 0) {
    throw new ImportRefusal('IMPORT_DUPLICATE_CALL', [label], `${label}: the model event shows ${JSON.stringify(model['retries'])} retries; the tool called the model more than once for this grade`);
  }
  if (model['pending'] !== undefined && model['pending'] !== null && model['pending'] !== false) {
    throw new ImportRefusal('IMPORT_UNGRADED', [label], `${label}: the grader's model event is marked pending, not completed`);
  }
  if (Object.hasOwn(model, 'error')) throw new ImportRefusal('IMPORT_UNGRADED', [label], `${label}: the grader's model event holds an error`);

  const ev = asObj(resolveDeep(model, attachments, `${evPath}/model`), `${evPath}/model`);
  const bad: string[] = [];
  if (ev['model'] !== `recording/${g.requestedModel}`) bad.push(`model is ${JSON.stringify(ev['model'])}, the record says recording/${g.requestedModel}`);
  const out = isObject(ev['output']) ? ev['output'] : {};
  if (out['model'] !== g.servedModel) bad.push(`output.model is ${JSON.stringify(out['model'])}, the record says ${g.servedModel}`);
  const choices = Array.isArray(out['choices']) ? out['choices'] : [];
  const choice = choices.length === 1 && isObject(choices[0]) ? choices[0] : undefined;
  const message = choice !== undefined && isObject(choice['message']) ? choice['message'] : undefined;
  if (choice === undefined || message === undefined) bad.push('output.choices is not exactly one choice with a message');
  else {
    if (message['id'] !== g.responseId) bad.push(`the reply message id is ${JSON.stringify(message['id'])}, the record says ${g.responseId}`);
    if (message['content'] !== g.reply) bad.push('the reply message differs from the record');
    if (choice['stop_reason'] !== 'stop') bad.push(`stop_reason is ${JSON.stringify(choice['stop_reason'])}, not "stop"`);
  }
  const eventRecord = isObject(out['metadata']) ? out['metadata']['graderEvidence'] : undefined;
  if (eventRecord === undefined || hashOf(eventRecord) !== hashOf(g)) bad.push('the event holds a different grader record from the score');
  // The token usage: the grader hands the tool the counters of the slot's last ask, so the tool's own copy in the
  // event must be the record's. A record that states none must stand beside an event that holds none.
  const evUsage = out['usage'];
  if (g.usage === 'ABSENT') {
    if (evUsage !== undefined && evUsage !== null) bad.push('output.usage is set, the record says the response stated no usage');
  } else if (!isObject(evUsage) || evUsage['input_tokens'] !== g.usage.input_tokens || evUsage['output_tokens'] !== g.usage.output_tokens || evUsage['total_tokens'] !== g.usage.input_tokens + g.usage.output_tokens) {
    bad.push(`output.usage is ${JSON.stringify(evUsage ?? 'not set')}, the record says input ${g.usage.input_tokens} and output ${g.usage.output_tokens} (total ${g.usage.input_tokens + g.usage.output_tokens})`);
  }
  if (!Array.isArray(ev['tools']) || ev['tools'].length !== 0) bad.push('tools is not an empty list');
  if (ev['tool_choice'] !== 'none') bad.push(`tool_choice is ${JSON.stringify(ev['tool_choice'])}, not "none"`);
  const config = isObject(ev['config']) ? ev['config'] : undefined;
  if (config === undefined) bad.push('config is not an object');
  else {
    for (const k of Object.keys(config)) if (k !== 'max_tokens' && k !== 'temperature') bad.push(`config.${k} is a setting the record does not hold`);
    // Numbers are compared as numbers: the event writes 0.0 where the record says 0.
    if (typeof config['max_tokens'] !== 'number' || config['max_tokens'] !== cs['maxOutputTokens']) bad.push(`config.max_tokens is ${JSON.stringify(config['max_tokens'])}, the record's call shape says ${JSON.stringify(cs['maxOutputTokens'])}`);
    if (cs['temperature'] === NOT_SENT) {
      if (config['temperature'] !== undefined) bad.push('config.temperature is set, the record says it was not sent');
    } else if (typeof config['temperature'] !== 'number' || config['temperature'] !== cs['temperature']) {
      bad.push(`config.temperature is ${JSON.stringify(config['temperature'])}, the record's call shape says ${JSON.stringify(cs['temperature'])}`);
    }
  }
  const se = asObj(resolveDeep(scoreEvent, attachments, `${evPath}/score`), `${evPath}/score`);
  const sc = isObject(se['score']) ? se['score'] : {};
  const mine = r.score;
  for (const k of ['value', 'answer'] as const) if (sc[k] !== mine[k]) bad.push(`the score event's ${k} differs from the sample's score`);
  const scMeta = isObject(sc['metadata']) ? sc['metadata']['grading'] : undefined;
  const myMeta = (mine['metadata'] as J)['grading'];
  if (hashOf(scMeta ?? null) !== hashOf(myMeta)) bad.push("the score event's grading messages differ from the sample's score");
  if (bad.length > 0) throw new ImportRefusal('IMPORT_EVIDENCE', [`${evPath}`], `${label}: ${bad.join('; ')}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------

export type { Io };
const USAGE = 'usage: node examples/importers/inspect/import.ts --in <log.json> --cases <cases.json> --bar <bar.json> --out <run.json> [--grader-sha256 <sha256 of your own grader file>]   (the first four required)';

/** Runs the importer; returns the exit code: 0 written, 2 refused, 64 usage, 65 a cases file or a bar that does not validate, 70 an unexpected error. */
export function main(argv: readonly string[], io: Io): number {
  return runImporter(argv, io, {
    tool: 'inspect',
    usage: USAGE,
    graderPath: join(import.meta.dirname, 'recording_grader.py'),
    convert: (bytes, fileName, cases, bar) => {
      const r = buildInspectRun(bytes, fileName, cases, bar);
      return { run: r.run, summary: r.summary };
    },
  });
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  runImporterAsProcess(main, 'inspect import');
}
