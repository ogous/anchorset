// Writes a run file (`anchorset.run/v3`) from what a harness of your own recorded, and writes down nothing else.
//
//   node examples/run-format/write-run.ts --in <input.json> --out <run.json>
//
// An example input is beside this script: `input/recorded.json` (three cases, two draws each, graded by code, every identity field
// stated). `run.json` in this folder is not an input: it is a finished run file, written by `generate.ts`.
//
// It reads no other tool's result file and calls nothing. It imports from the library's public entry (`../../src/index.ts`) and
// Node built-ins only. Every identity field the input does not state is written as "UNKNOWN", a stop the input does not state is
// "UNKNOWN", and a seed the input does not state is "UNKNOWN": nothing is defaulted, inferred or copied from another field. `gate`
// refuses a file with an unknown identity field or an unknown stop (IDENTITY_GAP, naming what is missing), which is the file telling the truth
// about itself; fill the gaps in your harness (the input), not by editing the run.
//
// The input is one closed JSON object (an unknown key is invalid input):
//
//   {
//     "graded": "by-code" | "by-judge",                 required: whether a judge graded the outputs
//     "bar": { "labels": [...], "classes": {...}, "knownFailures": [...] },        the bar file's content
//     "cases": [ { "id": "q01", "klass": "<class of the bar>", "input": <any JSON>, "expect": "<label of the bar>" } ],
//     "drawsPerCase": 2,
//     "identity": { "<field>": "<value>", ... },        only what you state; see below
//     "callShapes": { "system": {<anchorset.callshape/v1>}, "judge": {<anchorset.callshape/v1>} },   optional; absent = every key "UNKNOWN"
//     "draws": [ { "case": "q01", "draw": 0, "attempts": [ <attempt>, ... ] }, ... ]
//   }
//
// `identity` may state: rubricHash, systemModelRequested, systemModelServed, systemPromptHash, systemToolsHash, systemHarnessVersion, seed,
// and, when "graded" is "by-judge", judgeDefinitionHash, judgeModelRequested, judgeModelServed, judgeHarnessVersion. It may not state
// the four the file derives from what it holds (caseSetHash, barHash, drawsPerCase, and the two call-shape hashes, which are hashes of the call
// shapes), and when "graded" is "by-code" the five judge fields are NO_JUDGE and may not be stated.
//
// An attempt is one of:
//   { "output": "<text>", "label": "<label of the bar>", "stop": "<stop>", "judgeStop": "<stop>" }     graded; "stop" is
//        end | stop-sequence | tool-use | max-tokens | content-filter | refusal | other | UNKNOWN, left out = UNKNOWN; "judgeStop" is required
//        when "graded" is "by-judge" and not allowed otherwise
//   { "failed": "truncated" | "client-error" | "system-error", "detail": "<text>", "stop": "<stop> | NOT_SENT" }     the system's own failure
//   { "unmeasured": "<reason>", "role": "system", "detail": "<text>" }                                         no response from the system
//   { "unmeasured": "<reason>", "role": "judge", "detail": "<text>", "output": "<text>", "stop": "<stop>" }   the judge could not grade
// The last attempt of a draw is its outcome; every earlier one must be unmeasured (a retry), for a reason that is not final: a judge's
// parse-failure, content-filter and client-error end the slot. A judged run's packet hashes are written as
// "UNKNOWN" and its packet basis as "UNKNOWN": this tool cannot record what the judge was shown, so `flips` refuses such a file (IDENTITY_GAP,
// naming packetBasis). The verdict and exit code of `gate` read no packet: it refuses such a file only for an identity field or a stop that is
// unknown (a judged run with every identity field stated, and its packets UNKNOWN, passes `gate`). Under `gate --rejudge-of`, though, the
// judge-and-system split is not computed for such a file (PACKET_MISMATCH, naming packetBasis); the verdict is unchanged. A harness that
// records the packets writes them itself.
//
// A label or an expected label that is not a label of the bar, and a case whose class is not a class of the bar, is invalid input
// (UNKNOWN_LABEL, UNKNOWN_CLASS), checked before anything is written.
//
// Exit codes: 0 written, 64 usage, 65 invalid input (a file that is not JSON, or an input that does not describe a run), 70 an unforeseen error.
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { barHash, CALL_SHAPE_SCHEMA, callShapeHash, caseSetHash, FAIL_REASONS, GAP, hashOf, InputError, JUDGE_UNMEASURED_REASONS, NO_JUDGE, NOT_SENT, oneLine, outputHashOf, parseBarFile, parseJsonBytes, parseRunArtifact, RUN_SCHEMA, STOPS, TRANSPORT_REASONS } from '../../src/index.ts';
import type { Attempt, Case, Draw, RunArtifact } from '../../src/index.ts';

export const USAGE = 'usage: node examples/run-format/write-run.ts --in <input.json> --out <run.json>';
const CALL_SHAPE_KEYS = [
  'endpoint', 'apiVersion', 'betaFlags', 'thinkingMode', 'thinkingBudgetTokens', 'effort', 'toolChoice', 'toolChoiceName', 'strictTools', 'parallelToolUse', 'temperature', 'topP', 'topK',
  'frequencyPenalty', 'presencePenalty', 'samplingSeed', 'maxOutputTokens', 'stopSequences', 'responseFormat', 'contextPolicy', 'stream', 'timeoutMs', 'extras',
] as const;
const STATED_ALWAYS = ['rubricHash', 'systemModelRequested', 'systemModelServed', 'systemPromptHash', 'systemToolsHash', 'systemHarnessVersion', 'seed'] as const;
const STATED_WITH_JUDGE = ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeHarnessVersion'] as const;
const DERIVED = ['caseSetHash', 'barHash', 'drawsPerCase', 'systemCallShapeHash', 'judgeCallShapeHash'] as const;
const INPUT_KEYS = ['graded', 'bar', 'cases', 'drawsPerCase', 'identity', 'callShapes', 'draws'] as const;

class Usage extends Error {}
/** An input that does not describe a run is invalid input (exit 65), as in the library; exit 2 is the library's, for a comparison it refused. */
const refuse = (message: string): never => {
  throw new InputError('INVALID_ARGUMENT', [message]);
};
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const closed = (o: Obj, allowed: readonly string[], at: string): void => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) refuse(`${at}: unknown key ${extra.map((k) => JSON.stringify(k)).join(', ')} (the input is closed; allowed: ${allowed.join(', ')})`);
};
const need = (o: Obj, key: string, at: string): unknown => (key in o ? o[key] : refuse(`${at}: ${key} is required`));
const str = (v: unknown, at: string): string => (typeof v === 'string' ? v : refuse(`${at} must be a string`));

/** The shape with every key "UNKNOWN": what a harness that states nothing about its call has said. */
function unknownShape(): Obj {
  return { schema: CALL_SHAPE_SCHEMA, ...Object.fromEntries(CALL_SHAPE_KEYS.map((k) => [k, GAP])) };
}

function stopOf(v: unknown, at: string, allowNotSent: boolean, name = 'stop'): string {
  if (v === undefined) return allowNotSent ? refuse(`${at}.${name} is required (a stop word or ${NOT_SENT}): a failed attempt's stop is never guessed`) : GAP;
  const s = str(v, `${at}.${name}`);
  if ((STOPS as readonly string[]).includes(s) || s === GAP || (allowNotSent && s === NOT_SENT)) return s;
  return refuse(`${at}.${name} is ${JSON.stringify(s)}; it is one of ${STOPS.join(', ')}, ${GAP}${allowNotSent ? `, ${NOT_SENT}` : ''}`);
}

/** The run for an input, or a refusal; nothing is read but what is handed in. */
export function runFor(input: unknown): { run: RunArtifact; unknown: string[] } {
  if (!isObj(input)) return refuse('the input must be one JSON object');
  closed(input, INPUT_KEYS, 'input');
  const graded = need(input, 'graded', 'input');
  if (graded !== 'by-code' && graded !== 'by-judge') return refuse('input.graded must be "by-code" or "by-judge"');
  const byJudge = graded === 'by-judge';

  const bar = parseBarFile(need(input, 'bar', 'input'));
  const casesIn = need(input, 'cases', 'input');
  if (!Array.isArray(casesIn) || casesIn.length === 0) return refuse('input.cases must be a non-empty list');
  const cases: Case[] = casesIn.map((c, i) => {
    if (!isObj(c)) return refuse(`input.cases[${i}] must be an object`);
    closed(c, ['id', 'klass', 'input', 'expect'], `input.cases[${i}]`);
    return { id: str(need(c, 'id', `input.cases[${i}]`), `input.cases[${i}].id`), klass: str(need(c, 'klass', `input.cases[${i}]`), `input.cases[${i}].klass`), input: need(c, 'input', `input.cases[${i}]`), expect: str(need(c, 'expect', `input.cases[${i}]`), `input.cases[${i}].expect`) } as Case;
  });
  const { labels, classes } = bar;
  const unknownClass = cases.filter((c) => !Object.hasOwn(classes, c.klass)).map((c) => `case "${c.id}": class ${JSON.stringify(c.klass)} is not a class of the bar (${Object.keys(classes).join(', ')})`);
  if (unknownClass.length > 0) throw new InputError('UNKNOWN_CLASS', unknownClass);
  const unknownExpect = cases.filter((c) => !labels.includes(c.expect)).map((c) => `case "${c.id}": expect ${JSON.stringify(c.expect)} is not a label of the bar (${labels.join(', ')})`);
  if (unknownExpect.length > 0) throw new InputError('UNKNOWN_LABEL', unknownExpect);
  const drawsPerCase = need(input, 'drawsPerCase', 'input');
  if (typeof drawsPerCase !== 'number' || !Number.isInteger(drawsPerCase) || drawsPerCase < 1) return refuse('input.drawsPerCase must be a positive integer');

  // The identity: what is stated, and "UNKNOWN" for the rest.
  const stated = input['identity'] === undefined ? {} : input['identity'];
  if (!isObj(stated)) return refuse('input.identity must be an object');
  const allowed: readonly string[] = [...STATED_ALWAYS, ...(byJudge ? STATED_WITH_JUDGE : [])];
  const derived = Object.keys(stated).filter((k) => (DERIVED as readonly string[]).includes(k) || (!byJudge && (STATED_WITH_JUDGE as readonly string[]).includes(k)));
  if (derived.length > 0) return refuse(`input.identity states ${derived.join(', ')}, which the file derives from what it holds${byJudge ? '' : ' (or, for a run graded by code, is NO_JUDGE)'}; state the things they come from, not the hashes`);
  closed(stated, allowed, 'input.identity');
  const identity: Obj = {};
  const left: string[] = [];
  for (const f of [...STATED_ALWAYS, ...STATED_WITH_JUDGE]) {
    if (!byJudge && (STATED_WITH_JUDGE as readonly string[]).includes(f)) identity[f] = NO_JUDGE;
    else if (f in stated) identity[f] = stated[f];
    else {
      identity[f] = GAP;
      left.push(f);
    }
  }

  // The call shapes: stated whole, or every key "UNKNOWN" (and then the hash is "UNKNOWN" too).
  const shapesIn = input['callShapes'] === undefined ? {} : input['callShapes'];
  if (!isObj(shapesIn)) return refuse('input.callShapes must be an object');
  closed(shapesIn, byJudge ? ['system', 'judge'] : ['system'], 'input.callShapes');
  const system = shapesIn['system'] === undefined ? unknownShape() : shapesIn['system'];
  const judge = byJudge ? (shapesIn['judge'] === undefined ? unknownShape() : shapesIn['judge']) : NO_JUDGE;
  if (!isObj(system) || (byJudge && !isObj(judge))) return refuse('input.callShapes.system and .judge must be objects');
  const systemHash = callShapeHash(system as never);
  const judgeHash = byJudge ? callShapeHash(judge as never) : NO_JUDGE;
  if (systemHash === GAP) left.push('systemCallShapeHash');
  if (byJudge && judgeHash === GAP) left.push('judgeCallShapeHash');

  // The draws.
  const drawsIn = need(input, 'draws', 'input');
  if (!Array.isArray(drawsIn)) return refuse('input.draws must be a list');
  const draws: Draw[] = drawsIn.map((d, i) => {
    const at = `input.draws[${i}]`;
    if (!isObj(d)) return refuse(`${at} must be an object`);
    closed(d, ['case', 'draw', 'attempts'], at);
    const index = need(d, 'draw', at);
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return refuse(`${at}.draw must be a non-negative integer`);
    const attemptsIn = need(d, 'attempts', at);
    if (!Array.isArray(attemptsIn) || attemptsIn.length === 0) return refuse(`${at}.attempts must be a non-empty list`);
    return { caseId: str(need(d, 'case', at), `${at}.case`), drawIndex: index, attempts: attemptsIn.map((a, j) => attemptOf(a, `${at}.attempts[${j}]`, byJudge)) };
  });

  const unknownLabels = draws.flatMap((d) => d.attempts.flatMap((a, j) => (a.kind === 'graded' && !labels.includes(a.label) ? [`draw ${d.caseId}#${d.drawIndex}, attempt ${j}: label ${JSON.stringify(a.label)} is not a label of the bar (${labels.join(', ')})`] : [])));
  if (unknownLabels.length > 0) throw new InputError('UNKNOWN_LABEL', unknownLabels);

  const run: RunArtifact = {
    schema: RUN_SCHEMA,
    identity: { ...identity, caseSetHash: caseSetHash(cases), barHash: barHash(bar), systemCallShapeHash: systemHash, judgeCallShapeHash: judgeHash, drawsPerCase } as RunArtifact['identity'],
    callShapes: { system: system as never, judge: judge as never },
    cases,
    draws,
    packetBasis: byJudge ? GAP : NO_JUDGE,
  };
  // The library's own parser, on the exact value that is about to be written.
  const parsed = parseRunArtifact(JSON.parse(JSON.stringify(run)));
  return { run: parsed, unknown: left };
}

function attemptOf(a: unknown, at: string, byJudge: boolean): Attempt {
  if (!isObj(a)) return refuse(`${at} must be an object`);
  if ('output' in a || 'label' in a) {
    closed(a, ['output', 'label', 'stop', 'judgeStop'], at);
    const output = str(need(a, 'output', at), `${at}.output`);
    const label = str(need(a, 'label', at), `${at}.label`);
    if (!byJudge && 'judgeStop' in a) return refuse(`${at}.judgeStop is not allowed in a run graded by code`);
    const judgeStop = byJudge ? stopOf(need(a, 'judgeStop', at), at, false, 'judgeStop') : NO_JUDGE;
    if (byJudge && judgeStop === GAP) return refuse(`${at}.judgeStop must be a stop word: a graded attempt's judge stop is never "${GAP}"`);
    return { kind: 'graded', label, outputHash: outputHashOf(output), systemStop: stopOf(a['stop'], at, false) as never, judgeStop: judgeStop as never, packetHash: (byJudge ? GAP : NO_JUDGE) as never };
  }
  if ('failed' in a) {
    closed(a, ['failed', 'detail', 'stop'], at);
    const reason = str(a['failed'], `${at}.failed`);
    if (!(FAIL_REASONS as readonly string[]).includes(reason)) return refuse(`${at}.failed is ${JSON.stringify(reason)}; it is one of ${FAIL_REASONS.join(', ')}`);
    const detail = str(need(a, 'detail', at), `${at}.detail`);
    return { kind: 'failed', reason: reason as never, detail, outputHash: outputHashOf({ failed: reason, detail }), systemStop: stopOf(a['stop'], at, true) as never };
  }
  if ('unmeasured' in a) {
    const reason = str(a['unmeasured'], `${at}.unmeasured`);
    const role = need(a, 'role', at);
    if (role === 'system') {
      closed(a, ['unmeasured', 'role', 'detail'], at);
      if (!(TRANSPORT_REASONS as readonly string[]).includes(reason)) return refuse(`${at}.unmeasured is ${JSON.stringify(reason)}; for the system it is one of ${TRANSPORT_REASONS.join(', ')}`);
      return { kind: 'unmeasured', role: 'system', reason: reason as never, detail: str(need(a, 'detail', at), `${at}.detail`) };
    }
    if (role === 'judge') {
      if (!byJudge) return refuse(`${at}: a run graded by code has no judge attempts`);
      closed(a, ['unmeasured', 'role', 'detail', 'output', 'stop'], at);
      if (!(JUDGE_UNMEASURED_REASONS as readonly string[]).includes(reason)) return refuse(`${at}.unmeasured is ${JSON.stringify(reason)}; for the judge it is one of ${JUDGE_UNMEASURED_REASONS.join(', ')}`);
      return { kind: 'unmeasured', role: 'judge', reason: reason as never, detail: str(need(a, 'detail', at), `${at}.detail`), outputHash: outputHashOf(str(need(a, 'output', at), `${at}.output`)), systemStop: stopOf(a['stop'], at, false) as never, packetHash: GAP };
    }
    return refuse(`${at}.role must be "system" or "judge"`);
  }
  return refuse(`${at} is none of a graded attempt (output, label), a failed one (failed), or an unmeasured one (unmeasured)`);
}

type Io = { out: (line: string) => void; err: (line: string) => void };

export function main(argv: readonly string[], given: Io): number {
  // Every printed line goes through the library's one-line escaper: a problem, a refusal and a path hold text of the files read
  // and of the command line, and none of it may erase or forge a line.
  const io: Io = { out: (s) => given.out(oneLine(s)), err: (s) => given.err(oneLine(s)) };
  try {
    const flags = new Map<string, string>();
    for (let k = 0; k < argv.length; k += 2) {
      const flag = argv[k] as string;
      if (flag !== '--in' && flag !== '--out') throw new Usage(`unknown argument ${JSON.stringify(flag)}. ${USAGE}`);
      if (flags.has(flag)) throw new Usage(`${flag} given twice. ${USAGE}`);
      const value = argv[k + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Usage(`${flag} needs a value. ${USAGE}`);
      flags.set(flag, value);
    }
    const missing = ['--in', '--out'].filter((f) => !flags.has(f));
    if (missing.length > 0) throw new Usage(`missing ${missing.join(', ')}. ${USAGE}`);
    const [inPath, outPath] = [flags.get('--in') as string, flags.get('--out') as string];
    if (existsSync(outPath)) throw new Usage(`${outPath} exists; this tool never overwrites --out`);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(inPath);
    } catch (e) {
      throw new Usage(`cannot read ${inPath} (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    const read = parseJsonBytes(bytes);
    if ('problem' in read) throw new InputError('INVALID_ARGUMENT', [`${inPath}: ${read.problem}`]);
    const { run, unknown } = runFor(read.json);
    const fd = openSync(outPath, 'wx');
    try {
      writeSync(fd, `${JSON.stringify(run, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    io.out(`run written to ${outPath}`);
    io.out(`run hash: ${hashOf(run)}`);
    io.out(unknown.length === 0 ? 'identity fields left "UNKNOWN": none' : `identity fields left "UNKNOWN": ${unknown.join(', ')} (gate refuses this file with IDENTITY_GAP until they are stated)`);
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      io.err(`USAGE: ${e.message}`);
      return 64;
    }
    if (e instanceof InputError) {
      io.err(`anchorset: invalid input (${e.code})`);
      for (const p of e.problems) io.err(`  - ${p}`);
      io.err('  Nothing was written.');
      return 65;
    }
    io.err(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return 70;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
}
