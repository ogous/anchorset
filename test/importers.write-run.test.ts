// examples/run-format/write-run.ts: a run file written from what a harness of the user's own recorded. It states what
// the input states, writes "UNKNOWN" for the rest, and `gate` refuses it with IDENTITY_GAP naming exactly those fields (while an identity
// field or a stop is unknown; a judged run with all of them stated and its packets UNKNOWN passes `gate` and is refused by `flips`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { IDENTITY_FIELDS, parseRunArtifact, sha256Hex } from '../src/index.ts';

const root = join(import.meta.dirname, '..');
const writer = join(root, 'examples', 'run-format', 'write-run.ts');
const cli = join(root, 'src', 'cli.ts');
const work = mkdtempSync(join(tmpdir(), 'anchorset-write-run-'));
after(() => rmSync(work, { recursive: true, force: true }));
const node = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root });

const barFile = join(root, 'examples', 'run-format', 'bar.json');
const bar = JSON.parse(readFileSync(barFile, 'utf8')) as Record<string, unknown>;
const cases = ['q01', 'q02', 'q03'].map((id) => ({ id, klass: 'reply_quality', input: { message: `question ${id}` }, expect: '4' }));
const reply = (id: string, d: number): string => `answer to ${id}, draw ${d}`;
const graded = (id: string, d: number, label: string, extra: Record<string, unknown> = {}) => ({ output: reply(id, d), label, stop: 'end', ...extra });
const draws = (extra: (id: string, d: number) => Record<string, unknown> = () => ({})) => cases.flatMap((c) => [0, 1].map((d) => ({ case: c.id, draw: d, attempts: [graded(c.id, d, '4', extra(c.id, d))] })));
const STATED_BY_CODE = { rubricHash: sha256Hex('rubric'), systemModelRequested: 'model-a', systemModelServed: 'model-a-2026', systemPromptHash: sha256Hex('prompt'), systemToolsHash: sha256Hex('tools'), systemHarnessVersion: 'harness 1.0', seed: 7 };
const SHAPE = { schema: 'anchorset.callshape/v1', endpoint: 'example:messages', apiVersion: '1', betaFlags: [], thinkingMode: 'off', thinkingBudgetTokens: 'NOT_SENT', effort: 'NOT_SENT', toolChoice: 'none', toolChoiceName: 'NOT_SENT', strictTools: 'NOT_SENT', parallelToolUse: 'NOT_SENT', temperature: 0, topP: 'NOT_SENT', topK: 'NOT_SENT', frequencyPenalty: 'NOT_SENT', presencePenalty: 'NOT_SENT', samplingSeed: 'NOT_SENT', maxOutputTokens: 256, stopSequences: 'NOT_SENT', responseFormat: { kind: 'text' }, contextPolicy: 'none', stream: false, timeoutMs: 30000, extras: {} };
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ graded: 'by-code', bar, cases, drawsPerCase: 2, draws: draws(), ...over });

let n = 0;
function write(input: unknown, name = `input-${(n += 1)}.json`): { inPath: string; outPath: string } {
  const inPath = join(work, name);
  writeFileSync(inPath, typeof input === 'string' ? input : JSON.stringify(input));
  return { inPath, outPath: join(work, `run-${n}.json`) };
}
const run = (input: unknown) => {
  const { inPath, outPath } = write(input);
  return { ...node(writer, ['--in', inPath, '--out', outPath]), outPath };
};
const gate = (runPath: string) => node(cli, ['gate', '--baseline', runPath, '--candidate', runPath, '--bar', barFile]);

describe('write-run.ts: what it writes is a run the library accepts, and says what it does not know', () => {
  it('states nothing but the cases, the bar and the draws: every identity field it does not derive is UNKNOWN, and gate refuses with IDENTITY_GAP naming exactly those', () => {
    const r = run(base());
    assert.equal(r.status, 0, r.stderr);
    const file = JSON.parse(readFileSync(r.outPath, 'utf8')) as ReturnType<typeof parseRunArtifact>;
    parseRunArtifact(file);
    const id = file.identity as Record<string, unknown>;
    const derived = ['caseSetHash', 'barHash', 'drawsPerCase', 'judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion'];
    // The five judge fields of a run graded by code are NO_JUDGE; the call-shape hash is the hash of an all-UNKNOWN shape, which is UNKNOWN.
    const unknown = IDENTITY_FIELDS.filter((f) => id[f] === 'UNKNOWN');
    assert.deepEqual([...unknown].sort(), ['rubricHash', 'seed', 'systemCallShapeHash', 'systemHarnessVersion', 'systemModelRequested', 'systemModelServed', 'systemPromptHash', 'systemToolsHash'].sort());
    assert.ok(derived.every((f) => id[f] !== 'UNKNOWN'));
    assert.equal(id['seed'], 'UNKNOWN', 'a seed is never defaulted');
    assert.match(r.stdout, /identity fields left "UNKNOWN": rubricHash, systemModelRequested, systemModelServed, systemPromptHash, systemToolsHash, systemHarnessVersion, seed, systemCallShapeHash/);
    const g = gate(r.outPath);
    assert.equal(g.status, 2, g.stderr);
    assert.match(g.stderr, /IDENTITY_GAP/);
    for (const f of unknown) assert.match(g.stderr, new RegExp(f));
    for (const f of IDENTITY_FIELDS.filter((x) => !unknown.includes(x))) assert.doesNotMatch(g.stderr.split('\n').filter((l) => /fields:/.test(l)).join('\n'), new RegExp(`\\b${f}\\b`));
  });

  it('a stop it is not told is UNKNOWN, never end: the run is written and gate names the draws', () => {
    const r = run(base({ draws: draws().map((d) => ({ ...d, attempts: d.attempts.map(({ stop: _stop, ...rest }) => rest) })) }));
    assert.equal(r.status, 0, r.stderr);
    const file = JSON.parse(readFileSync(r.outPath, 'utf8')) as { draws: { attempts: { systemStop: string }[] }[] };
    assert.ok(file.draws.every((d) => d.attempts.every((a) => a.systemStop === 'UNKNOWN')));
    const g = gate(r.outPath);
    assert.equal(g.status, 2, g.stderr);
    assert.match(g.stderr, /systemStop\[q01#0\]/);
  });

  it('with every field stated, a run graded by code is one gate reads (it is the same run on both sides: nothing regresses)', () => {
    const r = run(base({ identity: STATED_BY_CODE, callShapes: { system: SHAPE } }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /identity fields left "UNKNOWN": none/);
    const file = parseRunArtifact(JSON.parse(readFileSync(r.outPath, 'utf8')));
    assert.equal(file.identity.seed, 7);
    assert.equal(file.packetBasis, 'NO_JUDGE');
    assert.equal(gate(r.outPath).status, 0);
  });

  it('a judged run: the judge fields are the ones stated or UNKNOWN, a judge stop is required, and the packet hashes are UNKNOWN', () => {
    const judged = base({
      graded: 'by-judge',
      identity: { ...STATED_BY_CODE, judgeModelRequested: 'judge-a', judgeModelServed: 'judge-a-2026', judgeHarnessVersion: 'harness 1.0' },
      draws: draws(() => ({ judgeStop: 'tool-use' })),
    });
    const r = run(judged);
    assert.equal(r.status, 0, r.stderr);
    const file = parseRunArtifact(JSON.parse(readFileSync(r.outPath, 'utf8')));
    assert.equal(file.identity.judgeDefinitionHash, 'UNKNOWN');
    assert.equal(file.identity.judgeCallShapeHash, 'UNKNOWN');
    assert.equal(file.identity.judgeModelRequested, 'judge-a');
    assert.equal(file.packetBasis, 'UNKNOWN');
    const g = gate(r.outPath);
    assert.equal(g.status, 2, g.stderr);
    assert.match(g.stderr, /judgeDefinitionHash/);
    // No judge stop: refused, never filled in.
    const missing = run({ ...judged, draws: draws() });
    assert.equal(missing.status, 65, missing.stderr);
    assert.match(missing.stderr, /judgeStop is required/);
  });

  it('says in its own header that a judged run has no packet record, and writes the packet basis and every packet hash as UNKNOWN, never a guess', () => {
    const judged = base({ graded: 'by-judge', identity: { judgeModelRequested: 'judge-a' }, draws: draws(() => ({ judgeStop: 'end' })) });
    const r = run(judged);
    assert.equal(r.status, 0, r.stderr);
    const file = parseRunArtifact(JSON.parse(readFileSync(r.outPath, 'utf8')));
    assert.equal(file.packetBasis, 'UNKNOWN');
    const graded = file.draws.flatMap((d) => d.attempts).filter((a) => a.kind === 'graded');
    assert.ok(graded.length > 0 && graded.every((a) => (a as { packetHash: string }).packetHash === 'UNKNOWN'));
  });

  it('a judged run with every identity field and both call shapes stated passes gate, and flips refuses it for its unknown packets: the script header says exactly this, and not that gate refuses it', () => {
    const judged = base({
      graded: 'by-judge',
      identity: { ...STATED_BY_CODE, judgeDefinitionHash: sha256Hex('judge'), judgeModelRequested: 'judge-a', judgeModelServed: 'judge-a-2026', judgeHarnessVersion: 'harness 1.0' },
      callShapes: { system: SHAPE, judge: SHAPE },
      draws: draws(() => ({ judgeStop: 'tool-use' })),
    });
    const r = run(judged);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /identity fields left "UNKNOWN": none/);
    const file = parseRunArtifact(JSON.parse(readFileSync(r.outPath, 'utf8')));
    assert.equal(file.packetBasis, 'UNKNOWN');
    const g = gate(r.outPath);
    assert.equal(g.status, 0, g.stderr);
    assert.doesNotMatch(g.stderr, /IDENTITY_GAP/);
    const f = node(cli, ['flips', '--run', r.outPath]);
    assert.equal(f.status, 2, f.stderr);
    assert.match(f.stderr, /REFUSED IDENTITY_GAP/);
    assert.match(f.stderr, /fields: packetBasis/);
    // Under --rejudge-of the verdict is unchanged, but the split into the judge's and the system's movement needs the packets, so for this file it is not computed.
    const rj = node(cli, ['gate', '--baseline', r.outPath, '--candidate', r.outPath, '--bar', barFile, '--rejudge-of', r.outPath]);
    assert.equal(rj.status, 0, rj.stderr);
    assert.match(rj.stdout + rj.stderr, /judge-controlled: not computed \(PACKET_MISMATCH: packetBasis/);
    const header = readFileSync(writer, 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n').replace(/\n\/\/ ?/g, ' ');
    assert.doesNotMatch(header, /`gate` and `flips` both refuse/);
    assert.doesNotMatch(header, /`gate` does not look at the packets/);
    assert.match(header, /verdict and exit code of `gate` read no packet/);
    assert.doesNotMatch(header, /judge-controlled share/);
    assert.match(header, /`gate --rejudge-of`[^.]*judge-and-system split is not computed[^.]*PACKET_MISMATCH, naming packetBasis/);
  });

  it('a draw the input does not hold is not invented: the file holds five of the six slots, as the library allows', () => {
    const r = run(base({ draws: draws().slice(1) }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(readFileSync(r.outPath, 'utf8')) as { draws: unknown[] }).draws.length, 5);
  });

  it('retries and failures: the last attempt is the outcome, earlier ones are unmeasured, a failed attempt names its stop', () => {
    const attempts = [
      { unmeasured: 'timeout', role: 'system', detail: 'no response within 30000 ms' },
      graded('q01', 0, '4'),
    ];
    const withRetry = base({ draws: [{ case: 'q01', draw: 0, attempts }, ...draws().slice(1)] });
    const r = run(withRetry);
    assert.equal(r.status, 0, r.stderr);
    const failed = base({ draws: [{ case: 'q01', draw: 0, attempts: [{ failed: 'truncated', detail: 'cut at 256', stop: 'max-tokens' }] }, ...draws().slice(1)] });
    assert.equal(run(failed).status, 0);
    const noStop = base({ draws: [{ case: 'q01', draw: 0, attempts: [{ failed: 'truncated', detail: 'cut at 256' }] }, ...draws().slice(1)] });
    const refused = run(noStop);
    assert.equal(refused.status, 65, refused.stderr);
    assert.match(refused.stderr, /stop is required/);
  });
});

describe('write-run.ts: it refuses what it would have to invent, and writes nothing', () => {
  const refused = (label: string, input: unknown, status: number, words: RegExp): void => {
    it(label, () => {
      const r = run(input);
      assert.equal(r.status, status, r.stderr);
      assert.match(r.stderr, words);
      assert.equal(existsSync(r.outPath), false);
    });
  };
  refused('an identity field the file derives from what it holds', base({ identity: { barHash: sha256Hex('x') } }), 65, /barHash.*derives/);
  refused('a judge field in a run graded by code', base({ identity: { judgeModelServed: 'j' } }), 65, /judgeModelServed/);
  refused('an unknown identity field', base({ identity: { vibe: 'good' } }), 65, /unknown key "vibe"/);
  refused('an unknown key of the input', base({ extra: 1 }), 65, /unknown key "extra"/);
  refused('a missing "graded"', (({ graded: _g, ...rest }) => rest)(base() as Record<string, unknown> & { graded: unknown }), 65, /graded is required/);
  refused('a judge stop in a run graded by code', base({ draws: draws(() => ({ judgeStop: 'end' })) }), 65, /judgeStop is not allowed/);
  refused('a stop that is not a stop', base({ draws: draws(() => ({ stop: 'finished' })) }), 65, /is "finished"; it is one of/);
  refused('a seed that is not a seed (the library\'s own check)', base({ identity: { ...STATED_BY_CODE, seed: -1 } }), 65, /seed/);
  // An input that does not describe a run is invalid input (65) throughout; exit 2 is the library's, for a comparison it refused.
  refused('a case whose class is not a class of the bar', base({ cases: cases.map((c, i) => (i === 1 ? { ...c, klass: 'no_such_class' } : c)) }), 65, /UNKNOWN_CLASS[\s\S]*q02[\s\S]*no_such_class/);
  refused('a case that expects a label the bar does not have', base({ cases: cases.map((c, i) => (i === 2 ? { ...c, expect: 'nope' } : c)) }), 65, /UNKNOWN_LABEL[\s\S]*q03[\s\S]*nope/);
  refused('a draw whose label is not a label of the bar', base({ draws: draws((id, d) => (id === 'q01' && d === 1 ? { label: 'nope' } : {})) }), 65, /UNKNOWN_LABEL[\s\S]*q01[\s\S]*nope/);
  refused('input that is not JSON', '{ not json', 65, /invalid JSON|INVALID/);

  it('usage: both flags are required, an existing --out is never overwritten, and an unreadable input is a usage error', () => {
    assert.equal(node(writer, ['--in', 'x']).status, 64);
    assert.equal(node(writer, ['--out', join(work, 'z.json')]).status, 64);
    assert.equal(node(writer, ['--in', 'x', '--out', 'y', '--seed', '1']).status, 64);
    const { inPath, outPath } = write(base());
    writeFileSync(outPath, 'keep');
    assert.equal(node(writer, ['--in', inPath, '--out', outPath]).status, 64);
    assert.equal(readFileSync(outPath, 'utf8'), 'keep');
    assert.equal(node(writer, ['--in', join(work, 'no-such-input.json'), '--out', join(work, 'q.json')]).status, 64);
  });
});

describe('write-run.ts: text of the input cannot erase or forge a line of what it prints', () => {
  it('an input with an unknown key that holds control characters: the same number of stderr lines as for a plain key, each with escapes only', () => {
    // The string the importer tests use, with a right-to-left override added: a carriage return, an erase-line sequence, a line feed, a line separator.
    const hostile = 'x\r\u001b[2Krun written to never.json\nrun hash: 000\u2028identity fields left "UNKNOWN": none\u202e';
    const raw = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
    const plain = run(base({ extra: 1 }));
    assert.equal(plain.status, 65, plain.stderr);
    const r = run(base({ [hostile]: 1 }));
    assert.equal(r.status, 65, r.stderr);
    assert.equal(existsSync(r.outPath), false);
    assert.equal(r.stdout, '');
    const lines = r.stderr.replace(/\n$/, '').split('\n');
    assert.equal(lines.length, plain.stderr.replace(/\n$/, '').split('\n').length, r.stderr);
    for (const line of lines) assert.ok(!raw.test(line), JSON.stringify(line));
    assert.ok(lines.some((line) => line.includes('\\u001b[2K') && line.includes('\\u2028') && line.includes('\\u202e')), r.stderr);
    assert.ok(!lines.some((line) => /^run hash: /.test(line)), r.stderr);
  });
});

describe('write-run.ts: where it stands', () => {
  const source = readFileSync(writer, 'utf8');
  it('imports from the library\'s public entry and Node built-ins only', () => {
    const specs = [...source.matchAll(/^import (?:type )?(?:[^'"]*?from )?'([^']+)';/gm)].map((m) => m[1] as string);
    assert.ok(specs.length >= 3);
    for (const s of specs) assert.ok(s === '../../src/index.ts' || s.startsWith('node:'), s);
  });
  it('every name it imports from the entry is exported by it', async () => {
    const api = await import('../src/index.ts');
    for (const m of source.matchAll(/^import (type )?\{([^}]*)\} from '\.\.\/\.\.\/src\/index\.ts';/gm)) {
      if (m[1] !== undefined) continue;
      for (const name of (m[2] as string).split(',').map((x) => x.trim()).filter(Boolean)) assert.ok(name in api, name);
    }
  });
  it('reads no other tool\'s result file: no importer, no promptfoo or Inspect or skill-evals name in its code', () => {
    const code = source.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /promptfoo|inspect_ai|skill-evals|examples\/importers/i);
  });
});

describe('the example input beside the script', () => {
  const example = join(root, 'examples', 'run-format', 'input', 'recorded.json');
  it('examples/run-format/input/recorded.json is an input the script takes: it writes a run that parses, states every identity field, and gates against the example bar', () => {
    const input = JSON.parse(readFileSync(example, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(input['bar'], bar, 'the bar in the example input is examples/run-format/bar.json');
    const outPath = join(work, 'from-example.json');
    const r = node(writer, ['--in', example, '--out', outPath]);
    assert.equal(r.status, 0, r.stderr);
    const file = parseRunArtifact(JSON.parse(readFileSync(outPath, 'utf8')));
    assert.deepEqual(IDENTITY_FIELDS.filter((f) => file.identity[f] === 'UNKNOWN'), []);
    assert.equal(file.cases.length, 3);
    assert.equal(file.draws.length, 6);
    // Worst of two draws under a floor at label 4: q01 and q02 pass, q03 holds a 2 and fails; 2/3 = 0.667 meets the bar of 0.5.
    const g = gate(outPath);
    assert.equal(g.status, 0, g.stderr);
    assert.match(g.stdout, /reply_quality {3}floor {11}2\/3 0\.667 {5}2\/3 0\.667, 0 new {6}0\.500 {3}ok/);
  });
  it('the finished run file of the folder is not an input: the script refuses it as invalid input, naming its keys', () => {
    const r = node(writer, ['--in', join(root, 'examples', 'run-format', 'run.json'), '--out', join(work, 'from-run.json')]);
    assert.equal(r.status, 65);
    assert.match(r.stderr, /unknown key "schema", "packetBasis"/);
  });
});
