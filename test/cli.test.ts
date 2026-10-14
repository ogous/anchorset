import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { isEntryPoint } from '../src/cli.ts';
import { caseSetHash, RUN_SCHEMA } from '../src/artifact.ts';
import { barHash, parseBarFile } from '../src/gate.ts';
import { hashOf, sha256Hex } from '../src/identity.ts';
import { readLedger } from '../src/ledger.ts';
import type { RunLedgerRecord } from '../src/ledger.ts';
import { gradedAttempt, makeCallShape, makeJudgeCallShape, makeJudgedIdentity, slot } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const ex = (f: string): string => join(root, 'examples', 'refund-bot', f);
const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'anchorset-cli-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The first record of a ledger that holds a gate. */
const gateRecordOf = (path: string): RunLedgerRecord => {
  const rec = readLedger(path)[0];
  assert.equal(rec?.kind, 'gate');
  return rec as RunLedgerRecord;
};

const gateArgs = ['gate', '--baseline', ex('baseline.json'), '--candidate', ex('candidate.json'), '--bar', ex('bar.json')];

test('demo gate exits 1 and names the broken and fixed cases', () => {
  const r = run(...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /BROKE \(1\)\n {2}must_handoff\/h03/);
  assert.match(r.stdout, /FIXED \(1\)\n {2}routine\/r07/);
  assert.match(r.stdout, /FAIL \(non-compensable\)/);
  assert.match(r.stdout, /systemModelServed/);
});

// The count on a BROKE row is pinned in test/scoring.test.ts (a hand-worked fixture and an independent recomputation).
// Here, the demo: case h03 of the candidate holds the draws handoff, review, handoff against an expected handoff
// under a floor, so the draw that says review fails and the other two pass: 1 of 3.
test('gate: each BROKE row ends "k of N draws fail", two whole numbers and never a share, a percentage or a bracket; the JSON carries the count with the folded case; nothing else in the report moves', () => {
  const args = [...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash'];
  const r = run(...args);
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stdout.split('\n');
  const at = lines.indexOf('BROKE (1)');
  assert.deepEqual(lines.slice(at, at + 4), ['BROKE (1)', '  must_handoff/h03  attributed draw #1: review; 1 of 3 draws fail', 'FIXED (1)', '  routine/r07  attributed draw #0: none']);
  // One line of the report holds the count, and it is the BROKE row: no FIXED row, no class row, no verdict line.
  const counted = lines.filter((l) => /draws fail/.test(l));
  assert.equal(counted.length, 1);
  for (const l of counted) {
    assert.match(l, /; \d+ of \d+ draws fail$/);
    assert.doesNotMatch(l, /%|\[|\]|\d\.\d/, 'a count of draws, never a share, a percentage or an interval');
  }
  assert.equal(lines.at(-2), 'verdict: REGRESSION (exit 1)');
  // No interval at the gate: without --rejudge-of the text report has no bracket and names no bootstrap.
  assert.doesNotMatch(r.stdout, /\[|interval|bootstrap|Wilson|nominal/);

  const j = JSON.parse(run(...args, '--json').stdout) as { exitCode: number; folded: Record<'baseline' | 'candidate', { caseId: string; pass: boolean; drawCount: number; failingDraws: number }[]> };
  assert.equal(j.exitCode, 1);
  for (const f of [...j.folded.baseline, ...j.folded.candidate]) {
    assert.ok(Number.isInteger(f.failingDraws) && f.failingDraws >= 0 && f.failingDraws <= f.drawCount, f.caseId);
    assert.equal(f.drawCount, 3, f.caseId);
    assert.equal(f.pass, f.failingDraws === 0, f.caseId);
  }
  assert.deepEqual(j.folded.candidate.filter((f) => f.failingDraws > 0).map((f) => [f.caseId, f.failingDraws, f.drawCount]), [['h03', 1, 3]]);
  // The baseline's one failing case (r07, FIXED in the candidate) has its own count in the JSON; the text prints a count on BROKE rows only.
  assert.deepEqual(j.folded.baseline.filter((f) => f.failingDraws > 0).map((f) => f.caseId), ['r07']);
});

test('demo gate without declared axes is refused with exit 2', () => {
  const r = run(...gateArgs);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED IDENTITY_MISMATCH/);
  assert.match(r.stderr, /fields: systemModelServed, systemCallShapeHash/);
});

test('gate --json and --ledger record the outcome', () => {
  const ledger = join(dir, 'l', 'ledger.jsonl');
  const r = run(...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash', '--json', '--ledger', ledger);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout) as { exitCode: number; kind: string };
  assert.equal(out.exitCode, 1);
  assert.equal(out.kind, 'evaluated');
  const recs = readLedger(ledger);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0]?.result['broke'], ['h03']);
  // The record names what the verdict was given: both identities, the bar hash, and the waived fields in the identity's order.
  const file = (f: string) => JSON.parse(readFileSync(ex(f), 'utf8')) as { identity: unknown };
  assert.deepEqual(gateRecordOf(ledger).inputs, {
    baseline: file('baseline.json').identity,
    candidate: file('candidate.json').identity,
    barHash: hashOf(JSON.parse(readFileSync(ex('bar.json'), 'utf8'))),
    allowDiffer: ['systemModelServed', 'systemCallShapeHash'],
  });
  assert.deepEqual(gateRecordOf(ledger).identity, file('candidate.json').identity);
  // The same waiver given twice and in the other order is one waiver, in the one order.
  const again = join(dir, 'l', 'again.jsonl');
  assert.equal(run(...gateArgs, '--allow-differ', 'systemCallShapeHash,systemModelServed,systemCallShapeHash', '--ledger', again).status, 1);
  assert.deepEqual(gateRecordOf(again).inputs.allowDiffer, ['systemModelServed', 'systemCallShapeHash']);
});

test('a refused gate records its inputs too, and no waived field when none was given', () => {
  const ledger = join(dir, 'l', 'refused.jsonl');
  const r = run(...gateArgs, '--ledger', ledger);
  assert.equal(r.status, 2);
  const rec = gateRecordOf(ledger);
  assert.deepEqual(rec.inputs.allowDiffer, []);
  assert.equal(rec.result['refused'], 'IDENTITY_MISMATCH');
  assert.notEqual(rec.inputs.baseline.systemModelServed, rec.inputs.candidate.systemModelServed);
});

test('gate --ledger prints the same trace line as agree, drift and judge-change: on stdout after the report, on stderr under --json, for a refusal too; without --ledger no byte changes', () => {
  const ledger = join(dir, 'trace', 'gate-ledger.jsonl');
  const allow = ['--allow-differ', 'systemModelServed,systemCallShapeHash'];
  const TRACE = /^ledger: line (\d+) · record ([0-9a-f]{64}) · result ([0-9a-f]{64})$/;
  const plain = run(...gateArgs, ...allow);
  const text = run(...gateArgs, ...allow, '--ledger', ledger);
  assert.equal(text.status, 1, text.stderr);
  const lines = text.stdout.split('\n');
  const m = TRACE.exec(lines.at(-2) as string);
  assert.ok(m !== null, text.stdout);
  assert.equal(lines.at(-1), '');
  assert.equal([...lines.slice(0, -2), ''].join('\n'), plain.stdout);
  assert.equal(text.stderr, plain.stderr);
  // The trace names the record that was appended: its line, the sha256 of that line's record and of its result.
  const first = readLedger(ledger);
  assert.equal(first.length, 1);
  assert.equal(m[1], '1');
  assert.equal(m[2], hashOf(first[0]));
  assert.equal(m[3], first[0]?.resultHash);
  const json = run(...gateArgs, ...allow, '--json', '--ledger', ledger);
  assert.equal(json.status, 1);
  assert.equal(json.stdout, run(...gateArgs, ...allow, '--json').stdout);
  assert.match(json.stderr, /^ledger: line 2 · record [0-9a-f]{64} · result [0-9a-f]{64}\n$/);
  // A refused gate is recorded, and says so the same way.
  const refused = run(...gateArgs, '--json', '--ledger', ledger);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^ledger: line 3 · record [0-9a-f]{64} · result [0-9a-f]{64}\n$/);
  assert.equal(readLedger(ledger).length, 3);
  // Without --ledger there is no trace anywhere.
  assert.doesNotMatch(plain.stdout + plain.stderr, /ledger:/);
});

test('gate refuses an edited bar file (barHash)', () => {
  const bar = JSON.parse(readFileSync(ex('bar.json'), 'utf8')) as { classes: Record<string, { minPassRate: number }> };
  (bar.classes['routine'] as { minPassRate: number }).minPassRate = 0.5;
  const edited = join(dir, 'bar.json');
  writeFileSync(edited, JSON.stringify(bar));
  const r = run('gate', '--baseline', ex('baseline.json'), '--candidate', ex('candidate.json'), '--bar', edited, '--allow-differ', 'systemModelServed,systemCallShapeHash');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HASH_MISMATCH/);
});

test('gate has no --labels flag: it is a usage error like any unknown flag (exit 64); the bar file is the one source of the labels, and a run label outside it is invalid input (65)', () => {
  const l = run(...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash', '--labels', 'none,handoff,review');
  assert.equal(l.status, 64, l.stderr);
  assert.match(l.stderr, /--labels/);
  assert.equal(l.stdout, '');
  // The bar file's labels are enforced on the runs: a verdict that the bar does not declare gives no verdict.
  const base = JSON.parse(readFileSync(ex('baseline.json'), 'utf8')) as { draws: { attempts: { label?: string }[] }[] };
  (base.draws[0]?.attempts[0] as { label?: string }).label = 'not-a-label';
  const edited = join(dir, 'baseline-outside-label.json');
  writeFileSync(edited, JSON.stringify(base));
  const r = run('gate', '--baseline', edited, '--candidate', ex('candidate.json'), '--bar', ex('bar.json'), '--allow-differ', 'systemModelServed,systemCallShapeHash');
  assert.equal(r.status, 65, r.stderr);
  assert.match(r.stderr, /"not-a-label" is not in \[none, review, handoff\]/);
});

test('gate refuses a bar file without knownFailures as invalid input (exit 65), naming the problem', () => {
  const bar = JSON.parse(readFileSync(ex('bar.json'), 'utf8')) as Record<string, unknown>;
  delete bar['knownFailures'];
  const file = join(dir, 'bar-no-known-failures.json');
  writeFileSync(file, JSON.stringify(bar));
  const r = run('gate', '--baseline', ex('baseline.json'), '--candidate', ex('candidate.json'), '--bar', file, '--allow-differ', 'systemModelServed,systemCallShapeHash');
  assert.equal(r.status, 65);
  assert.match(r.stderr, /bar\.knownFailures: required \(write \[\] for none\)/);
});

test('baseline against itself passes with exit 0', () => {
  const r = run('gate', '--baseline', ex('baseline.json'), '--candidate', ex('baseline.json'), '--bar', ex('bar.json'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verdict: OK/);
});

test('agree and drift run on the demo data', () => {
  const a = run('agree', '--ratings', ex('ratings.json'), '--json');
  assert.equal(a.status, 0, a.stderr);
  const rep = JSON.parse(a.stdout) as { kappaKind: string; ac1: number };
  assert.equal(rep.kappaKind, 'fleiss');
  assert.equal(typeof rep.ac1, 'number');
  const d = run('drift', '--old', ex('anchor_old.json'), '--new', ex('anchor_new.json'), '--flag', 'review,handoff');
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /classification {3}threshold-shift/);
});

// --- agreement is never a lone kappa, and never across unknown packets -------------------------
const NUM = String.raw`-?\d\.\d{3}`;
const BRACKET = String.raw`\[${NUM}, ${NUM}\]`;
const anchor = (name: string, change: (f: Record<string, unknown>) => void = () => undefined): string => {
  const f = JSON.parse(readFileSync(ex(name), 'utf8')) as Record<string, unknown>;
  change(f);
  const path = join(dir, `${name}-${sha256Hex(JSON.stringify(f)).slice(0, 8)}.json`);
  writeFileSync(path, JSON.stringify(f));
  return path;
};
const driftArgs = ['drift', '--old', ex('anchor_old.json'), '--new', ex('anchor_new.json'), '--flag', 'review,handoff'];

test('agree: kappa and AC1 each carry a seeded interval, every pairwise row carries AC1 and prevalence, and the seed is printed', () => {
  const r = run('agree', '--ratings', ex('ratings.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(String.raw`^fleiss kappa {5}${NUM} ${BRACKET}$`, 'm'));
  assert.match(r.stdout, new RegExp(String.raw`^gwet AC1 {9}${NUM} ${BRACKET}$`, 'm'));
  assert.match(r.stdout, /^prevalence {7}none \d\.\d{3} · review \d\.\d{3} · handoff \d\.\d{3}$/m);
  const rows = r.stdout.split('\n').filter((l) => / vs /.test(l));
  assert.equal(rows.length, 3);
  for (const row of rows) assert.match(row, new RegExp(String.raw`^ {2}rater-\w vs rater-\w: kappa ${NUM} ${BRACKET}( \([^)]*\))? · AC1 ${NUM} ${BRACKET}( \([^)]*\))? · agreement ${NUM} \(Wilson 95% ${BRACKET}\)$`));
  assert.equal(r.stdout.split('\n').filter((l) => /^ {4}prevalence none /.test(l)).length, 3);
  // One wording for every bracket that comes from resampling: what is resampled, what is held fixed, and that the level is nominal.
  assert.match(r.stdout, /^brackets: a percentile bootstrap interval over items, the raters and their labels held fixed: nominal 95%, coverage not checked; 2000 resamples, seed 7, 3 categories; it says nothing about another draw of a judge$/m);
  assert.doesNotMatch(r.stdout, /confidence interval|verified/);
  assert.ok(!/\bCI \[/.test(r.stdout), 'no interval is printed under a bare "CI"');
  const j = JSON.parse(run('agree', '--ratings', ex('ratings.json'), '--json').stdout) as { ac1CI: { seed: number; lo: number; hi: number }; bootstrap: { seed: number }; pairwise: { ac1: number; prevalence: Record<string, number>; ac1CI: { seed: number }; kappaCI: { seed: number } }[] };
  assert.deepEqual([j.ac1CI.seed, j.bootstrap.seed], [7, 7]);
  assert.ok(j.ac1CI.lo <= j.ac1CI.hi);
  for (const p of j.pairwise) {
    assert.equal(typeof p.ac1, 'number');
    assert.deepEqual(Object.keys(p.prevalence), ['none', 'review', 'handoff']);
    assert.deepEqual([p.ac1CI.seed, p.kappaCI.seed], [7, 7]);
  }
});

test('agree and drift: an unknown top-level key is invalid input (exit 65), named; a misspelt "bootstrap" never falls back to the defaults', () => {
  const edited = (name: string, file: string, over: Record<string, unknown>): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(ex(file), 'utf8')) as object), ...over }));
    return path;
  };
  // The committed examples hold only the keys the commands read.
  assert.equal(run('agree', '--ratings', ex('ratings.json')).status, 0);
  assert.equal(run(...driftArgs).status, 0);
  const ratings = JSON.parse(readFileSync(ex('ratings.json'), 'utf8')) as { bootstrap: unknown };
  const misspelt = edited('misspelt.json', 'ratings.json', { bootstrap: undefined, bootstrapp: ratings.bootstrap, note: 'x' });
  const r = run('agree', '--ratings', misspelt);
  assert.equal(r.status, 65, r.stdout);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^ {2}- ratings\.bootstrapp: unknown field$/m);
  assert.match(r.stderr, /^ {2}- ratings\.note: unknown field$/m);
  assert.equal(run('agree', '--ratings', misspelt, '--json', '--ledger', join(dir, 'unknown-key.jsonl')).status, 65);
  for (const [flag, name] of [['--old', 'old'], ['--new', 'new']] as const) {
    const f = edited(`anchor-${name}-extra.json`, `anchor_${name}.json`, { flag: 'handoff' });
    const args = ['drift', '--old', ex('anchor_old.json'), '--new', ex('anchor_new.json'), '--flag', 'review,handoff'];
    args[args.indexOf(flag) + 1] = f;
    const d = run(...args);
    assert.equal(d.status, 65, d.stdout);
    assert.match(d.stderr, new RegExp(`^ {2}- ${name}\\.flag: unknown field$`, 'm'));
  }
});

test('drift prints kappa with AC1, prevalence and a seeded interval, in text and in JSON, and --bootstrap-seed sets the seed', () => {
  const r = run(...driftArgs);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^anchor items 24 · packet hashes equal for every item, as the files state$/m);
  assert.match(r.stdout, new RegExp(String.raw`^cohen kappa {6}${NUM} ${BRACKET}  \(old against new\)$`, 'm'));
  assert.match(r.stdout, new RegExp(String.raw`^gwet AC1 {9}${NUM} ${BRACKET}$`, 'm'));
  assert.match(r.stdout, new RegExp(String.raw`^agreement {8}0\.833 \(Wilson 95% ${BRACKET}\)$`, 'm'));
  assert.match(r.stdout, /^prevalence {7}none 0\.479 · review 0\.292 · handoff 0\.229  \(old and new verdicts pooled\)$/m);
  assert.match(r.stdout, /^brackets: a percentile bootstrap interval over items, the labels of the two readings held fixed: nominal 95%, coverage not checked; 2000 resamples, seed 0, 3 categories; it says nothing about another draw of a judge$/m);
  assert.doesNotMatch(r.stdout, /confidence interval|verified/);
  // Wherever the word kappa is printed, a bracket is on the same line.
  for (const line of r.stdout.split('\n').filter((l) => /kappa/.test(l))) assert.match(line, new RegExp(BRACKET), line);
  const seeded = run(...driftArgs, '--bootstrap-seed', '5');
  assert.match(seeded.stdout, /2000 resamples, seed 5, /);
  const j = JSON.parse(run(...driftArgs, '--bootstrap-seed', '5', '--json').stdout) as { kappa: number; ac1: number; prevalence: Record<string, number>; kappaCI: { seed: number }; ac1CI: { seed: number }; bootstrap: { seed: number; iterations: number; alpha: number } };
  assert.equal(typeof j.ac1, 'number');
  assert.deepEqual(Object.keys(j.prevalence), ['none', 'review', 'handoff']);
  assert.deepEqual([j.kappaCI.seed, j.ac1CI.seed], [5, 5]);
  assert.deepEqual(j.bootstrap, { iterations: 2000, seed: 5, alpha: 0.05 });
  assert.equal(run(...driftArgs, '--bootstrap-seed', 'x').status, 64);
  assert.equal(run(...driftArgs, '--bootstrap-seed', '4294967296').status, 64);
});

test('drift refuses (exit 2, PACKET_MISMATCH) when neither anchor file carries packet hashes, when one does not, and when an item has none', () => {
  const bare = (f: Record<string, unknown>): void => void delete f['packetHashes'];
  const neither = run('drift', '--old', anchor('anchor_old.json', bare), '--new', anchor('anchor_new.json', bare), '--flag', 'handoff');
  assert.equal(neither.status, 2, neither.stdout);
  assert.match(neither.stderr, /REFUSED PACKET_MISMATCH\n {2}fields: old\.packetHashes, new\.packetHashes/);
  assert.equal(neither.stdout, '', 'no kappa is printed');
  const one = run('drift', '--old', ex('anchor_old.json'), '--new', anchor('anchor_new.json', bare), '--flag', 'handoff');
  assert.equal(one.status, 2);
  assert.match(one.stderr, /REFUSED PACKET_MISMATCH\n {2}fields: new\.packetHashes/);
  const drop = (f: Record<string, unknown>): void => void delete (f['packetHashes'] as Record<string, string>)['a07'];
  const item = run('drift', '--old', anchor('anchor_old.json', drop), '--new', anchor('anchor_new.json', drop), '--flag', 'handoff', '--json');
  assert.equal(item.status, 2);
  // Under --json a refusal is the one JSON object on stdout, for every command, and nothing is written to stderr.
  const refusal = JSON.parse(item.stdout) as { schema: string; kind: string; command: string; code: string; fields: string[]; exitCode: number };
  assert.deepEqual([refusal.schema, refusal.kind, refusal.command, refusal.code, refusal.exitCode], ['anchorset.refusal/v1', 'refused', 'drift', 'PACKET_MISMATCH', 2]);
  assert.deepEqual(refusal.fields, ['a07']);
  assert.equal(item.stderr, '');
  const differ = run('drift', '--old', ex('anchor_old.json'), '--new', anchor('anchor_new.json', (f) => void ((f['packetHashes'] as Record<string, string>)['a02'] = 'b'.repeat(64))), '--flag', 'handoff');
  assert.equal(differ.status, 2);
  assert.match(differ.stderr, /fields: a02/);
});

test('agree: a bootstrap block with a key it does not know, or a value that is not a number, is invalid input (65): a misspelt seed is never read as no seed', () => {
  const key = run('agree', '--ratings', anchor('ratings.json', (f) => void (f['bootstrap'] = { seed: 7, resamples: 10 })));
  assert.equal(key.status, 65);
  assert.match(key.stderr, /ratings\.bootstrap\.resamples: unknown field/);
  const value = run('agree', '--ratings', anchor('ratings.json', (f) => void (f['bootstrap'] = { seed: '7' })));
  assert.equal(value.status, 65);
  assert.match(value.stderr, /ratings\.bootstrap\.seed: must be a number/);
  const range = run('agree', '--ratings', anchor('ratings.json', (f) => void (f['bootstrap'] = { seed: -1 })));
  assert.equal(range.status, 65);
  assert.match(range.stderr, /seed must be a uint32 integer/);
});

// --- ledger records for agree and drift --------------------------------------------------------
test('agree --ledger and drift --ledger append one record each, bound to the files by sha256 and to the seed; the report printed is the report recorded', () => {
  const ledger = join(dir, 'ratings-ledger', 'ledger.jsonl');
  const a = run('agree', '--ratings', ex('ratings.json'), '--json', '--ledger', ledger);
  assert.equal(a.status, 0, a.stderr);
  const d = run(...driftArgs, '--bootstrap-seed', '5', '--json', '--ledger', ledger);
  assert.equal(d.status, 0, d.stderr);
  const recs = readLedger(ledger);
  assert.deepEqual(recs.map((r) => r.kind), ['agreement', 'drift']);
  const [ar, dr] = recs as unknown as [Record<string, unknown>, Record<string, unknown>];
  const sha = (f: string): string => sha256Hex(readFileSync(ex(f)));
  assert.deepEqual(ar['measurement'], { files: [{ role: 'ratings', sha256: sha('ratings.json') }], seeds: { bootstrap: { iterations: 2000, seed: 7, alpha: 0.05 } } });
  assert.deepEqual(dr['measurement'], {
    files: [{ role: 'anchor-old', sha256: sha('anchor_old.json') }, { role: 'anchor-new', sha256: sha('anchor_new.json') }],
    seeds: { bootstrap: { iterations: 2000, seed: 5, alpha: 0.05 } },
    flagLabels: ['review', 'handoff'],
  });
  assert.deepEqual(ar['result'], JSON.parse(a.stdout));
  assert.deepEqual(dr['result'], JSON.parse(d.stdout));
  assert.equal(ar['resultHash'], hashOf(JSON.parse(a.stdout)));
  assert.ok(!('identity' in ar) && !('identity' in dr));
  // With --json the trace goes to stderr, so stdout is the recorded report and nothing else.
  assert.match(a.stderr, /^ledger: line 1 · record [0-9a-f]{64} · result [0-9a-f]{64}\n$/);
  assert.match(d.stderr, /^ledger: line 2 · record [0-9a-f]{64} · result [0-9a-f]{64}\n$/);
});

test('without --ledger no byte of the agree or drift output changes; with it, one trace line is added', () => {
  const ledger = join(dir, 'trace', 'ledger.jsonl');
  for (const args of [['agree', '--ratings', ex('ratings.json')], driftArgs]) {
    const plain = run(...args);
    const recorded = run(...args, '--ledger', ledger);
    assert.equal(recorded.status, 0, recorded.stderr);
    const lines = recorded.stdout.split('\n');
    assert.match(lines.at(-2) as string, /^ledger: line \d · record [0-9a-f]{64} · result [0-9a-f]{64}$/);
    assert.equal([...lines.slice(0, -2), ''].join('\n'), plain.stdout);
    assert.equal(run(...args, '--json', '--ledger', ledger).stdout, run(...args, '--json').stdout);
  }
  assert.equal(readLedger(ledger).length, 4);
});

test('agree and drift check the ledger file before they compute: a ledger that cannot take a record is invalid input (65), and a refused comparison appends nothing', () => {
  const garbled = join(dir, 'garbled-ledger.jsonl');
  writeFileSync(garbled, 'not a record\n');
  const refusedRatings = anchor('ratings.json', (f) => void ((f['packetHashes'] as Record<string, Record<string, string>>)['rater-a']!['t01'] = 'c'.repeat(64)));
  // Without the ledger this ratings file is a refusal (2); with a bad ledger the ledger speaks first (65).
  assert.equal(run('agree', '--ratings', refusedRatings).status, 2);
  const a = run('agree', '--ratings', refusedRatings, '--ledger', garbled);
  assert.equal(a.status, 65, a.stderr);
  assert.match(a.stderr, /INVALID_LEDGER/);
  const d = run(...driftArgs, '--ledger', garbled);
  assert.equal(d.status, 65);
  assert.equal(d.stdout, '');
  assert.equal(readFileSync(garbled, 'utf8'), 'not a record\n');
  // A refusal is not a report: nothing is appended, and the file is not created.
  const fresh = join(dir, 'refused', 'ledger.jsonl');
  assert.equal(run('agree', '--ratings', refusedRatings, '--ledger', fresh).status, 2);
  assert.throws(() => readFileSync(fresh), /ENOENT/);
});

// --- flips --------------------------------------------------------------------------------------
test('flips on the judged demo run: 2 of 18 one-output cases flipped, 1 of 2 different-output cases, never pooled; exit 0', () => {
  const r = run('flips', '--run', ex('judged.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^20 cases · 3 draws per case · grader: judge example-judge-2026-01-15 · packets: recorded$/m);
  assert.match(r.stdout, /^ {2}flipped 2 of 18 cases \(0\.111\), 3 draws per case$/m);
  assert.match(r.stdout, new RegExp(String.raw`^ {2}Wilson 95% score interval, the 18 taken as fixed: \[0\.031, 0\.328\]$`, 'm'));
  assert.match(r.stdout, new RegExp(String.raw`^ {2}a percentile bootstrap interval over cases, the labels held fixed: nominal 95%, coverage not checked; all 20 cases, 2000 resamples, seed 0: ${BRACKET}$`, 'm'));
  assert.doesNotMatch(r.stdout, /confidence interval/);
  assert.match(r.stdout, /^ {2}flipped 1 of 2 cases \(0\.500\), 3 draws per case$/m);
  assert.match(r.stdout, /never pooled/);
  assert.match(r.stdout, /^r05 +one output +1 +none review none +0\.333 +yes$/m);
  assert.match(r.stdout, /^v01 +different outputs +3 +review handoff review +0\.333 +yes$/m);
  assert.match(r.stdout, /^h03 +different outputs +3 +handoff handoff handoff +0\.000 +no$/m);
  assert.ok(!/0\.150|\b3 of 20 cases/.test(r.stdout), 'the pooled 3 of 20 is not printed');
  const seeded = run('flips', '--run', ex('judged.json'), '--bootstrap-seed', '9');
  assert.match(seeded.stdout, /2000 resamples, seed 9: /);
});

test('flips --json carries both shares, every case, the seed, the grader and the sha256 of the run file', () => {
  const r = run('flips', '--run', ex('judged.json'), '--json');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout) as { run: { sha256: string; grader: string; packetBasis: string }; oneOutput: { cases: number; flipped: number; bootstrap: { seed: number } }; differentOutputs: { cases: number; flipped: number }; cases: unknown[]; bootstrap: { seed: number }; identity: { drawsPerCase: number } };
  assert.deepEqual(j.run, { sha256: sha256Hex(readFileSync(ex('judged.json'))), grader: 'judge', packetBasis: 'recorded' });
  assert.deepEqual([j.oneOutput.cases, j.oneOutput.flipped, j.differentOutputs.cases, j.differentOutputs.flipped], [18, 2, 2, 1]);
  assert.equal(j.cases.length, 20);
  assert.deepEqual([j.bootstrap.seed, j.oneOutput.bootstrap.seed, j.identity.drawsPerCase], [0, 0, 3]);
});

test('flips on a run graded by code says so: on the demo candidate no case with one output flips, and the two cases that flip hold different outputs', () => {
  const r = run('flips', '--run', ex('candidate.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /grader: code \(no judge\) · packets: NO_JUDGE$/m);
  assert.match(r.stdout, /^ {2}flipped 0 of 18 cases \(0\.000\), 3 draws per case$/m);
  assert.match(r.stdout, /seed 0: degenerate \(no flip observed, so no resample can hold one\); not a bound$/m);
  assert.match(r.stdout, /^ {2}Wilson 95% score interval, the 18 taken as fixed: \[0\.000, 0\.176\]$/m);
  assert.match(r.stdout, /^ {2}flipped 2 of 2 cases \(1\.000\), 3 draws per case$/m);
});

test('flips refuses (exit 2) a run with one draw per case, an unknown output hash, and a slot that measured nothing', () => {
  const t = trio();
  const one = run('flips', '--run', t.a);
  assert.equal(one.status, 2, one.stderr);
  assert.match(one.stderr, /REFUSED UNSUPPORTED_DESIGN\n {2}fields: drawsPerCase/);
  assert.equal(one.stdout, '');
  const edit = (change: (f: { draws: { caseId: string; drawIndex: number; attempts: Record<string, unknown>[] }[] }) => void): string => {
    const f = JSON.parse(readFileSync(ex('judged.json'), 'utf8')) as { draws: { caseId: string; drawIndex: number; attempts: Record<string, unknown>[] }[] };
    change(f);
    const path = join(dir, `judged-${sha256Hex(JSON.stringify(f)).slice(0, 8)}.json`);
    writeFileSync(path, JSON.stringify(f));
    return path;
  };
  const at = (f: { draws: { caseId: string; drawIndex: number; attempts: Record<string, unknown>[] }[] }, id: string, i: number) => f.draws.find((d) => d.caseId === id && d.drawIndex === i)!;
  const unhashed = run('flips', '--run', edit((f) => void (at(f, 'r01', 2).attempts[0]!['outputHash'] = 'UNKNOWN')), '--json');
  assert.equal(unhashed.status, 2, unhashed.stderr);
  const unhashedJson = JSON.parse(unhashed.stdout) as { schema: string; kind: string; command: string; code: string; fields: string[] };
  assert.deepEqual([unhashedJson.schema, unhashedJson.kind, unhashedJson.command, unhashedJson.code, unhashedJson.fields], ['anchorset.refusal/v1', 'refused', 'flips', 'IDENTITY_GAP', ['outputHash[r01#2]']]);
  assert.equal(unhashed.stderr, '');
  const timedOut = run('flips', '--run', edit((f) => void (at(f, 'r02', 1).attempts = [{ kind: 'unmeasured', role: 'system', reason: 'timeout', detail: 'no response' }])));
  assert.equal(timedOut.status, 2);
  assert.match(timedOut.stderr, /REFUSED INCOMPLETE_RUN\n {2}fields: r02#1/);
  const dropped = run('flips', '--run', edit((f) => void f.draws.splice(f.draws.indexOf(at(f, 'r03', 0)), 1)));
  assert.equal(dropped.status, 2);
  assert.match(dropped.stderr, /REFUSED INCOMPLETE_RUN\n {2}fields: r03#0/);
  const noCount = run('flips', '--run', edit((f) => void ((f as unknown as { identity: Record<string, unknown> }).identity['drawsPerCase'] = 'UNKNOWN')));
  assert.equal(noCount.status, 2, noCount.stderr);
  assert.match(noCount.stderr, /REFUSED IDENTITY_GAP\n {2}fields: drawsPerCase/);
  const otherPacket = run('flips', '--run', edit((f) => void (at(f, 'r04', 1).attempts[0]!['packetHash'] = 'd'.repeat(64))));
  assert.equal(otherPacket.status, 2);
  assert.match(otherPacket.stderr, /REFUSED PACKET_MISMATCH\n {2}fields: r04/);
  // A file that is not a run is invalid input, and a missing --run is a usage error.
  assert.equal(run('flips', '--run', ex('bar.json')).status, 65);
  assert.equal(run('flips').status, 64);
  assert.equal(run('flips', '--run', ex('judged.json'), '--bootstrap-seed', '-1').status, 64);
});

test('no shipped text keeps a sentence the report contradicts: the gate prints intervals under --rejudge-of, the split is three movements and not a share, and an ask is recorded only when its slot ends with a record', () => {
  const flat = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\s+/g, ' ');
  const shipped = ['README.md', 'CHANGELOG.md', 'docs/RUN_FORMAT.md', 'docs/JUDGE_CHANGE.md', 'docs/IMPORTERS.md', 'docs/MIGRATIONS.md',
    'examples/refund-bot/README.md', 'examples/importers/README.md', 'examples/run-format/write-run.ts', 'src/cli.ts', 'src/regression.ts'];
  for (const rel of shipped) {
    const text = flat(rel);
    assert.doesNotMatch(text, /The gate prints no interval/, rel);
    assert.doesNotMatch(text, /no interval at the gate/, rel);
    assert.doesNotMatch(text, /judge-controlled share/, rel);
    assert.doesNotMatch(text, /How much of the naive move/, rel);
    assert.doesNotMatch(text, /Every ask is in the grader's record/, rel);
    assert.doesNotMatch(text, /every ask is paid\b/, rel);
  }
});

test('--help names every command, flips among them', () => {
  const h = run('--help').stdout;
  for (const c of ['gate', 'agree', 'drift', 'flips', 'judge-change']) assert.match(h, new RegExp(`^  anchorset ${c} `, 'm'));
  assert.match(h, /anchorset agree --ratings <file\.json> \[--ledger <path>\] \[--json\]/);
  assert.match(h, /anchorset drift --old <file\.json> --new <file\.json> --flag <label,\.\.\.>\n? *\[--bootstrap-seed <uint32>\] \[--ledger <path>\] \[--json\]/);
});

test('gate --help describes the --rejudge-of split as the report prints it: three movements, not a share of a move', () => {
  const r = run('gate', '--help');
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /That share/);
  assert.doesNotMatch(r.stdout, /how much of the naive move/);
  assert.match(r.stdout.replace(/\s+/g, ' '), /reports the reported move, the judge's movement and the system's movement\. That split is computed only when both baselines recorded the same packet hash for every draw/);
  assert.ok(r.stdout.includes('That split is computed only when both'));
});

test('usage errors exit 64; invalid input exits 65', () => {
  assert.equal(run('gate', '--nope', 'x').status, 64);
  assert.equal(run('gate', '--baseline', ex('baseline.json')).status, 64);
  assert.equal(run('frobnicate').status, 64);
  assert.equal(run().status, 64);
  assert.equal(run(...gateArgs, '--allow-differ', 'color').status, 64);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ schema: 'anchorset.run/v0' }));
  const r = run('gate', '--baseline', bad, '--candidate', ex('candidate.json'), '--bar', ex('bar.json'));
  assert.equal(r.status, 65);
  assert.match(r.stderr, /identity/);
});

test('--help runs when the CLI is started directly and through a symlink (as npm .bin does)', () => {
  const direct = run('--help');
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /^usage:/);
  const link = join(dir, 'anchorset-link.ts');
  symlinkSync(join(root, 'src', 'cli.ts'), link);
  const linked = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stdout, /^usage:/);
});

test('isEntryPoint matches the script path directly and through a symlink, and nothing else', () => {
  const cli = join(root, 'src', 'cli.ts');
  const url = pathToFileURL(cli).href;
  const link = join(dir, 'entry-link.ts');
  symlinkSync(cli, link);
  assert.equal(isEntryPoint(url, cli), true);
  assert.equal(isEntryPoint(url, link), true);
  assert.equal(isEntryPoint(url, join(root, 'src', 'index.ts')), false);
  assert.equal(isEntryPoint(url, join(dir, 'missing.ts')), false);
  assert.equal(isEntryPoint(url, undefined), false);
});

// --- gate: the count of new cases on every class row ---------------------------------------------------
// The arithmetic is in test/regression.test.ts (a hand-worked fixture). Baseline: ten cases of class k under a floor
// with a bar of 0.9, eight pass: 8/10 = 0.800. Candidate: the same ten and ten new ones that all pass:
// 18/20 = 0.900, 10 new. The demo holds the same cases in both runs: every row says 0 new.
test('gate: every class row prints how many of the candidate\'s cases are new, as a whole number beside passed/total; --json and the ledger record carry the count', () => {
  const bar = { labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.9 } }, knownFailures: [] };
  const write = (name: string, ids: string[]): string => {
    const cases = ids.map((id) => ({ id, klass: 'k', input: `input ${id}`, expect: 'hi' }));
    const identity = { ...makeJudgedIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(parseBarFile(bar)), drawsPerCase: 1 }) };
    const draws = ids.map((id) => slot(id, 0, gradedAttempt(id === 'k09' || id === 'k10' ? 'lo' : 'hi', { judgeStop: 'tool-use', outputHash: sha256Hex(`output ${id}`) })));
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ schema: RUN_SCHEMA, identity, callShapes: { system: makeCallShape(), judge: makeJudgeCallShape() }, cases, draws, packetBasis: 'recorded' }));
    return path;
  };
  const ids = (prefix: string): string[] => Array.from({ length: 10 }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);
  const barPath = join(dir, 'new-cases-bar.json');
  writeFileSync(barPath, JSON.stringify(bar));
  const baseline = write('new-cases-baseline', ids('k'));
  const grown = write('new-cases-candidate', [...ids('k'), ...ids('n')]);
  const header = 'class           direction       baseline      candidate             bar     result';

  const same = run('gate', '--baseline', baseline, '--candidate', baseline, '--bar', barPath);
  assert.equal(same.status, 1, same.stderr);
  assert.deepEqual(same.stdout.split('\n').slice(0, 2), [header, 'k               floor           8/10 0.800    8/10 0.800, 0 new     0.900   FAIL']);

  const ledger = join(dir, 'new-cases.jsonl');
  const r = run('gate', '--baseline', baseline, '--candidate', grown, '--bar', barPath, '--allow-differ', 'caseSetHash', '--ledger', ledger);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const at = lines.indexOf(header);
  assert.ok(at >= 0, r.stdout);
  assert.equal(lines[at + 1], 'k               floor           8/10 0.800    18/20 0.900, 10 new   0.900   ok');
  assert.deepEqual((gateRecordOf(ledger).result['classes'] as unknown[]), [{ klass: 'k', passed: 18, total: 20, newCases: 10, missing: [], meetsBar: true }]);

  const json = JSON.parse(run('gate', '--baseline', baseline, '--candidate', grown, '--bar', barPath, '--allow-differ', 'caseSetHash', '--json').stdout) as { newCases: unknown };
  assert.deepEqual(json.newCases, [{ klass: 'k', count: 10, caseIds: ids('n') }]);

  // A cell as wide as its column, or wider, keeps one space before the next cell. The ten baseline cases and 100 new ones
  // that all pass: 108/110 = 0.98181..., printed 0.982, with `, 100 new` is 22 characters, the width of the candidate
  // column, and the bar follows after one space (a hand-worked fixture).
  const hundred = Array.from({ length: 100 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`);
  const wide = write('new-cases-wide', [...ids('k'), ...hundred]);
  const w = run('gate', '--baseline', baseline, '--candidate', wide, '--bar', barPath, '--allow-differ', 'caseSetHash');
  const row = w.stdout.split('\n').find((l) => l.startsWith('k ')) ?? '';
  assert.match(row, /108\/110 0\.982, 100 new +0\.900 /, w.stdout);
  assert.equal(row, 'k               floor           8/10 0.800    108/110 0.982, 100 new 0.900   ok');

  const demo = run(...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash').stdout.split('\n');
  const d = demo.indexOf(header);
  assert.deepEqual(demo.slice(d, d + 4), [
    header,
    'must_handoff    floor (strict)  5/5 1.000     4/5 0.800, 0 new      1.000   FAIL (non-compensable)',
    'should_review   floor           5/5 1.000     5/5 1.000, 0 new      0.900   ok',
    'routine         ceiling         9/10 0.900    10/10 1.000, 0 new    0.900   ok',
  ]);
  // On a class row the count is a whole number followed by "new": never a share.
  for (const l of [...lines.slice(at + 1, at + 2), ...demo.slice(d + 1, d + 4)]) assert.match(l, /\d+\/\d+ (\d\.\d{3}|NA|UNKNOWN), \d+ new {2,}/);
});

// --- gate --rejudge-of on a small judged trio ------------------------------------------------------
const trioBar = { labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] };
const trioCases = [
  { id: 'c1', klass: 'k', input: 'a', expect: 'hi' },
  { id: 'c2', klass: 'k', input: 'b', expect: 'hi' },
];
const trioIdentity = (over: Record<string, unknown> = {}) => ({
  ...makeJudgedIdentity({ caseSetHash: caseSetHash(trioCases), barHash: barHash(parseBarFile(trioBar)), drawsPerCase: 1 }),
  ...over,
});
const newJudge = { judgeDefinitionHash: hashOf('judge prompt v2'), judgeModelServed: 'judge-2026-06-01' };
const trioRun = (name: string, c1: string, c2: string, identity: Record<string, unknown>, outputs = 'baseline'): string => {
  const path = join(dir, `${name}.json`);
  const draws = [
    slot('c1', 0, gradedAttempt(c1, { judgeStop: 'tool-use', outputHash: sha256Hex(`${outputs} c1`) })),
    slot('c2', 0, gradedAttempt(c2, { judgeStop: 'tool-use', outputHash: sha256Hex(`${outputs} c2`) })),
  ];
  writeFileSync(path, JSON.stringify({ schema: RUN_SCHEMA, identity, callShapes: { system: makeCallShape(), judge: makeJudgeCallShape() }, cases: trioCases, draws, packetBasis: 'recorded' }));
  return path;
};
const trio = () => {
  const bar = join(dir, 'trio-bar.json');
  writeFileSync(bar, JSON.stringify(trioBar));
  return {
    bar,
    a: trioRun('a', 'hi', 'hi', trioIdentity()),
    b: trioRun('b', 'lo', 'hi', trioIdentity(newJudge)),
    c: trioRun('c', 'lo', 'hi', trioIdentity({ ...newJudge, systemModelServed: 'model-x-2026-06-01' }), 'candidate'),
  };
};

test('gate --rejudge-of: a stricter judge alone is not a regression (exit 0) and its share is printed', () => {
  const t = trio();
  const r = run('gate', '--baseline', t.b, '--candidate', t.c, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /BROKE \(0\)/);
  assert.match(r.stdout, /judge-controlled/);
  // The one wording for a resampled bracket: each effect is a difference of two pass shares, a smooth statistic.
  assert.ok(r.stdout.split('\n').includes('judge-controlled, against the baseline as first judged (a percentile bootstrap interval over cases, the folded labels of the three runs held fixed: nominal 95%, coverage not checked; 2000 resamples, seed 1):'), r.stdout);
  const seeded = run('gate', '--baseline', t.b, '--candidate', t.c, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed', '--bootstrap-seed', '9');
  assert.match(seeded.stdout, /coverage not checked; 2000 resamples, seed 9\):$/m);
  assert.doesNotMatch(r.stdout, /% bootstrap over cases/);
  // The candidate holds the re-judged baseline's labels on both cases, so no resample moves the system effect: the
  // bracket [0.000, 0.000] is degenerate and says so, in the words every other bracket uses; a moving one does not.
  const degenerate = '[0.000, 0.000] (degenerate: every resample gave this value; not a bound)';
  assert.ok(r.stdout.split('\n').includes(`  overall       n 2     reported  -0.500 [-1.000, 0.000]   judge  -0.500 [-1.000, 0.000]   system  0.000 ${degenerate}`), r.stdout);
  assert.ok(r.stdout.split('\n').includes(`  k             n 2     reported  -0.500 [-1.000, 0.000]   judge  -0.500 [-1.000, 0.000]   system  0.000 ${degenerate}`), r.stdout);
  // No class of this bar is non-compensable, so no listing and no line about one.
  assert.doesNotMatch(r.stdout, /non-compensable|newly failing/);
  assert.equal(r.stdout.split('\n').filter((l) => l.includes('degenerate')).length, 2, 'overall and the one class, the system effect only');
  assert.match(r.stdout, /judge\s+-0\.500/);
  const naive = run('gate', '--baseline', t.a, '--candidate', t.c, '--bar', t.bar, '--allow-differ', 'systemModelServed');
  assert.equal(naive.status, 2);
  assert.match(naive.stderr, /--rejudge-of/);
});

// The fixture of test/regression.test.ts (hand-worked there): class k is compensable (c1, c2), class s is
// non-compensable (s1, s2, s3), one draw per case. In s one case fails in each run and every case changes.
const mixedCases = [
  { id: 'c1', klass: 'k', input: 'a', expect: 'hi' },
  { id: 'c2', klass: 'k', input: 'b', expect: 'hi' },
  { id: 's1', klass: 's', input: 'c', expect: 'hi' },
  { id: 's2', klass: 's', input: 'd', expect: 'hi' },
  { id: 's3', klass: 's', input: 'e', expect: 'hi' },
];
const mixedBar = { labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0 }, s: { direction: 'floor', nonCompensable: true, minPassRate: 0 } }, knownFailures: [] };
const mixedRun = (name: string, labels: string, outputs: string, over: Record<string, unknown> = {}): string => {
  const path = join(dir, `mixed-${name}.json`);
  const identity = { ...makeJudgedIdentity({ caseSetHash: caseSetHash(mixedCases), barHash: barHash(parseBarFile(mixedBar)), drawsPerCase: 1 }), ...over };
  const draws = mixedCases.map((c, i) => slot(c.id, 0, gradedAttempt(labels.split(' ')[i] as string, { judgeStop: 'tool-use', outputHash: sha256Hex(`${outputs} ${c.id}`) })));
  writeFileSync(path, JSON.stringify({ schema: RUN_SCHEMA, identity, callShapes: { system: makeCallShape(), judge: makeJudgeCallShape() }, cases: mixedCases, draws, packetBasis: 'recorded' }));
  return path;
};

test('gate --rejudge-of: every row prints n; a non-compensable class prints counts and case ids, never a rate or a bracket, in text, --json and the ledger', () => {
  const bar = join(dir, 'mixed-bar.json');
  writeFileSync(bar, JSON.stringify(mixedBar));
  const a = mixedRun('a', 'hi hi hi hi lo', 'baseline');
  const b = mixedRun('b', 'lo hi lo hi hi', 'baseline', newJudge);
  const c = mixedRun('c', 'lo hi hi lo hi', 'candidate', { ...newJudge, systemModelServed: 'model-x-2026-06-01' });
  const args = ['gate', '--baseline', b, '--candidate', c, '--bar', bar, '--rejudge-of', a, '--allow-differ', 'systemModelServed'];
  const r = run(...args);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const lines = r.stdout.split('\n');
  const at = lines.findIndex((l) => l.startsWith('judge-controlled, against the baseline as first judged ('));
  assert.ok(at >= 0, r.stdout);
  const block = lines.slice(at + 1, lines.indexOf('', at));
  assert.match(block[0] as string, /^ {2}overall {7}n 5 {5}reported {2}-0\.200 \[-?\d\.\d{3}, -?\d\.\d{3}\] {3}judge {2}-0\.200 \[-?\d\.\d{3}, -?\d\.\d{3}\] {3}system {2}0\.000 \[/);
  assert.match(block[1] as string, /^ {2}k {13}n 2 {5}reported {2}-0\.500 \[/);
  assert.deepEqual(block.slice(2), [
    '  the overall row includes the 3 cases of the non-compensable class s; such a class gets counts and case ids, never a rate or a bracket:',
    '  s             n 3     failing: original baseline 1 (s3) · re-judged baseline 1 (s1) · candidate 1 (s2)',
    '    original baseline -> re-judged baseline: newly failing 1 (s1) · newly passing 1 (s3)',
    '    re-judged baseline -> candidate: newly failing 1 (s2) · newly passing 1 (s1)',
  ]);
  // On the class's own lines: no decimal number, no bracket, no percent sign.
  for (const l of block.slice(3)) assert.doesNotMatch(l, /\d\.\d|\[|\]|%/, l);
  // --json: the class is out of perClass and in the list, which holds no number but n.
  const out = JSON.parse(run(...args, '--json').stdout) as { judgeControl: { overall: { itemCount: number }; perClass: Record<string, { itemCount: number }>; nonCompensable: unknown[] } };
  assert.deepEqual(Object.keys(out.judgeControl.perClass), ['k']);
  assert.equal(out.judgeControl.overall.itemCount, 5);
  const listing = [
    {
      klass: 's',
      n: 3,
      failing: { originalBaseline: ['s3'], rejudgedBaseline: ['s1'], candidate: ['s2'] },
      transitions: [
        { from: 'originalBaseline', to: 'rejudgedBaseline', newlyFailing: ['s1'], newlyPassing: ['s3'] },
        { from: 'rejudgedBaseline', to: 'candidate', newlyFailing: ['s2'], newlyPassing: ['s1'] },
      ],
    },
  ];
  assert.deepEqual(out.judgeControl.nonCompensable, listing);
  // The ledger record's summary says the same, and its per-class numbers leave the class out.
  const ledger = join(dir, 'mixed', 'ledger.jsonl');
  assert.equal(run(...args, '--ledger', ledger).status, 1);
  const jc = readLedger(ledger)[0]?.result['judgeControl'] as { itemCount: number; perClass: Record<string, { itemCount: number }>; nonCompensable: unknown[] };
  assert.deepEqual([jc.itemCount, Object.keys(jc.perClass), jc.perClass['k']?.itemCount], [5, ['k'], 2]);
  assert.deepEqual(jc.nonCompensable, listing);
});

test('gate --rejudge-of: a bar class with no case is listed on the line "no case complete in all three runs", and the gate fails it', () => {
  const emptyBar = { ...trioBar, classes: { ...trioBar.classes, z: { direction: 'floor', minPassRate: 0.5 } } };
  const bar = join(dir, 'empty-class-bar.json');
  writeFileSync(bar, JSON.stringify(emptyBar));
  const id = (over: Record<string, unknown> = {}) => trioIdentity({ barHash: barHash(parseBarFile(emptyBar)), ...over });
  const a = trioRun('ea', 'hi', 'hi', id());
  const b = trioRun('eb', 'hi', 'hi', id(newJudge));
  const c = trioRun('ec', 'hi', 'hi', id({ ...newJudge, systemModelServed: 'model-x-2026-06-01' }), 'candidate');
  const r = run('gate', '--baseline', b, '--candidate', c, '--bar', bar, '--rejudge-of', a, '--allow-differ', 'systemModelServed');
  // The empty class fails the gate on its own (exit 1); the split of the other class is still printed, and the line names z.
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /^ {2}no case complete in all three runs: z$/m);
  assert.match(r.stdout, /^z .*0\/0 .*NA.*FAIL/m);
});

test('gate: a refusal (exit 2) comes before the check of a label outside the bar (exit 65)', () => {
  const t = trio();
  const badLabel = trioRun('badlabel', 'bogus', 'hi', trioIdentity({ systemModelServed: 'model-x-2026-06-01' }), 'candidate');
  // Same candidate, same label, but the identity matches: the label is then what is refused.
  const sameIdentity = trioRun('badlabel-same', 'bogus', 'hi', trioIdentity(), 'candidate');
  const refused = run('gate', '--baseline', t.a, '--candidate', badLabel, '--bar', t.bar);
  assert.equal(refused.status, 2, refused.stderr + refused.stdout);
  assert.match(refused.stderr, /IDENTITY_MISMATCH/);
  assert.equal(run('gate', '--baseline', t.a, '--candidate', sameIdentity, '--bar', t.bar).status, 65);
});

test('gate --rejudge-of: a real system break still exits 1', () => {
  const t = trio();
  const c = trioRun('c-broken', 'lo', 'lo', trioIdentity({ ...newJudge, systemModelServed: 'model-x-2026-06-01' }), 'candidate');
  const r = run('gate', '--baseline', t.b, '--candidate', c, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /BROKE \(1\)\n {2}k\/c2/);
  // One draw per case in this fixture, and it fails: 1 of 1.
  assert.ok(r.stdout.split('\n').some((l) => /^ {2}k\/c2 {2}attributed draw #0: .*; 1 of 1 draws fail$/.test(l)), r.stdout);
});

test('gate --rejudge-of refuses (exit 2) when the re-judged baseline graded different outputs', () => {
  const t = trio();
  const b = trioRun('b-other', 'lo', 'hi', trioIdentity(newJudge), 'other outputs');
  const r = run('gate', '--baseline', b, '--candidate', t.c, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED HASH_MISMATCH/);
  assert.match(r.stderr, /outputHash\[c1#0\]/);
});

test('gate --rejudge-of: allowing a judge field is a usage error (64); --bootstrap-seed needs --rejudge-of', () => {
  const t = trio();
  const r = run('gate', '--baseline', t.b, '--candidate', t.c, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed,judgeModelServed');
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /judgeModelServed/);
  const s = run('gate', '--baseline', t.b, '--candidate', t.c, '--bar', t.bar, '--bootstrap-seed', '5', '--allow-differ', 'systemModelServed');
  assert.equal(s.status, 64, s.stderr);
  const bad = run('gate', '--baseline', t.b, '--candidate', t.c, '--bar', t.bar, '--rejudge-of', t.a, '--bootstrap-seed', 'x', '--allow-differ', 'systemModelServed');
  assert.equal(bad.status, 64, bad.stderr);
});

test('gate with no --rejudge-of: a judge field in --allow-differ is a usage error (64) that names the field and --rejudge-of; the rule is gateRuns\', not the CLI\'s', () => {
  const t = trio();
  for (const field of ['judgeModelServed', 'judgeDefinitionHash', 'judgeCallShapeHash', 'judgeHarnessVersion', 'judgeModelRequested']) {
    const r = run('gate', '--baseline', t.a, '--candidate', t.c, '--bar', t.bar, '--allow-differ', `systemModelServed,${field}`);
    assert.equal(r.status, 64, `${field}: ${r.stderr}`);
    assert.equal(r.stdout, '', field);
    assert.match(r.stderr, new RegExp(field), field);
    assert.match(r.stderr, /--rejudge-of/, field);
  }
  // The rubric is judge movement too, so it is refused beside a judge.
  const rubric = run('gate', '--baseline', t.a, '--candidate', t.c, '--bar', t.bar, '--allow-differ', 'systemModelServed,rubricHash');
  assert.equal(rubric.status, 64, rubric.stderr);
  assert.match(rubric.stderr, /rubricHash/);
  // The CLI holds no judge-field check of its own: the rule is in gateRuns, and the CLI turns its refusal of the arguments into a usage error.
  assert.doesNotMatch(readFileSync(join(root, 'src', 'cli.ts'), 'utf8'), /JUDGE_FIELDS/);
  // And a refusal of the arguments leaves no record.
  const ledger = join(dir, 'judge-field.jsonl');
  assert.equal(run('gate', '--baseline', t.a, '--candidate', t.c, '--bar', t.bar, '--allow-differ', 'judgeModelServed', '--ledger', ledger).status, 64);
  assert.throws(() => readFileSync(ledger), /ENOENT/);
});

test('gate: drawsPerCase in --allow-differ is a usage error (64) that names the field and says why; nothing on stdout, no ledger record', () => {
  // The refund-bot baseline against itself cut to its first draw: without the rule, r07 would read FIXED and the gate would exit 0.
  const file = JSON.parse(readFileSync(ex('baseline.json'), 'utf8')) as { identity: Record<string, unknown>; draws: { drawIndex: number }[] };
  file.identity['drawsPerCase'] = 1;
  file.draws = file.draws.filter((d) => d.drawIndex === 0);
  const cut = join(dir, 'baseline-one-draw.json');
  writeFileSync(cut, JSON.stringify(file));
  const ledger = join(dir, 'draw-count.jsonl');
  for (const extra of [[], ['--json'], ['--ledger', ledger]]) {
    const r = run('gate', '--baseline', ex('baseline.json'), '--candidate', cut, '--bar', ex('bar.json'), '--allow-differ', 'drawsPerCase', ...extra);
    assert.equal(r.status, 64, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /drawsPerCase cannot be allowed to differ on a gate: the draw count changes the fold on its own; re-run the baseline at the new count/);
  }
  assert.throws(() => readFileSync(ledger), /ENOENT/);
  // Without the waiver the two counts are a refusal of the comparison (exit 2), naming the field.
  const plain = run('gate', '--baseline', ex('baseline.json'), '--candidate', cut, '--bar', ex('bar.json'));
  assert.equal(plain.status, 2, plain.stderr);
  assert.match(plain.stderr, /REFUSED IDENTITY_MISMATCH\n {2}fields: drawsPerCase/);
});

test('gate --rejudge-of: differing packets refuse the split only; verdict, diff and exit code are printed as before', () => {
  const t = trio();
  const b = join(dir, 'b-other-packet.json');
  const doc = JSON.parse(readFileSync(t.b, 'utf8')) as { draws: { attempts: { packetHash: string }[] }[] };
  (doc.draws[0]?.attempts[0] as { packetHash: string }).packetHash = sha256Hex('another view');
  writeFileSync(b, JSON.stringify(doc));
  const args = ['--candidate', t.c, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed'];
  const ok = run('gate', '--baseline', t.b, ...args);
  const r = run('gate', '--baseline', b, ...args);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.status, ok.status);
  assert.match(r.stdout, /judge-controlled: not computed \(PACKET_MISMATCH: packetHash\[c1#0\]\); this does not change the exit code\n {2}the two judges .*re-judge the baseline's stored outputs/);
  assert.doesNotMatch(r.stdout, /judge\s+-0\.500/);
  // Everything outside the judge-controlled block is the same text.
  const outside = (s: string): string => s.replace(/judge-controlled[\s\S]*?\n\n/, '');
  assert.equal(outside(r.stdout), outside(ok.stdout));
  assert.match(r.stdout, /verdict: OK \(exit 0\)/);
  const json = run('gate', '--baseline', b, ...args, '--json');
  assert.equal(json.status, 0);
  const out = JSON.parse(json.stdout) as { judgeControl: { refused: { code: string; fields: string[] } } };
  assert.equal(out.judgeControl.refused.code, 'PACKET_MISMATCH');
  assert.deepEqual(out.judgeControl.refused.fields, ['packetHash[c1#0]']);
});

test('gate --rejudge-of --json and --ledger carry the decomposition and its seed', () => {
  const t = trio();
  const ledger = join(dir, 'rejudge', 'ledger.jsonl');
  const r = run('gate', '--baseline', t.b, '--candidate', t.c, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed', '--bootstrap-seed', '5', '--json', '--ledger', ledger);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { judgeControl: { overall: { judgeEffect: { estimate: number; seed: number } } } };
  assert.equal(out.judgeControl.overall.judgeEffect.estimate, -0.5);
  assert.equal(out.judgeControl.overall.judgeEffect.seed, 5);
  const rec = readLedger(ledger)[0];
  const jc = rec?.result['judgeControl'] as { seed: number; judgeEffect: number; systemEffect: number; reportedDelta: number };
  assert.deepEqual([jc.seed, jc.judgeEffect, jc.systemEffect, jc.reportedDelta], [5, -0.5, 0, -0.5]);
  // The record names the re-judged baseline and the seed the split was drawn under.
  const inputs = gateRecordOf(ledger).inputs;
  assert.equal(inputs.rejudgeOf?.judgeModelServed, 'judge-2026-01-01');
  assert.equal(inputs.bootstrap?.seed, 5);
  assert.deepEqual(inputs.allowDiffer, ['systemModelServed']);
});

test('gate --rejudge-of --json and --ledger record a refused split and its per-class numbers', () => {
  const t = trio();
  const partial = join(dir, 'c-partial.json');
  const c = JSON.parse(readFileSync(t.c, 'utf8')) as { draws: unknown[] };
  c.draws = c.draws.slice(0, 1);
  writeFileSync(partial, JSON.stringify(c));
  const ledger = join(dir, 'rejudge-refused', 'ledger.jsonl');
  const r = run('gate', '--baseline', t.b, '--candidate', partial, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed', '--json', '--ledger', ledger);
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout) as { judgeControl: { refused: { code: string; fields: string[] } } };
  assert.equal(out.judgeControl.refused.code, 'ITEM_SET_MISMATCH');
  assert.deepEqual(out.judgeControl.refused.fields, ['c2']);
  assert.deepEqual(readLedger(ledger)[0]?.result['judgeControl'], { refused: 'ITEM_SET_MISMATCH', fields: ['c2'] });
  const okLedger = join(dir, 'rejudge-ok', 'ledger.jsonl');
  assert.equal(run('gate', '--baseline', t.b, '--candidate', t.c, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed', '--ledger', okLedger).status, 0);
  const jc = readLedger(okLedger)[0]?.result['judgeControl'] as { perClass: Record<string, { judgeEffect: number }> };
  assert.equal(jc.perClass['k']?.judgeEffect, -0.5);
});

const dropDraw = (file: string, caseId: string, drawIndex: number): string => {
  const a = JSON.parse(readFileSync(ex(file), 'utf8')) as { draws: { caseId: string; drawIndex: number }[] };
  a.draws = a.draws.filter((d) => !(d.caseId === caseId && d.drawIndex === drawIndex));
  const out = join(dir, `short-${file}`);
  writeFileSync(out, JSON.stringify(a));
  return out;
};

test('gate: a class with a missing candidate case prints its rate as UNKNOWN and fails as incomplete', () => {
  const ledger = join(dir, 'short', 'ledger.jsonl');
  const r = run('gate', '--baseline', ex('baseline.json'), '--candidate', dropDraw('candidate.json', 'r01', 2), '--bar', ex('bar.json'), '--allow-differ', 'systemModelServed,systemCallShapeHash', '--ledger', ledger);
  assert.equal(r.status, 1, r.stderr);
  // The ledger says why the class failed, so its rate cannot be recomputed as 9/9 from the record.
  const routine = (readLedger(ledger)[0]?.result['classes'] as { klass: string; missing: string[] }[]).find((c) => c.klass === 'routine');
  assert.deepEqual(routine?.missing, ['r01']);
  // Nine of the ten cases folded, the rate withheld, and none of the nine is new.
  assert.match(r.stdout, /^routine {9}ceiling {9}9\/10 0\.900 {4}9\/9 UNKNOWN, 0 new {4}0\.900 {3}FAIL \(incomplete\)$/m);
  assert.match(r.stdout, /incomplete candidate case r01: 2 of 3 draws/);
});

test('gate: an incomplete baseline is refused with exit 2 and names the short case', () => {
  const r = run('gate', '--baseline', dropDraw('baseline.json', 'r01', 2), '--candidate', ex('candidate.json'), '--bar', ex('bar.json'), '--allow-differ', 'systemModelServed,systemCallShapeHash');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED INCOMPLETE_RUN/);
  assert.match(r.stderr, /fields: r01/);
});

test('gate: a self-inconsistent artifact exits 65 and names the file it came from', () => {
  const a = JSON.parse(readFileSync(ex('baseline.json'), 'utf8')) as { identity: Record<string, unknown> };
  a.identity['systemCallShapeHash'] = hashOf('not the stored shape');
  const bad = join(dir, 'lying-baseline.json');
  writeFileSync(bad, JSON.stringify(a));
  const r = run('gate', '--baseline', bad, '--candidate', ex('candidate.json'), '--bar', ex('bar.json'), '--allow-differ', 'systemModelServed,systemCallShapeHash');
  assert.equal(r.status, 65);
  assert.match(r.stderr, /--baseline .*lying-baseline\.json: artifact\.identity\.systemCallShapeHash/);
});

test('gate: an incomplete line names what happened to each slot', () => {
  const a = JSON.parse(readFileSync(ex('candidate.json'), 'utf8')) as { draws: { caseId: string; drawIndex: number; attempts: unknown[] }[] };
  const d = a.draws.find((x) => x.caseId === 'r01' && x.drawIndex === 2);
  if (d !== undefined) d.attempts = [{ kind: 'unmeasured', role: 'system', reason: 'timeout', detail: '30s' }];
  const path = join(dir, 'timeout-candidate.json');
  writeFileSync(path, JSON.stringify(a));
  const r = run('gate', '--baseline', ex('baseline.json'), '--candidate', path, '--bar', ex('bar.json'), '--allow-differ', 'systemModelServed,systemCallShapeHash');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /incomplete candidate case r01: 2 of 3 draws measured \(#2 system timeout\)/);
});

test('gate: a judge call the provider rejected (4xx) is refused with exit 2', () => {
  const t = trio();
  const c = JSON.parse(readFileSync(t.c, 'utf8')) as { draws: { caseId: string; attempts: Record<string, unknown>[] }[] };
  const d = c.draws.find((x) => x.caseId === 'c2');
  const graded = d?.attempts[0];
  if (d !== undefined && graded !== undefined) {
    d.attempts = [{ kind: 'unmeasured', role: 'judge', reason: 'client-error', detail: '400', outputHash: graded['outputHash'], systemStop: graded['systemStop'], packetHash: graded['packetHash'] }, graded];
  }
  const path = join(dir, 'judge-400.json');
  writeFileSync(path, JSON.stringify(c));
  const r = run('gate', '--baseline', t.b, '--candidate', path, '--bar', t.bar, '--rejudge-of', t.a, '--allow-differ', 'systemModelServed');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /REFUSED MEASUREMENT_NOT_RUNNABLE/);
});

test('gate --ledger checks the ledger file before running the gate, so a bad ledger never costs a verdict', () => {
  const ledger = join(dir, 'garbled-ledger.jsonl');
  writeFileSync(ledger, '{"not": "a ledger');
  const r = run(...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash', '--ledger', ledger);
  assert.equal(r.status, 65);
  assert.match(r.stderr, /garbled-ledger\.jsonl/);
  assert.doesNotMatch(r.stdout, /verdict:/);
  assert.equal(readFileSync(ledger, 'utf8'), '{"not": "a ledger');
});

test('gate --ledger: a path that cannot hold a ledger is invalid input (65) before the gate, never exit 1', () => {
  const asDir = join(dir, 'a-directory');
  mkdirSync(asDir, { recursive: true });
  const r1 = run(...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash', '--ledger', asDir);
  assert.equal(r1.status, 65, r1.stderr);
  assert.match(r1.stderr, /a-directory/);
  const aFile = join(dir, 'plain-file.txt');
  writeFileSync(aFile, 'x');
  const r2 = run(...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash', '--ledger', join(aFile, 'ledger.jsonl'));
  assert.equal(r2.status, 65, r2.stderr);
  assert.doesNotMatch(r2.stdout, /verdict:/);
});

test('gate --ledger: a ledger with no final newline, or a device that keeps nothing, is refused (65) before the gate', () => {
  const args = [...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash'];
  // A first, good run leaves one record. Cut its newline off: the next record would be written onto its line.
  const ledger = join(dir, 'unterminated-ledger.jsonl');
  assert.equal(run(...args, '--ledger', ledger).status, 1);
  const whole = readFileSync(ledger, 'utf8');
  assert.ok(whole.endsWith('\n') && whole.split('\n').length === 2);
  writeFileSync(ledger, whole.slice(0, -1));
  const r = run(...args, '--ledger', ledger);
  assert.equal(r.status, 65, r.stderr);
  assert.match(r.stderr, /INVALID_LEDGER/);
  assert.match(r.stderr, /unterminated-ledger\.jsonl: line 1: the file does not end with a newline/);
  assert.doesNotMatch(r.stdout, /verdict:/);
  // The record that was there is untouched, and reads back once its newline is restored.
  assert.equal(readFileSync(ledger, 'utf8'), whole.slice(0, -1));
  writeFileSync(ledger, whole);
  assert.equal(readLedger(ledger).length, 1);
  if (process.platform !== 'win32') {
    const n = run(...args, '--ledger', '/dev/null');
    assert.equal(n.status, 65, n.stderr);
    assert.match(n.stderr, /\/dev\/null: is not a regular file/);
    assert.doesNotMatch(n.stdout, /verdict:/);
  }
});

test('gate --ledger records, for each incomplete candidate case, what happened and whether a measured draw already fails', () => {
  const a = JSON.parse(readFileSync(ex('candidate.json'), 'utf8')) as { draws: { caseId: string; drawIndex: number; attempts: Record<string, unknown>[] }[] };
  for (const d of a.draws.filter((x) => x.caseId === 'r01')) {
    if (d.drawIndex === 2) d.attempts = [{ kind: 'unmeasured', role: 'system', reason: 'timeout', detail: '30s' }];
    if (d.drawIndex === 0) d.attempts = [{ ...d.attempts[0], label: 'review' }];
  }
  const path = join(dir, 'fail-and-timeout.json');
  writeFileSync(path, JSON.stringify(a));
  const ledger = join(dir, 'incomplete-ledger', 'l.jsonl');
  const r = run('gate', '--baseline', ex('baseline.json'), '--candidate', path, '--bar', ex('bar.json'), '--allow-differ', 'systemModelServed,systemCallShapeHash', '--ledger', ledger);
  assert.equal(r.status, 1, r.stderr);
  const inc = readLedger(ledger)[0]?.result['incomplete'] as { caseId: string; measuredFailure: boolean; unmeasured: { reason: string }[] }[];
  assert.equal(inc[0]?.caseId, 'r01');
  assert.equal(inc[0]?.measuredFailure, true);
  assert.equal(inc[0]?.unmeasured[0]?.reason, 'timeout');
});

test('agree is untouched by reference v2: differing packets refuse, whatever a file states about them', () => {
  const h = sha256Hex;
  const ratings = { 'rater-a': { t1: 'none', t2: 'review' }, 'rater-b': { t1: 'none', t2: 'none' } };
  const categories = ['none', 'review'];
  const schema = 'anchorset.ratings/v1';
  const same = { 'rater-a': { t1: h('t1'), t2: h('t2') }, 'rater-b': { t1: h('t1'), t2: h('t2') } };
  const differing = { ...same, 'rater-b': { t1: h('t1'), t2: h('t2, beside four other items') } };
  // A statement of the kind a reference file may carry never admits here: agree reads no such field, and a key it does
  // not read is invalid input (exit 65), named. Without the statement the differing packets refuse (exit 2).
  const statement = { packets: 'different', quote: 'Rater b was shown each item beside four others.', source: 'the rating protocol' };
  const at = (name: string, body: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };
  for (const [name, body] of [['plain', { schema, categories, ratings, packetHashes: differing }], ['stated', { schema, categories, ratings, packetHashes: differing, packetDifference: statement }], ['unknown', { schema, categories, ratings, packetHashes: { ...same, 'rater-b': { t1: h('t1'), t2: 'UNKNOWN' } }, packetDifference: { ...statement, packets: 'UNKNOWN' } }]] as const) {
    const r = run('agree', '--ratings', at(`agree-${name}.json`, body));
    assert.equal(r.stdout, '', name);
    if (name === 'plain') {
      assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /REFUSED PACKET_MISMATCH\n {2}fields: t2/, name);
    } else {
      assert.equal(r.status, 65, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^ {2}- ratings\.packetDifference: unknown field$/m, name);
    }
  }
  const ok = run('agree', '--ratings', at('agree-same.json', { schema, categories, ratings, packetHashes: same }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^raters .* · items \d+ · packet hashes equal for every item, as the file states$/m);
});

// --- A key given twice in a file that is read: invalid input, the key and its place named ------------

let twiceCount = 0;
/**
 * A copy of a JSON file in which one object gives a key twice: `insert` goes in right after the first
 * match of `after`. The value put in comes first and the file's own value last, so `JSON.parse` reads
 * the copy as the original, and a command that does not look for the repeat runs as on the original.
 */
function givenTwice(path: string, after: RegExp, insert: string): string {
  const text = readFileSync(path, 'utf8');
  const changed = text.replace(after, (m) => `${m}${insert}`);
  assert.notEqual(changed, text);
  assert.deepEqual(JSON.parse(changed), JSON.parse(text));
  const out = join(dir, `twice-${twiceCount++}.json`);
  writeFileSync(out, changed);
  return out;
}
/** Invalid input (65) that names the file, the key and the place; nothing printed, no stack trace. */
function assertTwice(r: { status: number | null; stdout: string; stderr: string }, named: RegExp): void {
  assert.equal(r.status, 65, r.stdout + r.stderr);
  assert.match(r.stderr, /^anchorset: invalid input \(INVALID_ARGUMENT\)\n/);
  assert.match(r.stderr, named);
  assert.doesNotMatch(r.stderr, /\n\s+at .*\(|node:internal/);
  assert.equal(r.stdout, '');
}

test('gate: a baseline, candidate, re-judged or bar file that gives a key twice is invalid input (65), with the key and its place named', () => {
  const allow = ['--allow-differ', 'systemModelServed,systemCallShapeHash'];
  // Top level: a second "schema".
  const baseline = givenTwice(ex('baseline.json'), /^\{/, '"schema": "anchorset.run/v2",');
  assertTwice(run('gate', '--baseline', baseline, '--candidate', ex('candidate.json'), '--bar', ex('bar.json'), ...allow), /--baseline \S+: \S+twice-\d+\.json: the key "schema" is given twice in the top-level object\n/);
  // A nested object: an identity value given as unknown and then as known.
  const candidate = givenTwice(ex('candidate.json'), /"identity": \{/, '"caseSetHash": "UNKNOWN",');
  const ledger = join(dir, 'twice', 'ledger.jsonl');
  assertTwice(run('gate', '--baseline', ex('baseline.json'), '--candidate', candidate, '--bar', ex('bar.json'), ...allow, '--json', '--ledger', ledger), /--candidate \S+: \S+twice-\d+\.json: the key "caseSetHash" is given twice in the object at \/identity\n/);
  assert.throws(() => readFileSync(ledger), /ENOENT/);
  // An object inside a list: the first draw names two cases.
  const rejudged = givenTwice(ex('baseline.json'), /"draws": \[\s*\{/, '"caseId": "r01",');
  assertTwice(run('gate', '--baseline', ex('baseline.json'), '--candidate', ex('candidate.json'), '--rejudge-of', rejudged, '--bar', ex('bar.json')), /--rejudge-of \S+: \S+twice-\d+\.json: the key "caseId" is given twice in the object at \/draws\/0\n/);
  // The bar: a class with two bars, the lower one first.
  const bar = givenTwice(ex('bar.json'), /"classes": \{/, '"must_handoff": {"direction": "floor", "minPassRate": 0},');
  assertTwice(run('gate', '--baseline', ex('baseline.json'), '--candidate', ex('candidate.json'), '--bar', bar, ...allow), /twice-\d+\.json: the key "must_handoff" is given twice in the object at \/classes\n/);
  // A key spelled with an escape is the same key.
  const escaped = givenTwice(ex('baseline.json'), /^\{/, '"\\u0073chema": "anchorset.run/v2",');
  assertTwice(run('gate', '--baseline', escaped, '--candidate', ex('candidate.json'), '--bar', ex('bar.json'), ...allow), /the key "schema" is given twice in the top-level object\n/);
});

test('gate: a text that is not JSON keeps the message of the parser, also when a key is repeated in it', () => {
  const text = '{"schema": "anchorset.run/v3", "schema": ';
  const cut = join(dir, 'cut.json');
  writeFileSync(cut, text);
  const r = run('gate', '--baseline', cut, '--candidate', ex('candidate.json'), '--bar', ex('bar.json'));
  assert.equal(r.status, 65);
  let message = '';
  try {
    JSON.parse(text);
  } catch (e) {
    message = (e as Error).message;
  }
  assert.notEqual(message, '');
  assert.equal(r.stderr, `anchorset: invalid input (INVALID_ARGUMENT)\n  - --baseline ${cut}: ${cut}: invalid JSON: ${message}\n`);
});

test('agree, drift and flips: a ratings, anchor or run file that gives a key twice is invalid input (65)', () => {
  const ratings = givenTwice(ex('ratings.json'), /"ratings": \{/, '"rater-a": {},');
  assertTwice(run('agree', '--ratings', ratings), /twice-\d+\.json: the key "rater-a" is given twice in the object at \/ratings\n/);
  const agreeLedger = join(dir, 'twice-agree', 'ledger.jsonl');
  assertTwice(run('agree', '--ratings', ratings, '--json', '--ledger', agreeLedger), /the key "rater-a" is given twice in the object at \/ratings\n/);
  assert.throws(() => readFileSync(agreeLedger), /ENOENT/);

  const oldAnchor = givenTwice(ex('anchor_old.json'), /"verdicts": \{/, '"a01": "handoff",');
  const newAnchor = givenTwice(ex('anchor_new.json'), /^\{/, '"labels": ["none"],');
  assertTwice(run('drift', '--old', oldAnchor, '--new', ex('anchor_new.json'), '--flag', 'review,handoff'), /twice-\d+\.json: the key "a01" is given twice in the object at \/verdicts\n/);
  assertTwice(run('drift', '--old', ex('anchor_old.json'), '--new', newAnchor, '--flag', 'review,handoff', '--json'), /twice-\d+\.json: the key "labels" is given twice in the top-level object\n/);

  const judged = givenTwice(ex('judged.json'), /"draws": \[\s*\{/, '"drawIndex": 7,');
  assertTwice(run('flips', '--run', judged), /twice-\d+\.json: the key "drawIndex" is given twice in the object at \/draws\/0\n/);
  assertTwice(run('flips', '--run', judged, '--json'), /the key "drawIndex" is given twice in the object at \/draws\/0\n/);
});

test('a ledger whose record gives a key twice cannot take another record: invalid input (65) before anything is computed, as for any unreadable line', () => {
  const good = join(dir, 'twice-ledger', 'good.jsonl');
  assert.equal(run(...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash', '--ledger', good).status, 1);
  const line = readFileSync(good, 'utf8');
  // The record's own kind comes last, so JSON.parse reads the record that was written.
  const twice = line.replace(/^\{/, '{"kind":"drift",');
  assert.deepEqual(JSON.parse(twice), JSON.parse(line));
  const ledger = join(dir, 'twice-ledger', 'twice.jsonl');
  for (const args of [[...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash'], ['agree', '--ratings', ex('ratings.json')], driftArgs]) {
    writeFileSync(ledger, twice);
    const r = run(...args, '--ledger', ledger);
    assert.equal(r.status, 65, r.stdout + r.stderr);
    assert.equal(r.stderr, `anchorset: invalid input (INVALID_LEDGER)\n  - ${ledger}: line 1: the key "kind" is given twice in the top-level object\n`);
    assert.equal(r.stdout, '');
    assert.equal(readFileSync(ledger, 'utf8'), twice);
  }
});

test('drift: label lists are compared element by element: another order, another length or a label that holds the old separator is LABELS_MISMATCH, and the message says labels or label order', () => {
  const read = (f: string) => JSON.parse(readFileSync(ex(f), 'utf8')) as { labels: string[]; verdicts: Record<string, string> };
  const write = (name: string, labels: string[]): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ ...read('anchor_new.json'), labels }));
    return path;
  };
  const labels = read('anchor_old.json').labels;
  const against = (name: string, newLabels: string[], flag = 'review'): { status: number | null; stderr: string } => run('drift', '--old', ex('anchor_old.json'), '--new', write(name, newLabels), '--flag', flag);
  for (const [name, other] of [['reordered.json', [...labels].reverse()], ['shorter.json', labels.slice(0, 2)], ['longer.json', [...labels, 'extra']]] as [string, string[]][]) {
    const r = against(name, other);
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED LABELS_MISMATCH\n {2}fields: labels\n {2}old and new files declare different labels or a different label order/, name);
  }
  // Two lists that a "\u0000" join would make one text are two lists.
  const old = join(dir, 'split-old.json');
  const split = join(dir, 'split-new.json');
  writeFileSync(old, JSON.stringify({ ...read('anchor_old.json'), labels: ['a', 'b'] }));
  writeFileSync(split, JSON.stringify({ ...read('anchor_new.json'), labels: ['a\u0000b'] }));
  const r = run('drift', '--old', old, '--new', split, '--flag', 'a');
  assert.match(r.stderr, /LABELS_MISMATCH/, r.stderr);
  assert.equal(r.status, 2);
});

test('gate: a listed known failure that now passes is printed beside its class row, as one that still fails is; the demo, which lists none, prints neither', () => {
  const bar = { labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [{ caseId: 'k09', since: '2026-01-10', note: 'tracked' }] };
  const write = (name: string, failing: string[]): string => {
    const cases = Array.from({ length: 10 }, (_, i) => ({ id: `k${String(i + 1).padStart(2, '0')}`, klass: 'k', input: `input ${i}`, expect: 'hi' }));
    const identity = makeJudgedIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(parseBarFile(bar)), drawsPerCase: 1 });
    const draws = cases.map((c) => slot(c.id, 0, gradedAttempt(failing.includes(c.id) ? 'lo' : 'hi', { judgeStop: 'tool-use', outputHash: sha256Hex(`output ${c.id}`) })));
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ schema: RUN_SCHEMA, identity, callShapes: { system: makeCallShape(), judge: makeJudgeCallShape() }, cases, draws, packetBasis: 'recorded' }));
    return path;
  };
  const barPath = join(dir, 'known-failure-bar.json');
  writeFileSync(barPath, JSON.stringify(bar));
  const failing = write('known-failing', ['k09']);
  const passing = write('known-passing', []);
  const still = run('gate', '--baseline', failing, '--candidate', failing, '--bar', barPath);
  assert.equal(still.status, 0, still.stderr);
  assert.ok(still.stdout.split('\n').includes('  known failures (still counted): k09'), still.stdout);
  assert.doesNotMatch(still.stdout, /now passing/);
  const now = run('gate', '--baseline', failing, '--candidate', passing, '--bar', barPath);
  assert.equal(now.status, 0, now.stderr);
  const lines = now.stdout.split('\n');
  const row = lines.findIndex((l) => l.startsWith('k '));
  assert.equal(lines[row + 1], '  known failures (now passing): k09');
  assert.doesNotMatch(now.stdout, /still counted/);
  // The same fact is in --json as before, and the demo prints neither line.
  assert.deepEqual((JSON.parse(run('gate', '--baseline', failing, '--candidate', passing, '--bar', barPath, '--json').stdout) as { gate: { classes: { knownFailuresNowPassing: string[] }[] } }).gate.classes.map((c) => c.knownFailuresNowPassing), [['k09']]);
  assert.doesNotMatch(run(...gateArgs, '--allow-differ', 'systemModelServed,systemCallShapeHash').stdout, /known failures/);
});
