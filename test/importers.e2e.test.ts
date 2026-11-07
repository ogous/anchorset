// What an imported run may enter, pinned for both importers on the committed fixtures, at zero spend and with no network:
// the two locks that keep it out of `gate`, the judge-change measurement it does enter, and two end-to-end command runs.
// Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { JUDGE_FIELDS } from '../src/identity.ts';
import { gateRunsWithAdmission as gateRuns } from './helpers.ts';
import { callShapeHash, hashOf, IDENTITY_FIELDS, judgeChangeRuns, parseBarFile, parseJudgeChangePlan, parseRunArtifact, repeatFlips, sha256Hex } from '../src/index.ts';
import type { BarFile, IdentityField, JudgeChangePlan, JudgeChangeReport, RunArtifact } from '../src/index.ts';
import { RefusalError } from '../src/index.ts';
import { buildInspectRun } from '../examples/importers/inspect/import.ts';
import { loadBar, parseCasesFile, READINGS } from '../examples/importers/shared.ts';
import { asRecorded, makeCallShape, scratchEnv } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const TOOLS = ['promptfoo', 'inspect'] as const;
type Tool = (typeof TOOLS)[number];
/** promptfoo's importer is told the reading rule at import (`--reading`, no default); Inspect's takes no such flag. */
const readingArgs = (t: Tool, rule: string = READINGS[0]): string[] => (t === 'promptfoo' ? ['--reading', rule] : []);
const dirOf = (t: Tool): string => join(root, 'examples', 'importers', t);
const work = mkdtempSync(join(tmpdir(), 'anchorset-importers-e2e-'));
after(() => rmSync(work, { recursive: true, force: true }));

const node = (...args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8', env: scratchEnv() });
const cli = (...args: string[]) => node(join(root, 'src', 'cli.ts'), ...args);

// The seven fields no importer writes: six system-side fields and the seed.
const SYSTEM_SIDE: readonly IdentityField[] = ['systemModelRequested', 'systemModelServed', 'systemCallShapeHash', 'systemPromptHash', 'systemToolsHash', 'systemHarnessVersion', 'seed'];
// What judge-change lists as not compared: those seven and the system stop.
const NOT_COMPARED = [...SYSTEM_SIDE, 'systemStop'];

// ---- each tool's two fixtures, imported once by the real command ---------------------------------------------------

type Fragment = {
  barHash: string;
  caseSetHash: string;
  drawsPerCase: number;
  judge: Record<string, string>;
  systems?: Record<string, Record<string, string>>;
  run?: { sha256: string };
};
type Imported = { path: string; bytes: Buffer; sha256: string; stdout: string; stderr: string; status: number | null; fragment: Fragment; run: RunArtifact };

function importFixture(tool: Tool, judge: 'old' | 'new', rule: string = READINGS[0]): Imported {
  const folder = join(work, tool);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, rule === READINGS[0] ? `${judge}.json` : `${judge}-second-rule.json`);
  const r = node(join(dirOf(tool), 'import.ts'), '--in', join(dirOf(tool), 'fixtures', `${judge}-judge.json`), '--cases', join(dirOf(tool), 'cases.json'), '--bar', join(dirOf(tool), 'bar.json'), '--out', path, ...readingArgs(tool, rule));
  assert.equal(r.status, 0, `${tool} ${judge}: ${r.stderr}`);
  const bytes = readFileSync(path);
  // The fragment is the first JSON object on stdout: it ends at the first line that is a lone closing brace.
  const end = r.stdout.indexOf('\n}\n') + 2;
  return { path, bytes, sha256: sha256Hex(bytes), stdout: r.stdout, stderr: r.stderr, status: r.status, fragment: JSON.parse(r.stdout.slice(0, end)) as Fragment, run: parseRunArtifact(JSON.parse(bytes.toString('utf8'))) };
}
const imported = Object.fromEntries(TOOLS.map((t) => [t, { old: importFixture(t, 'old'), new: importFixture(t, 'new') }])) as Record<Tool, { old: Imported; new: Imported }>;
const barOf = (t: Tool): BarFile => parseBarFile(JSON.parse(readFileSync(join(dirOf(t), 'bar.json'), 'utf8')));
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

// ---- the plans: committed files that the importers' printed fragments regenerate -----------------------------------

const MEASURED = { promptfoo: { klass: 'refund_policy', cut: 'pass' }, inspect: { klass: 'refund_policy', cut: 'C' } } as const;

/** The plan, from the two printed fragments and the two run files' hashes, exactly as a user would paste them. */
function derivePlan(tool: Tool): JudgeChangePlan {
  const { old: o, new: n } = imported[tool];
  assert.equal(o.fragment.barHash, n.fragment.barHash);
  assert.equal(o.fragment.caseSetHash, n.fragment.caseSetHash);
  assert.equal(o.fragment.drawsPerCase, n.fragment.drawsPerCase);
  // The fragment's own record of the file's hash, in whichever key the importer prints it.
  const printed = (i: Imported): string => (i.fragment.systems !== undefined ? (Object.values(i.fragment.systems)[0] as Record<string, string>)[Object.keys(Object.values(i.fragment.systems)[0] as object)[0] as string] : i.fragment.run?.sha256) as string;
  assert.equal(printed(o), o.sha256, 'the printed hash is the sha256 of the written file');
  assert.equal(printed(n), n.sha256);
  const judgeMoves = Object.keys(o.fragment.judge).filter((f) => o.fragment.judge[f] !== n.fragment.judge[f]);
  return parseJudgeChangePlan({
    schema: 'anchorset.judge-change-plan/v1',
    barHash: o.fragment.barHash,
    caseSetHash: o.fragment.caseSetHash,
    drawsPerCase: o.fragment.drawsPerCase,
    judges: { old: o.fragment.judge, new: n.fragment.judge },
    judgeMoves,
    systems: { 'refund-bot': { old: o.sha256, new: n.sha256 } },
    storedOutputs: 'system-side-not-compared',
    measuredClass: MEASURED[tool].klass,
    cut: MEASURED[tool].cut,
    drawSets: { estimate: [0, 1, 2] },
    labelRule: 'majority',
    pooling: 'items-equal',
  });
}
const planText = (p: JudgeChangePlan): string => `${JSON.stringify(p, null, 2)}\n`;
const planPath = (t: Tool): string => join(dirOf(t), 'plan.json');

for (const tool of TOOLS) {
  test(`${tool}: the committed plan.json is what the importer's printed fragments give for the fixtures`, () => {
    const derived = planText(derivePlan(tool));
    // To regenerate after the fixtures or an importer change: ANCHORSET_WRITE_PLANS=1 node --test test/importers.e2e.test.ts
    if (process.env['ANCHORSET_WRITE_PLANS'] === '1') writeFileSync(planPath(tool), derived);
    assert.equal(readFileSync(planPath(tool), 'utf8'), derived);
    // Only the two judge models move: the same grader file, rubric, template, call shape and tool version on both sides.
    const plan = parseJudgeChangePlan(JSON.parse(derived));
    assert.deepEqual(plan.judgeMoves, ['judgeModelRequested', 'judgeModelServed']);
    assert.equal(plan.storedOutputs, 'system-side-not-compared');
  });
}

// ---- later additions ----------------------------------------------------------------------------------------------------------

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
const gateAll = (a: RunArtifact, b: RunArtifact, bar: BarFile) => gateRuns(a, withJudgeOf(b, a), bar, { allowDiffer: WAIVABLE });
function refusedWith(result: ReturnType<typeof gateRuns>): RefusalError {
  assert.equal(result.kind, 'refused');
  assert.ok(result.kind === 'refused');
  return result.refusal;
}
const slotStops = (r: RunArtifact): string[] => r.draws.map((d) => `systemStop[${d.caseId}#${d.drawIndex}]`);

for (const tool of TOOLS) {
  const { old: o, new: n } = imported[tool];
  const bar = barOf(tool);

  test(`arm 1 (${tool}): as imported, every system stop is UNKNOWN, so the FIRST lock fires: IDENTITY_GAP on systemStop[case#draw], with every identity field allowed`, () => {
    // This tool's importer records no known system stop (the grader sees the replay, not the system), so lock 1 is what stops it:
    // scoring.ts:assertStopsKnown, before any identity comparison.
    for (const r of [o.run, n.run]) assert.ok(r.draws.every((d) => d.attempts.every((a) => !('systemStop' in a) || a.systemStop === 'UNKNOWN')));
    const refusal = refusedWith(gateAll(o.run, n.run, bar));
    assert.equal(refusal.code, 'IDENTITY_GAP');
    assert.deepEqual([...refusal.fields], slotStops(o.run), 'the named fields are exactly the nine slots of the baseline');
    assert.match(refusal.message, /baseline: the system stop is unknown on c1#0/);
    // The importer's own packetSource is what triggers the hint, so a change to either breaks here.
    assert.match(refusal.message, /; imported run: use judge-change \(docs\/IMPORTERS\.md\)$/);
  });

  test(`arm 2 (${tool}): with every system stop rewritten to a known completing stop, the SECOND lock fires: IDENTITY_GAP on the six system-side fields and seed, though all are allowed`, () => {
    // A scratch copy only: the importer's output is untouched. Lock 2 is identity.ts:assertComparable, where a gap blocks even an allowed field.
    const refusal = refusedWith(gateAll(withKnownStops(o.run), withKnownStops(n.run), bar));
    assert.equal(refusal.code, 'IDENTITY_GAP');
    assert.deepEqual([...refusal.fields].sort(), [...SYSTEM_SIDE].sort());
    assert.match(refusal.message, /unknown on at least one side/);
    // The judge fields are all known and are not named: nothing but the unwritten system side blocks.
    for (const f of IDENTITY_FIELDS.filter((x) => !SYSTEM_SIDE.includes(x))) assert.ok(!refusal.fields.includes(f), f);
  });

  test(`${tool}: a run gated against itself with no flag is refused, IDENTITY_GAP`, () => {
    const first = refusedWith(gateRuns(o.run, o.run, bar));
    assert.equal(first.code, 'IDENTITY_GAP');
    assert.deepEqual([...first.fields], slotStops(o.run));
    const second = refusedWith(gateRuns(withKnownStops(o.run), withKnownStops(o.run), bar));
    assert.equal(second.code, 'IDENTITY_GAP');
    assert.deepEqual([...second.fields].sort(), [...SYSTEM_SIDE].sort());
  });

  test(`control (${tool}): the same two scratch copies with a known system side and a seed ARE gated, so the two locks are the only thing in the way`, () => {
    // One judge on both sides, so no judge field is waived: the gate has nothing to allow and is admitted.
    const result = gateRuns(fullyKnown(o.run), withJudgeOf(fullyKnown(n.run), o.run), bar);
    assert.equal(result.kind, 'evaluated');
  });

  test(`${tool}: an imported run in each position of --rejudge-of (original baseline, re-judged baseline, candidate) is refused, IDENTITY_GAP`, () => {
    const known = { original: fullyKnown(o.run), rejudged: fullyKnown(n.run), candidate: fullyKnown(n.run) };
    assert.equal(gateRuns(known.rejudged, known.candidate, bar, { rejudgeOf: known.original }).kind, 'evaluated', 'control: with all three known, the gate runs');
    const positions = [
      ['original baseline (--rejudge-of)', 'original', o.run],
      ['baseline', 'rejudged', n.run],
      ['candidate', 'candidate', n.run],
    ] as const;
    for (const [name, key, importedRun] of positions) {
      const three = { ...known, [key]: importedRun };
      const refusal = refusedWith(gateRuns(three.rejudged, three.candidate, bar, { rejudgeOf: three.original }));
      assert.equal(refusal.code, 'IDENTITY_GAP', name);
      assert.deepEqual([...refusal.fields], slotStops(importedRun), name);
      assert.ok(refusal.message.startsWith(`IDENTITY_GAP: ${name}: the system stop is unknown`), refusal.message);
    }
  });

  test(`${tool}: repeatFlips refuses an imported run twice over, each lock on its own: the declared packet basis (PACKET_MISMATCH), then the unknown system stops (IDENTITY_GAP), and so does the flips command`, () => {
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
    // The run as the importer wrote it: its packets are declared, and that is refused before a draw is read.
    const asWritten = refusedBy(o.run);
    assert.equal(o.run.packetBasis, 'declared');
    assert.equal(asWritten.code, 'PACKET_MISMATCH');
    assert.deepEqual([...asWritten.fields], ['packetBasis']);
    // Lock 1 alone: a scratch copy with known stops and the declared basis is still refused as PACKET_MISMATCH.
    const knownStops = refusedBy(withKnownStops(o.run));
    assert.equal(knownStops.code, 'PACKET_MISMATCH');
    assert.deepEqual([...knownStops.fields], ['packetBasis']);
    // Lock 2 alone: a scratch copy with the basis "recorded" and the importer's unknown stops is refused on the stops.
    const gap = refusedBy(asRecorded(o.run));
    assert.equal(gap.code, 'IDENTITY_GAP');
    assert.ok(gap.fields.length > 0 && !gap.fields.includes('packetBasis'));
    // The command: exit 2, the refusal naming packetBasis, and no flip share.
    const r = cli('flips', '--run', o.path);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /REFUSED PACKET_MISMATCH/);
    assert.match(r.stderr, /fields: packetBasis/);
    assert.doesNotMatch(r.stdout, /flipped \d+ of/);
  });
}

// ---- the measurement, with the numbers worked by hand from the fixtures --------------------------------------

const near = (got: number, want: number, what: string): void => assert.ok(Math.abs(got - want) < 1e-12, `${what}: ${got} != ${want}`);
const filesOf = (tool: Tool): { name: string; bytes: Uint8Array }[] => [
  { name: 'old.json', bytes: imported[tool].old.bytes },
  { name: 'new.json', bytes: imported[tool].new.bytes },
];
const planOf = (tool: Tool): JudgeChangePlan => parseJudgeChangePlan(JSON.parse(readFileSync(planPath(tool), 'utf8')));

// Both fixtures hold three cases (c1, c2, c3) with three draws each, graded by two fake judges that differ on c3 only:
// the old judge grades every draw of every case a pass, the new judge grades the three draws of c3 a fail.
// The fixtures' draws, per judge, are asserted first so that the hand-worked numbers below stand on what the files hold.
test('fixtures: the two fake judges differ on exactly one case, c3, on all three of its draws', () => {
  for (const tool of TOOLS) {
    const pass = tool === 'promptfoo' ? 'pass' : 'C';
    const fail = tool === 'promptfoo' ? 'fail' : 'I';
    const labels = (r: RunArtifact): string[] => r.draws.map((d) => `${d.caseId}#${d.drawIndex}=${(d.attempts[0] as { label: string }).label}`);
    const all = (id: string, l: string): string[] => [0, 1, 2].map((i) => `${id}#${i}=${l}`);
    assert.deepEqual(labels(imported[tool].old.run), [...all('c1', pass), ...all('c2', pass), ...all('c3', pass)], tool);
    assert.deepEqual(labels(imported[tool].new.run), [...all('c1', pass), ...all('c2', pass), ...all('c3', fail)], tool);
  }
});

test('promptfoo: judge-change admits the two imported runs; c3 is the non-compensable refund_safety case, so the measured class does not move and c3 is listed apart', () => {
  // Hand-worked. The bar (examples/importers/promptfoo/bar.json) measures class refund_policy = {c1, c2} and holds refund_safety = {c3} apart,
  // non-compensable. One system, three draws, estimate draws [0,1,2], majority label rule, cut "pass".
  //   per-draw pass rate, c1 and c2, 6 draws each judge: old 6/6 = 1, new 6/6 = 1, change 0
  //   label pass rate (majority of three): old 2/2 = 1, new 2/2 = 1, change 0
  //   labels that differ between the judges, on the measured items: 0 of 2; there is no re-ask set, so the within-judge share is "not declared"
  //   c3 (refund_safety): old fails no draw; new fails draws 0, 1 and 2; one judge passes every draw and the other fails some: worstOfNDiffers
  //   not compared: the seven system-side fields; the system stop is unknown on all 3 cases x 3 draws = 9 draws (a case of a non-compensable class is read too)
  const report = judgeChangeRuns(filesOf('promptfoo'), barOf('promptfoo'), planOf('promptfoo'));
  assert.deepEqual(report.inputs.map((i) => [i.system, i.role, i.sha256]), [['refund-bot', 'old-judge', imported.promptfoo.old.sha256], ['refund-bot', 'new-judge', imported.promptfoo.new.sha256]]);
  assert.deepEqual(report.judges.moved.map((m) => m.field), ['judgeModelRequested', 'judgeModelServed']);
  assert.deepEqual(report.counts, { systems: 1, cases: 2, fitOnlyCases: 0, items: 2, drawsPerSet: 3 });
  near(report.perDrawPassRate.old, 1, 'per-draw old');
  near(report.perDrawPassRate.new, 1, 'per-draw new');
  near(report.perDrawPassRate.change, 0, 'per-draw change');
  near(report.labelPassRate.old, 1, 'label old');
  near(report.labelPassRate.new, 1, 'label new');
  near(report.flips.acrossJudges, 0, 'flips');
  assert.equal(report.flips.withinJudge, 'not declared');
  assert.deepEqual(report.flips.items, []);
  assert.deepEqual(report.nonCompensableClasses, ['refund_safety']);
  assert.deepEqual(report.nonCompensable, [{ klass: 'refund_safety', system: 'refund-bot', caseId: 'c3', oldFailingDraws: [], newFailingDraws: [0, 1, 2], worstOfNDiffers: true }]);
  assert.deepEqual(report.notCompared.fields, NOT_COMPARED);
  assert.equal(report.notCompared.unknownStopDraws, 9);
  assert.equal(report.notCompared.draws, 9);
  // The two runs carry different packetSource strings (each names its own source file) and the report is produced all the same.
  assert.notEqual(report.inputs[0]?.packetSource, report.inputs[1]?.packetSource);
  assert.ok(report.inputs.every((i) => i.packetBasis === 'declared' && i.packetSource !== undefined));
});

test('inspect: judge-change admits the two imported runs; c3 is a measured case and the only item whose label flips', () => {
  // Hand-worked. The bar (examples/importers/inspect/bar.json) has one class, refund_policy = {c1, c2, c3}, cut "C". One system, three draws,
  // estimate draws [0,1,2], majority label rule.
  //   per-draw pass rate, 9 draws each judge: old 9/9 = 1, new 6/9 = 0.666..., change -3/9 = -0.333...
  //   label pass rate (majority of three): old 3/3 = 1, new 2/3 = 0.666..., change -1/3
  //   labels that differ between the judges: c3 only, 1 of 3 items = 0.333...; old C (pass) -> new I (fail); no re-ask set: within-judge "not declared"
  //   no non-compensable class; the system stop is unknown on 3 cases x 3 draws = 9 draws
  const report = judgeChangeRuns(filesOf('inspect'), barOf('inspect'), planOf('inspect'));
  assert.deepEqual(report.judges.moved.map((m) => m.field), ['judgeModelRequested', 'judgeModelServed']);
  assert.deepEqual(report.counts, { systems: 1, cases: 3, fitOnlyCases: 0, items: 3, drawsPerSet: 3 });
  near(report.perDrawPassRate.old, 1, 'per-draw old');
  near(report.perDrawPassRate.new, 6 / 9, 'per-draw new');
  near(report.perDrawPassRate.change, -3 / 9, 'per-draw change');
  near(report.labelPassRate.old, 1, 'label old');
  near(report.labelPassRate.new, 2 / 3, 'label new');
  near(report.labelPassRate.change, -1 / 3, 'label change');
  near(report.flips.acrossJudges, 1 / 3, 'flips');
  assert.equal(report.flips.withinJudge, 'not declared');
  assert.deepEqual(report.flips.items, [{ system: 'refund-bot', caseId: 'c3', old: true, new: false }]);
  assert.deepEqual(report.nonCompensable, []);
  assert.deepEqual(report.notCompared.fields, NOT_COMPARED);
  assert.equal(report.notCompared.unknownStopDraws, 9);
  assert.notEqual(report.inputs[0]?.packetSource, report.inputs[1]?.packetSource);
});

for (const tool of TOOLS) {
  test(`${tool}: the same plan with "system-side-compared" is refused, IDENTITY_GAP`, () => {
    const plan = { ...planOf(tool), storedOutputs: 'system-side-compared' as const };
    assert.throws(
      () => judgeChangeRuns(filesOf(tool), barOf(tool), plan),
      (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && SYSTEM_SIDE.every((f) => e.fields.some((x) => x.includes(f))),
    );
  });

  test(`(${tool}): two imported systems and a plan with a gate block exit 0, which says a report was written, NOT that the gate passed; the system side and stop are listed as not compared`, () => {
    const folder = join(work, `${tool}-two-systems`);
    mkdirSync(folder, { recursive: true });
    // A second system must hold other outputs (the roster refuses two systems with the same output on every draw). A scratch copy of
    // each run in which case c1 holds another stored output, the same one on both sides: a derived file, not an importer's output.
    const other = (i: Imported): Buffer => {
      const r = clone(i.run);
      for (const d of r.draws) {
        if (d.caseId !== 'c1') continue;
        for (const a of d.attempts) if ('outputHash' in a) Object.assign(a, { outputHash: sha256Hex('another stored output of c1'), packetHash: sha256Hex('another packet of c1') });
      }
      return Buffer.from(`${JSON.stringify(r, null, 2)}\n`);
    };
    const second = { old: other(imported[tool].old), new: other(imported[tool].new) };
    copyFileSync(imported[tool].old.path, join(folder, 'a-old.json'));
    copyFileSync(imported[tool].new.path, join(folder, 'a-new.json'));
    writeFileSync(join(folder, 'b-old.json'), second.old);
    writeFileSync(join(folder, 'b-new.json'), second.new);
    const plan = parseJudgeChangePlan({
      ...planOf(tool),
      systems: { 'refund-bot-a': { old: imported[tool].old.sha256, new: imported[tool].new.sha256 }, 'refund-bot-b': { old: sha256Hex(second.old), new: sha256Hex(second.new) } },
      gate: { statistic: 'tango-1998', margin: 0.1, alpha: 0.05 },
      oneCasePerCluster: true,
    });
    const planFile = join(work, `${tool}-gate-plan.json`);
    writeFileSync(planFile, JSON.stringify(plan, null, 2));
    const r = cli('judge-change', '--plan', planFile, '--bar', join(dirOf(tool), 'bar.json'), '--inputs', folder);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not compared \(the plan opts in\): systemModelRequested, systemModelServed, systemCallShapeHash, systemPromptHash, systemToolsHash, systemHarnessVersion, seed, systemStop\n {2}the system stop is unknown on 18 of 18 draws/);
    assert.match(r.stdout, /pair gates on majority labels: tango-1998/);
    // The same through the library, for the structure: pair states are printed, with the system side unknown on every pair.
    const files = ['a-old', 'a-new', 'b-old', 'b-new'].map((n) => ({ name: `${n}.json`, bytes: readFileSync(join(folder, `${n}.json`)) }));
    const report: JudgeChangeReport = judgeChangeRuns(files, barOf(tool), plan);
    assert.deepEqual(report.notCompared, { fields: NOT_COMPARED, unknownStopDraws: 18, draws: 18 });
    assert.equal(report.blocks.gate, 'computed');
    assert.ok(report.gate !== 'not declared' && !('withheld' in report.gate), 'the pair gates were computed');
    // The pair states are not a release gate: both systems are the same stored outputs, and nothing says which system was run.
    assert.equal(report.counts.systems, 2);
  });
}

// ---- the Inspect tool's two judge-definition parts move one field each ---------------------------------------

test('inspect: logs that differ only in instructions differ in rubricHash and agree in judgeDefinitionHash; only in template, the reverse', () => {
  type J = any; // a parsed log, edited freely
  const text = readFileSync(join(dirOf('inspect'), 'fixtures', 'old-judge.json'), 'utf8');
  const bar = loadBar(readFileSync(join(dirOf('inspect'), 'bar.json'), 'utf8'));
  const stated = parseCasesFile(readFileSync(join(dirOf('inspect'), 'cases.json'), 'utf8'), bar);
  const SC = 'model_graded_qa';
  const score = (s: J): J => s.scores[SC];
  const scoreEvent = (s: J): J => s.events.find((e: J) => e.event === 'score');
  const modelEvent = (s: J): J => s.events.find((e: J) => e.event === 'model');
  const records = (s: J): J[] => [score(s).metadata.grading[1].metadata.graderEvidence, modelEvent(s).output.metadata.graderEvidence, modelEvent(s).output.choices[0].message.metadata.graderEvidence, scoreEvent(s).score.metadata.grading[1].metadata.graderEvidence];
  // The independent single-pass rendering of the logged template; every sample's prompt and its hashes are rewritten to match.
  const rerender = (l: J): void => {
    const o = l.eval.scorers[0].options;
    for (const s of l.samples) {
      const v: Record<string, string> = { question: s.input, answer: s.output.completion, criterion: s.target, instructions: o.instructions };
      const prompt = (o.template as string).replace(/\{(question|answer|criterion|instructions)\}/g, (_m, n: string) => v[n] as string);
      score(s).metadata.grading[0].content = prompt;
      scoreEvent(s).score.metadata.grading[0].content = prompt;
      for (const r of records(s)) {
        r.promptSha256 = sha256Hex(prompt);
        r.sent.user = sha256Hex(prompt);
      }
    }
  };
  const ident = (l: J) => (buildInspectRun(Buffer.from(JSON.stringify(l), 'utf8'), 'log.json', stated, bar).run as RunArtifact).identity;
  const base = ident(JSON.parse(text));
  const byInstructions: J = JSON.parse(text);
  byInstructions.eval.scorers[0].options.instructions += '\nAnswer with the letter only.\n';
  rerender(byInstructions);
  const i = ident(byInstructions);
  assert.notEqual(i.rubricHash, base.rubricHash);
  assert.equal(i.judgeDefinitionHash, base.judgeDefinitionHash);
  const byTemplate: J = JSON.parse(text);
  byTemplate.eval.scorers[0].options.template += '\nThank you.\n';
  rerender(byTemplate);
  const t = ident(byTemplate);
  assert.equal(t.rubricHash, base.rubricHash);
  assert.notEqual(t.judgeDefinitionHash, base.judgeDefinitionHash);
  // Nothing else of the identity moved in either case.
  for (const [what, x] of [['instructions', i], ['template', t]] as const) {
    for (const f of IDENTITY_FIELDS.filter((k) => k !== 'rubricHash' && k !== 'judgeDefinitionHash')) assert.equal(x[f], base[f], `${what}: ${f}`);
  }
  // The same two hashes are what the old fixture's own options give.
  const o = JSON.parse(text).eval.scorers[0].options;
  assert.equal(base.rubricHash, hashOf({ tool: 'inspect_ai', scorer: SC, instructions: o.instructions }));
});

test('a plan cannot pair one source read under the two rules as one judge: judge-change refuses, naming judgeDefinitionHash', () => {
  const first = imported.promptfoo.old;
  const second = importFixture('promptfoo', 'old', READINGS[1]);
  assert.equal(first.sha256 === second.sha256, false);
  assert.notEqual(first.fragment.judge['judgeDefinitionHash'], second.fragment.judge['judgeDefinitionHash']);
  const claim = (judgeMoves: string[]): JudgeChangePlan =>
    parseJudgeChangePlan({
      ...planOf('promptfoo'),
      judges: { old: first.fragment.judge, new: second.fragment.judge },
      judgeMoves,
      systems: { 'refund-bot': { old: first.sha256, new: second.sha256 } },
    });
  const files = [{ name: 'old.json', bytes: first.bytes }, { name: 'new.json', bytes: second.bytes }];
  // the plan says it is one judge (no definition move, which two honest fragments contradict): refused, naming the field
  assert.throws(() => judgeChangeRuns(files, barOf('promptfoo'), claim(['judgeModelRequested'])), (e: unknown) => e instanceof RefusalError && e.fields.includes('judgeDefinitionHash'));
  // only a plan that declares the definition moved admits them, as two judges
  const report = judgeChangeRuns(files, barOf('promptfoo'), claim(['judgeDefinitionHash']));
  assert.deepEqual(report.judges.moved.map((m) => m.field), ['judgeDefinitionHash']);
});

// ---- end to end, through the commands -----------------------------------------------------------------------------

for (const tool of TOOLS) {
  test(`end to end (${tool}): import.ts on the two fixtures, then judge-change on the result exits 0 with the numbers; gate on the two runs exits 2`, () => {
    const folder = join(work, `${tool}-cli`);
    const inputs = join(folder, 'runs');
    mkdirSync(inputs, { recursive: true });
    const outs: Record<string, string> = {};
    for (const j of ['old', 'new'] as const) {
      const out = join(inputs, `${j}.json`);
      const r = node(join(dirOf(tool), 'import.ts'), '--in', join(dirOf(tool), 'fixtures', `${j}-judge.json`), '--cases', join(dirOf(tool), 'cases.json'), '--bar', join(dirOf(tool), 'bar.json'), '--out', out, ...readingArgs(tool));
      assert.equal(r.status, 0, r.stderr);
      // The lines an importer prints on success: the grader's identity, the shipped-grader line and the statement about the system side.
      assert.match(r.stdout, /^grader: anchorset-recording-grader/m);
      assert.match(r.stdout, /^the record reports the shipped grader's sha256$/m);
      assert.match(r.stdout, /^system side and seed: UNKNOWN \(this run can enter judge-change only under "system-side-not-compared"; `gate` refuses it\)$/m);
      outs[j] = out;
      // Writing it again is a usage error, exit 64: an importer never overwrites its output.
      assert.equal(node(join(dirOf(tool), 'import.ts'), '--in', join(dirOf(tool), 'fixtures', `${j}-judge.json`), '--cases', join(dirOf(tool), 'cases.json'), '--bar', join(dirOf(tool), 'bar.json'), '--out', out, ...readingArgs(tool)).status, 64);
    }
    // The committed plan names these very bytes by sha256, so this run is the one the plan was written for.
    const jc = cli('judge-change', '--plan', planPath(tool), '--bar', join(dirOf(tool), 'bar.json'), '--inputs', inputs);
    assert.equal(jc.status, 0, jc.stderr);
    assert.match(jc.stdout, /^judge change on stored outputs: a measurement\. It has no verdict and never exits 1\.$/m);
    assert.match(jc.stdout, /judgeModelRequested {1,}fake-judge-old -> fake-judge-strict-new/);
    assert.match(jc.stdout, /not compared \(the plan opts in\): systemModelRequested, systemModelServed, systemCallShapeHash, systemPromptHash, systemToolsHash, systemHarnessVersion, seed, systemStop\n {2}the system stop is unknown on 9 of 9 draws/);
    assert.match(jc.stdout, /refund-bot {1,}old-judge {1,}old\.json {2}[0-9a-f]{64} {2}packets: declared from computed at import from /);
    if (tool === 'promptfoo') {
      assert.match(jc.stdout, /systems 1 · scored cases 2 · items 2/);
      assert.match(jc.stdout, /per-draw pass rate {1,}1\.000 {1,}1\.000 {1,}\+0\.000/);
      assert.match(jc.stdout, /items whose label differs between the judges \(0: pass -> fail 0, fail -> pass 0\):/);
      assert.match(jc.stdout, /refund_safety\/refund-bot\/c3 {2}old judge fails draws \[\] · new judge fails draws \[0, 1, 2\] · worst-of-N differs between the judges/);
    } else {
      assert.match(jc.stdout, /systems 1 · scored cases 3 · items 3/);
      assert.match(jc.stdout, /per-draw pass rate {1,}1\.000 {1,}0\.667 {1,}-0\.333/);
      assert.match(jc.stdout, /label pass rate \(majority\) {1,}1\.000 {1,}0\.667 {1,}-0\.333/);
      assert.match(jc.stdout, /items whose label differs between the judges \(1: pass -> fail 1, fail -> pass 0\):\n {2}refund-bot\/c3 {2}pass -> fail/);
    }
    // The same two runs given to gate are refused, exit 2, whatever may be allowed to differ.
    const gate = cli('gate', '--baseline', outs['old'] as string, '--candidate', outs['new'] as string, '--bar', join(dirOf(tool), 'bar.json'), '--allow-differ', WAIVABLE.join(','));
    assert.equal(gate.status, 2, gate.stderr);
    assert.match(gate.stderr, /REFUSED IDENTITY_GAP/);
    assert.match(gate.stderr, /fields: systemStop\[c1#0\], systemStop\[c1#1\]/);
  });
}

// ---- the bounded, recorded re-ask: the pair under two bounds, the gate, and one pin of the library's behaviour ------------

/** A named fixture imported by the real command. */
function importNamed(tool: Tool, fixture: string, folderName: string, outName: string): Imported {
  const folder = join(work, `${tool}-${folderName}`);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${outName}.json`);
  const r = node(join(dirOf(tool), 'import.ts'), '--in', join(dirOf(tool), 'fixtures', `${fixture}.json`), '--cases', join(dirOf(tool), 'cases.json'), '--bar', join(dirOf(tool), 'bar.json'), '--out', path, ...readingArgs(tool));
  assert.equal(r.status, 0, `${tool} ${fixture}: ${r.stderr}`);
  const bytes = readFileSync(path);
  const end = r.stdout.indexOf('\n}\n') + 2;
  return { path, bytes, sha256: sha256Hex(bytes), stdout: r.stdout, stderr: r.stderr, status: r.status, fragment: JSON.parse(r.stdout.slice(0, end)) as Fragment, run: parseRunArtifact(JSON.parse(bytes.toString('utf8'))) };
}
/** The numbers of a report: everything but the hashes, the file names and the judges' identity strings. */
const numbersOf = (r: JudgeChangeReport) => ({ counts: r.counts, perDraw: r.perDrawPassRate, label: r.labelPassRate, flips: r.flips, nonCompensable: r.nonCompensable, notCompared: r.notCompared, blocks: r.blocks });
const attemptKinds = (r: RunArtifact): string[] => r.draws.map((d) => d.attempts.map((a) => (a.kind === 'unmeasured' ? a.reason : a.kind)).join('+'));

for (const tool of TOOLS) {
  // The old judge under a bound of 2 and the new judge under a bound of 1, on the same stored outputs: two slots of each were asked twice.
  const reask = { old: importNamed(tool, 'reask', 'reask', 'old'), new: importNamed(tool, 'reask-new-judge', 'reask', 'new') };
  const bar = barOf(tool);
  const planFor = (judgeMoves: string[]): Record<string, unknown> => ({
    schema: 'anchorset.judge-change-plan/v1',
    barHash: reask.old.fragment.barHash,
    caseSetHash: reask.old.fragment.caseSetHash,
    drawsPerCase: reask.old.fragment.drawsPerCase,
    judges: { old: reask.old.fragment.judge, new: reask.new.fragment.judge },
    judgeMoves,
    systems: { 'refund-bot': { old: reask.old.sha256, new: reask.new.sha256 } },
    storedOutputs: 'system-side-not-compared',
    measuredClass: MEASURED[tool].klass,
    cut: MEASURED[tool].cut,
    drawSets: { estimate: [0, 1, 2] },
    labelRule: 'majority',
    pooling: 'items-equal',
  });
  const files = [{ name: 'old.json', bytes: reask.old.bytes }, { name: 'new.json', bytes: reask.new.bytes }];
  const differing = Object.keys(reask.old.fragment.judge).filter((f) => reask.old.fragment.judge[f] !== reask.new.fragment.judge[f]);

  test(`re-ask (${tool}): the two imported runs hold re-asked slots, and the two bounds are two harness strings`, () => {
    assert.equal(attemptKinds(reask.old.run).filter((k) => k === 'truncated+graded').length, 1);
    assert.equal(attemptKinds(reask.old.run).filter((k) => k === 'server-error+graded').length, 1);
    assert.equal(attemptKinds(reask.old.run).filter((k) => k === 'graded').length, 7);
    assert.equal(attemptKinds(reask.new.run).filter((k) => k !== 'graded').length, 2);
    assert.match(reask.old.stdout, /^re-asks: 2 on 2 of 9 slots \(truncated 1, timeout 0, transport 0, server-error 1, rate-limited 0\); at most 2 per slot$/m);
    assert.match(reask.new.stdout, /^re-asks: 2 on 2 of 9 slots \(truncated 1, timeout 0, transport 0, server-error 1, rate-limited 0\); at most 1 per slot$/m);
    assert.match(reask.old.run.identity.judgeHarnessVersion, /; max-reasks 2; wire anthropic-messages\/v1$/);
    assert.match(reask.new.run.identity.judgeHarnessVersion, /; max-reasks 1; wire anthropic-messages\/v1$/);
    // The bound is in both: the harness string states it, and it enters the judge's definition hash.
    assert.deepEqual(differing, ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeHarnessVersion']);
    // But for the bound, the two harness strings are one.
    assert.equal(reask.old.run.identity.judgeHarnessVersion.replace(/max-reasks 2; wire anthropic-messages\/v1$/, ''), reask.new.run.identity.judgeHarnessVersion.replace(/max-reasks 1; wire anthropic-messages\/v1$/, ''));
  });

  test(`re-ask (${tool}): judge-change on the reask run and the new judge's run refuses when judgeMoves leaves out judgeHarnessVersion`, () => {
    const moves = ['judgeModelRequested', 'judgeModelServed'];
    let caught: unknown;
    try {
      judgeChangeRuns(files, bar, parseJudgeChangePlan(planFor(moves)));
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof RefusalError, String(caught));
    assert.equal(caught.code, 'IDENTITY_MISMATCH');
    assert.ok(caught.fields.includes('judgeHarnessVersion'), caught.fields.join(', '));
    const planFile = join(work, `${tool}-reask-plan-without.json`);
    writeFileSync(planFile, JSON.stringify(planFor(moves), null, 2));
    const r = cli('judge-change', '--plan', planFile, '--bar', join(dirOf(tool), 'bar.json'), '--inputs', join(work, `${tool}-reask`));
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /REFUSED IDENTITY_MISMATCH/);
    assert.match(r.stderr, /judgeHarnessVersion/);
  });

  test(`re-ask (${tool}): the same pair is admitted when judgeMoves names it, and every number equals that of the pair without re-asks`, () => {
    const plan = parseJudgeChangePlan(planFor(differing));
    const report = judgeChangeRuns(files, bar, plan);
    assert.deepEqual(report.judges.moved.map((m) => m.field), ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeHarnessVersion']);
    // The pair without re-asks: the two example fixtures, the same two judges on stored outputs without the markers.
    const plain = judgeChangeRuns(filesOf(tool), bar, planOf(tool));
    assert.deepEqual(numbersOf(report), numbersOf(plain));
    const planFile = join(work, `${tool}-reask-plan-with.json`);
    writeFileSync(planFile, JSON.stringify(plan, null, 2));
    const r = cli('judge-change', '--plan', planFile, '--bar', join(dirOf(tool), 'bar.json'), '--inputs', join(work, `${tool}-reask`));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /judgeHarnessVersion .*max-reasks 2; wire [^ ]+ -> .*max-reasks 1; wire/);
    // Under each run the report counts its judge retries, over the scored cases and over the run file:
    // here two slots of each run, asked twice, both in cases of the measured class.
    const lines = r.stdout.split('\n');
    const scored = tool === 'promptfoo' ? 'the 2 scored cases of class "refund_policy": 2 of 6 slots' : 'the 3 scored cases of class "refund_policy": 2 of 9 slots';
    const retries = [`    judge retries, ${scored} hold one · earlier judge attempts by reason: server-error 1, truncated 1`, '    judge retries, the run file, every class included: 2 of 9 slot records hold one · earlier judge attempts by reason: server-error 1, truncated 1'];
    assert.deepEqual(lines.filter((l) => /^ {4}judge retries, /.test(l)), [...retries, ...retries]);
    // No other line names a re-ask.
    for (const line of lines.filter((l) => !/^\s+refund-bot\s/.test(l) && !retries.includes(l))) assert.doesNotMatch(line, /unmeasured|truncated|server-error|retr|asked again/, line);
  });

  test(`re-ask (${tool}): gate refuses the reask run through both locks`, () => {
    const first = refusedWith(gateAll(reask.old.run, reask.new.run, bar));
    assert.equal(first.code, 'IDENTITY_GAP');
    assert.deepEqual([...first.fields], slotStops(reask.old.run));
    const second = refusedWith(gateAll(withKnownStops(reask.old.run), withKnownStops(reask.new.run), bar));
    assert.equal(second.code, 'IDENTITY_GAP');
    for (const f of SYSTEM_SIDE) assert.ok(second.fields.includes(f), f);
    const r = cli('gate', '--baseline', reask.old.path, '--candidate', reask.new.path, '--bar', join(dirOf(tool), 'bar.json'), '--allow-differ', WAIVABLE.join(','));
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /REFUSED IDENTITY_GAP/);
  });
}

test('a run with judge-unmeasured attempts before each graded one gives the judge-change report of the same run without them, but for the plan hash, the file hash and its judge-retry counts', () => {
  // A pin of the library's behaviour, on the two promptfoo example runs; nothing of src/ is changed for it. The new
  // judge's run is copied with one to three judge attempts that measured nothing, of all five reasons, before the
  // graded attempt of five of its nine draws: what an importer writes for recorded re-asks.
  const tool: Tool = 'promptfoo';
  const reasons = ['truncated', 'timeout', 'transport', 'server-error', 'rate-limited'] as const;
  const edited = clone(imported[tool].new.run);
  let k = 0;
  edited.draws.forEach((d, i) => {
    if (i % 2 !== 0) return;
    const graded = d.attempts[0];
    assert.ok(graded !== undefined && graded.kind === 'graded' && d.attempts.length === 1);
    const n = (k % 3) + 1;
    const before = Array.from({ length: n }, (_, j) => ({ kind: 'unmeasured' as const, role: 'judge' as const, reason: reasons[(k + j) % reasons.length] as (typeof reasons)[number], detail: `judge ask ${j + 1} of ${n + 1}`, outputHash: graded.outputHash, systemStop: graded.systemStop, packetHash: graded.packetHash }));
    d.attempts = [...before, graded];
    k += 1;
  });
  assert.equal(edited.draws.filter((d) => d.attempts.length > 1).length, 5);
  assert.deepEqual([...new Set(edited.draws.flatMap((d) => d.attempts.flatMap((a) => (a.kind === 'unmeasured' ? [a.reason] : []))))].sort(), [...reasons].sort());
  const editedBytes = Buffer.from(`${JSON.stringify(edited, null, 2)}\n`);
  parseRunArtifact(JSON.parse(editedBytes.toString('utf8')));

  const reportOf = (name: string, newBytes: Buffer): { status: number | null; stdout: string; stderr: string; planHash: string } => {
    const folder = join(work, `pin-${name}`);
    mkdirSync(folder, { recursive: true });
    copyFileSync(imported[tool].old.path, join(folder, 'old.json'));
    writeFileSync(join(folder, 'new.json'), newBytes);
    const plan = { ...planOf(tool), systems: { 'refund-bot': { old: imported[tool].old.sha256, new: sha256Hex(newBytes) } } };
    const planFile = join(work, `pin-${name}-plan.json`);
    writeFileSync(planFile, JSON.stringify(plan, null, 2));
    const r = cli('judge-change', '--plan', planFile, '--bar', join(dirOf(tool), 'bar.json'), '--inputs', folder);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, planHash: hashOf(parseJudgeChangePlan(plan)) };
  };
  const without = reportOf('without', imported[tool].new.bytes);
  const withAttempts = reportOf('with', editedBytes);
  assert.equal(without.status, 0, without.stderr);
  assert.equal(withAttempts.status, 0, withAttempts.stderr);
  const a = without.stdout.split('\n');
  const b = withAttempts.stdout.split('\n');
  assert.equal(a.length, b.length);
  const differing = a.map((line, i) => [line, b[i] as string] as const).filter(([x, y]) => x !== y);
  // Exactly four lines differ: the plan's hash, the new run file's sha256, and the new run's two judge-retry lines under it.
  assert.equal(differing.length, 4, differing.map(([x, y]) => `${x}\n${y}`).join('\n---\n'));
  // Draws 0, 2, 4, 6, 8 (c1#0, c1#2, c2#1, c3#0, c3#2) get k = 0..4: 1, 2, 3, 1, 2 attempts, of reasons (k + j) mod 5.
  // The run file: 5 of 9 slots, 9 attempts. The scored cases (c1, c2; c3 is non-compensable): k = 0, 1, 2, so 3 of 6 slots,
  // truncated 1, timeout 1 and transport 1, transport 1, server-error 1 and rate-limited 1.
  assert.deepEqual(differing.filter(([x]) => /^ {4}judge retries, /.test(x)), [
    ['    judge retries, the 2 scored cases of class "refund_policy": 0 of 6 slots hold one · earlier judge attempts: 0', '    judge retries, the 2 scored cases of class "refund_policy": 3 of 6 slots hold one · earlier judge attempts by reason: rate-limited 1, server-error 1, timeout 1, transport 2, truncated 1'],
    ['    judge retries, the run file, every class included: 0 of 9 slot records hold one · earlier judge attempts: 0', '    judge retries, the run file, every class included: 5 of 9 slot records hold one · earlier judge attempts by reason: rate-limited 2, server-error 2, timeout 1, transport 2, truncated 2'],
  ]);
  const fileLine = differing.find(([x]) => x.includes(imported[tool].new.sha256));
  assert.ok(fileLine !== undefined && fileLine[1].includes(sha256Hex(editedBytes)));
  assert.equal(fileLine[0].replace(imported[tool].new.sha256, sha256Hex(editedBytes)), fileLine[1]);
  const planLine = differing.find(([x]) => !x.includes(imported[tool].new.sha256) && !/^ {4}judge retries, /.test(x));
  assert.ok(planLine !== undefined);
  assert.equal(planLine[0].replace(/[0-9a-f]{64}/g, '<sha>'), planLine[1].replace(/[0-9a-f]{64}/g, '<sha>'));
  // gate and flips refuse the edited run as they refuse the original: the unknown system stops.
  const gated = refusedWith(gateAll(imported[tool].old.run, edited, barOf(tool)));
  assert.equal(gated.code, 'IDENTITY_GAP');
  assert.throws(() => repeatFlips(asRecorded(edited), { iterations: 200, seed: 1, alpha: 0.05 }), (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP');
  assert.throws(() => repeatFlips(edited, { iterations: 200, seed: 1, alpha: 0.05 }), (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH');
});
