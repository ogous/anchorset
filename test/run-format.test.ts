import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PACKET_BASES, parseRunArtifact, RUN_SCHEMA, runArtifactProblems } from '../src/artifact.ts';
import type { RunArtifact } from '../src/artifact.ts';
import { CONTEXT_POLICIES, EFFORTS, NOT_SENT, THINKING_MODES, TOOL_CHOICES } from '../src/callshape.ts';
import { barHash, parseBarFile } from '../src/gate.ts';
import { GAP, IDENTITY_FIELDS, NO_JUDGE, NO_SEED } from '../src/identity.ts';
import { gateExitCode, gateRuns } from '../src/regression.ts';
import { FAIL_REASONS, finalAttempt, JUDGE_UNMEASURED_REASONS, STOPS, TRANSPORT_REASONS } from '../src/scoring.ts';

// docs/RUN_FORMAT.md is the run file's contract for someone writing one from their own harness. Its example is a
// file, examples/run-format/run.json, so that what the document shows is what the parser and the gate accept.
const root = join(import.meta.dirname, '..');
const text = (...path: string[]): string => readFileSync(join(root, ...path), 'utf8');
const doc = text('docs', 'RUN_FORMAT.md');
const runText = text('examples', 'run-format', 'run.json');
const barText = text('examples', 'run-format', 'bar.json');
const tmp = mkdtempSync(join(tmpdir(), 'anchorset-run-format-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('the documented run file is valid, and the gate accepts it: against itself it exits 0', () => {
  const json: unknown = JSON.parse(runText);
  assert.deepEqual(runArtifactProblems(json), []);
  const run = parseRunArtifact(json);
  const bar = parseBarFile(JSON.parse(barText));
  assert.equal(run.schema, RUN_SCHEMA);
  assert.equal(run.identity.barHash, barHash(bar));
  const result = gateRuns(run, run, bar);
  assert.equal(result.kind, 'evaluated');
  assert.equal(gateExitCode(result), 0);
  // The command, as the document prints it.
  const ex = (f: string): string => join(root, 'examples', 'run-format', f);
  const r = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), 'gate', '--baseline', ex('run.json'), '--candidate', ex('run.json'), '--bar', ex('bar.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reply_quality {3}floor {11}2\/3 0\.667 {5}2\/3 0\.667, 0 new {6}0\.500 {3}ok/);
  assert.match(r.stdout, /verdict: OK \(exit 0\)/);
  assert.ok(doc.includes(r.stdout.trimEnd()), 'the document prints the gate\'s output as it is');
});

test('docs/RUN_FORMAT.md quotes the example run file and its bar file byte for byte', () => {
  assert.ok(doc.includes(`\`\`\`json\n${runText}\`\`\`\n`), 'the run file in the document is not examples/run-format/run.json');
  assert.ok(doc.includes(`\`\`\`json\n${barText}\`\`\`\n`), 'the bar file in the document is not examples/run-format/bar.json');
});

test('the example shows what the document annotates: a retry after a timeout, a judge retry on the same output, and a truncated reply', () => {
  const run = JSON.parse(runText) as RunArtifact;
  const kinds = run.draws.map((d) => d.attempts.map((a) => (a.kind === 'unmeasured' ? `${a.kind}:${a.role}:${a.reason}` : a.kind)).join(' > '));
  assert.deepEqual(kinds, ['graded', 'unmeasured:system:timeout > graded', 'unmeasured:judge:parse-failure > graded', 'graded', 'failed', 'graded']);
  assert.deepEqual(run.draws.map((d) => `${d.caseId}#${d.drawIndex}`), ['q01#0', 'q01#1', 'q02#0', 'q02#1', 'q03#0', 'q03#1']);
  // The judge retry grades the same stored reply: one output, one stop, one packet.
  const [first, second] = (run.draws[2] as RunArtifact['draws'][number]).attempts as unknown as [Record<string, unknown>, Record<string, unknown>];
  assert.deepEqual([first['outputHash'], first['systemStop'], first['packetHash']], [second['outputHash'], second['systemStop'], second['packetHash']]);
  const failed = finalAttempt(run.draws[4] as RunArtifact['draws'][number]);
  assert.deepEqual([failed.kind, failed.kind === 'failed' && failed.reason, failed.kind === 'failed' && failed.systemStop], ['failed', 'truncated', 'max-tokens']);
  assert.equal(run.packetBasis, 'recorded');
  // Everything is known in this run: no gap, and the judge is not NO_JUDGE.
  assert.ok(!runText.includes(`"${GAP}"`) && !runText.includes(`"${NO_JUDGE}"`) && !runText.includes(`"${NO_SEED}"`));
  assert.ok(runText.includes(`"${NOT_SENT}"`));
});

test('docs/RUN_FORMAT.md names every field and every value of a closed list that the parser knows', () => {
  const run = JSON.parse(runText) as RunArtifact;
  const named = (word: string): boolean => doc.includes(`\`${word}\``) || doc.includes(`\`"${word}"\``);
  const missing = [
    ...['schema', 'identity', 'callShapes', 'cases', 'draws', 'packetBasis', 'packetSource'],
    ...IDENTITY_FIELDS,
    ...Object.keys(run.callShapes.system),
    ...THINKING_MODES, ...EFFORTS, ...TOOL_CHOICES, ...CONTEXT_POLICIES,
    ...['id', 'klass', 'input', 'expect', 'caseId', 'drawIndex', 'attempts'],
    ...['kind', 'role', 'label', 'reason', 'detail', 'outputHash', 'systemStop', 'judgeStop', 'packetHash'],
    ...STOPS, ...FAIL_REASONS, ...TRANSPORT_REASONS, ...JUDGE_UNMEASURED_REASONS,
    ...PACKET_BASES,
    GAP, NOT_SENT, NO_JUDGE, NO_SEED,
  ].filter((w) => !named(w));
  assert.deepEqual(missing, [], `not named in docs/RUN_FORMAT.md: ${missing.join(', ')}`);
  // The call shape the document lists is the whole closed schema: 24 keys with `schema` and `extras`.
  assert.equal(Object.keys(run.callShapes.system).length, 24);
});

test('examples/run-format/generate.ts rewrites the two files byte for byte', () => {
  const r = spawnSync(process.execPath, [join(root, 'examples', 'run-format', 'generate.ts'), tmp], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(tmp, 'run.json'), 'utf8'), runText);
  assert.equal(readFileSync(join(tmp, 'bar.json'), 'utf8'), barText);
});
