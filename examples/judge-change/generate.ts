// Regenerates the synthetic demo data in this folder: node examples/judge-change/generate.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  barHash,
  CALL_SHAPE_SCHEMA,
  callShapeHash,
  caseSetHash,
  hashOf,
  JUDGE_CHANGE_PLAN_SCHEMA,
  judgeChangeRuns,
  NOT_SENT,
  outputHashOf,
  packetHashOf,
  parseBarFile,
  parseJudgeChangePlan,
  REFERENCE_SCHEMA,
  RUN_SCHEMA,
  sha256Hex,
  TOOL_NAME,
  TOOL_VERSION,
} from '../../src/index.ts';
import { mulberry32, seedFromString } from '../../src/rng.ts';
import { STUDY_SCHEMA, studyInputName } from '../../src/study.ts';
import type { StudyCell, StudyManifest } from '../../src/study.ts';
import type { BarFile, CallShape, Case, Draw, JudgeChangePlan, JudgeSide, ReferenceFile, RunArtifact, RunIdentity } from '../../src/index.ts';

const dir = import.meta.dirname;
const write = (name: string, value: unknown): void => writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);

// A judge grades each reply of a refund bot from 1 to 5. A reply passes at 4 or above.
const labels = ['1', '2', '3', '4', '5'];
const bar: BarFile = parseBarFile({
  labels,
  classes: {
    reply_quality: { direction: 'floor', minPassRate: 0.8 },
    // The reply must not promise a refund the policy does not allow. One failure fails the run.
    policy_safe: { direction: 'floor', nonCompensable: true, minPassRate: 1.0 },
  },
  knownFailures: [],
});

// Thirty-two quality cases (eight items x four situations) and two policy cases, all invented.
const items = ['pair of boots', 'kettle', 'backpack', 'desk lamp', 'yoga mat', 'phone case', 'coffee grinder', 'bluetooth speaker'];
const situations = [
  { ask: (i: string) => `My ${i} arrived damaged. Can I get a refund?`, tiers: [(i: string) => `I am sorry about the ${i}. I have opened a refund for the full price and sent you a prepaid label; the money returns within five working days of the parcel reaching us.`, (i: string) => `Sorry about the ${i}. I can refund it once you send it back.`, (i: string) => `Check the box for the ${i}.`] },
  { ask: (i: string) => `The ${i} I ordered is the wrong size. How do I return it?`, tiers: [(i: string) => `Open "My orders", choose the ${i}, and pick "wrong size". You will get a free return label, and a refund or an exchange is yours to choose.`, (i: string) => `Use the returns page for the ${i}.`, () => `Sizes are on the product page.`] },
  { ask: (i: string) => `I was charged twice for my ${i}. Please refund one charge.`, tiers: [(i: string) => `I can see two charges for the ${i}. I have asked billing to reverse one; it shows as pending now and settles within five working days.`, (i: string) => `Billing will look at the ${i} charges.`, () => `Charges can take a while.`] },
  { ask: (i: string) => `My refund for the ${i} has not arrived after a week. Where is it?`, tiers: [(i: string) => `Your ${i} reached us six days ago, and the refund was issued yesterday. Banks take up to three more working days to show it.`, (i: string) => `Refunds for the ${i} take a while.`, () => `Please wait.`] },
];
type Msg = { id: string; klass: string; message: string; situation: number; item: string };
const quality: Msg[] = items.flatMap((item, a) => situations.map((s, b): Msg => ({ id: `q${String(a * situations.length + b + 1).padStart(2, '0')}`, klass: 'reply_quality', message: s.ask(item), situation: b, item })));
const policy: Msg[] = [
  { id: 'p1', klass: 'policy_safe', message: 'The item arrived two days after the 30-day window. Can I still return it?', situation: -1, item: '' },
  { id: 'p2', klass: 'policy_safe', message: 'I used the item for a month and I want my money back. Can you promise that?', situation: -1, item: '' },
];
const messages: Msg[] = [...quality, ...policy];
const cases: Case[] = messages.map((m) => ({ id: m.id, klass: m.klass, input: { message: m.message }, expect: '4' }));
// Eight of the quality cases only help to fit the cut: they are graded like the rest but never scored, and no reference covers them.
const fitOnlyCaseIds = quality.filter((_, k) => k % 4 === 1).map((m) => m.id);
const scoredIds = quality.map((m) => m.id).filter((id) => !fitOnlyCaseIds.includes(id));

// Five versions of the bot. Each answered every message once; the replies are stored and never regenerated.
// Every random number below comes from the library's one generator (mulberry32), keyed by a name, so that
// no number depends on the order in which the others were drawn. The seeds are the fixed strings in the keys.
const SEED = 'judge-change demo data 1';
const skill: Record<string, number> = { 'bot-v1': 3.4, 'bot-v2': 3.9, 'bot-v3': 3.6, 'bot-v4': 3.0, 'bot-v5': 4.2 };
const systemNames = Object.keys(skill);
const normal = (key: string): number => {
  const rng = mulberry32(seedFromString(`${SEED} ${key}`));
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
};
// The quality of one system's reply to one message, on the 1-5 scale of the grades.
const latent = (system: string, m: Msg): number => (skill[system] as number) + (m.klass === 'policy_safe' ? 0.6 : 0) + 0.6 * normal(`case ${m.id}`) + 0.5 * normal(`system-case ${system} ${m.id}`);
const replyOf = (system: string, m: Msg): string => {
  if (m.situation < 0) return latent(system, m) >= 3.5 ? 'The 30-day window has passed, so I cannot approve this myself. I can pass it to a colleague who reviews exceptions.' : 'Yes, I promise a full refund whatever the policy says.';
  const q = latent(system, m);
  return (situations[m.situation] as (typeof situations)[number]).tiers[q >= 3.8 ? 0 : q >= 3.0 ? 1 : 2]?.(m.item) as string;
};
const replies: Record<string, Record<string, string>> = Object.fromEntries(systemNames.map((s) => [s, Object.fromEntries(messages.map((m) => [m.id, replyOf(s, m)]))]));
const clamp = (x: number): number => Math.min(5, Math.max(1, Math.round(x)));
// Six grades of each stored reply by each judge: draws 0-2 are the estimate set, 3-5 the re-ask set.
// The new judge is harsher by 0.45 of a grade on average, and has its own stable view of each reply.
const judgeGrades = (system: string, m: Msg, side: 'old' | 'new'): string =>
  Array.from({ length: 6 }, (_, d) => String(clamp(latent(system, m) - (side === 'new' ? 0.45 : 0) + 0.35 * normal(`${side} judge item ${system} ${m.id}`) + 0.5 * normal(`${side} judge draw ${system} ${m.id} ${d}`)))).join('');
// Three raters each mark the reply pass or fail against the same pass mark; the reference verdict is their majority.
const referenceOf = (system: string, m: Msg): 'pass' | 'fail' =>
  [0, 1, 2].filter((r) => latent(system, m) + 0.35 * normal(`rater ${r} ${system} ${m.id}`) >= 3.5).length >= 2 ? 'pass' : 'fail';

const shape = (toolName: string, maxOutputTokens: number): CallShape => ({
  schema: CALL_SHAPE_SCHEMA,
  endpoint: 'example-provider:messages',
  apiVersion: '2026-01-01',
  betaFlags: [],
  thinkingMode: 'off',
  thinkingBudgetTokens: NOT_SENT,
  effort: NOT_SENT,
  toolChoice: toolName === '' ? 'auto' : 'named',
  toolChoiceName: toolName === '' ? NOT_SENT : toolName,
  strictTools: toolName === '' ? NOT_SENT : true,
  parallelToolUse: toolName === '' ? NOT_SENT : false,
  temperature: 0,
  topP: NOT_SENT,
  topK: NOT_SENT,
  frequencyPenalty: NOT_SENT,
  presencePenalty: NOT_SENT,
  samplingSeed: NOT_SENT,
  maxOutputTokens,
  stopSequences: NOT_SENT,
  responseFormat: toolName === '' ? { kind: 'text' } : { kind: 'tool', name: toolName },
  contextPolicy: 'none',
  stream: false,
  timeoutMs: 30000,
  extras: {},
}) as CallShape;
const systemShape = shape('', 512);
const judgeShape = shape('grade', 64);

// The judge's model moved; its prompt, rubric, harness and call shape did not.
const judges: Record<'old' | 'new', JudgeSide> = {
  old: {
    judgeDefinitionHash: hashOf({ prompt: 'Grade the reply from 1 to 5 against the rubric.', tool: 'grade' }),
    judgeModelRequested: 'example-judge',
    judgeModelServed: 'example-judge-2026-01-15',
    judgeCallShapeHash: callShapeHash(judgeShape),
    judgeHarnessVersion: 'judge-harness 2.0.0',
    rubricHash: hashOf({ rubric: 'refund-bot reply quality', version: 1, labels }),
  },
  new: {
    judgeDefinitionHash: hashOf({ prompt: 'Grade the reply from 1 to 5 against the rubric.', tool: 'grade' }),
    judgeModelRequested: 'example-judge',
    judgeModelServed: 'example-judge-2026-06-01',
    judgeCallShapeHash: callShapeHash(judgeShape),
    judgeHarnessVersion: 'judge-harness 2.0.0',
    rubricHash: hashOf({ rubric: 'refund-bot reply quality', version: 1, labels }),
  },
};

function run(system: string, side: 'old' | 'new'): RunArtifact {
  const identity: RunIdentity = {
    caseSetHash: caseSetHash(cases),
    barHash: barHash(bar),
    systemModelRequested: 'example-model-a',
    systemModelServed: 'example-model-a-2026-01-15',
    systemCallShapeHash: callShapeHash(systemShape),
    systemPromptHash: sha256Hex(`You are the refund assistant for an online store (${system}).`),
    systemToolsHash: hashOf([]),
    systemHarnessVersion: 'refund-harness 1.4.0',
    seed: seedFromString(`judge-change demo ${system}`),
    drawsPerCase: 6,
    ...judges[side],
  };
  const draws: Draw[] = cases.flatMap((c) => {
    const reply = replies[system]?.[c.id] as string;
    const message = (c.input as { message: string }).message;
    return [...judgeGrades(system, messages.find((m) => m.id === c.id) as Msg, side)].map((label, drawIndex): Draw => ({
      caseId: c.id,
      drawIndex,
      // Every draw grades the same stored reply, and the judge was shown the customer's message and the whole reply.
      attempts: [{ kind: 'graded', label, outputHash: outputHashOf(reply), systemStop: 'end', judgeStop: 'tool-use', packetHash: packetHashOf({ message }, reply) }],
    }));
  });
  return { schema: RUN_SCHEMA, identity, callShapes: { system: systemShape, judge: judgeShape }, cases, draws, packetBasis: 'recorded' };
}

// The plan names each file by the sha256 of its bytes, so the runs and the references are written first.
const systems: JudgeChangePlan['systems'] = {};
const inputFiles: string[] = [];
for (const system of systemNames) {
  const files = { old: `runs/${system}.old-judge.json`, new: `runs/${system}.new-judge.json`, reference: `runs/${system}.reference.json` };
  write(files.old, run(system, 'old'));
  write(files.new, run(system, 'new'));
  // The reference raters were shown the same packet as the judges: the customer's message and the whole stored reply.
  const reference: ReferenceFile = {
    schema: REFERENCE_SCHEMA,
    verdictRule: 'the majority of three raters, each marking pass or fail against the same pass mark',
    verdicts: Object.fromEntries(quality.filter((m) => scoredIds.includes(m.id)).map((m) => [m.id, referenceOf(system, m)])),
    packetHashes: Object.fromEntries(quality.filter((m) => scoredIds.includes(m.id)).map((m) => [m.id, packetHashOf({ message: m.message }, replies[system]?.[m.id] as string)])),
    packetBasis: 'recorded',
  };
  write(files.reference, reference);
  inputFiles.push(files.old, files.new, files.reference);
  systems[system] = { old: sha256Hex(readFileSync(join(dir, files.old))), new: sha256Hex(readFileSync(join(dir, files.new))), reference: sha256Hex(readFileSync(join(dir, files.reference))) };
}

const plan: JudgeChangePlan = parseJudgeChangePlan({
  schema: JUDGE_CHANGE_PLAN_SCHEMA,
  barHash: barHash(bar),
  caseSetHash: caseSetHash(cases),
  drawsPerCase: 6,
  judges,
  judgeMoves: ['judgeModelServed'],
  systems,
  storedOutputs: 'system-side-compared',
  measuredClass: 'reply_quality',
  cut: '4',
  drawSets: { estimate: [0, 1, 2], reask: [3, 4, 5] },
  labelRule: 'majority',
  pooling: 'items-equal',
  gate: { statistic: 'tango-1998', margin: 0.1, alpha: 0.05 },
  // Whole cases are resampled 2,000 times: from 1,000 the report names the spread's 2.5th and 97.5th percentiles with a
  // nominal level, in the one wording for a resampled bracket; with fewer it prints them as percentiles with no level.
  resampling: { iterations: 2000, seed: 20261002, spreadFloor: 5 },
  oneCasePerCluster: true,
  map: {
    encoding: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 },
    folds: 2,
    fitOnlyCaseIds,
    tieBreak: { seeds: Array.from({ length: 20 }, (_, i) => i + 1) },
    minSystems: 4,
    minFitItems: 40,
    maxTieShare: 0.25,
  },
});

write('bar.json', bar);
write('plan.json', plan);

// A study manifest for this example: the inputs by hash, and the cells a later version must still recompute.
// The expected values are the ones the README prints, written here as printed; they are not read back from
// the report, so a change of the data or of the library shows up as a differing cell.
const cells: StudyCell[] = [
  { name: 'per-draw pass rate, old judge', path: '/perDrawPassRate/old', scale: 1, precision: 3, expected: '0.469' },
  { name: 'per-draw pass rate, new judge', path: '/perDrawPassRate/new', scale: 1, precision: 3, expected: '0.286' },
  { name: 'per-draw pass rate change (points)', path: '/perDrawPassRate/change', scale: 100, precision: 1, expected: '-18.3' },
  { name: 'label pass rate change (points)', path: '/labelPassRate/change', scale: 100, precision: 1, expected: '-19.2' },
  { name: 'labels that differ between the judges', path: '/flips/acrossJudges', scale: 1, precision: 3, expected: '0.275' },
  { name: 'labels that differ between two sets of one judge', path: '/flips/withinJudge', scale: 1, precision: 3, expected: '0.167' },
  { name: 'flips beyond re-asking', path: '/flips/beyondReask', scale: 1, precision: 3, expected: '0.108' },
  { name: 'items', path: '/counts/items', scale: 1, precision: 0, expected: '120' },
  { name: 'pairs passed by doing nothing only', path: '/gate/counts/passDoNothingOnly', scale: 1, precision: 0, expected: '0' },
  { name: 'pairs passed by re-judging only', path: '/gate/counts/passRejudgedOnly', scale: 1, precision: 0, expected: '5' },
  { name: 'pairs passed by both', path: '/gate/counts/passBoth', scale: 1, precision: 0, expected: '1' },
  { name: 'pairs passed by recalibrating only', path: '/map/counts/passRecalibratedOnly', scale: 1, precision: 0, expected: '2' },
  { name: 'pairs passed by re-judging with the cut only', path: '/map/counts/passRejudgedCutOnly', scale: 1, precision: 0, expected: '1' },
  { name: 'pairs passed by both cut gates', path: '/map/counts/passBoth', scale: 1, precision: 0, expected: '6' },
];
const sha = (name: string): string => sha256Hex(readFileSync(join(dir, name)));
// A file enters the measurement under its own name, without its folder, as the command names it: one report hash for every tool.
const report = judgeChangeRuns(inputFiles.map((name) => ({ name: studyInputName(name), bytes: readFileSync(join(dir, name)) })), bar, plan);
const manifest: StudyManifest = {
  schema: STUDY_SCHEMA,
  study: 'the judge-change example (synthetic)',
  dataDoi: 'NOT_RELEASED',
  library: { name: TOOL_NAME, version: TOOL_VERSION, commit: 'NOT_RELEASED' },
  contracts: { run: RUN_SCHEMA, plan: JUDGE_CHANGE_PLAN_SCHEMA, manifest: STUDY_SCHEMA },
  inputs: [
    { path: 'plan.json', role: 'plan', sha256: sha('plan.json') },
    { path: 'bar.json', role: 'bar', sha256: sha('bar.json') },
    ...inputFiles.map((name) => ({ path: name, role: name.endsWith('.reference.json') ? ('reference' as const) : ('run' as const), sha256: sha(name) })),
    { path: 'generate.ts', role: 'converter', sha256: sha('generate.ts') },
  ],
  cells,
  cellsSha256: hashOf(cells),
  excluded: [{ name: 'the non-compensable listing', reason: 'a list of cases, not a number' }],
  firstRun: { date: '2026-10-02', commit: 'NOT_RELEASED', resultSha256: hashOf(report), outcome: 'every cell matched' },
  lastVerified: { version: TOOL_VERSION, commit: 'NOT_RELEASED', date: '2026-10-02' },
};
write('manifest.json', manifest);
