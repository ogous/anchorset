// examples/importers/make-plan.ts: the plan of a judge-change measurement, written from the two run files of one
// tool and the choices the user states. The test is the byte equality with the plan each tool ships, and the refusals.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { hashOf, sha256Hex } from '../src/index.ts';
import { scratchEnv } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const importers = join(root, 'examples', 'importers');
const work = mkdtempSync(join(tmpdir(), 'anchorset-make-plan-'));
after(() => rmSync(work, { recursive: true, force: true }));

const node = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root, env: scratchEnv() });
const READING = 'one-json-object-boolean-pass/v1';
const SKILL_FLOW = join(importers, 'skill-evals', 'example-flow');

type Tool = { name: string; dir: string; old: string[]; new: string[]; cut: string };
const TOOLS: Tool[] = [
  { name: 'promptfoo', dir: join(importers, 'promptfoo'), old: [join(importers, 'promptfoo', 'fixtures', 'old-judge.json'), '--reading', READING], new: [join(importers, 'promptfoo', 'fixtures', 'new-judge.json'), '--reading', READING], cut: 'pass' },
  { name: 'inspect', dir: join(importers, 'inspect'), old: [join(importers, 'inspect', 'fixtures', 'old-judge.json')], new: [join(importers, 'inspect', 'fixtures', 'new-judge.json')], cut: 'C' },
  { name: 'skill-evals', dir: join(importers, 'skill-evals'), old: [join(importers, 'skill-evals', 'fixtures', 'old-judge.regrade.jsonl'), '--reading', READING, '--flow', SKILL_FLOW], new: [join(importers, 'skill-evals', 'fixtures', 'new-judge.regrade.jsonl'), '--reading', READING, '--flow', SKILL_FLOW], cut: 'pass' },
];

/** The two imported runs of one tool, written into a scratch folder by the tool's own importer. */
const importedAlready = new Map<string, { old: string; new: string }>();
function imported(t: Tool): { old: string; new: string } {
  const cached = importedAlready.get(t.name);
  if (cached !== undefined) return cached;
  const dir = join(work, t.name);
  mkdirSync(dir, { recursive: true });
  const one = (side: 'old' | 'new'): string => {
    const [input, ...extra] = t[side] as [string, ...string[]];
    const out = join(dir, `${side}.json`);
    const r = node(join(t.dir, 'import.ts'), ['--in', input, '--cases', join(t.dir, 'cases.json'), '--bar', join(t.dir, 'bar.json'), '--out', out, ...extra]);
    assert.equal(r.status, 0, r.stderr);
    return out;
  };
  const runs = { old: one('old'), new: one('new') };
  importedAlready.set(t.name, runs);
  return runs;
}

/** The flags that state the four choices of the measurement (and the label, the opt-in and the draws), as the shipped plans made them. */
const choices = (t: Tool): Record<string, string> => ({
  '--system': 'refund-bot',
  '--stored-outputs': 'system-side-not-compared',
  '--measured-class': 'refund_policy',
  '--cut': t.cut,
  '--label-rule': 'majority',
  '--pooling': 'items-equal',
  '--estimate-draws': '0,1,2',
  '--judge-moves': 'judgeModelRequested,judgeModelServed',
});
const argsOf = (t: Tool, runs: { old: string; new: string }, out: string, over: Record<string, string | null> = {}): string[] => {
  const all: Record<string, string> = { '--old': runs.old, '--new': runs.new, '--bar': join(t.dir, 'bar.json'), '--out': out, ...choices(t) };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete all[k];
    else all[k] = v;
  }
  return Object.entries(all).flat();
};
const makePlan = join(importers, 'make-plan.ts');

describe('make-plan.ts: the two imported runs of a tool and the choices give the plan the tool ships', () => {
  for (const t of TOOLS) {
    it(`${t.name}: the bytes equal ${t.name}/plan.json`, () => {
      const runs = imported(t);
      const out = join(work, `${t.name}-plan.json`);
      const r = node(makePlan, argsOf(t, runs, out));
      assert.equal(r.status, 0, r.stderr);
      const written = readFileSync(out);
      assert.ok(written.equals(readFileSync(join(t.dir, 'plan.json'))), 'the plan differs from the shipped one');
      assert.match(r.stdout, new RegExp(`plan hash: ${hashOf(JSON.parse(written.toString('utf8')))}`));
      // The roster binds each run by the sha256 of its bytes.
      const plan = JSON.parse(written.toString('utf8')) as { systems: Record<string, { old: string; new: string }> };
      assert.deepEqual(plan.systems['refund-bot'], { old: sha256Hex(readFileSync(runs.old)), new: sha256Hex(readFileSync(runs.new)) });
    });
  }
});

describe('make-plan.ts: it refuses, and writes nothing', () => {
  const t = TOOLS[0] as Tool;
  const runs = (): { old: string; new: string } => imported(t);

  it('a missing flag, a repeated one, an unknown one and an empty value are usage errors (64) naming the flag, for each of the twelve', () => {
    const r = runs();
    const full = argsOf(t, r, join(work, 'never.json'));
    const names = full.filter((_, i) => i % 2 === 0);
    assert.equal(names.length, 12);
    for (const name of names) {
      const out = join(work, `missing${name}.json`);
      const res = node(makePlan, argsOf(t, r, out, { [name]: null }));
      assert.equal(res.status, 64, `${name}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`missing ${name}`));
      assert.equal(existsSync(out), false);
    }
    assert.equal(node(makePlan, [...full, '--cut', 'pass']).status, 64);
    assert.equal(node(makePlan, [...full, '--weight', '1']).status, 64);
    assert.equal(node(makePlan, argsOf(t, r, join(work, 'empty.json'), { '--system': '' })).status, 64);
  });

  it('an existing --out is never overwritten', () => {
    const r = runs();
    const out = join(work, 'exists.json');
    writeFileSync(out, 'keep');
    assert.equal(node(makePlan, argsOf(t, r, out)).status, 64);
    assert.equal(readFileSync(out, 'utf8'), 'keep');
  });

  // Every refusal of the measurement is the library's own: the plan is handed to `judgeChangeRuns` with the bar and the two files'
  // bytes, and what it refuses is printed with its code and its fields (as `anchorset judge-change` prints it). The script holds no
  // copy of the rules.
  const refused = (label: string, over: Record<string, string | null>, code: string, fields: RegExp): void => {
    it(label, () => {
      const out = join(work, `${label.replace(/\W+/g, '-').slice(0, 40)}-${Math.abs(label.length * 7919)}.json`);
      const res = node(makePlan, argsOf(t, runs(), out, over));
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, new RegExp(`^REFUSED ${code}\\n {2}fields: `));
      assert.match(res.stderr, fields);
      assert.match(res.stderr, /Nothing was written\./);
      assert.equal(existsSync(out), false);
    });
  };
  refused('a judge move that did not happen is refused, and so is one that was not declared', { '--judge-moves': 'judgeModelRequested' }, 'IDENTITY_MISMATCH', /fields: judgeModelServed/);
  refused('a judge move that was declared and did not happen', { '--judge-moves': 'judgeModelRequested,judgeModelServed,rubricHash' }, 'IDENTITY_MISMATCH', /fields: rubricHash/);
  refused('a class that is not a class of the bar', { '--measured-class': 'no_such_class' }, 'UNSUPPORTED_DESIGN', /fields: measuredClass\n/);
  refused('a class that is not compensable', { '--measured-class': 'refund_safety' }, 'UNSUPPORTED_DESIGN', /fields: measuredClass\n/);
  refused('a cut that is not a label of the bar', { '--cut': 'maybe' }, 'UNSUPPORTED_DESIGN', /fields: cut\n/);
  refused('a cut that a case of the class does not expect', { '--cut': 'fail' }, 'UNSUPPORTED_DESIGN', /fields: c1, c2\n/);

  it('another bar file than the one the runs name is refused with HASH_MISMATCH naming barHash', () => {
    const r = runs();
    const bar = join(work, 'other-bar.json');
    writeFileSync(bar, JSON.stringify({ labels: ['fail', 'pass'], classes: { refund_policy: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] }));
    const out = join(work, 'other-bar-plan.json');
    const res = node(makePlan, argsOf(t, r, out, { '--bar': bar }));
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /^REFUSED HASH_MISMATCH\n {2}fields: barHash\n/);
    assert.equal(existsSync(out), false);
  });

  it('a plan the library would not read for these runs is not written: stored outputs "system-side-compared" over imported runs', () => {
    const out = join(work, 'compared.json');
    const res = node(makePlan, argsOf(t, runs(), out, { '--stored-outputs': 'system-side-compared' }));
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /^REFUSED IDENTITY_GAP\n/);
    assert.equal(existsSync(out), false);
  });

  it('two runs that are not two judgements of one set of cases are refused by the library, and a run that is not a run is invalid input (65)', () => {
    const r = runs();
    const other = imported(TOOLS[1] as Tool);
    const res = node(makePlan, argsOf(t, { old: r.old, new: other.new }, join(work, 'mixed.json')));
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /^REFUSED [A-Z_]+\n {2}fields: /);
    assert.equal(existsSync(join(work, 'mixed.json')), false);
    const bad = join(work, 'not-a-run.json');
    writeFileSync(bad, '{"schema": "anchorset.run/v3"}');
    const res2 = node(makePlan, argsOf(t, { old: bad, new: r.new }, join(work, 'bad.json')));
    assert.equal(res2.status, 65, res2.stderr);
  });
});

describe('make-plan.ts: text of a run file cannot erase or forge a line of what it prints', () => {
  // The string the importer tests use, with a right-to-left override added: a carriage return, an erase-line sequence, a line feed, a line separator.
  const HOSTILE = 'x\r\u001b[2Kplan written to never.json\nplan hash: 000\u2028run hash: 000\u202e';
  const RAW = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
  const withKey = (path: string, key: string, name: string): string => {
    const edited = join(work, name);
    writeFileSync(edited, JSON.stringify({ ...(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>), [key]: 1 }));
    return edited;
  };

  it('a run file with an extra key that holds control characters: the same number of stderr lines as for a plain key, each with escapes only', () => {
    const t = TOOLS[0] as Tool;
    const r = imported(t);
    const plain = node(makePlan, argsOf(t, { old: withKey(r.old, 'extra', 'plain-key.json'), new: r.new }, join(work, 'plain-key-plan.json')));
    assert.equal(plain.status, 65, plain.stderr);
    const out = join(work, 'hostile-key-plan.json');
    const res = node(makePlan, argsOf(t, { old: withKey(r.old, HOSTILE, 'hostile-key.json'), new: r.new }, out));
    assert.equal(res.status, 65, res.stderr);
    assert.equal(existsSync(out), false);
    assert.equal(res.stdout, '');
    const lines = res.stderr.replace(/\n$/, '').split('\n');
    assert.equal(lines.length, plain.stderr.replace(/\n$/, '').split('\n').length, res.stderr);
    for (const line of lines) assert.ok(!RAW.test(line), JSON.stringify(line));
    assert.ok(lines.some((line) => line.includes('\\r\\u001b[2K') && line.includes('\\n') && line.includes('\\u2028') && line.includes('\\u202e')), res.stderr);
    assert.ok(!lines.some((line) => /^(plan|run) hash: /.test(line)), res.stderr);
  });
});

describe('make-plan.ts: where it stands', () => {
  it('imports from the library\'s public entry and Node built-ins only', () => {
    const source = readFileSync(makePlan, 'utf8');
    const specs = [...source.matchAll(/^import (?:type )?(?:[^'"]*?from )?'([^']+)';/gm)].map((m) => m[1] as string);
    assert.ok(specs.length >= 2);
    for (const s of specs) assert.ok(s === '../../src/index.ts' || s.startsWith('node:'), s);
  });
  it('holds no copy of the plan rules: it calls judgeChangeRuns and names no refusal class of its own', () => {
    const source = readFileSync(makePlan, 'utf8');
    assert.match(source, /judgeChangeRuns\(/);
    assert.ok(!/class \w+ extends Error \{\}/.test(source.replace(/class Usage extends Error \{\}/, '')), 'a private refusal class');
    assert.ok(!source.includes('not a class of the bar') && !source.includes('not a label of the bar'), 'a rule worded here');
  });
  it('every name it imports from the entry is a value or a type the entry exports', async () => {
    const api = await import('../src/index.ts');
    const source = readFileSync(makePlan, 'utf8');
    const m = /import \{([^}]*)\} from '\.\.\/\.\.\/src\/index\.ts';/.exec(source);
    assert.ok(m);
    for (const name of (m[1] as string).split(',').map((n) => n.trim()).filter(Boolean)) assert.ok(name in api, name);
  });
});

// ---- the cross-wire note ------------------------------------------------------------------------------------------------------

describe('make-plan.ts: the note printed when the two run files were graded through two wires', () => {
  const pf = join(importers, 'promptfoo');
  /** A promptfoo fixture imported by the real command into the scratch folder. */
  const importPf = (fixture: string, out: string): string => {
    const dest = join(work, 'wires');
    mkdirSync(dest, { recursive: true });
    const path = join(dest, out);
    const r = node(join(pf, 'import.ts'), ['--in', join(pf, 'fixtures', `${fixture}.json`), '--cases', join(pf, 'cases.json'), '--bar', join(pf, 'bar.json'), '--out', path, '--reading', READING]);
    assert.equal(r.status, 0, r.stderr);
    return path;
  };
  const choices = (moves: string): string[] => ['--bar', join(pf, 'bar.json'), '--system', 'refund-bot', '--stored-outputs', 'system-side-not-compared', '--measured-class', 'refund_policy', '--cut', 'pass', '--label-rule', 'majority', '--pooling', 'items-equal', '--estimate-draws', '0,1,2', '--judge-moves', moves];
  const plan = (oldRun: string, newRun: string, out: string, moves: string) => node(makePlan, ['--old', oldRun, '--new', newRun, '--out', join(work, out), ...choices(moves)]);
  const FOUR = 'judgeModelRequested,judgeModelServed,judgeCallShapeHash,judgeHarnessVersion';
  /** The note, word for word: the two names fill the two places. */
  const note = (a: string, b: string): string =>
    `The two run files were graded through two APIs (\`${a}\` and \`${b}\`). The report measures the change of the whole grading path: the model, the provider's API, the provider's defaults for every setting not sent, and how the reply is taken from the response. It does not separate the model from the rest. A setting with the same value in both files is the same text in the record, not the same setting: \`effort\`, \`temperature\`, the output cap and \`NOT_SENT\` mean different things to the two providers. Compare the two imports' reasoning and re-ask lines.`;
  const stripWire = (from: string, to: string): string => {
    const run = JSON.parse(readFileSync(from, 'utf8')) as { identity: { judgeHarnessVersion: string } };
    run.identity.judgeHarnessVersion = run.identity.judgeHarnessVersion.replace(/; wire [^;]+/, '');
    writeFileSync(join(work, 'wires', to), JSON.stringify(run, null, 2));
    return join(work, 'wires', to);
  };

  it('a Claude judge against a GPT judge: four judge fields move, the note is printed on standard error before the plan is written, and the plan is written', () => {
    const a = importPf('old-judge', 'anth-old.json');
    const o = importPf('openai-new-judge', 'openai-new.json');
    const r = plan(a, o, 'cross-plan.json', FOUR);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, `${note('anthropic-messages/v1', 'openai-responses/v1')}\n`);
    assert.equal(r.stdout.split('\n')[0], `plan written to ${join(work, 'cross-plan.json')}`);
    assert.ok(existsSync(join(work, 'cross-plan.json')));
    const p = JSON.parse(readFileSync(join(work, 'cross-plan.json'), 'utf8')) as { judgeMoves: string[] };
    assert.deepEqual(p.judgeMoves, ['judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion']);
  });

  it('the plan is refused when either of the last two fields is left out of the moves, and the note does not make up for it', () => {
    const a = importPf('old-judge', 'anth-old-2.json');
    const o = importPf('openai-new-judge', 'openai-new-2.json');
    for (const moves of ['judgeModelRequested,judgeModelServed,judgeCallShapeHash', 'judgeModelRequested,judgeModelServed,judgeHarnessVersion', 'judgeModelRequested,judgeModelServed']) {
      const out = `refused-${moves.length}.json`;
      const r = plan(a, o, out, moves);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /^REFUSED IDENTITY_MISMATCH\n/);
      assert.equal(existsSync(join(work, out)), false);
      assert.ok(!r.stderr.includes('graded through two APIs'), 'a refused plan prints no note: nothing is written');
    }
  });

  it('two OpenAI judges: both name the same wire, so no note is printed', () => {
    const o = importPf('openai-old-judge', 'oa-old.json');
    const n = importPf('openai-new-judge', 'oa-new.json');
    const r = plan(o, n, 'same-wire-plan.json', 'judgeModelRequested,judgeModelServed');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  });

  it('two Anthropic judges: no note', () => {
    const r = plan(importPf('old-judge', 'a1.json'), importPf('new-judge', 'a2.json'), 'anth-plan.json', 'judgeModelRequested,judgeModelServed');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  });

  it('a run imported before the wire was named (no component) against one that names it: the note is printed, and the missing name reads "not named in the run file"', () => {
    const named = importPf('openai-new-judge', 'oa-named.json');
    const bare = stripWire(importPf('old-judge', 'anth-for-strip.json'), 'anth-bare.json');
    // the older side is the old run
    const r = plan(bare, named, 'bare-old-plan.json', FOUR);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, `${note('not named in the run file', 'openai-responses/v1')}\n`);
    // and the other way round, with the old run named and the new one bare
    const r2 = plan(importPf('openai-old-judge', 'oa-old-2.json'), stripWire(importPf('new-judge', 'anth-new-for-strip.json'), 'anth-bare-new.json'), 'bare-new-plan.json', FOUR);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.stderr, `${note('openai-responses/v1', 'not named in the run file')}\n`);
  });

  it('neither run names a wire: both are older runs, and no wire is inferred for either; no note', () => {
    const a = stripWire(importPf('old-judge', 'anth-old-3.json'), 'bare-a.json');
    const b = stripWire(importPf('new-judge', 'anth-new-3.json'), 'bare-b.json');
    const r = plan(a, b, 'neither-plan.json', 'judgeModelRequested,judgeModelServed');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  });

  it('the wire component is read from the harness string: after max-reasks, before script-files', async () => {
    const { wireOfHarness, wireNote } = await import('../examples/importers/make-plan.ts');
    assert.equal(wireOfHarness('promptfoo 0.1; g js sha256:x; node v1; max-reasks 0; wire openai-responses/v1'), 'openai-responses/v1');
    assert.equal(wireOfHarness('skill-evals skill-evals/1; g js sha256:x; node v1; max-reasks 2; wire anthropic-messages/v1; script-files sha256:abc'), 'anthropic-messages/v1');
    assert.equal(wireOfHarness('promptfoo 0.1; g js sha256:x; node v1; max-reasks 0'), undefined);
    assert.equal(wireNote('a; wire x', 'b; wire x'), undefined);
    assert.equal(wireNote('a', 'b'), undefined);
    assert.ok(wireNote('a; wire x', 'b; wire y')?.startsWith('The two run files were graded through two APIs (`x` and `y`).'));
  });
});
