// What a run of the third importer may enter, pinned on the committed re-grade fixtures at zero spend and with no
// network: the judge-change measurement it does enter, the two locks that keep it out of `gate` (each pinned on its
// own), the lock that keeps it out of `flips`, and the commands end to end. Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { JUDGE_FIELDS } from '../src/identity.ts';
import { gateRunsWithAdmission as gateRuns } from './helpers.ts';
import { callShapeHash, IDENTITY_FIELDS, judgeChangeRuns, parseBarFile, parseJudgeChangePlan, parseRunArtifact, RefusalError, repeatFlips, sha256Hex } from '../src/index.ts';
import type { BarFile, IdentityField, JudgeChangePlan, RunArtifact } from '../src/index.ts';
import { asRecorded, makeCallShape, scratchEnv } from './helpers.ts';
import { parseCasesFile } from '../examples/importers/shared.ts';
import { readFlow } from '../examples/importers/skill-evals/flow.ts';
import { convertRegrade } from '../examples/importers/skill-evals/import.ts';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'examples', 'importers', 'skill-evals');
const work = mkdtempSync(join(tmpdir(), 'anchorset-skill-e2e-'));
after(() => rmSync(work, { recursive: true, force: true }));

const node = (...args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8', env: scratchEnv() });
const cli = (...args: string[]) => node(join(root, 'src', 'cli.ts'), ...args);
const FIXTURE_KEY = 'dummy-key-for-local-fake-endpoint';
const READING = 'one-json-object-boolean-pass/v1';

// The seven fields no importer writes: six system-side fields and the seed.
const SYSTEM_SIDE: readonly IdentityField[] = ['systemModelRequested', 'systemModelServed', 'systemCallShapeHash', 'systemPromptHash', 'systemToolsHash', 'systemHarnessVersion', 'seed'];
// What judge-change lists as not compared: those seven and the system stop.
const NOT_COMPARED = [...SYSTEM_SIDE, 'systemStop'];
// Three cases x three grades of one stored output each, in the order of the run's draws.
const SLOTS = ['bank-dispute', 'clearance-organiser', 'faulty-headphones'].flatMap((id) => [0, 1, 2].map((d) => `${id}#${d}`));

// ---- the fixtures, imported once by the real command, with the flow read again ---------------------------------------

type Fragment = { barHash: string; caseSetHash: string; drawsPerCase: number; judge: Record<string, string>; systems: Record<string, Record<string, string>> };
type Imported = { path: string; bytes: Buffer; sha256: string; stdout: string; fragment: Fragment; run: RunArtifact };

function importFixture(fixture: string, folderName: string, outName: string): Imported {
  const folder = join(work, folderName);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${outName}.json`);
  const r = node(join(dir, 'import.ts'), '--in', join(dir, 'fixtures', `${fixture}.regrade.jsonl`), '--cases', join(dir, 'cases.json'), '--bar', join(dir, 'bar.json'), '--out', path, '--reading', READING, '--flow', join(dir, 'example-flow'));
  assert.equal(r.status, 0, `${fixture}: ${r.stderr}`);
  const bytes = readFileSync(path);
  // The fragment is the first JSON object on stdout: it ends at the first line that is a lone closing brace.
  const end = r.stdout.indexOf('\n}\n') + 2;
  return { path, bytes, sha256: sha256Hex(bytes), stdout: r.stdout, fragment: JSON.parse(r.stdout.slice(0, end)) as Fragment, run: parseRunArtifact(JSON.parse(bytes.toString('utf8'))) };
}
// Both judges on source rep 0: the pair of the example plan.
const imported = { old: importFixture('old-judge', 'runs', 'old'), new: importFixture('new-judge', 'runs', 'new') };
// The new judge on source rep 1: another measurement.
const newOnRep1 = importFixture('new-judge-rep1', 'other-rep', 'new-rep1');
const bar: BarFile = parseBarFile(JSON.parse(readFileSync(join(dir, 'bar.json'), 'utf8')));
const clone = (r: RunArtifact): RunArtifact => JSON.parse(JSON.stringify(r)) as RunArtifact;

/** A scratch copy of a run with every system stop rewritten to `end`, the one completing stop. */
function withKnownStops(r: RunArtifact): RunArtifact {
  const c = clone(r);
  for (const d of c.draws) for (const a of d.attempts) if ('systemStop' in a) a.systemStop = 'end';
  return c;
}

/** A scratch copy with the stops known, a known system side and a seed: what no importer ever writes. */
function fullyKnown(r: RunArtifact): RunArtifact {
  const c = withKnownStops(r);
  const shape = makeCallShape();
  c.callShapes.system = shape;
  Object.assign(c.identity, {
    systemModelRequested: 'example-bot',
    systemModelServed: 'example-bot-2026-01-01',
    systemCallShapeHash: callShapeHash(shape),
    systemPromptHash: sha256Hex('system prompt'),
    systemToolsHash: sha256Hex('tools'),
    systemHarnessVersion: 'example-harness 1.0.0',
    seed: 7,
  });
  return parseRunArtifact(JSON.parse(JSON.stringify(c)));
}

// ---- the plan: a committed file that the importer's printed fragments regenerate ---------------------------------------

const planPath = join(dir, 'plan.json');

/** The plan, from the two printed fragments and the two run files' hashes, exactly as a user would paste them. */
function derivePlan(): JudgeChangePlan {
  const { old: o, new: n } = imported;
  assert.equal(o.fragment.barHash, n.fragment.barHash);
  assert.equal(o.fragment.caseSetHash, n.fragment.caseSetHash);
  assert.equal(o.fragment.drawsPerCase, n.fragment.drawsPerCase);
  assert.equal(o.fragment.systems['<system name>']?.['<old or new>'], o.sha256, 'the printed hash is the sha256 of the written file');
  assert.equal(n.fragment.systems['<system name>']?.['<old or new>'], n.sha256);
  const judgeMoves = Object.keys(o.fragment.judge).filter((f) => o.fragment.judge[f] !== n.fragment.judge[f]);
  // The same choices as the example plans of the other two importers: three draws, the majority label, items pooled equally.
  return parseJudgeChangePlan({
    schema: 'anchorset.judge-change-plan/v1',
    barHash: o.fragment.barHash,
    caseSetHash: o.fragment.caseSetHash,
    drawsPerCase: o.fragment.drawsPerCase,
    judges: { old: o.fragment.judge, new: n.fragment.judge },
    judgeMoves,
    systems: { 'refund-bot': { old: o.sha256, new: n.sha256 } },
    storedOutputs: 'system-side-not-compared',
    measuredClass: 'refund_policy',
    cut: 'pass',
    drawSets: { estimate: [0, 1, 2] },
    labelRule: 'majority',
    pooling: 'items-equal',
  });
}
const planOf = (): JudgeChangePlan => parseJudgeChangePlan(JSON.parse(readFileSync(planPath, 'utf8')));

test('the committed plan.json is what the importer\'s printed fragments give for the two fixtures', () => {
  const derived = `${JSON.stringify(derivePlan(), null, 2)}\n`;
  // This test only reads the committed file, whatever the environment holds: no switch makes it write into the tree.
  // The file is written by examples/importers/skill-evals/fixtures.sh, together with the fixtures it is made from.
  assert.equal(readFileSync(planPath, 'utf8'), derived, 'plan.json is not what the fixtures give; make the fixtures and the plan again with examples/importers/skill-evals/fixtures.sh');
  // The whole of this file writes only below its temporary folder: the one function that creates a file is not imported.
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.equal(/\b(writeFile|appendFile|copyFile|rename|cp|symlink|createWriteStream)(Sync)?\b\s*\(/.test(source), false, 'the test holds a call that could write a file');
  assert.equal(/process\.env\[/.test(source), false, 'the test reads the environment');
  // Only the two judge models move: the same grader file, script files, template, system text, selector, reading rule, criterion and call shape on both sides.
  const plan = parseJudgeChangePlan(JSON.parse(derived));
  assert.deepEqual(plan.judgeMoves, ['judgeModelRequested', 'judgeModelServed']);
  assert.equal(plan.storedOutputs, 'system-side-not-compared');
  assert.equal(plan.drawsPerCase, 3);
});

test('the two re-grades read the same results.jsonl and the same source rep, and the importer prints both', () => {
  const line = (i: Imported): string => /^results\.jsonl sha256: ([0-9a-f]{64}) /m.exec(i.stdout)?.[1] ?? '';
  assert.equal(line(imported.old).length, 64);
  assert.equal(line(imported.old), line(imported.new));
  assert.equal(line(imported.old), sha256Hex(readFileSync(join(dir, 'example-flow', 'baseline', 'results.jsonl'))));
  for (const i of [imported.old, imported.new]) {
    assert.match(i.stdout, /^source rep: 0 of the flow's 2 declared; each stored output graded 3 times /m);
    assert.match(i.stdout, /^flow: read again from /m);
    assert.match(i.stdout, /^replies with reasoning: 0 of 9 asks; /m);
    assert.match(i.stdout, /^reading rule: one-json-object-boolean-pass\/v1$/m);
    // The key the fixture script handed the grader is in no run and in nothing printed.
    assert.ok(!i.stdout.includes(FIXTURE_KEY));
    assert.ok(!i.bytes.toString('utf8').includes(FIXTURE_KEY));
  }
  assert.match(newOnRep1.stdout, /^source rep: 1 of the flow's 2 declared; /m);
});

// ---- the two locks of `gate`, pinned apart -------------------------------------------------------------------------

/** Every field a gate may be told to waive for a pair of imported runs: all but the judge fields and the rubric (a changed judge is judge-change's subject) and the draw count (it changes the fold on its own), which no gate waives. */
const WAIVABLE = IDENTITY_FIELDS.filter((f) => !(JUDGE_FIELDS as readonly string[]).includes(f) && f !== 'rubricHash' && f !== 'drawsPerCase');

/** A scratch copy of `r` that names the judge of `like`: the five judge fields, the rubric and the judge call shape. The two locks of `gate` are the subject of these tests, not the judge. */
function withJudgeOf(r: RunArtifact, like: RunArtifact): RunArtifact {
  const c = clone(r);
  for (const f of [...JUDGE_FIELDS, 'rubricHash'] as const) (c.identity as Record<string, unknown>)[f] = like.identity[f];
  c.callShapes.judge = like.callShapes.judge;
  return c;
}

/** gateRuns with every waivable identity field allowed to differ, on the second run as a scratch copy with the first's judge: the test of the first lock and of the second. */
const gateAll = (a: RunArtifact, b: RunArtifact) => gateRuns(a, withJudgeOf(b, a), bar, { allowDiffer: WAIVABLE });
function refusedWith(result: ReturnType<typeof gateRuns>): RefusalError {
  assert.equal(result.kind, 'refused');
  assert.ok(result.kind === 'refused');
  return result.refusal;
}
const slotStops = (r: RunArtifact): string[] => r.draws.map((d) => `systemStop[${d.caseId}#${d.drawIndex}]`);

test('arm 1: as imported, every system stop is UNKNOWN, so the FIRST lock fires: IDENTITY_GAP on systemStop[case#draw], with every identity field allowed', () => {
  const { old: o, new: n } = imported;
  for (const r of [o.run, n.run]) assert.ok(r.draws.every((d) => d.attempts.every((a) => !('systemStop' in a) || a.systemStop === 'UNKNOWN')));
  const refusal = refusedWith(gateAll(o.run, n.run));
  assert.equal(refusal.code, 'IDENTITY_GAP');
  assert.deepEqual([...refusal.fields], SLOTS.map((s) => `systemStop[${s}]`), 'the named fields are exactly the nine slots of the baseline');
  assert.deepEqual([...refusal.fields], slotStops(o.run));
  assert.match(refusal.message, /baseline: the system stop is unknown on bank-dispute#0/);
  assert.match(refusal.message, /; imported run: use judge-change \(docs\/IMPORTERS\.md\)$/);
});

test('arm 2: with every system stop rewritten to a known completing stop in a scratch copy, the SECOND lock fires: IDENTITY_GAP on the six system-side fields and seed, though all are allowed', () => {
  const { old: o, new: n } = imported;
  // A scratch copy only: the importer's output is untouched. Lock 2 is the identity comparison, where a gap blocks even an allowed field.
  const refusal = refusedWith(gateAll(withKnownStops(o.run), withKnownStops(n.run)));
  assert.equal(refusal.code, 'IDENTITY_GAP');
  assert.deepEqual([...refusal.fields].sort(), [...SYSTEM_SIDE].sort());
  assert.match(refusal.message, /unknown on at least one side/);
  // The judge fields are all known and are not named: nothing but the unwritten system side blocks.
  for (const f of IDENTITY_FIELDS.filter((x) => !SYSTEM_SIDE.includes(x))) assert.ok(!refusal.fields.includes(f), f);
});

test('a run gated against itself with no flag is refused, by the first lock and then by the second', () => {
  const o = imported.old.run;
  const first = refusedWith(gateRuns(o, o, bar));
  assert.equal(first.code, 'IDENTITY_GAP');
  assert.deepEqual([...first.fields], slotStops(o));
  const second = refusedWith(gateRuns(withKnownStops(o), withKnownStops(o), bar));
  assert.equal(second.code, 'IDENTITY_GAP');
  assert.deepEqual([...second.fields].sort(), [...SYSTEM_SIDE].sort());
});

test('control: the same two scratch copies with a known system side and a seed ARE gated, so the two locks are the only thing in the way', () => {
  // One judge on both sides, so no judge field is waived: the gate has nothing to allow and is admitted.
  const result = gateRuns(fullyKnown(imported.old.run), withJudgeOf(fullyKnown(imported.new.run), imported.old.run), bar);
  assert.equal(result.kind, 'evaluated');
});

test('repeatFlips refuses an imported run twice over, each lock on its own: the declared packet basis (PACKET_MISMATCH), then the unknown system stops (IDENTITY_GAP), and so does the flips command', () => {
  const o = imported.old;
  const boot = { iterations: 200, seed: 1, alpha: 0.05 };
  const refusedBy = (run: RunArtifact): RefusalError => {
    try {
      repeatFlips(run, boot);
    } catch (e) {
      if (e instanceof RefusalError) return e;
      throw e;
    }
    return assert.fail('repeatFlips returned a report');
  };
  // The run as the importer wrote it: its packets are declared, refused before a draw is read.
  assert.equal(o.run.packetBasis, 'declared');
  const asWritten = refusedBy(o.run);
  assert.equal(asWritten.code, 'PACKET_MISMATCH');
  assert.deepEqual([...asWritten.fields], ['packetBasis']);
  // Lock 1 alone: known stops and the declared basis are still refused as PACKET_MISMATCH.
  const knownStops = refusedBy(withKnownStops(o.run));
  assert.equal(knownStops.code, 'PACKET_MISMATCH');
  assert.deepEqual([...knownStops.fields], ['packetBasis']);
  // Lock 2 alone: the basis "recorded" with the importer's unknown stops is refused on the stops.
  const gap = refusedBy(asRecorded(o.run));
  assert.equal(gap.code, 'IDENTITY_GAP');
  assert.ok(gap.fields.length > 0 && gap.fields.every((f) => f.startsWith('systemStop[')));
  // Control: known stops and the basis "recorded" in a scratch copy give a report, so the two locks are the only thing in the way.
  repeatFlips(asRecorded(withKnownStops(o.run)), boot);
  const r = cli('flips', '--run', o.path);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /REFUSED PACKET_MISMATCH/);
  assert.match(r.stderr, /fields: packetBasis/);
  assert.doesNotMatch(r.stdout, /flipped \d+ of/);
});

// ---- the measurement, with the numbers worked by hand from the fixtures ----------------------------------------------

const near = (got: number, want: number, what: string): void => assert.ok(Math.abs(got - want) < 1e-12, `${what}: ${got} != ${want}`);
const files = (): { name: string; bytes: Uint8Array }[] => [
  { name: 'old.json', bytes: imported.old.bytes },
  { name: 'new.json', bytes: imported.new.bytes },
];

test('fixtures: the two fake judges differ on exactly one case, clearance-organiser, on all three grades of its one stored output', () => {
  const labels = (r: RunArtifact): string[] => r.draws.map((d) => `${d.caseId}#${d.drawIndex}=${(d.attempts[0] as { label: string }).label}`);
  assert.deepEqual(labels(imported.old.run), SLOTS.map((s) => `${s}=pass`));
  assert.deepEqual(labels(imported.new.run), SLOTS.map((s) => `${s}=${s.startsWith('clearance-organiser') ? 'fail' : 'pass'}`));
  // One stored output and one packet per case, the same under both judges: what judge-change reads.
  for (const r of [imported.old.run, imported.new.run]) {
    for (const c of r.cases) {
      const ofCase = r.draws.filter((d) => d.caseId === c.id).map((d) => d.attempts[0] as { outputHash: string; packetHash: string });
      assert.equal(new Set(ofCase.map((a) => `${a.outputHash} ${a.packetHash}`)).size, 1, c.id);
    }
  }
});

test('judge-change admits the two imported runs under "system-side-not-compared"; the numbers are the hand-worked ones', () => {
  // Hand-worked. The bar (examples/importers/skill-evals/bar.json) measures class refund_policy = {clearance-organiser, faulty-headphones}
  // and holds refund_safety = {bank-dispute} apart, non-compensable. One system, three draws (three grades of one stored
  // output per case), estimate draws [0, 1, 2], label rule "majority", cut "pass".
  //   per-draw pass rate over the measured class, 2 cases x 3 draws = 6 draws each judge:
  //     old judge: all 6 pass                                                    -> 6/6 = 1
  //     new judge: clearance-organiser fails draws 0, 1 and 2; faulty-headphones passes 3 -> 3/6 = 0.5
  //     change: 0.5 - 1 = -0.5
  //   label pass rate (majority of three), 2 items:
  //     old 2/2 = 1; new: clearance-organiser 0 of 3 passes -> fail, faulty-headphones 3 of 3 -> pass: 1/2 = 0.5; change -0.5
  //   labels that differ between the judges: clearance-organiser only, 1 of 2 items = 0.5 (old pass -> new fail); no re-ask set: within-judge "not declared"
  //   bank-dispute (refund_safety, held apart): neither judge fails a draw of it, so the list of non-compensable failures is empty
  //   not compared: the seven system-side fields and the system stop, unknown on 3 cases x 3 draws = 9 of 9 draws
  const report = judgeChangeRuns(files(), bar, planOf());
  assert.deepEqual(report.inputs.map((i) => [i.system, i.role, i.sha256]), [['refund-bot', 'old-judge', imported.old.sha256], ['refund-bot', 'new-judge', imported.new.sha256]]);
  assert.deepEqual(report.judges.moved.map((m) => m.field), ['judgeModelRequested', 'judgeModelServed']);
  assert.deepEqual(report.counts, { systems: 1, cases: 2, fitOnlyCases: 0, items: 2, drawsPerSet: 3 });
  near(report.perDrawPassRate.old, 1, 'per-draw old');
  near(report.perDrawPassRate.new, 3 / 6, 'per-draw new');
  near(report.perDrawPassRate.change, -3 / 6, 'per-draw change');
  assert.equal(report.labelPassRate.rule, 'majority');
  near(report.labelPassRate.old, 1, 'label old');
  near(report.labelPassRate.new, 1 / 2, 'label new');
  near(report.labelPassRate.change, -1 / 2, 'label change');
  near(report.flips.acrossJudges, 1 / 2, 'flips');
  assert.equal(report.flips.withinJudge, 'not declared');
  assert.deepEqual(report.flips.items, [{ system: 'refund-bot', caseId: 'clearance-organiser', old: true, new: false }]);
  assert.deepEqual(report.nonCompensableClasses, ['refund_safety']);
  assert.deepEqual(report.nonCompensable, []);
  assert.deepEqual(report.notCompared, { fields: NOT_COMPARED, unknownStopDraws: 9, draws: 9 });
  // The two runs carry different packetSource strings (each names its own re-grade file) and the report is produced all the same.
  assert.notEqual(report.inputs[0]?.packetSource, report.inputs[1]?.packetSource);
  assert.ok(report.inputs.every((i) => i.packetBasis === 'declared' && i.packetSource !== undefined));
});

test('the same plan with "system-side-compared" is refused, IDENTITY_GAP', () => {
  const plan = { ...planOf(), storedOutputs: 'system-side-compared' as const };
  assert.throws(
    () => judgeChangeRuns(files(), bar, plan),
    (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && SYSTEM_SIDE.every((f) => e.fields.some((x) => x.includes(f))),
  );
});

test('a run made from source rep 0 and a run made from source rep 1, given to judge-change as old and new, are refused: HASH_MISMATCH on every case', () => {
  // The two runs agree in everything a plan binds (the cases, the bar, the draws, the judge fields but the two models):
  // nothing of the identity says they were made from different stored outputs. What says it is the output hash of each
  // draw, and judge-change compares those before it measures anything.
  const o = imported.old;
  const n = newOnRep1;
  assert.deepEqual(IDENTITY_FIELDS.filter((f) => o.run.identity[f] !== n.run.identity[f]), ['judgeModelRequested', 'judgeModelServed']);
  assert.match(o.run.packetSource ?? '', /; source rep 0 of 2; /);
  assert.match(n.run.packetSource ?? '', /; source rep 1 of 2; /);
  const plan = parseJudgeChangePlan({ ...planOf(), systems: { 'refund-bot': { old: o.sha256, new: n.sha256 } } });
  let caught: unknown;
  try {
    judgeChangeRuns([{ name: 'old.json', bytes: o.bytes }, { name: 'new.json', bytes: n.bytes }], bar, plan);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof RefusalError, String(caught));
  assert.equal(caught.code, 'HASH_MISMATCH', caught.message);
  // In the example flow the two reps of every case differ, so every draw of every case is named.
  for (const s of SLOTS) assert.ok(caught.fields.some((f) => f.includes(s)), `${s} in ${caught.fields.join(', ')}`);
});

test('the new judge\'s file is refused under the other reading rule; the same rows re-graded under that rule are another judge definition, and judge-change refuses the pair under a plan that names one', () => {
  const FENCE = 'one-json-object-boolean-pass-or-json-fence/v1';
  const fixture = join(dir, 'fixtures', 'new-judge.regrade.jsonl');
  const importAs = (inPath: string, outPath: string) => node(join(dir, 'import.ts'), '--in', inPath, '--cases', join(dir, 'cases.json'), '--bar', join(dir, 'bar.json'), '--out', outPath, '--reading', FENCE, '--flow', join(dir, 'example-flow'));
  // The header names the rule the re-grade read the replies under, and the importer takes the file under no other.
  const refusedPath = join(work, 'refused-other-rule.json');
  const refused = importAs(fixture, refusedPath);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /^REFUSED IMPORT_EVIDENCE: .*reading: the header names the reading rule one-json-object-boolean-pass\/v1, and --reading states one-json-object-boolean-pass-or-json-fence\/v1/m);
  assert.match(refused.stderr, /^fields: header\/reading$/m);
  assert.equal(existsSync(refusedPath), false);
  // What a re-grade made with `--reading` of the other rule would have written: the same rows under a header that names it.
  // Every reply reads under both rules, so only the judge definition differs. Converted in memory: this test writes no file.
  const text = readFileSync(fixture, 'utf8');
  const cut = text.indexOf('\n');
  const header = JSON.parse(text.slice(0, cut)) as Record<string, unknown>;
  assert.equal(header['reading'], 'one-json-object-boolean-pass/v1');
  header['reading'] = FENCE;
  const regraded = Buffer.from(JSON.stringify(header) + text.slice(cut));
  const cases = parseCasesFile(readFileSync(join(dir, 'cases.json'), 'utf8'), bar);
  const converted = convertRegrade(regraded, 'new-judge-other-rule.regrade.jsonl', cases, bar, FENCE, (variant, stated, reps) => readFlow(join(dir, 'example-flow'), variant, stated, reps));
  const bytes = Buffer.from(`${JSON.stringify(converted.run, null, 2)}\n`);
  const other = parseRunArtifact(JSON.parse(bytes.toString('utf8')));
  assert.deepEqual(IDENTITY_FIELDS.filter((f) => other.identity[f] !== imported.new.run.identity[f]), ['judgeDefinitionHash']);
  const plan = parseJudgeChangePlan({ ...planOf(), systems: { 'refund-bot': { old: imported.old.sha256, new: sha256Hex(bytes) } } });
  assert.throws(() => judgeChangeRuns([{ name: 'old.json', bytes: imported.old.bytes }, { name: 'new.json', bytes }], bar, plan), (e: unknown) => e instanceof RefusalError && e.fields.some((f) => f.includes('judgeDefinitionHash')));
});

// ---- end to end, through the commands ----------------------------------------------------------------------------------------

test('end to end: the two imported runs under the committed plan give the judge-change report, exit 0; gate on the two runs exits 2', () => {
  const inputs = join(work, 'runs');
  // The committed plan names these very bytes by sha256, so this run is the one the plan was written for.
  const jc = cli('judge-change', '--plan', planPath, '--bar', join(dir, 'bar.json'), '--inputs', inputs);
  assert.equal(jc.status, 0, jc.stderr);
  assert.match(jc.stdout, /^judge change on stored outputs: a measurement\. It has no verdict and never exits 1\.$/m);
  assert.match(jc.stdout, /judgeModelRequested {1,}fake-judge-old -> fake-judge-strict-new/);
  assert.match(jc.stdout, /not compared \(the plan opts in\): systemModelRequested, systemModelServed, systemCallShapeHash, systemPromptHash, systemToolsHash, systemHarnessVersion, seed, systemStop\n {2}the system stop is unknown on 9 of 9 draws/);
  assert.match(jc.stdout, /refund-bot {1,}old-judge {1,}old\.json {2}[0-9a-f]{64} {2}packets: declared from computed at import from a skill-evals re-grade file sha256:[0-9a-f]{64} \(sourceVersion: UNKNOWN; rowProfile: skill-evals\/1, pinned by the importer; written against CLI 2\.1\.288; no version is read; source rep 0 of 2; /);
  assert.match(jc.stdout, /systems 1 · scored cases 2 · items 2/);
  assert.match(jc.stdout, /per-draw pass rate {1,}1\.000 {1,}0\.500 {1,}-0\.500/);
  assert.match(jc.stdout, /label pass rate \(majority\) {1,}1\.000 {1,}0\.500 {1,}-0\.500/);
  assert.match(jc.stdout, /items whose label differs between the judges \(1: pass -> fail 1, fail -> pass 0\):\n {2}refund-bot\/clearance-organiser {2}pass -> fail/);
  // The same two runs given to gate are refused, exit 2, whatever may be allowed to differ.
  const gate = cli('gate', '--baseline', imported.old.path, '--candidate', imported.new.path, '--bar', join(dir, 'bar.json'), '--allow-differ', WAIVABLE.join(','));
  assert.equal(gate.status, 2, gate.stderr);
  assert.match(gate.stderr, /REFUSED IDENTITY_GAP/);
  assert.match(gate.stderr, /fields: systemStop\[bank-dispute#0\], systemStop\[bank-dispute#1\]/);
});

// ---- the bounded, recorded re-ask ----------------------------------------------------------------------------------------

// The old judge under a bound of 2 and the new judge under a bound of 1, on the same stored outputs and the same
// criterion (the one that carries the fake endpoint's marker): the first grade of each case was asked twice.
const reask = { old: importFixture('reask', 'reask-runs', 'old'), new: importFixture('reask-new-judge', 'reask-runs', 'new') };
const reaskPlan = (judgeMoves: string[]): Record<string, unknown> => ({
  ...planOf(),
  barHash: reask.old.fragment.barHash,
  caseSetHash: reask.old.fragment.caseSetHash,
  judges: { old: reask.old.fragment.judge, new: reask.new.fragment.judge },
  judgeMoves,
  systems: { 'refund-bot': { old: reask.old.sha256, new: reask.new.sha256 } },
});
const reaskFiles = [{ name: 'old.json', bytes: reask.old.bytes }, { name: 'new.json', bytes: reask.new.bytes }];
const reaskDiffering = Object.keys(reask.old.fragment.judge).filter((f) => reask.old.fragment.judge[f] !== reask.new.fragment.judge[f]);

test('fixtures/reask.regrade.jsonl imports: the first grade of each case is an unmeasured judge attempt, then the graded one', () => {
  const kinds = (r: RunArtifact): string[] => r.draws.map((d) => d.attempts.map((a) => (a.kind === 'unmeasured' ? `${a.role} ${a.reason}` : a.kind)).join('+'));
  const expected = ['judge truncated+graded', 'graded', 'graded', 'judge truncated+graded', 'graded', 'graded', 'judge truncated+graded', 'graded', 'graded'];
  assert.deepEqual(kinds(reask.old.run), expected);
  assert.deepEqual(kinds(reask.new.run), expected);
  assert.match(reask.old.stdout, /^re-asks: 3 on 3 of 9 slots \(truncated 3, timeout 0, transport 0, server-error 0, rate-limited 0\); at most 2 per slot$/m);
  assert.match(reask.new.stdout, /^re-asks: 3 on 3 of 9 slots \(truncated 3, timeout 0, transport 0, server-error 0, rate-limited 0\); at most 1 per slot$/m);
  assert.match(reask.old.run.identity.judgeHarnessVersion, /; max-reasks 2; wire anthropic-messages\/v1; script-files sha256:[0-9a-f]{64}$/);
  assert.match(reask.new.run.identity.judgeHarnessVersion, /; max-reasks 1; wire anthropic-messages\/v1; script-files sha256:[0-9a-f]{64}$/);
  assert.deepEqual(reaskDiffering, ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeHarnessVersion']);
  // The criterion is another text than the example's, so the rubric is another; the case set is the same.
  assert.notEqual(reask.old.run.identity.rubricHash, imported.old.run.identity.rubricHash);
  assert.equal(reask.old.run.identity.caseSetHash, imported.old.run.identity.caseSetHash);
});

test('re-ask: judge-change on the reask run and the new judge\'s run refuses when judgeMoves leaves out judgeHarnessVersion', () => {
  let caught: unknown;
  try {
    judgeChangeRuns(reaskFiles, bar, parseJudgeChangePlan(reaskPlan(['judgeModelRequested', 'judgeModelServed'])));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof RefusalError, String(caught));
  assert.equal(caught.code, 'IDENTITY_MISMATCH');
  assert.ok(caught.fields.includes('judgeHarnessVersion'), caught.fields.join(', '));
});

test('re-ask: the same pair is admitted when judgeMoves names it, and every number equals that of the pair without re-asks', () => {
  const report = judgeChangeRuns(reaskFiles, bar, parseJudgeChangePlan(reaskPlan(reaskDiffering)));
  const plain = judgeChangeRuns([{ name: 'old.json', bytes: imported.old.bytes }, { name: 'new.json', bytes: imported.new.bytes }], bar, planOf());
  const numbers = (r: typeof report) => ({ counts: r.counts, perDraw: r.perDrawPassRate, label: r.labelPassRate, flips: r.flips, nonCompensable: r.nonCompensable, notCompared: r.notCompared });
  assert.deepEqual(numbers(report), numbers(plain));
  assert.deepEqual(report.judges.moved.map((m) => m.field), ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeHarnessVersion']);
  // gate refuses the pair, as it refuses every imported run.
  const gate = cli('gate', '--baseline', reask.old.path, '--candidate', reask.new.path, '--bar', join(dir, 'bar.json'), '--allow-differ', WAIVABLE.join(','));
  assert.equal(gate.status, 2, gate.stderr);
  assert.match(gate.stderr, /REFUSED IDENTITY_GAP/);
});

// ---- the OpenAI Responses wire ---------------------------------------------------------------------------------------------------

test('the OpenAI old and new judges go through judge-change; the pair across the wires needs the four judge fields in the plan, and the library refuses a plan that leaves one out', () => {
  const [oaOld, oaNew] = [importFixture('openai-old-judge', 'openai', 'oa-old'), importFixture('openai-new-judge', 'openai', 'oa-new')];
  const planFor = (a: Imported, b: Imported, moves: string[]): JudgeChangePlan =>
    parseJudgeChangePlan({
      schema: 'anchorset.judge-change-plan/v1',
      barHash: a.fragment.barHash,
      caseSetHash: a.fragment.caseSetHash,
      drawsPerCase: a.fragment.drawsPerCase,
      judges: { old: a.fragment.judge, new: b.fragment.judge },
      judgeMoves: moves,
      systems: { 'refund-bot': { old: a.sha256, new: b.sha256 } },
      storedOutputs: 'system-side-not-compared',
      measuredClass: 'refund_policy',
      cut: 'pass',
      drawSets: { estimate: [0, 1, 2] },
      labelRule: 'majority',
      pooling: 'items-equal',
    });
  const filesOf = (a: Imported, b: Imported): { name: string; bytes: Uint8Array }[] => [{ name: 'old.json', bytes: a.bytes }, { name: 'new.json', bytes: b.bytes }];
  // OpenAI against OpenAI: the model moves, nothing else
  const same = judgeChangeRuns(filesOf(oaOld, oaNew), bar, planFor(oaOld, oaNew, ['judgeModelRequested', 'judgeModelServed']));
  assert.ok(same.blocks.gate !== undefined);
  // Anthropic against OpenAI, the same stored outputs: four fields move
  const four = ['judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion'];
  const cross = judgeChangeRuns(filesOf(imported.old, oaNew), bar, planFor(imported.old, oaNew, four));
  assert.ok(cross.blocks.gate !== undefined);
  const moved = Object.keys(imported.old.fragment.judge).filter((f) => imported.old.fragment.judge[f] !== oaNew.fragment.judge[f]);
  assert.deepEqual(moved, four);
  assert.equal(imported.old.fragment.judge['judgeDefinitionHash'], oaNew.fragment.judge['judgeDefinitionHash'], 'the same template, system text, selector, reading rule and bound: the definition does not move');
  assert.match(oaNew.fragment.judge['judgeHarnessVersion'] as string, /; max-reasks 0; wire openai-responses\/v1; script-files sha256:[0-9a-f]{64}$/);
  // a plan that leaves one of the last two out is refused
  for (const left of [four.filter((f) => f !== 'judgeCallShapeHash'), four.filter((f) => f !== 'judgeHarnessVersion')]) {
    assert.throws(() => judgeChangeRuns(filesOf(imported.old, oaNew), bar, planFor(imported.old, oaNew, left)), (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_MISMATCH');
  }
});
