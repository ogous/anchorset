#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agreementReport, DEFAULT_BOOTSTRAP, RATER_IDENTITIES } from './agreement.ts';
import type { AgreementReport, RaterIdentity } from './agreement.ts';
import { parseRunArtifact } from './artifact.ts';
import { noLevelNote, resampleBracketWording, resamplesText, suppliedPercentilesWording } from './stats.ts';
import type { BootstrapOptions, PercentileInterval } from './stats.ts';
import { driftReport } from './drift.ts';
import type { DriftReport } from './drift.ts';
import { InputError, RefusalError } from './errors.ts';
import { barHash, parseBarFile } from './gate.ts';
import { appendAll, findIllFormed, IDENTITY_FIELDS, isSha256Hex, MAX_JSON_DEPTH, NO_JUDGE, oneLine, parseJsonBytes, sha256Hex } from './identity.ts';
import { judgeChangeRuns, NOT_DECLARED, parseJudgeChangePlan, SPREAD_ALPHA, spreadPercentilesWording } from './judgechange.ts';
import type { JudgeChangeInput, JudgeChangeReport, PairGate, Placebo, Withheld } from './judgechange.ts';
import type { FoldCut } from './cutmap.ts';
import type { FoldedCase, JudgeRetries } from './scoring.ts';
import type { IdentityField } from './identity.ts';
import { appendRecord, checkLedgerFile, makeGateRecord, makeJudgeChangeRecord, makeRatingsRecord } from './ledger.ts';
import { EXIT_CODES, gateExitCode, gateRuns, REJUDGE_BOOTSTRAP_DEFAULTS } from './regression.ts';
import { extraKeys, finalAttempt, incompleteDetail } from './scoring.ts';
import { repeatFlips, STORED_OUTPUTS_DECLARED } from './flips.ts';
import { unknownOutputHashes } from './stability.ts';
import type { FlipShare, RepeatFlipReport } from './stability.ts';
import type { GateRunResult, JudgeControl } from './regression.ts';
import type { BootstrapResult } from './stats.ts';
import type { JudgeControlledDelta } from './drift.ts';
import { ANCHOR_SCHEMA, RATINGS_SCHEMA, REPORT_SCHEMAS, TOOL_NAME, TOOL_VERSION } from './version.ts';

const USAGE_GATE = `  anchorset gate --baseline <run.json> --candidate <run.json> --bar <bar.json>
                 [--allow-differ field,field] [--ledger <path>] [--json]
                 [--rejudge-of <run.json> [--bootstrap-seed <uint32>]]
      --rejudge-of: --baseline is the baseline's outputs re-graded by the candidate's judge;
      this is the baseline as first graded. The gate runs against the re-judged baseline and
      reports the reported move, the judge's movement and the system's movement.
      That split is computed only when both baselines recorded the same packet hash for every
      draw; otherwise it is not computed (PACKET_MISMATCH, naming the draws), and the verdict
      and exit code are unchanged.
      --ledger: appends one record: the identities the runs declared (three with --rejudge-of, and its bootstrap),
      the bar's hash, the flags and the summary of the result; it holds no hash of the run files. A refused gate is
      recorded too.`;
const USAGE_AGREE = `  anchorset agree --ratings <file.json> [--ledger <path>] [--json]
      Agreement between raters who were shown the same packets: kappa with Gwet's AC1, prevalence
      and a seeded bootstrap interval for each, overall and, where the file says its names are persistent
      raters, for every pair. The seed is the file's. A measurement: it never exits 1.`;
const USAGE_DRIFT = `  anchorset drift --old <file.json> --new <file.json> --flag <label,...>
                  [--bootstrap-seed <uint32>] [--ledger <path>] [--json]
      One judge's verdicts on the same anchor items, before and after. Both files must carry a
      packet hash for every item, and the two must be equal. A rating file names no judge, so that
      both came from one judge is not shown. A measurement: it never exits 1.`;
const USAGE_LEDGER_NOTE = `      --ledger (agree, drift): appends one record of the report: the sha256 of every file read,
      the seed, and the report itself.`;
const USAGE_FLIPS = `  anchorset flips --run <run.json> [--stored-outputs system-side-not-compared] [--bootstrap-seed <uint32>] [--json]
      Label flips among the repeat draws of one run. Cases whose draws graded one stored output
      (the grader's variation alone) and cases whose draws hold different outputs (system and
      grader variation mixed) are reported apart and never pooled. A measurement: it never exits 1.
      --stored-outputs: says the graded texts are stored ones whose system stop nobody observed. Needs recorded
      packets, a known judge and rubric, one output in each case, and at least one unknown stop. It is not
      recorded in any hash.`;
const USAGE_JUDGE_CHANGE = `  anchorset judge-change --plan <plan.json> --bar <bar.json> --inputs <dir> [--ledger <path>] [--json]
      Two judges graded the same stored outputs; reports what changed in the labels. <dir> must hold
      only the files the plan names by sha256, and may also hold the plan, the bar and the --ledger file,
      which are skipped. A measurement, not a gate: it never exits 1.
      --ledger: appends one record of the report: the plan's hash, the sha256 of every file read,
      every seed, and the report itself. The record is not signed: it says what was read, and
      verifying it means recomputing the report from the files.`;

const USAGE_FOOTER = `anchorset --version prints the version; anchorset <command> --help prints one command's usage.

every file read, by every command: UTF-8 text with no byte-order mark; no object gives a key twice;
objects and lists nest at most ${MAX_JSON_DEPTH} deep; every number is finite. Anything else, a file that cannot be read included, is invalid input (65).
The exit code is the command's own whether or not anything still reads its output.

--json prints one JSON object that names its contract in "schema" and the tool in "tool", except judge-change, whose report names its
contracts in "contracts". A refusal under --json is the object {"schema": "${REPORT_SCHEMAS.refusal}", "tool", "kind": "refused", "command",
"code", "fields", "message", "exitCode": 2}, on stdout, for every command;
usage errors and invalid input stay text on stderr.

exit codes: 0 ok · 1 regression · 2 refused comparison · 64 usage · 65 invalid input · 70 internal error`;

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  gate: USAGE_GATE,
  agree: `${USAGE_AGREE}\n${USAGE_LEDGER_NOTE}`,
  drift: `${USAGE_DRIFT}\n${USAGE_LEDGER_NOTE}`,
  flips: USAGE_FLIPS,
  'judge-change': USAGE_JUDGE_CHANGE,
};

const USAGE = `usage:
${[USAGE_GATE, USAGE_AGREE, USAGE_DRIFT, USAGE_LEDGER_NOTE, USAGE_FLIPS, USAGE_JUDGE_CHANGE].join('\n')}

${USAGE_FOOTER}`;

/** The usage text of one subcommand (with the footer that holds for all), or the whole text for anything else. */
function usageFor(cmd: string | undefined): string {
  const one = cmd !== undefined && Object.hasOwn(COMMAND_USAGE, cmd) ? COMMAND_USAGE[cmd] : undefined;
  return one === undefined ? USAGE : `usage:\n${one}\n\n${USAGE_FOOTER}`;
}

class UsageError extends Error {}

type Io = { out: (s: string) => void; err: (s: string) => void };

/** The printer of a text report: each call is one line, whatever the text holds. An empty line is a call of its own. Also study-check's. */
export function textIo(io: Io): Io {
  return { out: (s) => io.out(oneLine(s)), err: (s) => io.err(oneLine(s)) };
}

type FlagKind = 'string' | 'boolean';

function parseFlags(argv: readonly string[], spec: Record<string, FlagKind>, required: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    // Own properties only: "--constructor" or "--__proto__" is an unknown flag, not a flag that Object.prototype defines.
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (kind === undefined) throw new UsageError(`unknown flag --${name}`);
    if (flags.has(name)) throw new UsageError(`--${name} given twice`);
    if (kind === 'boolean') {
      flags.set(name, true);
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
      i++;
    }
  }
  const missing = required.filter((r) => !flags.has(r));
  if (missing.length === 1) throw new UsageError(`--${missing[0]} is required`);
  if (missing.length > 1) throw new UsageError(`${missing.map((r) => `--${r}`).join(', ')} are required`);
  return flags;
}

function str(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function list(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** One read of a JSON file: what it parses to, and the bytes that were parsed. */
function readJsonFile(path: string): { json: unknown; bytes: Uint8Array } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new InputError('INVALID_ARGUMENT', [`cannot read ${path}: ${(e as Error).message}`]);
  }
  // Bytes that are not UTF-8 (never replaced: two files that differ in such a byte would read as one text), a byte-order
  // mark, a text that is not JSON, one nested too deep, or one in which an object gives a key twice.
  const parsed = parseJsonBytes(bytes);
  if ('problem' in parsed) throw new InputError('INVALID_ARGUMENT', [`${path}: ${parsed.problem}`]);
  return { json: parsed.json, bytes };
}

const readJson = (path: string): unknown => readJsonFile(path).json;

const short = (v: string | number): string => (typeof v === 'string' && isSha256Hex(v) ? `${v.slice(0, 12)}…` : String(v));
/** A cell of a text table: padded to its column's width, and one space is kept after a cell that fills the column or is wider, so two cells never join. */
const pad = (s: string, n: number): string => (s.length >= n ? `${s} ` : s.padEnd(n));
const fmt = (x: number | string): string => (typeof x === 'number' ? x.toFixed(3) : x);

/** A refusal as three lines: its code, the fields it names, its reason. Also study-check's. */
export function printRefusal(io: Io, r: RefusalError): void {
  io.err(`REFUSED ${r.code}`);
  io.err(`  fields: ${r.fields.join(', ')}`);
  io.err(`  ${r.message.slice(r.code.length + 2)}`);
}

/** The first two keys of every `--json` object but the judge-change report's (which carries its own `contracts`): its contract string and the tool. */
function contract(schema: string): { schema: string; tool: { name: string; version: string } } {
  return { schema, tool: { name: TOOL_NAME, version: TOOL_VERSION } };
}

/** The one object a command prints under `--json` when it refuses: the same keys for every command, exit code included. */
function refusalJson(command: string, r: RefusalError): Record<string, unknown> {
  return { ...contract(REPORT_SCHEMAS.refusal), kind: 'refused', command, code: r.code, fields: [...r.fields], message: r.message, exitCode: EXIT_CODES.REFUSED };
}

/** How many of a class's candidate cases are new: a whole number from the result, or nothing is printed as a count. */
function newCaseCount(result: Extract<GateRunResult, { kind: 'evaluated' }>, klass: string): number {
  const n = result.newCases.find((x) => x.klass === klass)?.count;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new TypeError(`new cases of class "${klass}": expected a whole number, got ${String(n)}`);
  return n;
}

function gateSummary(result: GateRunResult): Record<string, unknown> {
  if (result.kind === 'refused') {
    return { exitCode: EXIT_CODES.REFUSED, refused: result.refusal.code, fields: [...result.refusal.fields] };
  }
  return {
    exitCode: gateExitCode(result),
    pass: result.gate.pass,
    classes: result.gate.classes.map((c) => ({ klass: c.klass, passed: c.passed, total: c.total, newCases: newCaseCount(result, c.klass), missing: c.missingCaseIds, meetsBar: c.meetsBar })),
    broke: result.diff.filter((d) => d.status === 'BROKE').map((d) => d.caseId),
    fixed: result.diff.filter((d) => d.status === 'FIXED').map((d) => d.caseId),
    missing: result.gate.missingCaseIds,
    incomplete: result.incomplete.candidate.map((x) => ({ caseId: x.caseId, missing: x.missing, unmeasured: x.unmeasured, measuredFailure: x.measuredFailure })),
    ...(result.judgeControl === undefined ? {} : { judgeControl: judgeControlSummary(result.judgeControl) }),
  };
}

function judgeControlSummary(jc: JudgeControl): Record<string, unknown> {
  if ('refused' in jc) return { refused: jc.refused.code, fields: [...jc.refused.fields] };
  const o = jc.overall;
  const ci = (b: BootstrapResult): number[] => [b.lo, b.hi];
  const parts = (d: JudgeControlledDelta): Record<string, unknown> => ({
    itemCount: d.itemCount,
    reportedDelta: d.reportedDelta.estimate,
    judgeEffect: d.judgeEffect.estimate,
    systemEffect: d.systemEffect.estimate,
    reportedDeltaCI: ci(d.reportedDelta),
    judgeEffectCI: ci(d.judgeEffect),
    systemEffectCI: ci(d.systemEffect),
  });
  return {
    seed: o.judgeEffect.seed,
    iterations: o.judgeEffect.iterations,
    alpha: o.judgeEffect.alpha,
    ...parts(o),
    perClass: Object.fromEntries(Object.entries(jc.perClass).map(([k, d]) => [k, parts(d)])),
    // Counts and case ids, as the result holds them: a non-compensable class has no rate to summarise.
    nonCompensable: jc.nonCompensable,
    emptyClasses: [...jc.emptyClasses],
  };
}

function printJudgeControl(io: Io, jc: JudgeControl): void {
  if ('refused' in jc) {
    const fields = jc.refused.fields.length > 0 ? jc.refused.fields.join(', ') : jc.refused.message.slice(jc.refused.code.length + 2);
    io.out(`judge-controlled: not computed (${jc.refused.code}: ${fields}); this does not change the exit code`);
    // A packet refusal is the one a user can act on by re-judging, so it says how.
    if (jc.refused.code === 'PACKET_MISMATCH') io.out(`  ${jc.refused.message.slice(jc.refused.code.length + 2)}`);
    io.out('');
    return;
  }
  const b = jc.overall.judgeEffect;
  // Each of the three is a difference of two pass shares over the same cases, a smooth statistic: the one wording.
  io.out(`judge-controlled, against the baseline as first judged (${resampleBracketWording('cases', 'the folded labels of the three runs', b)}; ${resamplesText(b.iterations)}, seed ${b.seed}):`);
  // The bracket as every other report prints it: a degenerate one (lo = hi) says it is not a bound.
  const part = (name: string, r: BootstrapResult): string => `${name}  ${fmt(r.estimate)} ${bracket(r)}`;
  // Every row says how many cases it is over.
  const head = (label: string, n: number): string => `  ${pad(label, 14)}${pad(`n ${n}`, 8)}`;
  const row = (label: string, d: JudgeControlledDelta): void =>
    io.out(`${head(label, d.itemCount)}${part('reported', d.reportedDelta)}   ${part('judge', d.judgeEffect)}   ${part('system', d.systemEffect)}`);
  row('overall', jc.overall);
  for (const [k, d] of Object.entries(jc.perClass)) row(k, d);
  // A non-compensable class: counts and case ids, never a rate or a bracket. A net rate there can show no
  // movement while one case newly fails and another newly passes; the ids show both.
  const strict = jc.nonCompensable;
  if (strict.length > 0) {
    const cases = strict.reduce((s, x) => s + x.n, 0);
    const ids = (xs: readonly string[]): string => (xs.length === 0 ? '0' : `${xs.length} (${xs.join(', ')})`);
    const RUNS = { originalBaseline: 'original baseline', rejudgedBaseline: 're-judged baseline', candidate: 'candidate' } as const;
    io.out(`  the overall row includes the ${cases} case${cases === 1 ? '' : 's'} of the non-compensable class${strict.length === 1 ? '' : 'es'} ${strict.map((x) => x.klass).join(', ')}; such a class gets counts and case ids, never a rate or a bracket:`);
    for (const x of strict) {
      io.out(`${head(x.klass, x.n)}failing: ${RUNS.originalBaseline} ${ids(x.failing.originalBaseline)} · ${RUNS.rejudgedBaseline} ${ids(x.failing.rejudgedBaseline)} · ${RUNS.candidate} ${ids(x.failing.candidate)}`);
      for (const t of x.transitions) io.out(`    ${RUNS[t.from]} -> ${RUNS[t.to]}: newly failing ${ids(t.newlyFailing)} · newly passing ${ids(t.newlyPassing)}`);
    }
  }
  if (jc.emptyClasses.length > 0) io.out(`  no case complete in all three runs: ${jc.emptyClasses.join(', ')}`);
  io.out('');
}

/** "k of N draws fail" for one folded case. Both numbers must be whole and 0 <= k <= N, or nothing is printed as a count. */
function failingDrawsText(f: FoldedCase): string {
  const k = f.failingDraws;
  const n = f.drawCount;
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || k > n) throw new TypeError(`failing draws of case "${f.caseId}": expected whole numbers with 0 <= failing <= draws, got ${String(k)} of ${String(n)}`);
  return `${k} of ${n} draws fail`;
}

function printGate(io: Io, result: Extract<GateRunResult, { kind: 'evaluated' }>): void {
  if (result.allowedDifferences.length > 0) {
    io.out('allowed to differ:');
    for (const d of result.allowedDifferences) io.out(`  ${pad(d.field, 20)} ${short(d.baseline)} -> ${short(d.candidate)}`);
    io.out('');
  }
  io.out(`${pad('class', 16)}${pad('direction', 16)}${pad('baseline', 14)}${pad('candidate', 22)}${pad('bar', 8)}result`);
  for (const c of result.gate.classes) {
    const b = result.baselineGate.classes.find((x) => x.klass === c.klass);
    const dir = c.nonCompensable ? `${c.direction} (strict)` : c.direction;
    const base = b === undefined ? '-' : `${b.passed}/${b.total} ${fmt(b.rate)}`;
    let verdict = c.meetsBar ? 'ok' : 'FAIL';
    if (!c.meetsBar && c.nonCompensable && c.failedCaseIds.length > 0) verdict = 'FAIL (non-compensable)';
    else if (c.missingCaseIds.length > 0) verdict = 'FAIL (incomplete)';
    // The candidate's cell says how many of its cases are new: they are in the rate, and the baseline's cell is over fewer cases.
    const cand = `${c.passed}/${c.total} ${fmt(c.rate)}, ${newCaseCount(result, c.klass)} new`;
    io.out(`${pad(c.klass, 16)}${pad(dir, 16)}${pad(base, 14)}${pad(cand, 22)}${pad(c.minPassRate.toFixed(3), 8)}${verdict}`);
    if (c.knownFailureIds.length > 0) io.out(`  known failures (still counted): ${c.knownFailureIds.join(', ')}`);
    if (c.knownFailuresNowPassing.length > 0) io.out(`  known failures (now passing): ${c.knownFailuresNowPassing.join(', ')}`);
  }
  io.out('');
  const cand = new Map(result.folded.candidate.map((f) => [f.caseId, f]));
  for (const status of ['BROKE', 'FIXED'] as const) {
    const rows = result.diff.filter((d) => d.status === status);
    io.out(`${status} (${rows.length})`);
    for (const d of rows) {
      const f = cand.get(d.caseId);
      const a = f === undefined ? undefined : finalAttempt(f.attributedDraw);
      const out = a === undefined ? '' : a.kind === 'graded' ? a.label : a.kind === 'failed' ? `failed (${a.reason}): ${a.detail}` : `unmeasured (${a.role} ${a.reason})`;
      // A BROKE row ends with the count of failing draws, as two integers: never a share, a percentage or a bracket (the class table and the case diff print no interval).
      const count = status === 'BROKE' && f !== undefined ? `; ${failingDrawsText(f)}` : '';
      io.out(`  ${d.klass}/${d.caseId}  attributed draw #${f?.attributedDraw.drawIndex ?? '-'}: ${out}${count}`);
    }
  }
  for (const [name, list] of Object.entries(result.incomplete)) {
    for (const x of list) io.out(`incomplete ${name} case ${x.caseId}: ${incompleteDetail(x)}`);
  }
  if (result.gate.missingCaseIds.length > 0) io.out(`missing cases: ${result.gate.missingCaseIds.join(', ')}`);
  if (result.gate.extraCaseIds.length > 0) io.out(`extra cases: ${result.gate.extraCaseIds.join(', ')}`);
  if (result.judgeControl !== undefined) {
    io.out('');
    printJudgeControl(io, result.judgeControl);
  }
  const code = gateExitCode(result);
  if (result.judgeControl === undefined) io.out('');
  io.out(`verdict: ${code === EXIT_CODES.OK ? 'OK' : 'REGRESSION'} (exit ${code})`);
}

function cmdGate(argv: readonly string[], io: Io): number {
  const flags = parseFlags(
    argv,
    {
      baseline: 'string',
      candidate: 'string',
      bar: 'string',
      'allow-differ': 'string',
      ledger: 'string',
      json: 'boolean',
      'rejudge-of': 'string',
      'bootstrap-seed': 'string',
    },
    ['baseline', 'candidate', 'bar'],
  );
  const allowDiffer = list(str(flags, 'allow-differ') ?? '');
  const badFields = allowDiffer.filter((f) => !(IDENTITY_FIELDS as readonly string[]).includes(f));
  if (badFields.length > 0) throw new UsageError(`--allow-differ: unknown identity field(s) ${badFields.join(', ')}; the fields are ${IDENTITY_FIELDS.join(', ')}`);
  const rejudgePath = str(flags, 'rejudge-of');
  const seedFlag = str(flags, 'bootstrap-seed');
  if (seedFlag !== undefined && rejudgePath === undefined) throw new UsageError('--bootstrap-seed only applies with --rejudge-of');
  if (seedFlag !== undefined && !/^\d+$/.test(seedFlag)) throw new UsageError('--bootstrap-seed must be a uint32 integer');
  const seed = seedFlag === undefined ? REJUDGE_BOOTSTRAP_DEFAULTS.seed : Number(seedFlag);
  if (seed > 0xffffffff) throw new UsageError('--bootstrap-seed must be a uint32 integer');
  const parseRun = (flag: string, path: string) => {
    try {
      return parseRunArtifact(readJson(path));
    } catch (e) {
      if (e instanceof InputError) throw new InputError(e.code, e.problems.map((p) => `--${flag} ${path}: ${p}`));
      throw e;
    }
  };
  // Check the ledger first: a file that cannot take a record must not cost the verdict after the fact.
  const ledgerPath = str(flags, 'ledger');
  if (ledgerPath !== undefined) checkLedgerFile(ledgerPath);
  const baseline = parseRun('baseline', str(flags, 'baseline') as string);
  const candidate = parseRun('candidate', str(flags, 'candidate') as string);
  const rejudgeOf = rejudgePath === undefined ? undefined : parseRun('rejudge-of', rejudgePath);
  const bar = parseBarFile(readJson(str(flags, 'bar') as string));
  const bootstrap = { ...REJUDGE_BOOTSTRAP_DEFAULTS, seed };
  let result: GateRunResult;
  try {
    result = gateRuns(baseline, candidate, bar, {
      allowDiffer: allowDiffer as IdentityField[],
      ...(rejudgeOf === undefined ? {} : { rejudgeOf, bootstrap }),
    });
  } catch (e) {
    // The arguments of the call were refused (a judge field or the draw count in --allow-differ is the case): a usage error, whose rule lives in gateRuns.
    if (e instanceof InputError && e.code === 'INVALID_ARGUMENT') throw new UsageError(e.problems.join('; '));
    throw e;
  }
  const code = gateExitCode(result);

  // Append before printing, as the other commands do: a verdict asked to be recorded is never printed unrecorded.
  let trace: string | undefined;
  if (ledgerPath !== undefined) {
    const record = makeGateRecord({
      inputs: {
        baseline: baseline.identity,
        candidate: candidate.identity,
        barHash: barHash(bar),
        // Each waived field once, in the order of the identity's fields: the one order a record is valid in.
        allowDiffer: IDENTITY_FIELDS.filter((f) => allowDiffer.includes(f)),
        ...(rejudgeOf === undefined ? {} : { rejudgeOf: rejudgeOf.identity, bootstrap }),
      },
      result: gateSummary(result),
    });
    trace = traceLine(appendRecord(ledgerPath, record), record.resultHash);
  }

  if (flags.has('json')) {
    const json = result.kind === 'refused'
      ? refusalJson('gate', result.refusal)
      : {
          ...contract(REPORT_SCHEMAS.gate),
          ...result,
          ...(result.judgeControl !== undefined && 'refused' in result.judgeControl
            ? { judgeControl: { refused: { code: result.judgeControl.refused.code, fields: result.judgeControl.refused.fields, message: result.judgeControl.refused.message } } }
            : {}),
          exitCode: code,
        };
    io.out(JSON.stringify(json, null, 2));
    // The JSON on stdout is the same with or without --ledger; the trace goes to stderr.
    if (trace !== undefined) io.err(trace);
  } else {
    if (result.kind === 'refused') printRefusal(textIo(io), result.refusal);
    else printGate(textIo(io), result);
    if (trace !== undefined) io.out(trace);
  }
  return code;
}

function isStringMap(x: unknown): x is Record<string, string> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.values(x).every((v) => typeof v === 'string');
}

function isNestedStringMap(x: unknown): x is Record<string, Record<string, string>> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.values(x).every(isStringMap);
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === 'string');
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** --bootstrap-seed as a uint32, or the default. */
function seedFlag(flags: Map<string, string | true>, fallback: number): number {
  const raw = str(flags, 'bootstrap-seed');
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) > 0xffffffff) throw new UsageError('--bootstrap-seed must be a uint32 integer');
  return Number(raw);
}

/** A percentile bootstrap interval as printed: its brackets, and whatever a reader must know before reading them as a bound. */
function bracket(ci: PercentileInterval | 'NA'): string {
  if (ci === 'NA') return '[NA: undefined on every resample]';
  const undefinedNote = ci.undefinedResamples > 0 ? ` (undefined on ${ci.undefinedResamples} of ${ci.iterations} resamples, which are left out)` : '';
  const degenerate = ci.lo === ci.hi ? ' (degenerate: every resample gave this value; not a bound)' : '';
  // A row whose statistic was undefined on enough resamples falls below the floor on its own: it says so, whatever the report's one wording names.
  const unlevelled = noLevelNote(ci);
  return `[${fmt(ci.lo)}, ${fmt(ci.hi)}]${undefinedNote}${degenerate}${unlevelled === '' ? '' : ` (${unlevelled})`}`;
}

const shares = (p: Record<string, number>): string => Object.entries(p).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ');
const wilsonText = (w: { lo: number; hi: number }): string => `(Wilson 95% [${fmt(w.lo)}, ${fmt(w.hi)}])`;

/** What the brackets of an agreement or drift report are: said once, under the numbers, with the seed. */
function bracketsLine(b: BootstrapOptions, categories: number, fixed: string, printed: readonly (PercentileInterval | 'NA')[], limit = ''): string {
  // The level is decided per bracket, on the resamples its statistic was defined on, so the line says which rows it does not cover.
  const marked = printed.filter((ci) => ci !== 'NA' && noLevelNote(ci) !== '').length;
  const rows = marked === 0 ? '' : `; ${marked} of the ${printed.length} brackets above ${marked === 1 ? 'is' : 'are'} marked "no level" and ${marked === 1 ? 'is' : 'are'} not such an interval: the statistic was undefined on too many resamples`;
  return `brackets: ${resampleBracketWording('items', fixed, b)}${rows}; ${resamplesText(b.iterations)}, seed ${b.seed}, ${categories} categories; it says nothing about another draw of a judge${limit}`;
}

/** Whether a value of the judge-change report is one of its withheld markers, not a number or "NA". */
const isWithheld = (x: unknown): x is Withheld => typeof x === 'object' && x !== null && 'withheld' in x;

/** The record of a report in the ledger, as one line: where it went and what it hashes to. */
const traceLine = (at: { line: number; recordHash: string }, resultHash: string): string => `ledger: line ${at.line} · record ${at.recordHash} · result ${resultHash}`;

/** The words of a report whose names are not persistent raters: nothing here may read as a comparison of raters. */
const NOT_RATERS = {
  positional: {
    header: (n: number) => `${n} rating positions per item, no rater identity`,
    among: 'among positions',
    behind: 'the raters behind the positions are',
  },
  UNKNOWN: {
    header: (n: number) => `${n} names per item, and the names are unknown: the file does not say who or what they stand for`,
    among: 'among unknown names',
    behind: 'whoever rated under these names is',
  },
} as const;

function printAgreement(io: Io, r: AgreementReport): void {
  const words = r.raterIdentity === 'persistent' ? undefined : NOT_RATERS[r.raterIdentity];
  io.out(`${words === undefined ? `raters ${r.raters.join(', ')}` : words.header(r.raters.length)} · items ${r.itemCount} · packet hashes equal for every item, as the file states`);
  io.out(`${pad(`${r.kappaKind} kappa`, 17)}${fmt(r.kappa)} ${bracket(r.kappaCI)}`);
  io.out(`gwet AC1         ${fmt(r.ac1)} ${bracket(r.ac1CI)}`);
  // With three or more persistent raters this is Fleiss' P-bar, the mean share of agreeing pairs of raters, not the share of items on which all agree.
  if (words !== undefined) io.out(`mean pairwise agreement ${words.among} (Fleiss P̄)  ${fmt(r.percentAgreement)}  (not the share of items on which all of them agree)`);
  else io.out(r.percentAgreementKind === 'mean-pairwise' ? `mean pairwise agreement (Fleiss P̄)  ${fmt(r.percentAgreement)}  (not the share of items on which every rater agrees)` : `agreement        ${fmt(r.percentAgreement)}`);
  io.out(`prevalence       ${shares(r.prevalence)}`);
  for (const p of r.pairwise) {
    io.out(`  ${p.a} vs ${p.b}: kappa ${fmt(p.kappa)} ${bracket(p.kappaCI)} · AC1 ${fmt(p.ac1)} ${bracket(p.ac1CI)} · agreement ${fmt(p.percentAgreement)} ${wilsonText(p.percentAgreementWilson)}`);
    io.out(`    prevalence ${shares(p.prevalence)}  (the two raters pooled)`);
    io.out(`    ${p.a}: ${shares(p.marginals.a)}  ·  ${p.b}: ${shares(p.marginals.b)}`);
  }
  if (r.identityNote !== undefined) io.out(r.identityNote);
  io.out(bracketsLine(
    r.bootstrap,
    r.categories.length,
    words === undefined ? 'the raters and their labels' : 'the labels',
    [r.kappaCI, r.ac1CI, ...r.pairwise.flatMap((p) => [p.kappaCI, p.ac1CI])],
    words === undefined ? '' : `; ${words.behind} resampled only with their items and may recur across items, so the brackets may be too narrow or too wide`,
  ));
  io.out(r.scope);
}

function cmdAgree(argv: readonly string[], io: Io): number {
  const flags = parseFlags(argv, { ratings: 'string', ledger: 'string', json: 'boolean' }, ['ratings']);
  // Check the ledger first, as the gate does: a file that cannot take a record refuses before anything is computed.
  const ledgerPath = str(flags, 'ledger');
  if (ledgerPath !== undefined) checkLedgerFile(ledgerPath);
  const read = readJsonFile(str(flags, 'ratings') as string);
  const file = isRecord(read.json) ? read.json : {};
  const problems: string[] = [];
  // The file names its own format, so that a file of another version is refused and never read as this one.
  if (file['schema'] !== RATINGS_SCHEMA) problems.push(`ratings.schema: required, and must be "${RATINGS_SCHEMA}"`);
  // Item, rater and label names are compared, printed and hashed into the record: each must be text.
  findIllFormed(file, 'ratings', problems);
  // A key the command does not read is invalid, never ignored: a misspelt "bootstrap" would fall back to the defaults.
  appendAll(problems, extraKeys(file, RATINGS_KEYS, 'ratings'));
  if (!isNestedStringMap(file['ratings'])) problems.push('ratings: must map rater -> item -> label');
  if (!isNestedStringMap(file['packetHashes'])) problems.push('packetHashes: must map rater -> item -> sha256');
  // Required, with no default: a default would state, for the file, that its names are raters.
  if (!RATER_IDENTITIES.includes(file['raterIdentity'])) problems.push('raterIdentity: required: "persistent", "positional" or "UNKNOWN"');
  // Required: the number of categories enters AC1, so two files with the same ratings and different scales differ, and none is guessed.
  if (file['categories'] === undefined) problems.push('categories: required: the declared scale as a string array, every category listed whether or not it was used');
  else if (!isStringArray(file['categories'])) problems.push('categories: must be a string array');
  const boot = file['bootstrap'];
  if (boot !== undefined) {
    if (!isRecord(boot)) problems.push('bootstrap: must be { iterations?, seed?, alpha? }');
    else {
      appendAll(problems, extraKeys(boot, ['iterations', 'seed', 'alpha'], 'ratings.bootstrap'));
      for (const [k, v] of Object.entries(boot)) if (typeof v !== 'number') problems.push(`ratings.bootstrap.${k}: must be a number`);
    }
  }
  if (problems.length > 0) throw new InputError('INVALID_ARGUMENT', problems);
  // The printed object and the recorded result are one: the report under its contract.
  const report = {
    ...contract(REPORT_SCHEMAS.agree),
    ...agreementReport(file['ratings'] as Record<string, Record<string, string>>, {
      packetHashes: file['packetHashes'] as Record<string, Record<string, string>>,
      categories: file['categories'] as string[],
      raterIdentity: file['raterIdentity'] as RaterIdentity,
      ...(boot === undefined ? {} : { bootstrap: boot as Partial<BootstrapOptions> }),
    }),
  };
  // Append before printing, as the gate does: a report asked to be recorded is never printed unrecorded.
  let trace: string | undefined;
  if (ledgerPath !== undefined) {
    const record = makeRatingsRecord({ kind: 'agreement', ratingsFile: read.bytes, report });
    trace = traceLine(appendRecord(ledgerPath, record), record.resultHash);
  }
  if (flags.has('json')) {
    // The JSON on stdout is the recorded result itself, with or without --ledger; the trace goes to stderr.
    io.out(JSON.stringify(report, null, 2));
    if (trace !== undefined) io.err(trace);
  } else {
    printAgreement(textIo(io), report);
    if (trace !== undefined) io.out(trace);
  }
  return EXIT_CODES.OK;
}

type VerdictFile = { labels: string[]; verdicts: Record<string, string>; packetHashes?: Record<string, string> };

/** The top-level keys of a ratings file and of an anchor file (docs/RATINGS_FORMAT.md). Any other is invalid input. */
const RATINGS_KEYS = ['schema', 'raterIdentity', 'categories', 'ratings', 'packetHashes', 'bootstrap'] as const;
const ANCHOR_KEYS = ['schema', 'labels', 'verdicts', 'packetHashes'] as const;

function parseVerdictFile(x: unknown, name: string): VerdictFile {
  const r = isRecord(x) ? x : {};
  const problems: string[] = [];
  findIllFormed(r, name, problems);
  appendAll(problems, extraKeys(r, ANCHOR_KEYS, name));
  if (r['schema'] !== ANCHOR_SCHEMA) problems.push(`${name}.schema: required, and must be "${ANCHOR_SCHEMA}"`);
  if (!isStringMap(r['verdicts'])) problems.push(`${name}.verdicts: must map item -> label`);
  // Required in both files: the number of labels enters AC1, and a scale read off one file's verdicts is not the declared one.
  if (r['labels'] === undefined) problems.push(`${name}.labels: required: the declared, ordered labels as a string array, every label listed whether or not it was used`);
  else if (!isStringArray(r['labels'])) problems.push(`${name}.labels: must be a string array`);
  if (r['packetHashes'] !== undefined && !isStringMap(r['packetHashes'])) problems.push(`${name}.packetHashes: must map item -> sha256`);
  if (problems.length > 0) throw new InputError('INVALID_ARGUMENT', problems);
  return r as unknown as VerdictFile;
}

function printDrift(io: Io, r: DriftReport): void {
  io.out(`anchor items ${r.itemCount} · packet hashes equal for every item, as the files state`);
  // Kappa is never printed without its interval, AC1, the agreeing share and the prevalence that interprets it.
  io.out(`cohen kappa      ${fmt(r.kappa)} ${bracket(r.kappaCI)}  (old against new)`);
  io.out(`gwet AC1         ${fmt(r.ac1)} ${bracket(r.ac1CI)}`);
  io.out(`agreement        ${fmt(r.percentAgreement)} ${wilsonText(r.percentAgreementWilson)}`);
  io.out(`prevalence       ${shares(r.prevalence)}  (old and new verdicts pooled)`);
  io.out(`  old            ${shares(r.marginals.old)}`);
  io.out(`  new            ${shares(r.marginals.new)}`);
  io.out(bracketsLine(r.bootstrap, r.labels.length, 'the labels of the two readings', [r.kappaCI, r.ac1CI]));
  io.out('');
  io.out('transition (rows old, columns new)');
  io.out(`${pad('', 12)}${r.labels.map((l) => pad(l, 10)).join('')}`);
  r.transition.counts.forEach((row, i) => io.out(`${pad(r.labels[i] as string, 12)}${row.map((n) => pad(String(n), 10)).join('')}`));
  io.out('');
  io.out(`${pad('label', 12)}${pad('old', 6)}${pad('new', 6)}${pad('delta', 7)}kept-rate`);
  for (const p of r.perLabel) io.out(`${pad(p.label, 12)}${pad(String(p.oldCount), 6)}${pad(String(p.newCount), 6)}${pad(String(p.delta), 7)}${fmt(p.keptRate)}`);
  io.out('');
  io.out(`max rate shift   ${fmt(r.maxRateShift)} (threshold ${r.thresholds.rateShift}: ${r.rateShiftMinItems === 'NA' ? 'no net change in a label\'s count reaches it' : `a net change of ${r.rateShiftMinItems} or more in one label's count, of ${r.itemCount} items, reaches it`}; the overlap rule is checked first)`);
  io.out(`flagged [${r.flagLabels.join(', ')}]  old ${r.flaggedOld} · new ${r.flaggedNew} · overlap ${fmt(r.flaggedOverlap)} (threshold ${r.thresholds.overlap}) · jaccard ${fmt(r.flaggedJaccard)}`);
  // The class reads net counts and the flagged sets, so moves that cancel leave it as it was: the changed-label count beside it shows them.
  const changed = r.transition.counts.reduce((sum, row, i) => sum + row.reduce((s, n, j) => (i === j ? s : s + n), 0), 0);
  io.out(`classification   ${r.classification} · ${changed} of ${r.itemCount} items changed label  (${r.classificationBasis})`);
  io.out(r.scope);
}

function cmdDrift(argv: readonly string[], io: Io): number {
  const flags = parseFlags(argv, { old: 'string', new: 'string', flag: 'string', 'bootstrap-seed': 'string', ledger: 'string', json: 'boolean' }, ['old', 'new', 'flag']);
  const seed = seedFlag(flags, DEFAULT_BOOTSTRAP.seed);
  // Check the ledger first, as the gate does: a file that cannot take a record refuses before anything is computed.
  const ledgerPath = str(flags, 'ledger');
  if (ledgerPath !== undefined) checkLedgerFile(ledgerPath);
  const oldRead = readJsonFile(str(flags, 'old') as string);
  const newRead = readJsonFile(str(flags, 'new') as string);
  const oldF = parseVerdictFile(oldRead.json, 'old');
  const newF = parseVerdictFile(newRead.json, 'new');
  // The labels are an ordered scale: the same labels in another order are another declaration. Element by element, so no label can run into the next.
  if (oldF.labels.length !== newF.labels.length || oldF.labels.some((l, i) => l !== newF.labels[i])) {
    throw new RefusalError('LABELS_MISMATCH', ['labels'], 'old and new files declare different labels or a different label order');
  }
  // A file with no packet hashes says nothing about what its reading was shown, and two such files are not shown to agree.
  const unhashed = [...(oldF.packetHashes === undefined ? ['old.packetHashes'] : []), ...(newF.packetHashes === undefined ? ['new.packetHashes'] : [])];
  if (oldF.packetHashes === undefined || newF.packetHashes === undefined) {
    throw new RefusalError('PACKET_MISMATCH', unhashed, `no packet hashes in ${unhashed.length === 2 ? 'either anchor file' : `the ${unhashed[0] === 'old.packetHashes' ? 'old' : 'new'} anchor file`}, so the two readings cannot be shown to have seen the same packets`);
  }
  const report = {
    ...contract(REPORT_SCHEMAS.drift),
    ...driftReport(new Map(Object.entries(oldF.verdicts)), new Map(Object.entries(newF.verdicts)), {
      flagLabels: list(str(flags, 'flag') as string),
      labels: oldF.labels,
      packetHashes: { old: new Map(Object.entries(oldF.packetHashes)), new: new Map(Object.entries(newF.packetHashes)) },
      bootstrap: { seed },
    }),
  };
  let trace: string | undefined;
  if (ledgerPath !== undefined) {
    const record = makeRatingsRecord({ kind: 'drift', oldFile: oldRead.bytes, newFile: newRead.bytes, report });
    trace = traceLine(appendRecord(ledgerPath, record), record.resultHash);
  }
  if (flags.has('json')) {
    io.out(JSON.stringify(report, null, 2));
    if (trace !== undefined) io.err(trace);
  } else {
    printDrift(textIo(io), report);
    if (trace !== undefined) io.out(trace);
  }
  return EXIT_CODES.OK;
}

/** Above this many cases the text report lists only the cases that are not a plain one-output agreement. */
const FLIPS_TABLE_MAX = 30;

function printFlips(io: Io, r: RepeatFlipReport, grader: string, packets: string): void {
  const n = r.drawsPerCase;
  const storedNote = r.notCompared.fields.length === 0 ? '' : `stored outputs, declared by --stored-outputs: the system stop is unknown on ${r.notCompared.unknownStopDraws} of ${r.notCompared.draws} draws. These shares hold for the stored texts as they stand, a cut-off answer included, and claim nothing about what produced them.`;
  if (storedNote !== '') io.out(storedNote);
  io.out('repeat draws of one run: a measurement. It has no verdict and never exits 1.');
  io.out(`${r.caseCount} cases · ${n} draws per case · grader: ${grader} · packets: ${packets}`);
  io.out(`a case is flipped when its ${n} draws did not all get the same label. Each share below is a share of cases with at least one disagreeing draw among ${n}: it rises with the number of draws, and it is not the rate at which one grade changes.`);
  const block = (s: FlipShare): void => {
    if (s.cases === 0) return io.out('  no case');
    io.out(`  flipped ${s.flipped} of ${s.cases} cases (${fmt(s.share)}), ${n} draws per case`);
    if (s.wilson !== 'NA') io.out(`  Wilson 95% score interval, the ${s.cases} taken as fixed: [${fmt(s.wilson.lo)}, ${fmt(s.wilson.hi)}]`);
    // The one wording. The resamples are of every case of the run, not of this basis alone, so the line keeps saying how many.
    const head = `  ${resampleBracketWording('cases', 'the labels', r.bootstrap)}; all ${r.caseCount} cases, ${resamplesText(r.bootstrap.iterations)}, seed ${r.bootstrap.seed}: `;
    const why = s.flipped === 0 ? 'no flip observed, so no resample can hold one' : 'every case flipped, so no resample can hold one that did not';
    io.out(`${head}${s.degenerate ? `degenerate (${why}); not a bound` : bracket(s.bootstrap)}`);
  };
  io.out('');
  io.out(packets === NO_JUDGE
    ? 'one output: every draw of the case states the same output hash, under the one grader this run states, so the file names no other source for a label difference.'
    : 'one output: every draw of the case states the same output hash and the same packet hash, under the one judge this run states, so the file names no other source for a label difference. It cannot show what a provider or a harness did unseen.');
  if (storedNote !== '') io.out(storedNote);
  block(r.oneOutput);
  io.out('different outputs: the draws of the case hold more than one output, so a label difference mixes system and grader variation; never pooled with the share above');
  block(r.differentOutputs);
  io.out(`ungraded (every draw is the system's own failure): ${r.ungradedCases} case(s), in neither share`);
  io.out('');
  const basisName = { 'one-output': 'one output', 'different-outputs': 'different outputs', ungraded: 'ungraded' } as const;
  const shown = r.caseCount <= FLIPS_TABLE_MAX ? r.cases : r.cases.filter((c) => c.flipped || c.basis !== 'one-output');
  const text = (c: RepeatFlipReport['cases'][number]): string => c.outcomes.map((o) => (o.kind === 'label' ? o.label : 'failed')).join(' ');
  // A reduce, not Math.max(...list): a run may list more flipping cases than a call may take arguments.
  const idWidth = shown.reduce((w, c) => Math.max(w, c.caseId.length), 4) + 2;
  const labelWidth = shown.reduce((w, c) => Math.max(w, text(c).length), 6) + 2;
  if (shown.length < r.cases.length) io.out(`${r.cases.length - shown.length} case(s) with one output and the same label on every draw are not listed: the table is in --json`);
  io.out(`${pad('case', idWidth)}${pad('basis', 19)}${pad('outputs', 9)}${pad('labels', labelWidth)}${pad('off-mode', 10)}flipped`);
  for (const c of shown) {
    io.out(`${pad(c.caseId, idWidth)}${pad(basisName[c.basis], 19)}${pad(String(c.distinctOutputs), 9)}${pad(text(c), labelWidth)}${pad(fmt(c.disagreeShare), 10)}${c.basis === 'ungraded' ? '-' : c.flipped ? 'yes' : 'no'}`);
  }
}

function cmdFlips(argv: readonly string[], io: Io): number {
  const flags = parseFlags(argv, { run: 'string', 'stored-outputs': 'string', 'bootstrap-seed': 'string', json: 'boolean' }, ['run']);
  const seed = seedFlag(flags, DEFAULT_BOOTSTRAP.seed);
  const stored = str(flags, 'stored-outputs');
  if (stored !== undefined && stored !== STORED_OUTPUTS_DECLARED) {
    throw new InputError('INVALID_ARGUMENT', [`--stored-outputs: must be ${STORED_OUTPUTS_DECLARED}, got ${stored}`]);
  }
  const path = str(flags, 'run') as string;
  const read = readJsonFile(path);
  // An unknown output hash is a refusal, named before the parser calls the file malformed: draws nobody hashed cannot be shown to share an output.
  const unhashed = unknownOutputHashes(isRecord(read.json) ? read.json['draws'] : undefined);
  if (unhashed.length > 0) {
    throw new RefusalError('IDENTITY_GAP', unhashed.map((k) => `outputHash[${k}]`), `the output hash is unknown on ${unhashed.join(', ')}; draws cannot be shown to share an output nobody hashed`);
  }
  let run;
  try {
    run = parseRunArtifact(read.json);
  } catch (e) {
    if (e instanceof InputError) throw new InputError(e.code, e.problems.map((p) => `--run ${path}: ${p}`));
    throw e;
  }
  const report = repeatFlips(run, { ...DEFAULT_BOOTSTRAP, seed }, stored === undefined ? {} : { storedOutputs: stored });
  const judged = run.identity.judgeDefinitionHash !== NO_JUDGE;
  if (flags.has('json')) {
    const about = { sha256: sha256Hex(read.bytes), grader: judged ? 'judge' : 'code', packetBasis: run.packetBasis, ...(run.packetSource === undefined ? {} : { packetSource: run.packetSource }) };
    io.out(JSON.stringify({ ...contract(REPORT_SCHEMAS.flips), run: about, identity: run.identity, ...report }, null, 2));
  } else {
    printFlips(textIo(io), report, judged ? `judge ${run.identity.judgeModelServed}` : 'code (no judge)', run.packetBasis);
  }
  return EXIT_CODES.OK;
}

function printJudgeChange(io: Io, r: JudgeChangeReport): void {
  const num = (x: number | string): string => (typeof x === 'number' ? x.toFixed(3) : x);
  const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;
  // A line that holds a number computed against a reference that saw another packet ends with the label.
  const tag = (x: { referencePackets?: string }, sep = ' · '): string => (x.referencePackets === undefined ? '' : `${sep}${x.referencePackets}`);
  io.out('judge change on stored outputs: a measurement. It has no verdict and never exits 1.');
  io.out(`plan ${r.planHash} · bar ${short(r.barHash)} · ${r.tool.name} ${r.tool.version} · ${r.contracts.run} · ${r.contracts.plan}`);
  io.out('');
  io.out('judge fields that moved:');
  if (r.judges.moved.length === 0) io.out('  none');
  for (const m of r.judges.moved) io.out(`  ${pad(m.field, 22)}${short(m.old)} -> ${short(m.new)}`);
  if (r.judges.callShapeMoved.length > 0) io.out(`  judge call shape: ${r.judges.callShapeMoved.join(', ')}`);
  if (r.notCompared.fields.length > 0) {
    io.out(`not compared (the plan opts in): ${r.notCompared.fields.join(', ')}`);
    if (r.notCompared.unknownStopDraws > 0) io.out(`  the system stop is unknown on ${r.notCompared.unknownStopDraws} of ${r.notCompared.draws} draws`);
  }
  io.out('');
  io.out('inputs:');
  for (const f of r.inputs) {
    const packets = f.packetSource === undefined ? `packets: ${f.packetBasis}` : `packets: declared from ${f.packetSource}, not observed`;
    io.out(`  ${pad(f.system, 12)}${pad(f.role, 11)}${f.name}  ${f.sha256}  ${packets}`);
    // Counts beside the run they describe, zero included, never a rate: over the slots the numbers are computed on, and over the whole file.
    const retries = (jr: JudgeRetries, scope: string, unit: string): string => {
      const why = jr.earlierAttemptsByReason.length === 0 ? 'earlier judge attempts: 0' : `earlier judge attempts by reason: ${jr.earlierAttemptsByReason.map((x) => `${x.reason} ${x.attempts}`).join(', ')}`;
      return `    judge retries, ${scope}: ${jr.slotsWithRetry} of ${jr.slots} ${unit} hold one · ${why}`;
    };
    io.out(retries(f.judgeRetriesScored, `the ${r.counts.cases} scored cases of class "${r.measuredClass}"`, 'slots'));
    io.out(retries(f.judgeRetries, 'the run file, every class included', 'slot records'));
  }
  io.out('');
  const reask = r.drawSets.reask === NOT_DECLARED ? NOT_DECLARED : `[${r.drawSets.reask.join(', ')}]`;
  io.out(`class ${r.measuredClass} · cut ${r.cut} · label rule ${r.labelRule} · estimate draws [${r.drawSets.estimate.join(', ')}] · re-ask draws ${reask}`);
  io.out(`systems ${r.counts.systems} · scored cases ${r.counts.cases} · items ${r.counts.items}${r.counts.fitOnlyCases > 0 ? ` · ${r.counts.fitOnlyCases} fit-only cases, which enter no number below` : ''}`);
  io.out(`packets of the two judges: equal ${r.packetEquality.judges === 'observed' ? 'as recorded' : 'by declaration, not observed'}`);
  io.out('');
  io.out(`${pad('', 40)}${pad('old', 9)}${pad('new', 9)}change (new - old)`);
  io.out(`${pad('per-draw pass rate', 40)}${pad(num(r.perDrawPassRate.old), 9)}${pad(num(r.perDrawPassRate.new), 9)}${signed(r.perDrawPassRate.change)}`);
  io.out(`${pad(`label pass rate (${r.labelPassRate.rule})`, 40)}${pad(num(r.labelPassRate.old), 9)}${pad(num(r.labelPassRate.new), 9)}${signed(r.labelPassRate.change)}`);
  io.out('');
  io.out(`${pad(`labels that differ between the judges (${r.flips.rule})`, 62)}${num(r.flips.acrossJudges)}`);
  io.out(`${pad(`labels that differ between two sets of one judge (${r.flips.rule})`, 62)}${num(r.flips.withinJudge)}`);
  io.out(`${pad('the first share minus the second (from the counts)', 62)}${num(r.flips.beyondReask)}`);
  if (r.perSystem.length > 1) {
    io.out('');
    io.out(`per-draw rates, and labels and flips by the ${r.labelRule} rule:`);
    io.out(`${pad('system', 16)}${pad('items', 7)}${pad('per-draw old', 14)}${pad('new', 8)}${pad('label old', 11)}${pad('new', 8)}flips`);
    for (const s of r.perSystem) {
      io.out(`${pad(s.system, 16)}${pad(String(s.items), 7)}${pad(num(s.perDrawPassRate.old), 14)}${pad(num(s.perDrawPassRate.new), 8)}${pad(num(s.labelPassRate.old), 11)}${pad(num(s.labelPassRate.new), 8)}${num(s.flipsAcrossJudges)}`);
    }
  }
  io.out('');
  const word = (b: boolean): string => (b ? 'pass' : 'fail');
  io.out(`items whose label differs between the judges (${r.flips.items.length}):`);
  for (const x of r.flips.items) io.out(`  ${x.system}/${x.caseId}  ${word(x.old)} -> ${word(x.new)}`);
  if (r.nonCompensableClasses.length > 0) {
    io.out('');
    io.out(`non-compensable classes (${r.nonCompensableClasses.join(', ')}): cases with a failing draw, listed, never pooled (${r.nonCompensable.length}):`);
    for (const x of r.nonCompensable) {
      io.out(`  ${x.klass}/${x.system}/${x.caseId}  old judge fails draws [${x.oldFailingDraws.join(', ')}] · new judge fails draws [${x.newFailingDraws.join(', ')}]${x.worstOfNDiffers ? ' · worst-of-N differs between the judges' : ''}`);
    }
  }
  if (r.notMeasuredClasses.length > 0) {
    io.out('');
    io.out(`not measured (one class per plan): ${r.notMeasuredClasses.join(', ')}`);
  }
  if (r.reference !== NOT_DECLARED) {
    io.out('');
    if ('withheld' in r.reference) io.out(`reference: withheld (${r.reference.withheld}): ${r.reference.detail}`);
    else {
      const a = r.reference.agreement;
      const c = r.reference.criterion;
      if (c !== undefined) {
        io.out(`reference: the criterion of the pair gates only · reference verdicts: ${c.verdictRule}${tag(c)}`);
        io.out(`  stated in the reference files: "${c.quote}" (${c.source})`);
      }
      if ('withheld' in a) io.out(`  agreement with the reference: withheld (${a.withheld}): ${a.detail}`);
      else {
        io.out(`agreement with the reference · judge labels: ${a.rule} · reference verdicts: ${a.verdictRule} · ${a.items} items · the reference passes ${num(a.referencePassShare)} · packets equal ${r.packetEquality.reference === 'observed' ? 'as recorded' : 'by declaration, not observed'}:`);
        // Supplied index rows are not called a bootstrap and carry no level: the spread's draws say which they are.
        const computedSpread = typeof r.spread === 'object' && !('withheld' in r.spread) ? r.spread : undefined;
        const supplied = computedSpread !== undefined && 'suppliedSha256' in computedSpread.draws;
        const seededSpread = supplied ? undefined : computedSpread;
        // The level comes from the one floor (stats.ts): with too few resamples the two percentiles are printed with none.
        const iterations = computedSpread?.iterations ?? 0;
        for (const [name, x] of [['old judge', a.old], ['new judge', a.new]] as const) {
          const iv = a.spread === NOT_DECLARED ? undefined : name === 'old judge' ? a.spread.old : a.spread.new;
          // A bracket whose statistic was undefined on enough resamples is below the floor on its own, and says so (seeded resamples only: supplied ones carry no level anywhere).
          const unlevelled = (stat: string): string => {
            const q = seededSpread?.quantities[`${stat} with the reference, ${name}`];
            const note = q === undefined ? '' : noLevelNote({ iterations: seededSpread?.iterations as number, alpha: SPREAD_ALPHA, undefinedResamples: q.undefinedReplicates });
            return note === '' ? '' : ` (${note})`;
          };
          const band = (b: readonly (number | string)[] | undefined, stat: string): string => (b === undefined ? '' : ` [${num(b[0] as number | string)}, ${num(b[1] as number | string)}]${unlevelled(stat)}`);
          // Kappa and AC1 are printed only beside their percentiles over resamples. Withheld, the row keeps the agreeing
          // count, the number of items and the pass share: no coefficient and no agreeing share stands there bare.
          const { kappa, ac1 } = x;
          if (isWithheld(kappa) || isWithheld(ac1)) io.out(`  ${pad(name, 11)}agrees on ${x.agree} of ${a.items} · passes ${num(x.passShare)}`);
          else io.out(`  ${pad(name, 11)}agrees on ${x.agree} (${num(x.share)}) · kappa ${num(kappa)}${band(iv?.kappa, 'kappa')} · AC1 ${num(ac1)}${band(iv?.ac1, 'AC1')} · passes ${num(x.passShare)}`);
        }
        const why = [a.old.kappa, a.old.ac1, a.new.kappa, a.new.ac1].find(isWithheld);
        if (why !== undefined) io.out(`  kappa and AC1: withheld (${why.withheld}): ${why.detail}`);
        // A coefficient that is printed has its spread: the report builds both from the one test.
        else if (a.spread === NOT_DECLARED) throw new TypeError('judge-change: kappa and AC1 are present with no spread beside them');
        else io.out(`  brackets: ${supplied ? suppliedPercentilesWording('cases') : resampleBracketWording('cases', 'the judge draws', { iterations, alpha: SPREAD_ALPHA })} (the ${a.spread.percentiles.map((p) => `${p}th`).join(' and ')} percentiles of the resamples)`);
      }
      for (const f of r.reference.inputs) {
        const packets = f.packetSource === undefined ? `packets: ${f.packetBasis}` : `packets: declared from ${f.packetSource}, not observed`;
        io.out(`  ${pad(f.system, 12)}${pad('reference', 11)}${f.name}  ${f.sha256}  ${packets}`);
      }
    }
  }
  if (r.gate !== NOT_DECLARED) {
    io.out('');
    if ('withheld' in r.gate) io.out(`pair gates: withheld (${r.gate.withheld}): ${r.gate.detail}`);
    else {
      const g = r.gate;
      io.out(`pair gates on majority labels: ${g.statistic}, margin ${g.margin}, nominal alpha ${g.alpha}, critical value ${num(g.critical)}, ${g.approximation} · ${g.n} cases per pair`);
      for (const [name, meaning] of Object.entries(g.states)) io.out(`  ${name}: ${meaning}`);
      io.out(`  the smallest n at which a table with no discordant pair passes: ${g.smallestConcordantPassN === 'NA' ? 'none' : g.smallestConcordantPassN}`);
      io.out(`  one case per cluster: ${g.oneCasePerCluster}`);
      io.out(`  largest error rates found on the null boundary at this n, margin and alpha (nuisance share on a grid of ${g.nominalCheck.grid}, each by exact enumeration of the tables): false PASS ${num(g.nominalCheck.falsePass)} · false REGRESSION ${num(g.nominalCheck.falseRegression)} (nominal ${g.alpha})`);
      io.out('  do nothing: the baseline as the old judge labelled it, the candidate as the new judge labels it');
      io.out('  re-judged: both as the new judge labels them');
      const cell = (x: PairGate | undefined): string => (x === undefined ? '' : `${x.n10}/${x.n01} ${num(x.z)} ${x.state}`);
      if (g.pairs.length <= 30) {
        io.out(`  ${pad('baseline', 14)}${pad('candidate', 14)}${pad('do nothing', 28)}${pad('re-judged', 28)}reference   (worse/better z state)`);
        for (const p of g.pairs) io.out(`  ${pad(p.baseline, 14)}${pad(p.candidate, 14)}${pad(cell(p.doNothing), 28)}${pad(cell(p.rejudged), 28)}${cell(p.reference)}${tag(p)}`);
      } else {
        io.out(`  ${g.pairs.length} ordered pairs: the table is in --json`);
      }
      const c = g.counts;
      io.out(`  pairs ${c.pairs} · passed by doing nothing only ${c.passDoNothingOnly} · by re-judging only ${c.passRejudgedOnly} · by both ${c.passBoth} · net ${c.net}`);
      if (g.reference === NOT_DECLARED) io.out('  no reference: the two gates are compared only with each other');
      else if ('withheld' in g.reference) io.out(`  reference rows: withheld (${g.reference.withheld})`);
      else {
        const e = g.reference;
        const packets = e.referencePackets === undefined ? ` (packets equal ${r.packetEquality.reference === 'observed' ? 'as recorded' : 'by declaration, not observed'})` : tag(e);
        io.out(`  the reference gate does not pass ${e.notPass} pair(s): REGRESSION ${e.regression}, INCONCLUSIVE ${e.inconclusive}${packets}`);
        io.out(`    of those, passed by doing nothing ${e.passDoNothing} · by re-judging ${e.passRejudged} · net ${e.net} (only doing nothing ${e.onlyDoNothing}, only re-judging ${e.onlyRejudged})${tag(e)}`);
        io.out(`    of the pairs it passes, not passed by doing nothing minus not passed by re-judging: ${e.notPassedNet}${tag(e)}`);
        io.out(`    pairs it calls REGRESSION that a gate passes (${e.referenceRegressionPassed.length})${e.referencePackets === undefined ? ':' : tag(e)}`);
        for (const x of e.referenceRegressionPassed) io.out(`      ${x.baseline} -> ${x.candidate}  passed by ${x.passedBy.map((k) => (k === 'doNothing' ? 'doing nothing' : 're-judging')).join(' and ')}${tag(e)}`);
      }
    }
  }
  if (r.map !== NOT_DECLARED) {
    io.out('');
    if ('withheld' in r.map) io.out(`recalibration map: withheld (${r.map.withheld}): ${r.map.detail}`);
    else {
      const m = r.map;
      io.out(`recalibration map, a measured option and not a correction: ${m.folds} folds · ${m.scoredCases} scored cases · ${m.fitOnlyCases} fit-only · tie-break ${'seed' in m.tieBreak ? `seed ${m.tieBreak.seed}` : `supplied (${short(m.tieBreak.suppliedSha256)})`}`);
      io.out(`  assumed, not checked: ${m.assumes.join('; ')}`);
      io.out('  recalibrated: the baseline is passed where the old judge\'s summed score is at or above a cut placed, on the other cases, where it passes the number the new judge passes there');
      io.out('  re-judged with the cut: the same rule on the new judge\'s own summed score');
      const cutOf = (f: FoldCut): string => (typeof f.cut === 'string' ? f.cut : `(sum, tie-break) >= (${f.cut.sum}, ${f.cut.u.toFixed(4)})`);
      for (const [i, f] of m.cuts.recalibrated.entries()) {
        const g = m.cuts.rejudged[i] as FoldCut;
        io.out(`  fold ${f.fold}: recalibrated ${cutOf(f)} (target ${f.target} of ${f.fit} fit items, at or above ${f.achieved}) · re-judged ${cutOf(g)} (target ${g.target} of ${g.fit}, at or above ${g.achieved})`);
      }
      io.out(`  the sum equals the cut's for ${num(m.tieShare.recalibrated)} of the recalibrated labels and ${num(m.tieShare.rejudged)} of the re-judged ones, so the tie-break decides them (the plan's maxTieShare is ${m.limits.maxTieShare}; minFitItems ${m.limits.minFitItems}; minSystems ${m.limits.minSystems})`);
      for (const s of m.perSystem) io.out(`  ${pad(s.system, 14)}passes: new judge, majority ${s.newJudgePasses} · recalibrated ${s.recalibratedPasses} · re-judged with the cut ${s.rejudgedCutPasses}`);
      const cell = (x: PairGate): string => `${x.n10}/${x.n01} ${num(x.z)} ${x.state}`;
      if (m.pairs.length <= 30) {
        io.out(`  ${pad('baseline', 14)}${pad('candidate', 14)}${pad('recalibrated', 28)}re-judged with the cut   (worse/better z state)`);
        for (const p of m.pairs) io.out(`  ${pad(p.baseline, 14)}${pad(p.candidate, 14)}${pad(cell(p.recalibrated), 28)}${cell(p.rejudgedCut)}`);
      } else {
        io.out(`  ${m.pairs.length} ordered pairs: the table is in --json`);
      }
      const c = m.counts;
      io.out(`  pairs ${c.pairs} · passed by recalibrating only ${c.passRecalibratedOnly} · by re-judging with the cut only ${c.passRejudgedCutOnly} · by both ${c.passBoth} · net ${c.net}`);
      if (m.reference === NOT_DECLARED) io.out('  no reference: the two gates are compared only with each other');
      else if ('withheld' in m.reference) io.out(`  reference rows: withheld (${m.reference.withheld})`);
      else {
        const e = m.reference;
        io.out(`  of the pairs the reference gate does not pass: passed by recalibrating ${e.passRecalibrated} · by re-judging with the cut ${e.passRejudgedCut} · net ${e.net} (only recalibrating ${e.onlyRecalibrated}, only re-judging ${e.onlyRejudgedCut})${tag(e)}`);
        io.out(`    passed by doing nothing minus by re-judging with the cut: ${e.doNothingMinusRejudgedCut} · minus by recalibrating: ${e.doNothingMinusRecalibrated}${tag(e)}`);
        io.out(`    passed by re-judging on majority labels minus with the cut: ${e.rejudgedMajorityMinusCut}${tag(e)}`);
        io.out(`  of the pairs it passes, not passed by recalibrating minus not passed by re-judging with the cut: ${e.notPassedNet} (doing nothing: ${e.doNothingNotPassedNet})${tag(e)}`);
        io.out(`    pairs it calls REGRESSION that a cut gate passes (${e.referenceRegressionPassed.length})${e.referencePackets === undefined ? ':' : tag(e)}`);
        for (const x of e.referenceRegressionPassed) io.out(`      ${x.baseline} -> ${x.candidate}  passed by ${x.passedBy.map((k) => (k === 'recalibrated' ? 'recalibrating' : 're-judging with the cut')).join(' and ')}${tag(e)}`);
      }
      if (m.placebo !== NOT_DECLARED) {
        const show = (p: Placebo): string => ('withheld' in p ? `withheld (${p.withheld}): ${p.detail}` : `passed from the re-ask set only ${p.onlyReask} · from the estimate set only ${p.onlyEstimate} · net ${p.net}${p.referenceNet === undefined ? '' : ` · net among pairs the reference gate does not pass ${p.referenceNet}${tag(p)}`}`);
        io.out('  placebo: the same map from a judge\'s re-ask set to its own estimate set; it shows what re-asking alone does, and no bar is set');
        io.out(`    old judge: ${show(m.placebo.old)}`);
        io.out(`    new judge: ${show(m.placebo.new)}`);
      }
      io.out(`  what the tie-break alone moves, across the ${m.overTieBreakSeeds.seeds.length} seeds ${m.overTieBreakSeeds.seeds.join(', ')} (min / median / max; then the value reported above, and how many seeds gave less, the same and more)${'seed' in m.tieBreak ? '' : '; the numbers above use the supplied draws, which are not one of the seeds'}:`);
      for (const [name, q] of Object.entries(m.overTieBreakSeeds.quantities)) io.out(`    ${pad(name, 104)}${q.min} / ${q.median} / ${q.max}  reported ${q.reported}: ${q.below} below, ${q.equal} equal, ${q.above} above${tag(q, '  ')}`);
    }
  }
  if (r.spread !== NOT_DECLARED) {
    io.out('');
    if ('withheld' in r.spread) io.out(`spread: withheld (${r.spread.withheld}): ${r.spread.detail}`);
    else {
      io.out('seed' in r.spread.draws
        ? `spread over ${resamplesText(r.spread.iterations)} of cases (seed ${r.spread.draws.seed}); the 2.5% and 97.5% columns: ${spreadPercentilesWording(r.spread.iterations)}`
        : `spread over ${r.spread.iterations} supplied resamples of cases (supplied indices ${short(r.spread.draws.suppliedSha256)}); on every row the 2.5% and 97.5% columns are ${suppliedPercentilesWording('cases')}`);
      if (r.spread.map !== undefined) io.out(`  the map's rows exclude ${r.spread.map.undefinedResamples} resample(s) on which it was undefined and ${r.spread.map.unidentifiedCutResamples} on which a cut was not identified`);
      io.out(`  ${pad('quantity', 106)}${pad('point', 9)}${pad('sd', 8)}${pad('2.5%', 9)}${pad('50%', 9)}${pad('97.5%', 9)}${pad('mean-point', 12)}${pad('share <0 / =0 / >0', 24)}undefined   (shares of resamples; not a p-value)`);
      for (const [name, q] of Object.entries(r.spread.quantities)) {
        io.out(`  ${pad(name, 106)}${pad(num(q.point), 9)}${pad(num(q.sd), 8)}${pad(num(q.p025), 9)}${pad(num(q.p50), 9)}${pad(num(q.p975), 9)}${pad(num(q.meanMinusPoint), 12)}${pad(`${num(q.shareBelow0)} / ${num(q.shareAt0)} / ${num(q.shareAbove0)}`, 24)}${q.undefinedReplicates}${tag(q, '  ')}`);
      }
    }
  }
  io.out('');
  io.out('optional blocks of the plan:');
  for (const [name, state] of Object.entries(r.blocks)) io.out(`  ${pad(name, 12)}${state}`);
  io.out('');
  for (const n of r.notes) io.out(`note: ${n}`);
}

function cmdJudgeChange(argv: readonly string[], io: Io): number {
  const flags = parseFlags(argv, { plan: 'string', bar: 'string', inputs: 'string', ledger: 'string', json: 'boolean' }, ['plan', 'bar', 'inputs']);
  const planPath = str(flags, 'plan') as string;
  const barPath = str(flags, 'bar') as string;
  const dir = str(flags, 'inputs') as string;
  // Check the ledger first, as the gate does: a file that cannot take a record refuses before anything is measured.
  const ledgerPath = str(flags, 'ledger');
  if (ledgerPath !== undefined) checkLedgerFile(ledgerPath);
  let plan;
  let planFile;
  try {
    planFile = readJsonFile(planPath);
    plan = parseJudgeChangePlan(planFile.json);
  } catch (e) {
    if (e instanceof InputError) throw new InputError(e.code, e.problems.map((p) => `--plan ${planPath}: ${p}`));
    throw e;
  }
  const barFile = readJsonFile(barPath);
  const bar = parseBarFile(barFile.json);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    throw new InputError('INVALID_ARGUMENT', [`cannot read --inputs ${dir}: ${(e as Error).message}`]);
  }
  // The plan, the bar and the ledger (once it exists) may sit beside the runs; they are not inputs of the roster.
  const own = [planPath, barPath].map((p) => realpathSync(p));
  if (ledgerPath !== undefined) {
    try {
      own.push(realpathSync(ledgerPath));
    } catch (e) {
      // No ledger file yet: nothing in the folder is it.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new InputError('INVALID_ARGUMENT', [`cannot read --ledger ${ledgerPath}: ${(e as Error).message}`]);
    }
  }
  const files: JudgeChangeInput[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (own.includes(realpathSync(path))) continue;
      files.push({ name, bytes: readFileSync(path) });
    } catch (e) {
      throw new InputError('INVALID_ARGUMENT', [`cannot read ${path}: ${(e as Error).message}`]);
    }
  }
  const report = judgeChangeRuns(files, bar, plan);
  // Append before printing, as the gate does: a report asked to be recorded is never printed unrecorded.
  let trace: string | undefined;
  if (ledgerPath !== undefined) {
    const record = makeJudgeChangeRecord({ planFile: planFile.bytes, barFile: barFile.bytes, report });
    trace = traceLine(appendRecord(ledgerPath, record), record.resultHash);
  }
  if (flags.has('json')) {
    // The JSON on stdout is the recorded result itself, with or without --ledger; the trace goes to stderr.
    io.out(JSON.stringify(report, null, 2));
    if (trace !== undefined) io.err(trace);
  } else {
    printJudgeChange(textIo(io), report);
    if (trace !== undefined) io.out(trace);
  }
  return EXIT_CODES.OK;
}

export function main(argv: readonly string[], io: Io): number {
  const [cmd, ...rest] = argv;
  // Every line below names something the user gave (a flag, a path, a field of a file): one line each, whatever it holds.
  const text = textIo(io);
  try {
    // `<cmd> --help` (or `-h`) prints that command's usage and exits 0; it is looked for before any flag is read.
    // A `-h` right after a flag that takes a value is that value, as a path may be named so.
    const asksHelp = rest.some((a, i) => a === '--help' || (a === '-h' && !(i > 0 && (rest[i - 1] as string).startsWith('--') && rest[i - 1] !== '--json')));
    if (cmd !== undefined && Object.hasOwn(COMMAND_USAGE, cmd) && asksHelp) {
      io.out(usageFor(cmd));
      return EXIT_CODES.OK;
    }
    switch (cmd) {
      case 'gate':
        return cmdGate(rest, io);
      case 'agree':
        return cmdAgree(rest, io);
      case 'drift':
        return cmdDrift(rest, io);
      case 'flips':
        return cmdFlips(rest, io);
      case 'judge-change':
        return cmdJudgeChange(rest, io);
      case '--help':
      case '-h':
        io.out(USAGE);
        return EXIT_CODES.OK;
      case '--version':
        io.out(`${TOOL_NAME} ${TOOL_VERSION}`);
        return EXIT_CODES.OK;
      default:
        throw new UsageError(cmd === undefined ? 'missing subcommand' : `unknown subcommand "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      text.err(`anchorset: ${e.message}`);
      io.err(`\n${usageFor(cmd)}`);
      return EXIT_CODES.USAGE;
    }
    if (e instanceof RefusalError) {
      // Under --json every command refuses as the one object (a flag value never starts with "--", so the token is the flag).
      if (cmd !== undefined && Object.hasOwn(COMMAND_USAGE, cmd) && argv.includes('--json')) io.out(JSON.stringify(refusalJson(cmd, e), null, 2));
      else printRefusal(text, e);
      return EXIT_CODES.REFUSED;
    }
    if (e instanceof InputError) {
      text.err(`anchorset: invalid input (${e.code})`);
      for (const p of e.problems) text.err(`  - ${p}`);
      return EXIT_CODES.INVALID_INPUT;
    }
    // Anything else was not foreseen. An uncaught error would end the process with exit 1, which is the verdict
    // "regression": it gets its own code, one line, and no stack trace.
    text.err(`anchorset: internal error: ${(e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, ' ')}`);
    return EXIT_CODES.INTERNAL;
  }
}

/**
 * True when the module at `moduleUrl` is the process entry point, including when it is started through
 * the symlink npm puts in `node_modules/.bin`. `import.meta.main` would do this, but only from Node 24.2;
 * on older runtimes it is undefined and the CLI would exit 0 without doing anything.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * Runs a command as this process: its lines go to stdout and stderr, and its return value is the
 * exit code. A write that fails never ends the process by itself, since an uncaught error is exit 1
 * with a stack trace, and exit 1 is the verdict "regression".
 *
 * A reader that closed its end of a pipe (`gate ... | true`, `flips ... | head -n 1`) is not a
 * failure of the command: nothing more is written to that stream, and the exit code is the command's
 * own. Any other failed write (a full disk, a descriptor that is not open for writing) is exit 70
 * with one line on stderr where stderr still takes one. A stream reports a failed write either by
 * throwing or by an 'error' event after the command has returned; both end here. `tool` names the
 * command in that line: a tool other than this CLI that runs through here (study-check) names itself.
 */
export function runAsProcess(command: (argv: readonly string[], io: Io) => number, tool: string = TOOL_NAME): void {
  const closed = new Set<NodeJS.WriteStream>();
  let lost = false;
  const write = (stream: NodeJS.WriteStream, s: string): void => {
    if (closed.has(stream)) return;
    try {
      stream.write(`${s}\n`);
    } catch (e) {
      failed(stream, e);
    }
  };
  const failed = (stream: NodeJS.WriteStream, e: unknown): void => {
    closed.add(stream);
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') return;
    lost = true;
    process.exitCode = EXIT_CODES.INTERNAL;
    if (stream !== process.stderr) write(process.stderr, oneLine(`${tool}: internal error: cannot write to stdout: ${e instanceof Error ? e.message : String(e)}`));
  };
  process.stdout.on('error', (e) => failed(process.stdout, e));
  process.stderr.on('error', (e) => failed(process.stderr, e));
  const code = command(process.argv.slice(2), { out: (s) => write(process.stdout, s), err: (s) => write(process.stderr, s) });
  process.exitCode = lost ? EXIT_CODES.INTERNAL : code;
}

if (isEntryPoint(import.meta.url, process.argv[1])) runAsProcess(main);
