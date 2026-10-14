// The skill-evals importer reads the flow again, always: `--flow` is required and has no default. Without it a
// re-grade file edited after the re-grade could not be told from one that was not, and the run would say "flow read again: no".
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ImportUsageError, loadBar, parseCasesFile } from '../examples/importers/shared.ts';
import { convertRegrade, main, USAGE } from '../examples/importers/skill-evals/import.ts';

const dir = join(import.meta.dirname, '..', 'examples', 'importers', 'skill-evals');
const work = mkdtempSync(join(tmpdir(), 'anchorset-flow-required-'));
after(() => rmSync(work, { recursive: true, force: true }));
const READING = 'one-json-object-boolean-pass/v1';
const bar = loadBar(readFileSync(join(dir, 'bar.json'), 'utf8'));
const cases = parseCasesFile(readFileSync(join(dir, 'cases.json'), 'utf8'), bar);

test('the command without --flow exits 64 naming --flow, writes no file and reads no file of the flow', () => {
  const out = join(work, 'run.json');
  const args = ['--in', join(dir, 'fixtures', 'old-judge.regrade.jsonl'), '--cases', join(dir, 'cases.json'), '--bar', join(dir, 'bar.json'), '--out', out, '--reading', READING];
  const r = spawnSync(process.execPath, [join(dir, 'import.ts'), ...args], { encoding: 'utf8' });
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /missing --flow/);
  assert.equal(existsSync(out), false);
  // In process, too, and the usage line says the flag is required, not optional.
  const err: string[] = [];
  assert.equal(main(args, { out: () => undefined, err: (s) => err.push(s) }), 64);
  assert.match(err.join('\n'), /missing --flow/);
  assert.ok(USAGE.includes('--flow <dir>') && !USAGE.includes('[--flow'), USAGE);
  assert.doesNotMatch(USAGE, /preferably/);
});

test('with --flow the command imports, and the run says the flow was read again', () => {
  const out = join(work, 'ok-run.json');
  const r = spawnSync(process.execPath, [join(dir, 'import.ts'), '--in', join(dir, 'fixtures', 'old-judge.regrade.jsonl'), '--cases', join(dir, 'cases.json'), '--bar', join(dir, 'bar.json'), '--out', out, '--reading', READING, '--flow', join(dir, 'example-flow')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(out, 'utf8'), /; flow read again: yes\)/);
});

test('the conversion takes the second look as a required parameter: a call without it is a type error, and at run time a usage error naming --flow, before anything is converted', () => {
  const bytes = readFileSync(join(dir, 'fixtures', 'old-judge.regrade.jsonl'));
  // @ts-expect-error the sixth parameter is required: there is no conversion without the flow read again
  const without = (): unknown => convertRegrade(bytes, 'in.regrade.jsonl', cases, bar, READING);
  assert.throws(without, (e: unknown) => e instanceof ImportUsageError && /missing --flow/.test(e.message));
});

test('no code path of the importer writes "flow read again: no"', () => {
  assert.doesNotMatch(readFileSync(join(dir, 'import.ts'), 'utf8'), /flow read again: \$\{|flow read again: no|'no' : 'yes'/);
});
