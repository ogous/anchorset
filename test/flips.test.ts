// The run-level entry of the stability measurement (src/flips.ts): the one public `repeatFlips`. The draws-level
// arithmetic is pinned in test/stability.test.ts; here is what the entry refuses before it reads a draw.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseRunArtifact } from '../src/artifact.ts';
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
