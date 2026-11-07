// No importer output holds the no-seed marker. `NO_SEED` says that a harness made no random choice; an importer reads
// a result file afterwards and knows nothing about the harness that produced the stored outputs, so the seed of an
// imported run is the gap, `UNKNOWN`, and the marker appears nowhere in the bytes an importer writes. Each importer is
// run as its command, over every committed fixture of its folder, under every reading rule it accepts; the fixtures
// that import are pinned by name, so a fixture that stops importing cannot leave this test checking nothing.
// Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GAP, NO_SEED, parseRunArtifact } from '../src/index.ts';
import { READINGS } from '../examples/importers/shared.ts';
import { scratchEnv } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const importers = join(root, 'examples', 'importers');
const work = mkdtempSync(join(tmpdir(), 'anchorset-no-seed-'));
after(() => rmSync(work, { recursive: true, force: true }));

type Imported = { fixture: string; bytes: string };

/** Runs one importer command over every fixture of `tool`, under each flag set in turn; returns the runs that were written. */
function importAll(tool: string, flagSets: readonly (readonly string[])[]): Imported[] {
  const dir = join(importers, tool);
  const written: Imported[] = [];
  for (const fixture of readdirSync(join(dir, 'fixtures')).sort()) {
    for (const [i, flags] of flagSets.entries()) {
      const out = join(work, `${tool}-${fixture}-${i}.json`);
      const r = spawnSync(process.execPath, [join(dir, 'import.ts'), '--in', join(dir, 'fixtures', fixture), '--cases', join(dir, 'cases.json'), '--bar', join(dir, 'bar.json'), '--out', out, ...flags], { env: scratchEnv(), encoding: 'utf8' });
      // A refused import writes nothing, so there is no output that could hold the marker.
      if (r.status !== 0) {
        assert.equal(existsSync(out), false, `${tool}/${fixture}: exit ${String(r.status)} and yet a file was written`);
        continue;
      }
      written.push({ fixture, bytes: readFileSync(out, 'utf8') });
      break;
    }
  }
  return written;
}

function assertNoMarker(tool: string, written: readonly Imported[], expected: readonly string[]): void {
  assert.deepEqual(written.map((w) => w.fixture), expected, `${tool}: the fixtures that import`);
  for (const { fixture, bytes } of written) {
    assert.equal(bytes.includes(NO_SEED), false, `${tool}/${fixture}: the written run holds "${NO_SEED}"`);
    const run = parseRunArtifact(JSON.parse(bytes));
    assert.equal(run.identity.seed, GAP, `${tool}/${fixture}: the seed of an imported run is the gap`);
  }
}

test('the marker is the text this test searches for, and the gap is another text', () => {
  assert.equal(NO_SEED, 'NO_SEED');
  assert.equal(GAP, 'UNKNOWN');
});

test('promptfoo: no imported run holds NO_SEED; the seed is UNKNOWN in every one', () => {
  const written = importAll('promptfoo', READINGS.map((reading) => ['--reading', reading]));
  assertNoMarker('promptfoo', written, ['fenced.json', 'new-judge.json', 'old-judge.json', 'openai-new-judge.json', 'openai-old-judge.json', 'openai-reask.json', 'reask-new-judge.json', 'reask.json', 'short-outputs.json', 'thinking.json']);
});

test('Inspect: no imported run holds NO_SEED; the seed is UNKNOWN in every one', () => {
  const written = importAll('inspect', [[]]);
  assertNoMarker('inspect', written, ['long-reply.json', 'new-judge.json', 'old-judge.json', 'openai-new-judge.json', 'openai-old-judge.json', 'reask-new-judge.json', 'reask.json', 'short-targets.json', 'thinking.json']);
});

test('skill-evals: no imported run holds NO_SEED; the seed is UNKNOWN in every one', () => {
  const flow = join(importers, 'skill-evals', 'example-flow');
  const written = importAll('skill-evals', READINGS.map((reading) => ['--reading', reading, '--flow', flow]));
  assertNoMarker('skill-evals', written, ['new-judge-rep1.regrade.jsonl', 'new-judge.regrade.jsonl', 'old-judge.regrade.jsonl', 'openai-new-judge.regrade.jsonl', 'openai-old-judge.regrade.jsonl', 'reask-new-judge.regrade.jsonl', 'reask.regrade.jsonl']);
});

test('no committed example run under examples/importers holds NO_SEED', () => {
  const holding: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(json|jsonl)$/.test(e.name) && readFileSync(p, 'utf8').includes(NO_SEED)) holding.push(p.slice(root.length + 1));
    }
  };
  walk(importers);
  assert.deepEqual(holding, []);
});
