// Writes the judge-change plan for the two run files of one comparison (an old judge's and a new judge's), from the
// library's public entry only (`../../src/index.ts`) and Node built-ins.
//
//   node examples/importers/make-plan.ts --old <run.json> --new <run.json> --bar <bar.json> --out <plan.json>
//        --system <label> --stored-outputs <system-side-not-compared | system-side-compared>
//        --measured-class <class> --cut <label> --label-rule <worst | majority> --pooling items-equal
//        --estimate-draws <i,j,...> --judge-moves <field,field,...>
//
// What it fills, and only that, is read from the two run files: the bar's hash, the case set's hash, the draws per case,
// the six judge fields of each side, and the sha256 of each file's bytes (the roster binds a run by it). What it never
// fills is a choice of the measurement: the system's label, the opt-in for the system side, the measured class, the cut,
// the label rule, the pooling, the draws that estimate and the judge fields that are meant to differ. Each is a flag, none has a
// default, and a missing one is a usage error. The bar is a file the user states.
//
// It holds no rule of its own about whether the plan is admissible, beyond refusing to copy a gap into a plan. The plan it built is handed, with the bar and the two files'
// bytes, to the library's `judgeChangeRuns`, which is what `anchorset judge-change` calls; whatever that refuses (a bar that is
// not the one the runs name, a class or a cut that does not fit, judge moves that are not exactly the fields that differ, runs of
// another comparison, a system side that cannot be compared) is printed with its code and its fields, and no plan is written. So a
// plan is written only when `judge-change` would read it. `--out` is never overwritten.
//
// Exit codes: 0 written, 2 refused (the library's refusal, or a run with no known value for a field a plan fixes), 64 usage,
// 65 invalid input (a file that does not parse, or a plan the library's parser rejects), 70 an unforeseen error.
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GAP, hashOf, InputError, JUDGE_CHANGE_PLAN_SCHEMA, judgeChangeRuns, oneLine, parseBarFile, parseJsonBytes, parseJudgeChangePlan, parseRunArtifact, RefusalError, sha256Hex } from '../../src/index.ts';
import type { RunArtifact } from '../../src/index.ts';

/** The six judge fields a plan holds for each side, in the order the plan writes them. */
const JUDGE_FIELDS = ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion', 'rubricHash'] as const;
type JudgeField = (typeof JUDGE_FIELDS)[number];
const FLAGS = ['--old', '--new', '--bar', '--out', '--system', '--stored-outputs', '--measured-class', '--cut', '--label-rule', '--pooling', '--estimate-draws', '--judge-moves'] as const;
export const USAGE = `usage: node examples/importers/make-plan.ts ${FLAGS.map((f) => `${f} <...>`).join(' ')}   (all required, none with a default)`;

class Usage extends Error {}

type Io = { out: (line: string) => void; err: (line: string) => void };

function parseFlags(argv: readonly string[]): Record<(typeof FLAGS)[number], string> {
  const got = new Map<string, string>();
  for (let k = 0; k < argv.length; k += 2) {
    const flag = argv[k] as string;
    if (!(FLAGS as readonly string[]).includes(flag)) throw new Usage(`unknown argument ${JSON.stringify(flag)}. ${USAGE}`);
    if (got.has(flag)) throw new Usage(`${flag} given twice. ${USAGE}`);
    const value = argv[k + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Usage(`${flag} needs a value. ${USAGE}`);
    got.set(flag, value);
  }
  const missing = FLAGS.filter((f) => !got.has(f));
  if (missing.length > 0) throw new Usage(`missing ${missing.join(', ')}. ${USAGE}`);
  return Object.fromEntries(got) as Record<(typeof FLAGS)[number], string>;
}

function readJson(path: string, what: string): { bytes: Uint8Array; json: unknown } {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new Usage(`${what}: cannot read ${path} (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  const read = parseJsonBytes(bytes);
  if ('problem' in read) throw new InputError('INVALID_ARGUMENT', [`${what}: ${read.problem}`]);
  return { bytes, json: read.json };
}

const list = (text: string, flag: string): string[] => {
  const items = text.split(',');
  if (items.some((i) => i === '' || i !== i.trim())) throw new Usage(`${flag} is a comma-separated list with no empty item and no space: ${JSON.stringify(text)}`);
  return items;
};

function judgeOf(run: RunArtifact, side: string): Record<JudgeField, string> {
  const id = run.identity as Record<string, unknown>;
  const judge = {} as Record<JudgeField, string>;
  const gaps: string[] = [];
  for (const f of JUDGE_FIELDS) {
    const v = id[f];
    if (typeof v !== 'string' || v === GAP) gaps.push(f);
    else judge[f] = v;
  }
  if (gaps.length > 0) throw new RefusalError('IDENTITY_GAP', gaps.map((f) => `${side}.${f}`), `the ${side} run holds no known value for ${gaps.join(', ')}: a plan fixes all six judge fields of each side, and this tool writes none that a run does not hold`);
  return judge;
}

/** The plan for the two runs, or the library's refusal of it. Pure but for the files it reads. */
export function planFor(flags: Record<(typeof FLAGS)[number], string>): { plan: Record<string, unknown>; oldSha: string; newSha: string } {
  const oldRead = readJson(flags['--old'], '--old');
  const newRead = readJson(flags['--new'], '--new');
  const old = parseRunArtifact(oldRead.json);
  const neu = parseRunArtifact(newRead.json);
  const barRead = readJson(flags['--bar'], '--bar');
  const bar = parseBarFile(barRead.json);

  // What a run holds is copied as it is. Whether the two runs, the bar and the choices fit together is the library's to say, below.
  const { barHash, caseSetHash, drawsPerCase } = old.identity;
  if (typeof drawsPerCase !== 'number') throw new RefusalError('IDENTITY_GAP', ['drawsPerCase'], 'the runs hold no known drawsPerCase');
  const judges = { old: judgeOf(old, 'old'), new: judgeOf(neu, 'new') };
  const stated = list(flags['--judge-moves'], '--judge-moves');
  const unknownMoves = stated.filter((f) => !(JUDGE_FIELDS as readonly string[]).includes(f));
  if (unknownMoves.length > 0) throw new Usage(`--judge-moves names ${unknownMoves.join(', ')}, which is not one of ${JUDGE_FIELDS.join(', ')}`);
  if (new Set(stated).size !== stated.length) throw new Usage(`--judge-moves names a field twice: ${stated.join(', ')}`);
  const judgeMoves = JUDGE_FIELDS.filter((f) => stated.includes(f));

  const estimate = list(flags['--estimate-draws'], '--estimate-draws').map((t) => {
    if (!/^(0|[1-9]\d*)$/.test(t)) throw new Usage(`--estimate-draws holds ${JSON.stringify(t)}, which is not a draw index`);
    return Number(t);
  });
  const rule = flags['--label-rule'];
  if (rule !== 'worst' && rule !== 'majority') throw new Usage(`--label-rule must be worst or majority, found ${JSON.stringify(rule)}`);
  if (flags['--pooling'] !== 'items-equal') throw new Usage(`--pooling must be items-equal, found ${JSON.stringify(flags['--pooling'])}`);
  const storedOutputs = flags['--stored-outputs'];
  if (storedOutputs !== 'system-side-not-compared' && storedOutputs !== 'system-side-compared') throw new Usage(`--stored-outputs must be system-side-not-compared or system-side-compared, found ${JSON.stringify(storedOutputs)}`);

  const oldSha = sha256Hex(oldRead.bytes);
  const newSha = sha256Hex(newRead.bytes);
  const plan: Record<string, unknown> = {
    schema: JUDGE_CHANGE_PLAN_SCHEMA,
    barHash,
    caseSetHash,
    drawsPerCase,
    judges,
    judgeMoves,
    systems: { [flags['--system']]: { old: oldSha, new: newSha } },
    storedOutputs,
    measuredClass: flags['--measured-class'],
    cut: flags['--cut'],
    drawSets: { estimate },
    labelRule: rule,
    pooling: 'items-equal',
  };
  // The library's own parser, then the library's own measurement, on the exact value that is about to be written: a plan is written
  // only when `judge-change` would read it with these two files and this bar. The report is not kept; it is not this tool's to print.
  const written = parseJudgeChangePlan(JSON.parse(JSON.stringify(plan)));
  judgeChangeRuns(
    [
      { name: 'old.json', bytes: oldRead.bytes },
      { name: 'new.json', bytes: newRead.bytes },
    ],
    bar,
    written,
  );
  return { plan, oldSha, newSha };
}

export function main(argv: readonly string[], given: Io): number {
  // Every printed line goes through the library's one-line escaper: a problem, a refusal and a path hold text of the files read
  // and of the command line, and none of it may erase or forge a line.
  const io: Io = { out: (s) => given.out(oneLine(s)), err: (s) => given.err(oneLine(s)) };
  try {
    const flags = parseFlags(argv);
    const out = flags['--out'];
    if (existsSync(out)) throw new Usage(`${out} exists; this tool never overwrites --out`);
    const { plan } = planFor(flags);
    const fd = openSync(out, 'wx');
    try {
      writeSync(fd, `${JSON.stringify(plan, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    io.out(`plan written to ${out}`);
    io.out(`plan hash: ${hashOf(plan)}`);
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      io.err(`USAGE: ${e.message}`);
      return 64;
    }
    if (e instanceof InputError) {
      io.err(`anchorset: invalid input (${e.code})`);
      for (const p of e.problems) io.err(`  - ${p}`);
      return 65;
    }
    if (e instanceof RefusalError) {
      io.err(`REFUSED ${e.code}`);
      io.err(`  fields: ${e.fields.join(', ')}`);
      io.err(`  ${e.message.slice(e.code.length + 2)}`);
      io.err('  Nothing was written.');
      return 2;
    }
    io.err(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return 70;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
}
