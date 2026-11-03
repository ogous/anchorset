// The run-level entry of the stability measurement (src/flips.ts): the one public `repeatFlips`. The draws-level
// arithmetic is pinned in test/stability.test.ts; here is what the entry refuses before it reads a draw.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { caseSetHash, parseRunArtifact } from '../src/artifact.ts';
import type { RunArtifact } from '../src/artifact.ts';
import { InputError, RefusalError } from '../src/errors.ts';
import { repeatFlips } from '../src/flips.ts';
import { GAP } from '../src/identity.ts';

const root = join(import.meta.dirname, '..');
const demo = (name: string): string => join(root, 'examples', 'refund-bot', name);
const load = (name: string): RunArtifact => parseRunArtifact(JSON.parse(readFileSync(demo(name), 'utf8')));
const BOOT = { iterations: 200, seed: 1, alpha: 0.05 };
const work = mkdtempSync(join(tmpdir(), 'anchorset-flips-'));
after(() => rmSync(work, { recursive: true, force: true }));

function refusal(run: RunArtifact): RefusalError {
  try {
    repeatFlips(run, BOOT);
  } catch (e) {
    if (e instanceof RefusalError) return e;
    throw e;
  }
  return assert.fail('repeatFlips returned a report');
}

test('repeatFlips on the judged demo run with the packet basis set to declared refuses with PACKET_MISMATCH naming packetBasis (it gave a report before)', () => {
  const judged = load('judged.json');
  assert.equal(judged.packetBasis, 'recorded');
  assert.equal(repeatFlips(judged, BOOT).caseCount, 20, 'control: the same run as recorded gives its report');
  const declared: RunArtifact = { ...judged, packetBasis: 'declared', packetSource: 'computed at import from a re-grade file' };
  const r = refusal(declared);
  assert.equal(r.code, 'PACKET_MISMATCH');
  assert.deepEqual([...r.fields], ['packetBasis']);
  assert.match(r.message, /computed at import from a re-grade file/);
});

// Runs that parse (the entry now holds the parser's checks): one draw per case, and a basis that is unknown, with every packet hash unknown.
const withOneDraw = (run: RunArtifact): RunArtifact => ({ ...run, identity: { ...run.identity, drawsPerCase: 1 }, draws: run.draws.filter((d) => d.drawIndex === 0) });
const withUnknownPacketHashes = (run: RunArtifact): RunArtifact => {
  const copy = JSON.parse(JSON.stringify(run)) as RunArtifact;
  for (const d of copy.draws) for (const a of d.attempts) (a as Record<string, unknown>)['packetHash'] = GAP;
  return copy;
};

test('the basis is read before the draws: a declared run with one draw per case is a PACKET_MISMATCH, not an UNSUPPORTED_DESIGN', () => {
  const judged = load('judged.json');
  const declaredOneDraw: RunArtifact = { ...withOneDraw(judged), packetBasis: 'declared', packetSource: 'x' };
  assert.equal(refusal(declaredOneDraw).code, 'PACKET_MISMATCH');
  const recordedOneDraw: RunArtifact = withOneDraw(judged);
  assert.equal(refusal(recordedOneDraw).code, 'UNSUPPORTED_DESIGN', 'control: a recorded run with one draw per case is refused on the draws');
});

test('only "recorded" and "NO_JUDGE" are admitted: an unknown basis is IDENTITY_GAP naming packetBasis', () => {
  const judged = load('judged.json');
  const unknown = refusal({ ...withUnknownPacketHashes(judged), packetBasis: GAP });
  assert.equal(unknown.code, 'IDENTITY_GAP');
  assert.deepEqual([...unknown.fields], ['packetBasis']);
  const code = load('candidate.json');
  assert.equal(code.packetBasis, 'NO_JUDGE');
  assert.equal(repeatFlips(code, BOOT).caseCount, 20);
});

test('a run that does not say how many draws each case has is IDENTITY_GAP naming drawsPerCase', () => {
  const judged = load('judged.json');
  const r = refusal({ ...judged, identity: { ...judged.identity, drawsPerCase: GAP } });
  assert.equal(r.code, 'IDENTITY_GAP');
  assert.deepEqual([...r.fields], ['drawsPerCase']);
});

test('anchorset flips on a declared run exits 2 and prints no flip share; the JSON refusal names packetBasis', () => {
  const judged = JSON.parse(readFileSync(demo('judged.json'), 'utf8')) as Record<string, unknown>;
  const path = join(work, 'declared.json');
  writeFileSync(path, JSON.stringify({ ...judged, packetBasis: 'declared', packetSource: 'computed at import from a re-grade file' }));
  const r = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), 'flips', '--run', path], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /REFUSED PACKET_MISMATCH\n {2}fields: packetBasis/);
  assert.doesNotMatch(r.stdout, /flipped \d+ of/);
  assert.equal(r.stdout, '');
  const j = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), 'flips', '--run', path, '--json'], { encoding: 'utf8' });
  assert.equal(j.status, 2, j.stderr);
  const o = JSON.parse(j.stdout) as { kind: string; code: string; fields: string[]; exitCode: number };
  assert.deepEqual([o.kind, o.code, o.fields, o.exitCode], ['refused', 'PACKET_MISMATCH', ['packetBasis'], 2]);
  assert.equal(j.stderr, '');
});

test('repeatFlips runs the parser\'s checks first: a run that was never parsed and breaks the format is an INVALID_ARTIFACT input error naming the field, not a report', () => {
  const judged = load('judged.json');
  const badSchema = { ...judged, schema: 'anchorset.run/v1' } as unknown as RunArtifact;
  const badBasis = { ...judged, packetBasis: 'NO_JUDGE' } as unknown as RunArtifact;
  for (const [name, run, field] of [['schema', badSchema, 'artifact.schema'], ['basis', badBasis, 'artifact.packetBasis']] as const) {
    assert.throws(
      () => repeatFlips(run, BOOT),
      (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARTIFACT' && e.problems.some((p) => p.includes(field)),
      name,
    );
  }
  assert.equal(repeatFlips(judged, BOOT).caseCount, 20, 'control: the parsed run still gives its report');
});

test('repeatFlips without a bootstrap setting is an INVALID_ARGUMENT input error, not a TypeError', () => {
  const judged = load('judged.json');
  assert.throws(
    () => (repeatFlips as unknown as (r: RunArtifact) => unknown)(judged),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems.some((p) => p.includes('bootstrap')),
  );
});

// A run with a judge is read as one judge's repeat draws only when that judge is known: the rubric and all five judge fields.
const JUDGE_IDENTITY = ['rubricHash', 'judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion'] as const;
const withGaps = (run: RunArtifact, fields: readonly string[]): RunArtifact => {
  const copy = JSON.parse(JSON.stringify(run)) as RunArtifact;
  for (const f of fields) (copy.identity as unknown as Record<string, unknown>)[f] = GAP;
  // A call shape hash is unknown only when the stored shape holds a gap; the parser refuses the hash alone.
  if (fields.includes('judgeCallShapeHash')) (copy.callShapes as unknown as { judge: Record<string, unknown> }).judge['timeoutMs'] = GAP;
  return parseRunArtifact(copy);
};

test('a run with a judge and any of the rubric or the five judge fields unknown is IDENTITY_GAP naming exactly those fields', () => {
  const judged = load('judged.json');
  for (const f of JUDGE_IDENTITY) {
    const r = refusal(withGaps(judged, [f]));
    assert.equal(r.code, 'IDENTITY_GAP', f);
    assert.deepEqual([...r.fields], [f]);
  }
  const all = refusal(withGaps(judged, JUDGE_IDENTITY));
  assert.equal(all.code, 'IDENTITY_GAP');
  assert.deepEqual([...all.fields].sort(), [...JUDGE_IDENTITY].sort());
});

test('a call shape hash stated unknown over a known shape, or a gap in the shape under a known hash, stays invalid input, not a refusal', () => {
  const judged = load('judged.json');
  const hashOnly = JSON.parse(JSON.stringify(judged)) as RunArtifact;
  (hashOnly.identity as unknown as Record<string, unknown>)['judgeCallShapeHash'] = GAP;
  assert.throws(() => parseRunArtifact(hashOnly), InputError);
  const shapeOnly = JSON.parse(JSON.stringify(judged)) as RunArtifact;
  (shapeOnly.callShapes as unknown as { judge: Record<string, unknown> }).judge['timeoutMs'] = GAP;
  assert.throws(() => parseRunArtifact(shapeOnly), InputError);
});

test('a run graded by code is not read for a judge: an unknown rubric hash changes nothing', () => {
  const coded = load('baseline.json');
  assert.equal(coded.identity.judgeDefinitionHash, 'NO_JUDGE');
  const before = repeatFlips(coded, BOOT);
  const gap = JSON.parse(JSON.stringify(coded)) as RunArtifact;
  (gap.identity as unknown as Record<string, unknown>)['rubricHash'] = GAP;
  assert.deepEqual(repeatFlips(parseRunArtifact(gap), BOOT), before);
});

test('the packet basis is still read first: a declared run with an unknown judge field is a PACKET_MISMATCH', () => {
  const declared: RunArtifact = { ...withGaps(load('judged.json'), ['judgeModelServed']), packetBasis: 'declared', packetSource: 'x' };
  assert.equal(refusal(declared).code, 'PACKET_MISMATCH');
});

test('the text report says what the file shows: no claim that labels differ by the grader alone', () => {
  const out = (name: string): string => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), 'flips', '--run', demo(name)], { encoding: 'utf8' }).stdout;
  const judged = out('judged.json');
  assert.match(judged, /one output: every draw of the case states the same output hash and the same packet hash, under the one judge this run states, so the file names no other source for a label difference\. It cannot show what a provider or a harness did unseen\./);
  assert.doesNotMatch(judged, /grader alone/);
  assert.match(out('baseline.json'), /one output: every draw of the case states the same output hash, under the one grader this run states, so the file names no other source for a label difference\./);
});

// --- The stored-output declaration: no statistic changes, so there is no new pin (the test below compares the counts) ---
const STORED = { storedOutputs: 'system-side-not-compared' } as const;
type Raw = { cases: { id: string }[]; identity: Record<string, unknown>; draws: { caseId: string; attempts: Record<string, unknown>[] }[] };
const rawJudged = (): Raw => JSON.parse(readFileSync(demo('judged.json'), 'utf8')) as Raw;
/** The judged demo, without its cases of several outputs, its stops unknown where `unknownIn` says. */
function storedRun(unknownIn: (caseId: string) => boolean = () => true): RunArtifact {
  const raw = rawJudged();
  const whole = parseRunArtifact(rawJudged());
  const keep = new Set(repeatFlips(whole, BOOT).cases.filter((c) => c.basis === 'one-output').map((c) => c.caseId));
  raw.cases = raw.cases.filter((c) => keep.has(c.id));
  raw.draws = raw.draws.filter((d) => keep.has(d.caseId));
  raw.identity['caseSetHash'] = caseSetHash(raw.cases as RunArtifact['cases']);
  for (const d of raw.draws) for (const a of d.attempts) if (unknownIn(d.caseId) && 'systemStop' in a) a['systemStop'] = GAP;
  return parseRunArtifact(raw);
}
function storedRefusal(run: RunArtifact): RefusalError {
  try {
    repeatFlips(run, BOOT, STORED);
  } catch (e) {
    if (e instanceof RefusalError) return e;
    throw e;
  }
  return assert.fail('repeatFlips returned a report');
}

test('without the declaration an unknown stop stays refused, the refusal names the declaration, and notCompared is empty on a run that passes', () => {
  const r = refusal(storedRun());
  assert.equal(r.code, 'IDENTITY_GAP');
  assert.ok(r.fields.every((f) => f.startsWith('systemStop[')));
  assert.match(r.message, /completion is never assumed; if these are stored outputs, say so with --stored-outputs system-side-not-compared/);
  assert.deepEqual(repeatFlips(load('judged.json'), BOOT).notCompared, { fields: [], unknownStopDraws: 0, draws: 0 });
});

test('the declaration changes no number: the same counts and intervals as the same run with its stops known, and only notCompared differs', () => {
  const known = storedRun(() => false);
  const unknown = storedRun();
  const a = repeatFlips(known, BOOT);
  const b = repeatFlips(unknown, BOOT, STORED);
  assert.deepEqual(b.oneOutput, a.oneOutput);
  assert.deepEqual(b.differentOutputs, a.differentOutputs);
  assert.equal(b.ungradedCases, a.ungradedCases);
  assert.deepEqual(b.cases.map((c) => [c.caseId, c.flipped, c.disagreeShare]), a.cases.map((c) => [c.caseId, c.flipped, c.disagreeShare]));
  assert.equal(b.notCompared.unknownStopDraws, unknown.draws.length);
  assert.equal(b.notCompared.draws, unknown.draws.length);
  assert.ok(b.notCompared.fields.includes('systemStop'));
});

test('a declaration refuses in order: a declared basis, an unknown basis, a run graded by code, an unknown judge field, a run that needs no declaration', () => {
  const r = storedRun();
  const declared = storedRefusal({ ...r, packetBasis: 'declared', packetSource: 'computed at import from a re-grade file' });
  assert.equal(declared.code, 'PACKET_MISMATCH');
  assert.deepEqual([...declared.fields], ['packetBasis']);
  const noPackets = JSON.parse(JSON.stringify(r)) as RunArtifact;
  for (const d of noPackets.draws) for (const at of d.attempts) if ('packetHash' in at) (at as Record<string, unknown>)['packetHash'] = GAP;
  const unknownBasis = storedRefusal({ ...noPackets, packetBasis: GAP });
  assert.equal(unknownBasis.code, 'IDENTITY_GAP');
  assert.deepEqual([...unknownBasis.fields], ['packetBasis']);
  const code = storedRefusal(load('baseline.json'));
  assert.equal(code.code, 'UNSUPPORTED_DESIGN');
  assert.deepEqual([...code.fields], ['judgeDefinitionHash']);
  for (const f of JUDGE_IDENTITY) {
    const gap = storedRefusal(withGaps(r, [f]));
    assert.equal(gap.code, 'IDENTITY_GAP', f);
    assert.deepEqual([...gap.fields], [f]);
  }
  const none = storedRefusal(storedRun(() => false));
  assert.equal(none.code, 'UNSUPPORTED_DESIGN');
  assert.deepEqual([...none.fields], ['systemStop']);
});

test('under a declaration a case of several outputs refuses, and a known stop beside an unknown one in a case is several outputs', () => {
  const whole: Raw = rawJudged();
  for (const d of whole.draws) for (const a of d.attempts) if ('systemStop' in a) a['systemStop'] = GAP;
  const several = storedRefusal(parseRunArtifact(whole));
  assert.equal(several.code, 'HASH_MISMATCH');
  const beside = JSON.parse(JSON.stringify(storedRun())) as Raw;
  const first = beside.draws[0] as Raw['draws'][number];
  (first.attempts[0] as Record<string, unknown>)['systemStop'] = 'end';
  const r = storedRefusal(parseRunArtifact(beside));
  assert.equal(r.code, 'HASH_MISMATCH');
  assert.deepEqual([...r.fields], [first.caseId]);
});

test('a run with some cases of unknown stops and others of known stops passes, and notCompared gives both counts', () => {
  const ids = storedRun().cases.map((c) => c.id);
  const half = new Set(ids.slice(0, 5));
  const run = storedRun((id) => half.has(id));
  const unknownDraws = run.draws.filter((d) => half.has(d.caseId)).length;
  const r = repeatFlips(run, BOOT, STORED);
  assert.equal(r.notCompared.unknownStopDraws, unknownDraws);
  assert.equal(r.notCompared.draws, run.draws.length);
  assert.ok(unknownDraws < run.draws.length);
});

test('under a declaration one case shown in two different packets, or a slot with no grade, still refuses', () => {
  const twoPackets = JSON.parse(JSON.stringify(storedRun())) as Raw;
  const first = twoPackets.draws[0] as Raw['draws'][number];
  (first.attempts[0] as Record<string, unknown>)['packetHash'] = 'f'.repeat(64);
  assert.equal(storedRefusal(parseRunArtifact(twoPackets)).code, 'PACKET_MISMATCH');
  const missing = JSON.parse(JSON.stringify(storedRun())) as Raw;
  missing.draws.shift();
  assert.equal(storedRefusal(parseRunArtifact(missing)).code, 'INCOMPLETE_RUN');
});

test('any other value of the option is an input error; the gate, with or without a re-judge, still refuses a run of unknown stops', () => {
  const r = storedRun();
  assert.throws(() => repeatFlips(r, BOOT, { storedOutputs: 'system-side-compared' } as unknown as typeof STORED), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
  const path = join(work, 'stored.json');
  writeFileSync(path, JSON.stringify(r));
  const bar = demo('bar.json');
  for (const extra of [[], ['--rejudge-of', path]]) {
    const out = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), 'gate', '--baseline', path, '--candidate', path, '--bar', bar, ...extra, '--json'], { encoding: 'utf8' });
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.equal((JSON.parse(out.stdout) as { kind: string }).kind, 'refused');
  }
});

test('the command takes the flag: the note is first and on the one-output heading, the JSON holds notCompared, and another value exits 64 or 65 with no report', () => {
  const path = join(work, 'stored-cli.json');
  writeFileSync(path, JSON.stringify(storedRun()));
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), 'flips', '--run', path, ...args], { encoding: 'utf8' });
  const text = cli('--stored-outputs', 'system-side-not-compared');
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.split('\n');
  assert.match(lines[0] as string, /^stored outputs, declared by --stored-outputs: the system stop is unknown on \d+ of \d+ draws\. These shares hold for the stored texts as they stand, a cut-off answer included, and claim nothing about what produced them\.$/);
  const heading = lines.findIndex((l) => l.startsWith('one output:'));
  assert.equal(lines[heading + 1], lines[0]);
  const json = cli('--stored-outputs', 'system-side-not-compared', '--json');
  assert.equal(json.status, 0, json.stderr);
  const o = JSON.parse(json.stdout) as { schema: string; notCompared: { fields: string[] } };
  assert.equal(o.schema, 'anchorset.flips-report/v2');
  assert.ok(o.notCompared.fields.includes('systemStop'));
  const bad = cli('--stored-outputs', 'yes');
  assert.ok(bad.status === 64 || bad.status === 65, String(bad.status));
  assert.doesNotMatch(bad.stdout, /flipped/);
});

test('the conditions are read in the stated order: an input that breaks two gets the refusal of the earlier', () => {
  // A declared basis and an unknown judge field: the basis comes first.
  assert.equal(storedRefusal({ ...withGaps(storedRun(), ['judgeModelServed']), packetBasis: 'declared', packetSource: 'computed at import from a re-grade file' }).code, 'PACKET_MISMATCH');
  // An unknown judge field on a run with every stop known: the judge comes before the need for a declaration.
  assert.equal(storedRefusal(withGaps(storedRun(() => false), ['judgeModelServed'])).code, 'IDENTITY_GAP');
  // Every stop known on a run with several outputs in a case: the need for a declaration comes before one output.
  const several = parseRunArtifact(rawJudged());
  assert.equal(storedRefusal(several).code, 'UNSUPPORTED_DESIGN');
  // Several outputs in a case and a slot with no record: one output comes before the slots.
  const whole = rawJudged();
  const manyCase = repeatFlips(parseRunArtifact(rawJudged()), BOOT).cases.find((c) => c.basis === 'different-outputs') as { caseId: string };
  for (const d of whole.draws) for (const a of d.attempts) if ('systemStop' in a) a['systemStop'] = GAP;
  whole.draws.splice(whole.draws.findIndex((d) => d.caseId !== manyCase.caseId), 1);
  assert.equal(storedRefusal(parseRunArtifact(whole)).code, 'HASH_MISMATCH');
});

test('the hint names the declaration only where it can help, and --help names the flag', () => {
  const coded = JSON.parse(readFileSync(demo('baseline.json'), 'utf8')) as Raw;
  for (const d of coded.draws) for (const a of d.attempts) if ('systemStop' in a) a['systemStop'] = GAP;
  assert.doesNotMatch(refusal(parseRunArtifact(coded)).message, /--stored-outputs/);
  const help = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), 'flips', '--help'], { encoding: 'utf8' });
  assert.match(help.stdout + help.stderr, /--stored-outputs system-side-not-compared/);
});
