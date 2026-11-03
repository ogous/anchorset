import { accessSync, appendFileSync, constants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { AGREE_SCOPE, agreeReportProblems, RATER_IDENTITIES } from './agreement.ts';
import type { AgreementReport } from './agreement.ts';
import { DRIFT_SCOPE } from './drift.ts';
import type { DriftReport } from './drift.ts';
import { InputError } from './errors.ts';
import { barHash, parseBarFile } from './gate.ts';
import { appendAll, canonicalJson, findIllFormed, findInexactIntegers, findNulls, hashOf, IDENTITY_FIELDS, isSha256Hex, gateNeverWaives, NO_JUDGE, NOT_UTF8, parseJsonBytes, parseJsonText, sha256Hex, TOO_LONG, utf8Text, validateIdentity } from './identity.ts';
import type { IdentityField, RunIdentity } from './identity.ts';
import { JUDGE_CHANGE_FILE_ROLES as FILE_ROLES, judgeChangePlanProblems, NOT_DECLARED } from './judgechange.ts';
import type { JudgeChangeFileRole as FileRole, JudgeChangePlan, JudgeChangeReport } from './judgechange.ts';
import { extraKeys } from './scoring.ts';
import type { BootstrapOptions } from './stats.ts';
import { REPORT_SCHEMAS, TOOL_NAME, TOOL_VERSION } from './version.ts';

export const LEDGER_SCHEMA = 'anchorset.ledger/v3';

/** The kind whose record is about one run and carries that run's identity. */
export type RunLedgerKind = 'gate';
/**
 * The kinds whose report was computed from rating files: verdicts with packet hashes, and no run
 * behind them. Their record carries the files' hashes and the seed instead of an identity.
 */
export type RatingsLedgerKind = 'agreement' | 'drift';
/** The judge-change report covers many runs and has no single identity: its record carries the plan's binding instead. */
export type LedgerKind = RunLedgerKind | RatingsLedgerKind | 'judge-change';

const RUN_KINDS: readonly string[] = ['gate'];
const RATINGS_KINDS: readonly string[] = ['agreement', 'drift'];
const JUDGE_CHANGE = 'judge-change';
const KINDS: readonly string[] = [...RUN_KINDS, ...RATINGS_KINDS, JUDGE_CHANGE];

type RecordBase = {
  schema: typeof LEDGER_SCHEMA;
  at: string;
  inputsHash: string;
  resultHash: string;
  result: Record<string, unknown>;
  tool: { name: typeof TOOL_NAME; version: string };
};

/**
 * What a gate was given, kept on its record: both identities as the run files declare them, the hash of the parsed bar
 * file, the identity fields the caller waived (each once, in the order of IDENTITY_FIELDS), and, for a gate against a
 * re-judged baseline, that baseline's identity and the bootstrap the judge-controlled split was drawn under.
 * `rejudgeOf` and `bootstrap` come together or not at all. A verdict can be traced to these: the identities the runs
 * declared, the bar's hash and the flags. It cannot be traced to a run file's bytes, which the record never holds or
 * hashes: recomputing the verdict takes the files again, and nothing in the record shows which files those were.
 */
export type GateInputs = {
  baseline: RunIdentity;
  candidate: RunIdentity;
  barHash: string;
  allowDiffer: IdentityField[];
  rejudgeOf?: RunIdentity;
  bootstrap?: BootstrapOptions;
};

/** `identity` is the candidate's, the same object as `inputs.candidate`; `inputsHash` is hashOf(inputs). */
export type RunLedgerRecord = RecordBase & { kind: RunLedgerKind; identity: RunIdentity; inputs: GateInputs };

/**
 * What produced a judge-change report: the plan's hash, every file the measurement read by the full
 * sha256 of its bytes, and every measurement seed. A supplied-draw file stands in for a seed
 * and is named by its hash in both places. No field is null or a gap; the only conditional field is
 * `suppliedSha256`. The record is not signed or chained: validation shows that it is well formed and
 * that its hashes and its report agree with each other, never that the report was derived from the files.
 */
export type JudgeChangeBinding = {
  /** hashOf(plan): the hash every report prints. The plan file's own bytes are among `files`. */
  planHash: string;
  /**
   * In the one canonical order: by role, in the order of JUDGE_CHANGE_FILE_ROLES (plan, bar, run,
   * reference, tie-break, resample-indices), then by sha256. Another order is invalid. No names or
   * paths: the same inputs give the same binding wherever they sit.
   */
  files: { role: FileRole; sha256: string }[];
  seeds: {
    resampling: typeof NOT_DECLARED | { seed: number } | { suppliedSha256: string };
    /** Every seed of the plan: the first gives the map's numbers unless draws are supplied, and all of them give the table across seeds. */
    tieBreak: typeof NOT_DECLARED | { seeds: number[]; suppliedSha256?: string };
  };
};

/** `inputsHash` is hashOf(measurement), and `result` is the report itself, so `resultHash` is hashOf(report). */
export type JudgeChangeLedgerRecord = RecordBase & { kind: typeof JUDGE_CHANGE; measurement: JudgeChangeBinding };

/**
 * What produced an agreement report: the ratings file by the full sha256 of its bytes, and the
 * resampling behind every interval. No names or paths, no field null or a gap. Like the
 * judge-change binding it is not signed: validation shows that the record is well formed and that its
 * binding and its report agree, never that the report was derived from the file. Verifying it means
 * recomputing the report from the file and comparing `resultHash`.
 */
export type AgreementBinding = { files: [{ role: 'ratings'; sha256: string }]; seeds: { bootstrap: BootstrapOptions } };
/**
 * What produced a drift report: the old and the new anchor file, in that order, the resampling, and
 * the flagged labels, which come from the command line and not from a file.
 */
export type DriftBinding = { files: [{ role: 'anchor-old'; sha256: string }, { role: 'anchor-new'; sha256: string }]; seeds: { bootstrap: BootstrapOptions }; flagLabels: string[] };

/** `inputsHash` is hashOf(measurement), and `result` is the report itself, so `resultHash` is hashOf(report). */
export type RatingsLedgerRecord = RecordBase & ({ kind: 'agreement'; measurement: AgreementBinding } | { kind: 'drift'; measurement: DriftBinding });

export type LedgerRecord = RunLedgerRecord | RatingsLedgerRecord | JudgeChangeLedgerRecord;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isSeed = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 0xffffffff;

/** Whether a value is a bootstrap: { iterations, seed, alpha } with a uint32 seed, a positive number of resamples and alpha in (0, 1). */
function isBootstrap(x: unknown): x is BootstrapOptions {
  return (
    isObj(x) && extraKeys(x, ['iterations', 'seed', 'alpha'], '').length === 0 &&
    isSeed(x['seed']) && Number.isSafeInteger(x['iterations']) && (x['iterations'] as number) >= 1 &&
    typeof x['alpha'] === 'number' && x['alpha'] > 0 && x['alpha'] < 1
  );
}

/** hashOf, or undefined for a value with no canonical JSON (a non-finite number, say). */
function hashOrUndefined(x: unknown): string | undefined {
  try {
    return hashOf(x);
  } catch {
    return undefined;
  }
}

/** The canonical order of a binding's files: by role, in the order of the one role list, then by sha256. */
const roleRank = (role: string): number => (FILE_ROLES as readonly string[]).indexOf(role);
const fileOrder = (a: { role: string; sha256: string }, b: { role: string; sha256: string }): number =>
  roleRank(a.role) - roleRank(b.role) || (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0);

/** Whether a part of a report is a withheld record: declared by the plan, and not computed. */
const isWithheld = (x: unknown): boolean => isObj(x) && typeof x['withheld'] === 'string';

/**
 * Every problem with the binding of a judge-change record, and with how it sits against the report
 * it carries. Where the report holds a fact about its inputs (its run files, its reference files, its
 * resampling draws, its tie-break seeds), the binding must state the same fact. A block the report
 * withholds carries no file hash and no seed, so only its presence is checked there.
 */
function bindingProblems(m: unknown, record: Record<string, unknown>): string[] {
  const at = 'record.measurement';
  if (!isObj(m)) return [`${at}: must be { planHash, files, seeds }`];
  const problems = extraKeys(m, ['planHash', 'files', 'seeds'], at);
  if (!isSha256Hex(m['planHash'])) problems.push(`${at}.planHash: must be a full sha256`);
  const supplied: Record<'tie-break' | 'resample-indices', string | undefined> = { 'tie-break': undefined, 'resample-indices': undefined };
  const seeds = m['seeds'];
  if (!isObj(seeds)) problems.push(`${at}.seeds: must be { resampling, tieBreak }`);
  else {
    appendAll(problems, extraKeys(seeds, ['resampling', 'tieBreak'], `${at}.seeds`));
    const res = seeds['resampling'];
    const resKeys = isObj(res) ? Object.keys(res).join() : '';
    if (isObj(res) && resKeys === 'suppliedSha256' && isSha256Hex(res['suppliedSha256'])) supplied['resample-indices'] = res['suppliedSha256'];
    else if (!(res === NOT_DECLARED || (isObj(res) && resKeys === 'seed' && isSeed(res['seed'])))) {
      problems.push(`${at}.seeds.resampling: must be "${NOT_DECLARED}", { seed } with a uint32 seed, or { suppliedSha256 } with a full sha256`);
    }
    const tie = seeds['tieBreak'];
    if (tie !== NOT_DECLARED) {
      const list = isObj(tie) ? tie['seeds'] : undefined;
      const ok =
        isObj(tie) &&
        extraKeys(tie, ['seeds', 'suppliedSha256'], '').length === 0 &&
        Array.isArray(list) && list.length > 0 && list.every(isSeed) && new Set(list).size === list.length &&
        (!('suppliedSha256' in tie) || isSha256Hex(tie['suppliedSha256']));
      if (!ok) problems.push(`${at}.seeds.tieBreak: must be "${NOT_DECLARED}", or { seeds, suppliedSha256? } with distinct uint32 seeds and a full sha256`);
      else if (isSha256Hex(tie['suppliedSha256'])) supplied['tie-break'] = tie['suppliedSha256'];
    }
  }
  const files = m['files'];
  if (!Array.isArray(files) || files.length === 0) return [...problems, `${at}.files: must be a non-empty list of { role, sha256 }`];
  const seen = new Set<string>();
  const byRole = new Map<string, string[]>();
  files.forEach((f: unknown, i) => {
    const fat = `${at}.files[${i}]`;
    if (!isObj(f)) return void problems.push(`${fat}: must be { role, sha256 }`);
    appendAll(problems, extraKeys(f, ['role', 'sha256'], fat));
    const role = f['role'];
    const sha = f['sha256'];
    if (!(FILE_ROLES as readonly unknown[]).includes(role)) problems.push(`${fat}.role: must be one of ${FILE_ROLES.join(', ')}`);
    if (!isSha256Hex(sha)) problems.push(`${fat}.sha256: must be the full sha256 of the file`);
    else if (seen.has(sha)) problems.push(`${fat}.sha256: listed twice; each file enters a record once`);
    else {
      seen.add(sha);
      if (typeof role === 'string') { const list = byRole.get(role); if (list === undefined) byRole.set(role, [sha]); else list.push(sha); }
    }
  });
  // The order is checked once every entry has a known role and a hash; until then those problems speak.
  const ordered = files.filter((f: unknown): f is { role: string; sha256: string } => isObj(f) && typeof f['role'] === 'string' && roleRank(f['role']) >= 0 && typeof f['sha256'] === 'string');
  if (ordered.length === files.length && ordered.some((f, i) => i > 0 && fileOrder(ordered[i - 1] as { role: string; sha256: string }, f) > 0)) {
    problems.push(`${at}.files: must be sorted by role (${FILE_ROLES.join(', ')}), then by sha256; one set of files has one binding`);
  }
  const of = (role: FileRole): string[] => byRole.get(role) ?? [];
  for (const role of ['plan', 'bar'] as const) {
    if (of(role).length !== 1) problems.push(`${at}.files: exactly one file with role "${role}", found ${of(role).length}`);
  }
  const runs = of('run');
  if (runs.length < 2 || runs.length % 2 !== 0) problems.push(`${at}.files: an old-judge and a new-judge run for each system, found ${runs.length} run file(s)`);
  // One reference file may serve several systems, so there are at most as many reference files as systems.
  else if (of('reference').length > runs.length / 2) problems.push(`${at}.files: a reference for every system, or for none; found ${of('reference').length} reference file(s) for ${runs.length / 2} system(s)`);
  // A supplied-draw file stands in for a seed: the seed entry and the file must name each other.
  for (const [role, entry] of [['resample-indices', 'resampling'], ['tie-break', 'tieBreak']] as const) {
    const named = supplied[role];
    const present = of(role);
    if (named !== undefined && !present.includes(named)) problems.push(`${at}.seeds.${entry}.suppliedSha256: no file with role "${role}" has this sha256`);
    if (present.length > (named === undefined ? 0 : 1)) {
      problems.push(`${at}.files: ${present.length} file(s) with role "${role}" but seeds.${entry} names ${named === undefined ? 'no supplied draws' : 'one'}`);
    }
  }
  // The record against the report it carries: one plan, one tool, the same run and reference files, the same seeds.
  const result = record['result'];
  if (isObj(result)) {
    if (result['kind'] !== 'measurement') problems.push('record.result.kind: must be "measurement", the judge-change report');
    if (isSha256Hex(m['planHash']) && result['planHash'] !== m['planHash']) problems.push(`${at}.planHash: differs from result.planHash`);
    if (hashOrUndefined(result['tool']) !== hashOrUndefined(record['tool'])) problems.push('record.tool: differs from result.tool');
    const inputs = result['inputs'];
    if (!Array.isArray(inputs) || !inputs.every((x) => isObj(x) && isSha256Hex(x['sha256']))) problems.push('record.result.inputs: must list the run files of the report, each with its sha256');
    else if (inputs.map((x: Record<string, unknown>) => x['sha256']).sort().join() !== [...runs].sort().join()) problems.push(`${at}.files: the run files must be exactly the runs of result.inputs`);
    // The reference files: none where the report has no reference, and exactly the report's where it lists them.
    const refs = of('reference');
    const reference = result['reference'];
    const refInputs = isObj(reference) ? reference['inputs'] : undefined;
    if (reference === NOT_DECLARED) {
      if (refs.length > 0) problems.push(`${at}.files: ${refs.length} file(s) with role "reference", but result.reference is "${NOT_DECLARED}"`);
    } else if (isWithheld(reference)) {
      if (refs.length === 0) problems.push(`${at}.files: no file with role "reference", but result.reference is withheld, so the plan named a reference for every system`);
    } else if (!Array.isArray(refInputs) || !refInputs.every((x) => isObj(x) && isSha256Hex(x['sha256']))) {
      problems.push('record.result.reference: must be "not declared", a withheld record, or list the reference files of the report, each with its sha256');
    } else if ([...new Set(refInputs.map((x: Record<string, unknown>) => x['sha256']))].sort().join() !== [...refs].sort().join() || refInputs.length !== runs.length / 2) {
      // The report lists a reference once for each system that uses it, so a shared file shows once for each of them and once in the binding.
      problems.push(`${at}.files: the reference files must be exactly the references of result.reference.inputs`);
    }
    // The seeds: what the report says its resamples and its tie-break came from.
    if (isObj(seeds)) {
      const declared = (entry: unknown, part: unknown, name: string, block: string): boolean => {
        if (part === NOT_DECLARED) {
          if (entry !== NOT_DECLARED) problems.push(`${at}.seeds.${name}: result.${block} is "${NOT_DECLARED}", so this must be "${NOT_DECLARED}" too`);
          return false;
        }
        if (entry === NOT_DECLARED) problems.push(`${at}.seeds.${name}: "${NOT_DECLARED}", but result.${block} is declared`);
        return entry !== NOT_DECLARED && !isWithheld(part);
      };
      const spread = result['spread'];
      if (declared(seeds['resampling'], spread, 'resampling', 'spread')) {
        const draws = isObj(spread) ? spread['draws'] : undefined;
        if (!isObj(draws)) problems.push('record.result.spread: must be "not declared", a withheld record, or hold its draws');
        else if (hashOrUndefined(draws) !== hashOrUndefined(seeds['resampling'])) problems.push(`${at}.seeds.resampling: differs from result.spread.draws`);
      }
      const map = result['map'];
      const tie = seeds['tieBreak'];
      if (declared(tie, map, 'tieBreak', 'map')) {
        const over = isObj(map) ? map['overTieBreakSeeds'] : undefined;
        const first = isObj(map) ? map['tieBreak'] : undefined;
        if (!isObj(over) || !Array.isArray(over['seeds']) || !isObj(first)) problems.push('record.result.map: must be "not declared", a withheld record, or hold its tie-break and its seeds');
        else if (isObj(tie)) {
          if (hashOrUndefined(over['seeds']) !== hashOrUndefined(tie['seeds'])) problems.push(`${at}.seeds.tieBreak.seeds: differs from result.map.overTieBreakSeeds.seeds`);
          // The map's point came from the supplied draws, or from the first seed: the record must say the same.
          const point = 'suppliedSha256' in tie ? { suppliedSha256: tie['suppliedSha256'] } : { seed: Array.isArray(tie['seeds']) ? tie['seeds'][0] : undefined };
          if (hashOrUndefined(point) !== hashOrUndefined(first)) problems.push(`${at}.seeds.tieBreak: differs from result.map.tieBreak, the draws behind the map's numbers`);
        }
      }
    }
  }
  if (isSha256Hex(record['inputsHash']) && hashOrUndefined(m) !== record['inputsHash']) problems.push('record.inputsHash: does not match hashOf(measurement)');
  return problems;
}

const RATINGS_ROLES: Record<string, readonly string[]> = { agreement: ['ratings'], drift: ['anchor-old', 'anchor-new'] };

/**
 * Every problem with the binding of an agreement or drift record, and with how it sits against the
 * report it carries: the report must be of the record's kind, state the same resampling as the
 * binding, draw every interval under it, and (drift) flag the same labels.
 */
function ratingsBindingProblems(kind: string, m: unknown, record: Record<string, unknown>): string[] {
  const at = 'record.measurement';
  const drift = kind === 'drift';
  const keys = drift ? ['files', 'seeds', 'flagLabels'] : ['files', 'seeds'];
  if (!isObj(m)) return [`${at}: must be { ${keys.join(', ')} }`];
  const problems = extraKeys(m, keys, at);
  const roles = RATINGS_ROLES[kind] as readonly string[];
  const files = m['files'];
  if (!Array.isArray(files) || files.length !== roles.length || !files.every((f: unknown, i) => isObj(f) && f['role'] === roles[i])) {
    problems.push(`${at}.files: must be exactly [${roles.join(', ')}], each { role, sha256 }, in that order`);
  } else {
    files.forEach((f: Record<string, unknown>, i) => {
      appendAll(problems, extraKeys(f, ['role', 'sha256'], `${at}.files[${i}]`));
      if (!isSha256Hex(f['sha256'])) problems.push(`${at}.files[${i}].sha256: must be the full sha256 of the file`);
    });
  }
  const seeds = m['seeds'];
  const boot = isObj(seeds) ? seeds['bootstrap'] : undefined;
  const bootOk = isObj(seeds) && Object.keys(seeds).join() === 'bootstrap' && isBootstrap(boot);
  if (!bootOk) problems.push(`${at}.seeds.bootstrap: must be { iterations, seed, alpha } with a uint32 seed, a positive number of resamples and alpha in (0, 1)`);
  const flags = m['flagLabels'];
  const flagsOk = Array.isArray(flags) && flags.length > 0 && flags.every((f) => typeof f === 'string' && f !== '');
  if (drift && !flagsOk) problems.push(`${at}.flagLabels: must be a non-empty list of labels`);
  const result = record['result'];
  if (isObj(result)) {
    const isReport = drift ? typeof result['classification'] === 'string' && isObj(result['transition']) : (result['kappaKind'] === 'cohen' || result['kappaKind'] === 'fleiss') && Array.isArray(result['raters']);
    if (!isReport) problems.push(`record.result: must be the ${kind} report`);
    else {
      // The result is the object --json prints: it names its contract and the tool, and the tool is the record's.
      const schema = drift ? REPORT_SCHEMAS.drift : REPORT_SCHEMAS.agree;
      if (result['schema'] !== schema) problems.push(`record.result.schema: must be "${schema}"`);
      // The sentence on what the figures describe goes with the report wherever it is read; an agree report also keeps its statement about its names, and its contents must agree with that statement.
      if (result['scope'] !== (drift ? DRIFT_SCOPE : AGREE_SCOPE)) problems.push('record.result.scope: must be the report\'s own sentence on what its figures describe');
      if (!drift) {
        if (!RATER_IDENTITIES.includes(result['raterIdentity'])) problems.push('record.result.raterIdentity: required: "persistent", "positional" or "UNKNOWN"');
        else if (result['raterIdentity'] !== 'persistent' && (result['kappaKind'] !== 'fleiss' || !Array.isArray(result['pairwise']) || result['pairwise'].length > 0)) {
          problems.push('record.result: a report whose names are not persistent raters holds no pair row and uses Fleiss\' kappa');
        }
        if (RATER_IDENTITIES.includes(result['raterIdentity'])) appendAll(problems, agreeReportProblems(result));
      }
      if (hashOrUndefined(result['tool']) !== hashOrUndefined(record['tool'])) problems.push('record.tool: differs from result.tool');
      const stated = result['bootstrap'];
      if (bootOk && hashOrUndefined(stated) !== hashOrUndefined(boot)) problems.push(`${at}.seeds.bootstrap: differs from result.bootstrap`);
      // Every interval of the report names its own seed: none may have been drawn under another.
      const intervals: [string, unknown][] = [['kappaCI', result['kappaCI']], ['ac1CI', result['ac1CI']]];
      const rows = result['pairwise'];
      if (Array.isArray(rows)) rows.forEach((row: unknown, i) => isObj(row) && intervals.push([`pairwise[${i}].kappaCI`, row['kappaCI']], [`pairwise[${i}].ac1CI`, row['ac1CI']]));
      for (const [name, ci] of intervals) {
        if (isObj(ci) && isObj(stated) && (ci['seed'] !== stated['seed'] || ci['iterations'] !== stated['iterations'] || ci['alpha'] !== stated['alpha'])) {
          problems.push(`record.result.${name}: its seed, iterations or alpha differ from result.bootstrap`);
        }
      }
      if (drift && flagsOk && hashOrUndefined(result['flagLabels']) !== hashOrUndefined(flags)) problems.push(`${at}.flagLabels: differs from result.flagLabels`);
    }
  }
  if (isSha256Hex(record['inputsHash']) && hashOrUndefined(m) !== record['inputsHash']) problems.push('record.inputsHash: does not match hashOf(measurement)');
  return problems;
}

/**
 * Every problem with the inputs of a gate record, and with how they sit against the record around them: the record's
 * identity is the candidate's, its inputsHash is the hash of the inputs, and the re-judge bootstrap is the one the
 * result's judge-controlled split states. A split that was refused states none.
 */
function gateInputsProblems(inputs: unknown, record: Record<string, unknown>): string[] {
  const at = 'record.inputs';
  if (!isObj(inputs)) return [`${at}: must be { baseline, candidate, barHash, allowDiffer }, with rejudgeOf and bootstrap for a gate against a re-judged baseline`];
  const problems = extraKeys(inputs, ['baseline', 'candidate', 'barHash', 'allowDiffer', 'rejudgeOf', 'bootstrap'], at);
  appendAll(problems, validateIdentity(inputs['baseline'], `${at}.baseline`));
  appendAll(problems, validateIdentity(inputs['candidate'], `${at}.candidate`));
  const rejudged = 'rejudgeOf' in inputs && inputs['rejudgeOf'] !== undefined;
  if (rejudged) appendAll(problems, validateIdentity(inputs['rejudgeOf'], `${at}.rejudgeOf`));
  if (!isSha256Hex(inputs['barHash'])) problems.push(`${at}.barHash: must be a full sha256`);
  const waived = inputs['allowDiffer'];
  const rank = (f: unknown): number => (IDENTITY_FIELDS as readonly unknown[]).indexOf(f);
  const ordered = Array.isArray(waived) && waived.every((f) => rank(f) >= 0) && waived.every((f, i) => i === 0 || rank(waived[i - 1]) < rank(f));
  if (!ordered) problems.push(`${at}.allowDiffer: must list identity fields, each once, in the order of the identity's fields`);
  const bootstrapped = 'bootstrap' in inputs && inputs['bootstrap'] !== undefined;
  if (rejudged !== bootstrapped) problems.push(`${at}: rejudgeOf and bootstrap come together`);
  if (bootstrapped && !isBootstrap(inputs['bootstrap'])) {
    problems.push(`${at}.bootstrap: must be { iterations, seed, alpha } with a uint32 seed, a positive number of resamples and alpha in (0, 1)`);
  }
  if (ordered) {
    // A judge field is never waived on a gate, re-judged baseline or not; the rubric is not either when either run has a judge; nor is the draw count (gateRuns).
    const judged = ['baseline', 'candidate', 'rejudgeOf'].some((k) => isObj(inputs[k]) && inputs[k]['judgeDefinitionHash'] !== NO_JUDGE);
    const never = gateNeverWaives(waived as string[], judged);
    if (never.length > 0) problems.push(`${at}.allowDiffer: ${never.join(', ')} cannot be allowed to differ on a gate`);
  }
  if (isObj(inputs['candidate']) && hashOrUndefined(record['identity']) !== hashOrUndefined(inputs['candidate'])) problems.push('record.identity: differs from record.inputs.candidate');
  if (isSha256Hex(record['inputsHash']) && hashOrUndefined(inputs) !== record['inputsHash']) problems.push('record.inputsHash: does not match hashOf(inputs)');
  const control = isObj(record['result']) ? record['result']['judgeControl'] : undefined;
  if (control !== undefined) {
    const shape = 'record.result.judgeControl: must be { refused, fields } or { seed, iterations, alpha } as numbers';
    if (!rejudged) problems.push('record.result.judgeControl: present, but record.inputs names no re-judged baseline');
    else if (isObj(control) && 'refused' in control) {
      // The refused form states no resampling: it carries nothing but the code and the fields that stopped the split.
      if (typeof control['refused'] !== 'string' || !Array.isArray(control['fields']) || !control['fields'].every((f) => typeof f === 'string') || extraKeys(control, ['refused', 'fields'], '').length > 0) {
        problems.push(shape);
      }
    } else if (!isObj(control) || typeof control['seed'] !== 'number' || typeof control['iterations'] !== 'number' || typeof control['alpha'] !== 'number') {
      problems.push(shape);
    } else {
      const stated = { iterations: control['iterations'], seed: control['seed'], alpha: control['alpha'] };
      if (bootstrapped && hashOrUndefined(inputs['bootstrap']) !== hashOrUndefined(stated)) problems.push(`${at}.bootstrap: differs from result.judgeControl`);
    }
  }
  return problems;
}

/** Every problem with a ledger record; empty when valid. */
export function validateRecord(x: unknown): string[] {
  if (!isObj(x)) return ['record: must be an object'];
  const r = x;
  const problems: string[] = [];
  findNulls(r, 'record', problems);
  findIllFormed(r, 'record', problems);
  // Past 2^53 - 1 an integer cannot be read exactly: the record would bind a number other than the one it holds.
  findInexactIntegers(r, 'record', problems, '');
  const judgeChange = r['kind'] === JUDGE_CHANGE;
  const ratings = typeof r['kind'] === 'string' && RATINGS_KINDS.includes(r['kind']);
  // A record has the identity of a run or the binding of a measurement, by its kind, and never both.
  appendAll(problems, extraKeys(r, ['schema', 'at', 'kind', ...(judgeChange || ratings ? ['measurement'] : ['identity', 'inputs']), 'inputsHash', 'resultHash', 'result', 'tool'], 'record'));
  if (ratings && 'identity' in r) problems.push('record.identity: an agreement or drift record carries "measurement" (file hashes and seeds), not a run identity');
  if (r['schema'] !== LEDGER_SCHEMA) problems.push(`record.schema: must be "${LEDGER_SCHEMA}"`);
  if (typeof r['at'] !== 'string' || !ISO_RE.test(r['at']) || Number.isNaN(Date.parse(r['at']))) {
    problems.push('record.at: must be an ISO-8601 UTC timestamp');
  }
  if (typeof r['kind'] !== 'string' || !KINDS.includes(r['kind'])) problems.push(`record.kind: must be one of ${KINDS.join(', ')}`);
  if (!isSha256Hex(r['inputsHash'])) problems.push('record.inputsHash: must be a full sha256 hex');
  if (!isSha256Hex(r['resultHash'])) problems.push('record.resultHash: must be a full sha256 hex');
  const result = r['result'];
  if (!isObj(result)) {
    problems.push('record.result: must be an object');
  } else if (isSha256Hex(r['resultHash']) && hashOrUndefined(result) !== r['resultHash']) {
    problems.push('record.resultHash: does not match hashOf(result)');
  }
  const tool = r['tool'];
  if (!isObj(tool) || tool['name'] !== TOOL_NAME || typeof tool['version'] !== 'string') {
    problems.push(`record.tool: must be { name: "${TOOL_NAME}", version: string }`);
  }
  if (judgeChange) appendAll(problems, bindingProblems(r['measurement'], r));
  else if (ratings) appendAll(problems, ratingsBindingProblems(r['kind'] as string, r['measurement'], r));
  else {
    appendAll(problems, validateIdentity(r['identity'], 'record.identity'));
    appendAll(problems, gateInputsProblems(r['inputs'], r));
  }
  return problems;
}

/**
 * Builds the record of one gate: the inputs it was given, whose hash is `inputsHash`, and the result summary. The
 * record's identity is the candidate's, taken from the inputs, so a record cannot contradict the inputs it carries.
 * The waived fields are stored in the order of the identity's fields, whatever order they are given in. Throws
 * InputError('INVALID_LEDGER') for inputs that do not validate.
 */
export function makeGateRecord(args: { inputs: GateInputs; result: Record<string, unknown>; at?: Date }): RunLedgerRecord {
  // The waived fields are a set, stored in the one order of the identity's fields, so the array a caller gave `gateRuns` is
  // accepted in any order. Ordering changes no meaning; a repeated or unknown field is left as it is, and refused below.
  const rank = (f: string): number => (IDENTITY_FIELDS as readonly string[]).indexOf(f);
  // A caller without types may hand over anything: the record is refused in the words the reader of a ledger would see, not by a TypeError.
  if (!isObj(args.inputs)) throw new InputError('INVALID_LEDGER', gateInputsProblems(args.inputs, {}));
  const inputs: GateInputs = Array.isArray(args.inputs.allowDiffer) ? { ...args.inputs, allowDiffer: [...args.inputs.allowDiffer].sort((a, b) => rank(a) - rank(b)) } : args.inputs;
  const record: RunLedgerRecord = {
    schema: LEDGER_SCHEMA,
    at: (args.at ?? new Date()).toISOString(),
    kind: 'gate',
    identity: inputs.candidate,
    inputs,
    inputsHash: hashOrUndefined(inputs) ?? '',
    resultHash: hashOrUndefined(args.result) ?? '',
    result: args.result,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
  };
  const problems = validateRecord(record);
  if (problems.length > 0) throw new InputError('INVALID_LEDGER', problems);
  return record;
}

/** A file's bytes as JSON, or the reason they are not: not UTF-8, a byte-order mark, not JSON, nested too deep, or an object that gives a key twice. */
function jsonOf(bytes: Uint8Array): { json: unknown } | { problem: string } {
  const parsed = parseJsonBytes(bytes);
  return 'problem' in parsed ? { problem: parsed.problem } : parsed;
}

/**
 * Builds the record of one judge-change report from the bytes of the plan file and of the bar file,
 * as read, and the report. It hashes the bytes itself and reads the plan from them, so the file
 * hashes of a record cannot contradict the plan it is bound to: the plan in those bytes must be the
 * report's (`planHash`), and the bar in those bytes must be the plan's and the report's (`barHash`).
 * The other files and the seeds are read from the plan: the measurement refuses unless the files it
 * was given are exactly the plan's roster, so a report that exists read those files and no others.
 * The result is the report itself. Throws InputError('INVALID_LEDGER') for bytes that are not a plan
 * or a bar, for a report that is not this plan's, and for a report that has no hash.
 */
export function makeJudgeChangeRecord(args: {
  planFile: Uint8Array;
  barFile: Uint8Array;
  report: JudgeChangeReport;
  at?: Date;
}): JudgeChangeLedgerRecord {
  const { report } = args;
  const planJson = jsonOf(args.planFile);
  const barJson = jsonOf(args.barFile);
  const unread = [
    ...('problem' in planJson ? [`plan file: ${planJson.problem}`] : judgeChangePlanProblems(planJson.json).map((p) => `plan file: ${p}`)),
    ...('problem' in barJson ? [`bar file: ${barJson.problem}`] : []),
  ];
  if (unread.length > 0) throw new InputError('INVALID_LEDGER', unread);
  const plan = (planJson as { json: unknown }).json as JudgeChangePlan;
  let barFileHash: string;
  try {
    barFileHash = barHash(parseBarFile((barJson as { json: unknown }).json));
  } catch (e) {
    if (e instanceof InputError) throw new InputError('INVALID_LEDGER', e.problems.map((p) => `bar file: ${p}`));
    throw e;
  }
  const unbound = [
    ...(barFileHash === plan.barHash ? [] : [`bar file: its barHash is ${barFileHash}, and the plan file declares ${plan.barHash}`]),
    ...(isObj(report) && report.barHash === plan.barHash ? [] : [`record.result.barHash: differs from the plan file's barHash ${plan.barHash}`]),
  ];
  if (unbound.length > 0) throw new InputError('INVALID_LEDGER', unbound);
  const roster = Object.values(plan.systems);
  const res = plan.resampling;
  const tie = plan.map?.tieBreak;
  const resSha = res !== undefined && 'suppliedSha256' in res ? res.suppliedSha256 : undefined;
  const of = (role: FileRole, hashes: readonly string[]): JudgeChangeBinding['files'] => hashes.map((sha256) => ({ role, sha256 }));
  const measurement: JudgeChangeBinding = {
    planHash: hashOrUndefined(plan) ?? '',
    files: [
      ...of('plan', [sha256Hex(args.planFile)]),
      ...of('bar', [sha256Hex(args.barFile)]),
      ...of('run', roster.flatMap((f) => [f.old, f.new])),
      ...of('reference', [...new Set(roster.flatMap((f) => (f.reference === undefined ? [] : [f.reference])))]),
      ...of('tie-break', tie?.suppliedSha256 === undefined ? [] : [tie.suppliedSha256]),
      ...of('resample-indices', resSha === undefined ? [] : [resSha]),
    ].sort(fileOrder),
    seeds: {
      resampling: res === undefined ? NOT_DECLARED : 'seed' in res ? { seed: res.seed } : { suppliedSha256: res.suppliedSha256 },
      tieBreak: tie === undefined ? NOT_DECLARED : { seeds: [...tie.seeds], ...(tie.suppliedSha256 === undefined ? {} : { suppliedSha256: tie.suppliedSha256 }) },
    },
  };
  const resultHash = hashOrUndefined(report);
  if (resultHash === undefined) throw new InputError('INVALID_LEDGER', ['record.result: the report cannot be hashed: it holds a value with no canonical JSON']);
  const record: JudgeChangeLedgerRecord = {
    schema: LEDGER_SCHEMA,
    at: (args.at ?? new Date()).toISOString(),
    kind: JUDGE_CHANGE,
    measurement,
    inputsHash: hashOf(measurement),
    resultHash,
    result: report,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
  };
  const problems = validateRecord(record);
  if (problems.length > 0) throw new InputError('INVALID_LEDGER', problems);
  return record;
}

/**
 * Builds the record of one agreement or drift report from the bytes of the rating files, as read, and
 * the report. It hashes the bytes itself, and takes the resampling and the flagged labels from the
 * report, so a record's binding cannot contradict the report it carries. The result is the report
 * itself. Throws InputError('INVALID_LEDGER') for a report of the other kind and for one that has no hash.
 */
export function makeRatingsRecord(
  args:
    | { kind: 'agreement'; ratingsFile: Uint8Array; report: AgreementReport; at?: Date }
    | { kind: 'drift'; oldFile: Uint8Array; newFile: Uint8Array; report: DriftReport; at?: Date },
): RatingsLedgerRecord {
  const seeds = { bootstrap: isObj(args.report) ? args.report.bootstrap : (undefined as unknown as BootstrapOptions) };
  const resultHash = hashOrUndefined(args.report);
  if (resultHash === undefined) throw new InputError('INVALID_LEDGER', ['record.result: the report cannot be hashed: it holds a value with no canonical JSON']);
  const base = {
    schema: LEDGER_SCHEMA,
    at: (args.at ?? new Date()).toISOString(),
    resultHash,
    result: args.report as unknown as Record<string, unknown>,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
  } as const;
  let record: RatingsLedgerRecord;
  if (args.kind === 'agreement') {
    const measurement: AgreementBinding = { files: [{ role: 'ratings', sha256: sha256Hex(args.ratingsFile) }], seeds };
    record = { ...base, kind: 'agreement', measurement, inputsHash: hashOrUndefined(measurement) ?? '' };
  } else {
    const measurement: DriftBinding = {
      files: [{ role: 'anchor-old', sha256: sha256Hex(args.oldFile) }, { role: 'anchor-new', sha256: sha256Hex(args.newFile) }],
      seeds,
      flagLabels: [...(args.report.flagLabels ?? [])],
    };
    record = { ...base, kind: 'drift', measurement, inputsHash: hashOrUndefined(measurement) ?? '' };
  }
  const problems = validateRecord(record);
  if (problems.length > 0) throw new InputError('INVALID_LEDGER', problems);
  return record;
}

/**
 * True for an error the file system gave: a failed system call (it names the call), or Node's own
 * refusal to read a file (ERR_FS_...). Only such an error says something about the ledger path.
 */
function isFileSystemError(e: unknown): boolean {
  const code: unknown = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && (typeof (e as NodeJS.ErrnoException).syscall === 'string' || code.startsWith('ERR_FS_'));
}

/** A file-system failure on the ledger path, as invalid input naming the path (exit 65, never exit 1). */
function ledgerIoError(path: string, e: unknown): InputError {
  const code = (e as NodeJS.ErrnoException).code;
  const why = code === 'ENOTDIR' ? 'a parent of this path is a file, not a directory' : (e as Error).message;
  return new InputError('INVALID_LEDGER', [`${path}: ${why}`]);
}

/**
 * Refuses a ledger path that can be seen to be unable to take a record, before anything is measured:
 * a path that is not a regular file (a directory, a device such as /dev/null, a pipe), a path under a
 * file, an existing file with any line that is not a valid record of this schema or whose last byte
 * is not a newline, an existing file this process may not write to, and a missing file whose nearest
 * existing folder it may not write to. A missing file is fine. Everything is invalid input naming the
 * path, so a bad --ledger never reads as a regression. Returns the number of records the file holds.
 * It is a check, not a lock: a failure of the write itself (a full disk, a permission that changed)
 * is still reported by appendRecord, after the fact.
 */
export function checkLedgerFile(path: string): number {
  let isFile: boolean;
  let isDirectory: boolean;
  try {
    const s = statSync(path);
    isFile = s.isFile();
    isDirectory = s.isDirectory();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw ledgerIoError(path, e);
    // The file does not exist yet: the nearest folder that does must be one this process can add to.
    let dir = dirname(path);
    for (;;) {
      try {
        if (!statSync(dir).isDirectory()) throw new InputError('INVALID_LEDGER', [`${path}: a parent of this path is a file, not a directory`]);
        accessSync(dir, constants.W_OK | constants.X_OK);
        return 0;
      } catch (inner) {
        if (inner instanceof InputError) throw inner;
        const parent = dirname(dir);
        if ((inner as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dir) throw ledgerIoError(path, inner);
        dir = parent;
      }
    }
  }
  if (isDirectory) throw new InputError('INVALID_LEDGER', [`${path}: is a directory`]);
  // A device or a pipe would take the bytes and keep nothing: a record there is a record nobody can read.
  if (!isFile) throw new InputError('INVALID_LEDGER', [`${path}: is not a regular file; a ledger is a file that keeps what is appended to it`]);
  let held: number;
  try {
    held = readLedger(path).length;
  } catch (e) {
    if (e instanceof InputError) throw new InputError(e.code, e.problems.map((p) => `${path}: ${p}`));
    // Only what the file system said is a fact about this file. Any other error is a defect of the reader, and calling it an invalid ledger would hide it.
    if (isFileSystemError(e)) throw ledgerIoError(path, e);
    throw e;
  }
  try {
    accessSync(path, constants.W_OK);
  } catch (e) {
    throw ledgerIoError(path, e);
  }
  return held;
}

/**
 * Validates the record and the existing file, then appends one canonical-JSON line. The file is only
 * ever opened for append. Returns where the record went: its 1-based line, as the file stood when it
 * was checked, and `recordHash`, the sha256 of the line without its newline, which is hashOf(record).
 */
export function appendRecord(path: string, record: LedgerRecord): { line: number; recordHash: string } {
  const problems = validateRecord(record);
  if (problems.length > 0) throw new InputError('INVALID_LEDGER', problems);
  const held = checkLedgerFile(path);
  const text = canonicalJson(record);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${text}\n`, { flag: 'a' });
  } catch (e) {
    throw ledgerIoError(path, e);
  }
  return { line: held + 1, recordHash: sha256Hex(text) };
}

/**
 * Parses and validates every line; the error names the first bad line (1-based). A file that holds
 * anything must end with a newline: a last line without one may be a record cut short, and an append
 * would be written onto that line and leave both records unreadable.
 */
export function readLedger(path: string): LedgerRecord[] {
  const bytes = readFileSync(path);
  const decoded = utf8Text(bytes);
  if ('problem' in decoded) {
    // The bytes are never replaced: a record read with U+FFFD in it is another record. The line is named: a line
    // feed is one byte in UTF-8 and part of no other character, so the bytes split into the file's lines as they are.
    let line = 1;
    if (decoded.problem === NOT_UTF8) {
      for (let from = 0; from <= bytes.length; line += 1) {
        const lf = bytes.indexOf(0x0a, from);
        const to = lf < 0 ? bytes.length : lf;
        const one = utf8Text(bytes.subarray(from, to));
        if ('problem' in one && one.problem === NOT_UTF8) break;
        from = to + 1;
      }
    }
    // A file too long to read is refused by its length alone: no line of it is at fault.
    throw new InputError('INVALID_LEDGER', [decoded.problem === TOO_LONG ? decoded.problem : `line ${line}: ${decoded.problem}`]);
  }
  const text = decoded.text;
  const lines = text.split('\n');
  const unterminated = lines.at(-1) !== '';
  if (!unterminated) lines.pop();
  const records = lines.map((line, i) => {
    // A record that gives a key twice is unreadable, like a line that is not JSON: which of its two values was meant is not on the line.
    const read = parseJsonText(line);
    if ('problem' in read) throw new InputError('INVALID_LEDGER', [`line ${i + 1}: ${read.notJson ? 'not valid JSON' : read.problem}`]);
    const parsed = read.json;
    const problems = validateRecord(parsed);
    if (problems.length > 0) throw new InputError('INVALID_LEDGER', problems.map((p) => `line ${i + 1}: ${p}`));
    return parsed as LedgerRecord;
  });
  if (unterminated && text !== '') throw new InputError('INVALID_LEDGER', [`line ${lines.length}: the file does not end with a newline; the last record may be cut short, and nothing is appended to it`]);
  return records;
}
