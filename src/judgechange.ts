import { assertSameOutputs, comparePackets, judgeRejected, listed, runArtifactProblems, RUN_SCHEMA, samePacket, systemFacts } from './artifact.ts';
import type { RunArtifact } from './artifact.ts';
import { callShapeDiff } from './callshape.ts';
import { fitCut, foldOfCase, sortItems, tieBreakU } from './cutmap.ts';
import type { CutFit, FoldCut } from './cutmap.ts';
import { InputError, RefusalError } from './errors.ts';
import { barHash, parseBarFile, splitBarFile } from './gate.ts';
import type { BarFile } from './gate.ts';
import { appendAll, assertComparable, findIllFormed, findNulls, GAP, hashOf, integerProblem, isSha256Hex, MAX_DRAWS_PER_CASE, NO_JUDGE, parseJsonBytes, readsAsGap, sha256Hex } from './identity.ts';
import type { IdentityField } from './identity.ts';
import { extraKeys, finalAttempt, incompleteCounts, judgeRetries, measuredSlots, scoreAttempt, unknownStops } from './scoring.ts';
import type { Case, ClassSpec, Draw, JudgeRetries, LabelSet, Measured } from './scoring.ts';
import { cohenKappa, gwetAC1 } from './agreement.ts';
import { fewResamplesWording, forEachResample, intervalWording, levelFloorAt, levelText, MAX_RESAMPLES, NA, nominalLevelOf, nominalLevelCheck, normalQuantile, placeAmong, quantileSorted, smallestConcordantPassN, spreadOf, suppliedPercentilesWording, tangoState, toStat } from './stats.ts';
import type { GateState, Placement, Spread, Stat } from './stats.ts';
import { TOOL_NAME, TOOL_VERSION } from './version.ts';

/**
 * The judge-change measurement on stored outputs (docs/JUDGE_CHANGE.md). Two judges graded the same
 * stored outputs; this reports what changed in the labels. It is a measurement, never a gate: it has
 * no pass bit, and the label rules below are private to this module and are not the fold of `scoring.ts`.
 */
export const JUDGE_CHANGE_PLAN_SCHEMA = 'anchorset.judge-change-plan/v1';
/** A reference: a rater with no judge definition (experts, say), one file per system. */
export const REFERENCE_SCHEMA = 'anchorset.reference/v2';

/**
 * What every number says when it rests on a reference that serves as the criterion of the pair gates
 * under a stated packet difference. Fixed in code: the words are not an option.
 */
const REFERENCE_PACKET_LABELS = { different: 'reference saw a different packet', [GAP]: 'reference packet unknown' } as const;
export type ReferencePacketLabel = (typeof REFERENCE_PACKET_LABELS)[keyof typeof REFERENCE_PACKET_LABELS];
/** `referencePackets` is present exactly on what was computed against such a reference. */
type Labelled = { referencePackets?: ReferencePacketLabel };

/** The judge fields a plan fixes for each side: the five identity fields of the judge, and the rubric. */
const PLAN_JUDGE_FIELDS = ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion', 'rubricHash'] as const satisfies readonly IdentityField[];
type PlanJudgeField = (typeof PLAN_JUDGE_FIELDS)[number];
const PLAN_JUDGE_HASHES: readonly string[] = ['judgeDefinitionHash', 'judgeCallShapeHash', 'rubricHash'];

/** The identity fields every run must share with the plan, in both modes. Internal: not re-exported from index.ts. */
export const PLAN_BOUND_FIELDS: readonly IdentityField[] = ['barHash', 'caseSetHash', 'drawsPerCase', ...PLAN_JUDGE_FIELDS];

/**
 * What the stored-outputs exception (`storedOutputs`) leaves uncompared when the plan opts in. Fixed in code, never an
 * option.
 * With PLAN_BOUND_FIELDS it covers every identity field (pinned by a test). Internal: not re-exported from index.ts.
 */
export const SYSTEM_SIDE_FIELDS: readonly IdentityField[] = ['systemModelRequested', 'systemModelServed', 'systemCallShapeHash', 'systemPromptHash', 'systemToolsHash', 'systemHarnessVersion', 'seed'];

export type JudgeSide = Record<PlanJudgeField, string>;
export type LabelRule = 'worst' | 'majority';

export type JudgeChangePlan = {
  schema: typeof JUDGE_CHANGE_PLAN_SCHEMA;
  barHash: string;
  caseSetHash: string;
  drawsPerCase: number;
  judges: { old: JudgeSide; new: JudgeSide };
  /** The judge fields that differ between the two judges. It must name exactly the fields that moved. */
  judgeMoves: PlanJudgeField[];
  /** The roster: system label → the sha256 of its old-judge run file, its new-judge run file and, optionally, its reference file. */
  systems: Record<string, { old: string; new: string; reference?: string }>;
  /** The opt-in of the stored-outputs exception: whether the system-side fields and the seed are compared between the two runs. */
  storedOutputs: 'system-side-compared' | 'system-side-not-compared';
  measuredClass: string;
  cut: string;
  drawSets: { estimate: number[]; reask?: number[] };
  labelRule: LabelRule;
  pooling: 'items-equal';
  gate?: { statistic: 'tango-1998'; margin: number; alpha: number };
  resampling?: { iterations: number; seed: number; spreadFloor: number } | { suppliedSha256: string; spreadFloor: number };
  oneCasePerCluster?: true;
  map?: {
    /** Label → integer score, strictly increasing with the bar's label order. */
    encoding: Record<string, number>;
    folds: number;
    /** Cases of the measured class that only fit the cut. They enter no estimand. */
    fitOnlyCaseIds: string[];
    tieBreak: { seeds: number[]; suppliedSha256?: string };
    minSystems: number;
    minFitItems: number;
    maxTieShare: number;
  };
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** A non-negative integer that is read exactly: past 2^53 - 1 two different values in a plan would read as one. */
const isIndex = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isShare = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1;

function judgeSideProblems(x: unknown, at: string): string[] {
  if (!isObj(x)) return [`${at}: must be an object with ${PLAN_JUDGE_FIELDS.join(', ')}`];
  const problems = extraKeys(x, PLAN_JUDGE_FIELDS, at);
  for (const f of PLAN_JUDGE_FIELDS) {
    const v = x[f];
    if (PLAN_JUDGE_HASHES.includes(f)) {
      if (!isSha256Hex(v)) problems.push(`${at}.${f}: must be a full sha256; a judge-change plan names two known judges`);
    } else if (typeof v !== 'string' || v === '' || v === GAP || v === NO_JUDGE || readsAsGap(v)) {
      problems.push(`${at}.${f}: must be a known, non-empty string; a judge-change plan names two known judges`);
    }
  }
  return problems;
}

function drawSetProblems(x: unknown, drawsPerCase: unknown, rule: unknown): string[] {
  const at = 'plan.drawSets';
  if (!isObj(x)) return [`${at}: must be { estimate, reask? }`];
  const problems = extraKeys(x, ['estimate', 'reask'], at);
  const sets: [string, unknown][] = [['estimate', x['estimate']], ...('reask' in x ? [['reask', x['reask']] as [string, unknown]] : [])];
  for (const [name, set] of sets) {
    if (!Array.isArray(set) || set.length === 0 || !set.every(isIndex)) problems.push(`${at}.${name}: must be a non-empty list of draw indices`);
    else if (new Set(set).size !== set.length) problems.push(`${at}.${name}: a draw index is listed twice`);
    else if (rule === 'majority' && set.length % 2 === 0) problems.push(`${at}.${name}: a majority needs an odd number of draws, got ${set.length}`);
  }
  if (problems.length > 0 || !isIndex(drawsPerCase)) return problems;
  const estimate = x['estimate'] as number[];
  const reask = (x['reask'] ?? []) as number[];
  if (estimate.some((i) => reask.includes(i))) problems.push(`${at}: estimate and reask must be disjoint`);
  if ('reask' in x && reask.length !== estimate.length) problems.push(`${at}: estimate and reask must be of equal size`);
  const all = [...estimate, ...reask].sort((a, b) => a - b);
  // Completeness: no draw may be left out of every set, or a failing or unmeasured draw could be dropped by the choice of indices.
  if (all.length !== drawsPerCase || all.some((v, i) => v !== i)) problems.push(`${at}: the sets must together cover every draw, 0..${drawsPerCase - 1}, exactly once`);
  return problems;
}

function blockProblems(plan: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const gate = plan['gate'];
  if (gate !== undefined) {
    if (!isObj(gate)) problems.push('plan.gate: must be { statistic, margin, alpha }');
    else {
      appendAll(problems, extraKeys(gate, ['statistic', 'margin', 'alpha'], 'plan.gate'));
      if (gate['statistic'] !== 'tango-1998') problems.push('plan.gate.statistic: must be "tango-1998"');
      if (!isShare(gate['margin'])) problems.push('plan.gate.margin: must be a number above 0 and below 1');
      if (!isShare(gate['alpha']) || gate['alpha'] >= 0.5) problems.push('plan.gate.alpha: must be a number above 0 and below 0.5');
    }
    // The pair gates are defined on majority labels; under another rule their names would not say what was computed.
    if (plan['labelRule'] !== 'majority') problems.push('plan.gate: requires labelRule "majority"');
  }
  const res = plan['resampling'];
  if (res !== undefined) {
    if (!isObj(res)) problems.push('plan.resampling: must be { iterations, seed, spreadFloor } or { suppliedSha256, spreadFloor }');
    else {
      const supplied = 'suppliedSha256' in res;
      appendAll(problems, extraKeys(res, supplied ? ['suppliedSha256', 'spreadFloor'] : ['iterations', 'seed', 'spreadFloor'], 'plan.resampling'));
      if (supplied && !isSha256Hex(res['suppliedSha256'])) problems.push('plan.resampling.suppliedSha256: must be the full sha256 of the supplied draws');
      // A floor for computing the spread, not for naming a level. With 41 resamples the 2.5th percentile (type 7,
      // position 40 x 0.025 = 1) is the second smallest of them; with fewer it lies between the smallest and the
      // second smallest. Whether the percentiles are given a level is decided by the one floor in stats.ts
      // (levelFloorAt): below it the report prints them as percentiles of that many resamples, with no level.
      if (!supplied && (!isIndex(res['iterations']) || res['iterations'] < 41)) problems.push(`plan.resampling.iterations: ${integerProblem(res['iterations'], 'must be an integer of at least 41')}`);
      else if (!supplied && (res['iterations'] as number) > MAX_RESAMPLES) problems.push(`plan.resampling.iterations: at most ${MAX_RESAMPLES} are drawn`);
      if (!supplied && (!isIndex(res['seed']) || res['seed'] > 0xffffffff)) problems.push(`plan.resampling.seed: ${integerProblem(res['seed'], 'must be a uint32 integer')}`);
      if (!isIndex(res['spreadFloor']) || res['spreadFloor'] < 2) problems.push(`plan.resampling.spreadFloor: ${integerProblem(res['spreadFloor'], 'must be an integer of at least 2; one case has no spread')}`);
    }
  }
  const cluster = plan['oneCasePerCluster'];
  if (cluster !== undefined && cluster !== true) problems.push('plan.oneCasePerCluster: must be true; clustered cases are not supported');
  if (cluster === undefined && (gate !== undefined || res !== undefined)) problems.push('plan.oneCasePerCluster: required, and true, with a gate or a resampling block');
  if (cluster !== undefined && gate === undefined && res === undefined) problems.push('plan.oneCasePerCluster: only with a gate or a resampling block; nothing else reads it');
  const map = plan['map'];
  if (map !== undefined) {
    if (!isObj(map)) problems.push('plan.map: must be an object');
    else {
      const keys = ['encoding', 'folds', 'fitOnlyCaseIds', 'tieBreak', 'minSystems', 'minFitItems', 'maxTieShare'];
      appendAll(problems, extraKeys(map, keys, 'plan.map'));
      for (const k of keys) if (!(k in map)) problems.push(`plan.map.${k}: required; the map has no defaults`);
      const enc = map['encoding'];
      // Small integers only: the sum of a draw set must stay exact.
      if ('encoding' in map && !(isObj(enc) && Object.keys(enc).length > 0 && Object.values(enc).every((v) => Number.isInteger(v) && Math.abs(v as number) <= 1_000_000))) problems.push('plan.map.encoding: must map each label to an integer between -1000000 and 1000000');
      if ('folds' in map && !(isIndex(map['folds']) && map['folds'] >= 2)) problems.push(`plan.map.folds: ${integerProblem(map['folds'], 'must be an integer of at least 2')}`);
      const fit = map['fitOnlyCaseIds'];
      if ('fitOnlyCaseIds' in map && !(Array.isArray(fit) && fit.every((v) => typeof v === 'string' && v !== '') && new Set(fit).size === fit.length)) problems.push('plan.map.fitOnlyCaseIds: must be a list of case ids, each once');
      const tie = map['tieBreak'];
      if ('tieBreak' in map) {
        if (!isObj(tie)) problems.push('plan.map.tieBreak: must be { seeds, suppliedSha256? }');
        else {
          // Supplied draws give the point; the seeds always give the table that shows what the tie-break alone moves.
          appendAll(problems, extraKeys(tie, ['suppliedSha256', 'seeds'], 'plan.map.tieBreak'));
          if ('suppliedSha256' in tie && !isSha256Hex(tie['suppliedSha256'])) problems.push('plan.map.tieBreak.suppliedSha256: must be the full sha256 of the supplied draws');
          const seeds = tie['seeds'];
          // Without supplied draws the first seed gives the reported point. Every seed enters the sensitivity table.
          if (!(Array.isArray(seeds) && seeds.length >= 20 && seeds.every((v) => isIndex(v) && v <= 0xffffffff) && new Set(seeds).size === seeds.length)) {
            problems.push('plan.map.tieBreak.seeds: must be at least 20 distinct uint32 seeds');
          }
        }
      }
      for (const k of ['minSystems', 'minFitItems']) if (k in map && !(isIndex(map[k]) && (map[k] as number) >= 1)) problems.push(`plan.map.${k}: ${integerProblem(map[k], 'must be a positive integer')}`);
      const share = map['maxTieShare'];
      if ('maxTieShare' in map && !(typeof share === 'number' && share >= 0 && share <= 1)) problems.push('plan.map.maxTieShare: must be a number from 0 to 1');
    }
    if (plan['labelRule'] !== 'majority') problems.push('plan.map: requires labelRule "majority"');
    if (gate === undefined) problems.push('plan.map: requires a gate block; the map exists to feed the pair gates');
  }
  return problems;
}

/** Every problem with a candidate plan; empty when valid. The schema is closed, with no nulls and no defaults. */
export function judgeChangePlanProblems(json: unknown): string[] {
  if (!isObj(json)) return ['plan: must be an object'];
  const problems = extraKeys(
    json,
    ['schema', 'barHash', 'caseSetHash', 'drawsPerCase', 'judges', 'judgeMoves', 'systems', 'storedOutputs', 'measuredClass', 'cut', 'drawSets', 'labelRule', 'pooling', 'gate', 'resampling', 'oneCasePerCluster', 'map'],
    'plan',
  );
  findNulls(json, 'plan', problems);
  findIllFormed(json, 'plan', problems);
  if (json['schema'] !== JUDGE_CHANGE_PLAN_SCHEMA) problems.push(`plan.schema: must be "${JUDGE_CHANGE_PLAN_SCHEMA}"`);
  for (const f of ['barHash', 'caseSetHash']) if (!isSha256Hex(json[f])) problems.push(`plan.${f}: must be a full sha256`);
  if (!isIndex(json['drawsPerCase']) || json['drawsPerCase'] === 0) problems.push(`plan.drawsPerCase: ${integerProblem(json['drawsPerCase'], 'must be a positive integer')}`);
  else if (json['drawsPerCase'] > MAX_DRAWS_PER_CASE) problems.push(`plan.drawsPerCase: at most ${MAX_DRAWS_PER_CASE} draws per case are read`);
  const judges = json['judges'];
  if (!isObj(judges)) problems.push('plan.judges: must be { old, new }');
  else {
    appendAll(problems, extraKeys(judges, ['old', 'new'], 'plan.judges'));
    appendAll(problems, judgeSideProblems(judges['old'], 'plan.judges.old'));
    appendAll(problems, judgeSideProblems(judges['new'], 'plan.judges.new'));
  }
  const moves = json['judgeMoves'];
  if (!Array.isArray(moves) || !moves.every((m) => (PLAN_JUDGE_FIELDS as readonly unknown[]).includes(m)) || new Set(moves).size !== moves.length) {
    problems.push(`plan.judgeMoves: must list, once each, the judge fields that differ (${PLAN_JUDGE_FIELDS.join(', ')})`);
  }
  const systems = json['systems'];
  if (!isObj(systems) || Object.keys(systems).length === 0) problems.push('plan.systems: must map at least one system label to its files');
  else {
    const seen = new Map<string, string>();
    for (const [label, files] of Object.entries(systems)) {
      const at = `plan.systems.${label}`;
      if (!isObj(files)) {
        problems.push(`${at}: must be { old, new, reference? }`);
        continue;
      }
      appendAll(problems, extraKeys(files, ['old', 'new', 'reference'], at));
      for (const role of ['old', 'new', 'reference']) {
        const h = files[role];
        if (role === 'reference' && h === undefined) continue;
        if (!isSha256Hex(h)) problems.push(`${at}.${role}: must be the full sha256 of the file`);
        // A reference file names no system, so one file may serve several; a run file, or a reference that is also a run, enters the roster once.
        else if (seen.has(h)) {
          if (!(role === 'reference' && seen.get(h)?.endsWith('.reference') === true)) problems.push(`${at}.${role}: the same file as ${seen.get(h)}; each file enters the roster once`);
        } else seen.set(h, `${at}.${role}`);
      }
    }
    const withRef = Object.values(systems).filter((f) => isObj(f) && f['reference'] !== undefined).length;
    if (withRef !== 0 && withRef !== Object.keys(systems).length) problems.push('plan.systems: a reference for every system, or for none');
  }
  if (json['storedOutputs'] !== 'system-side-compared' && json['storedOutputs'] !== 'system-side-not-compared') {
    problems.push('plan.storedOutputs: must be "system-side-compared" or "system-side-not-compared"');
  }
  for (const f of ['measuredClass', 'cut']) if (typeof json[f] !== 'string' || json[f] === '') problems.push(`plan.${f}: must be a non-empty string`);
  if (json['labelRule'] !== 'worst' && json['labelRule'] !== 'majority') problems.push('plan.labelRule: must be "worst" or "majority"');
  if (json['pooling'] !== 'items-equal') problems.push('plan.pooling: must be "items-equal"');
  appendAll(problems, drawSetProblems(json['drawSets'], json['drawsPerCase'], json['labelRule']));
  appendAll(problems, blockProblems(json));
  return problems;
}

/** Validates a parsed plan. Throws InputError('INVALID_PLAN') listing every problem. */
export function parseJudgeChangePlan(json: unknown): JudgeChangePlan {
  const problems = judgeChangePlanProblems(json);
  if (problems.length > 0) throw new InputError('INVALID_PLAN', problems);
  return json as JudgeChangePlan;
}

/**
 * One system's reference file: a verdict for each case of the measured class, and what the rater was
 * shown for it. `packetBasis` says where the packet hashes came from, as in a run.
 */
export type ReferenceFile = {
  schema: typeof REFERENCE_SCHEMA;
  /** How a verdict was derived from the raters' marks, in words: it is printed beside the judges' label rule. */
  verdictRule: string;
  verdicts: Record<string, 'pass' | 'fail'>;
  packetHashes: Record<string, string>;
  packetBasis: 'recorded' | 'declared' | typeof GAP;
  packetSource?: string;
  /**
   * The file's own statement that the rater's packets differ from the judges' ("different": every hash
   * known) or were not kept ("UNKNOWN": no hash at all), with a quotation and where it comes from.
   * With it, in every reference of the roster, the reference is the criterion of the pair gates under
   * a label and no agreement statistic is computed. Without it, such packets withhold every reference row.
   */
  packetDifference?: { packets: 'different' | typeof GAP; quote: string; source: string };
};

/** Every problem with a candidate reference file; empty when valid. */
export function referenceProblems(json: unknown): string[] {
  if (!isObj(json)) return ['reference: must be an object'];
  const problems = extraKeys(json, ['schema', 'verdictRule', 'verdicts', 'packetHashes', 'packetBasis', 'packetSource', 'packetDifference'], 'reference');
  findNulls(json, 'reference', problems);
  findIllFormed(json, 'reference', problems);
  if (json['schema'] !== REFERENCE_SCHEMA) problems.push(`reference.schema: must be "${REFERENCE_SCHEMA}"`);
  if (typeof json['verdictRule'] !== 'string' || json['verdictRule'].trim() === '') problems.push('reference.verdictRule: required: say how a verdict was derived from the raters\' marks');
  const verdicts = json['verdicts'];
  const packets = json['packetHashes'];
  if (!isObj(verdicts) || Object.keys(verdicts).length === 0 || !Object.values(verdicts).every((v) => v === 'pass' || v === 'fail')) {
    problems.push('reference.verdicts: must map each case id to "pass" or "fail"');
  }
  if (!isObj(packets) || !Object.values(packets).every((v) => v === GAP || isSha256Hex(v))) {
    problems.push(`reference.packetHashes: must map each case id to the full sha256 of what the rater was shown, or "${GAP}"`);
  } else if (isObj(verdicts) && Object.keys(verdicts).sort().join('\u0000') !== Object.keys(packets).sort().join('\u0000')) {
    problems.push('reference.packetHashes: must cover exactly the cases of reference.verdicts');
  }
  const basis = json['packetBasis'];
  if (basis !== 'recorded' && basis !== 'declared' && basis !== GAP) problems.push(`reference.packetBasis: must be "recorded", "declared" or "${GAP}"`);
  const source = json['packetSource'];
  if (basis === 'declared') {
    if (typeof source !== 'string' || source === '') problems.push('reference.packetSource: required with packetBasis "declared": name the documentation the view was taken from');
  } else if (source !== undefined) {
    problems.push('reference.packetSource: only allowed with packetBasis "declared"');
  }
  if (basis === GAP && isObj(packets) && Object.values(packets).some((v) => isSha256Hex(v))) problems.push(`reference.packetBasis: "${GAP}" but a rating carries a packet hash; say whether the hashes were recorded or declared`);
  const stated = json['packetDifference'];
  if (stated !== undefined) {
    const at = 'reference.packetDifference';
    if (!isObj(stated)) return [...problems, `${at}: must be { packets, quote, source }`];
    appendAll(problems, extraKeys(stated, ['packets', 'quote', 'source'], at));
    // The statement rests on a source a reader can check: the words quoted, and where they stand.
    for (const k of ['quote', 'source']) {
      const v = stated[k];
      if (typeof v !== 'string' || v.trim() === '' || readsAsGap(v.trim())) problems.push(`${at}.${k}: must be a non-empty string: ${k === 'quote' ? 'the words that say what the rater was shown' : 'where the quotation comes from'}`);
    }
    const hashes = isObj(packets) ? Object.values(packets) : [];
    if (stated['packets'] === 'different') {
      // A declared difference is a known difference: a file with any unknown packet cannot say how it differs.
      if ((basis !== 'recorded' && basis !== 'declared') || !hashes.every((v) => isSha256Hex(v))) {
        problems.push(`${at}.packets: "different" needs every packet hash known, with packetBasis "recorded" or "declared"; a file with an unknown packet states "${GAP}" or nothing`);
      }
    } else if (stated['packets'] === GAP) {
      if (basis !== GAP || !hashes.every((v) => v === GAP)) problems.push(`${at}.packets: "${GAP}" needs packetBasis "${GAP}" and no packet hash; a file with a known packet states "different" or nothing`);
    } else {
      problems.push(`${at}.packets: must be "different" or "${GAP}"`);
    }
  }
  return problems;
}

/**
 * The role of every file a measurement reads. One list: a ledger record names its files by these, and a
 * study manifest by these and its own "converter". Internal: not re-exported from index.ts.
 */
export const JUDGE_CHANGE_FILE_ROLES = ['plan', 'bar', 'run', 'reference', 'tie-break', 'resample-indices'] as const;
export type JudgeChangeFileRole = (typeof JUDGE_CHANGE_FILE_ROLES)[number];

/** Supplied tie-break draws: one value in [0, 1) for every (judge, draw set, system, case) the map reads. */
export const TIE_BREAK_SCHEMA = 'anchorset.tie-break/v1';
export type TieBreakFile = { schema: typeof TIE_BREAK_SCHEMA; u: Record<'old' | 'new', { estimate: Record<string, Record<string, number>>; reask?: Record<string, Record<string, number>> }> };

export function tieBreakProblems(json: unknown): string[] {
  if (!isObj(json)) return ['tieBreak: must be an object'];
  const problems = extraKeys(json, ['schema', 'u'], 'tieBreak');
  findNulls(json, 'tieBreak', problems);
  findIllFormed(json, 'tieBreak', problems);
  if (json['schema'] !== TIE_BREAK_SCHEMA) problems.push(`tieBreak.schema: must be "${TIE_BREAK_SCHEMA}"`);
  const u = json['u'];
  if (!isObj(u)) return [...problems, 'tieBreak.u: must be { old, new }'];
  appendAll(problems, extraKeys(u, ['old', 'new'], 'tieBreak.u'));
  for (const judge of ['old', 'new']) {
    const j = u[judge];
    if (!isObj(j) || !('estimate' in j)) {
      problems.push(`tieBreak.u.${judge}: must be { estimate, reask? }`);
      continue;
    }
    appendAll(problems, extraKeys(j, ['estimate', 'reask'], `tieBreak.u.${judge}`));
    for (const [set, bySystem] of Object.entries(j)) {
      const ok = isObj(bySystem) && Object.values(bySystem).every((byCase) => isObj(byCase) && Object.values(byCase).every((v) => typeof v === 'number' && v >= 0 && v < 1));
      if (!ok) problems.push(`tieBreak.u.${judge}.${set}: must map system → case id → a number in [0, 1)`);
    }
  }
  return problems;
}

/** Supplied resample indices: one row per resample; index k is the k-th case in case-id order, within its stratum. */
export const RESAMPLE_SCHEMA = 'anchorset.resample-indices/v1';
export type ResampleFile = { schema: typeof RESAMPLE_SCHEMA; scored: number[][]; fitOnly: number[][] };

export function resampleProblems(json: unknown): string[] {
  if (!isObj(json)) return ['resample: must be an object'];
  const problems = extraKeys(json, ['schema', 'scored', 'fitOnly'], 'resample');
  findNulls(json, 'resample', problems);
  findIllFormed(json, 'resample', problems);
  if (json['schema'] !== RESAMPLE_SCHEMA) problems.push(`resample.schema: must be "${RESAMPLE_SCHEMA}"`);
  for (const k of ['scored', 'fitOnly']) {
    const m = json[k];
    if (!Array.isArray(m) || !m.every((row) => Array.isArray(row) && row.every(isIndex))) problems.push(`resample.${k}: must be a list of rows of case indices`);
  }
  if (Array.isArray(json['scored']) && json['scored'].length < 41) problems.push('resample.scored: must hold at least 41 resamples');
  return problems;
}

/** One input file: its name and its bytes as read. The core hashes and parses them itself, so a hash is never taken on trust. */
export type JudgeChangeInput = { name: string; bytes: Uint8Array };
type HashedInput = { name: string; sha256: string; bytes: Uint8Array };

export const NOT_DECLARED = 'not declared';
export const COMPUTED = 'computed';
/** The reference under a stated packet difference: its pair gates are computed, and its agreement block is withheld. */
const CRITERION_ONLY = 'computed as the criterion of the pair gates; agreement withheld: PACKET_MISMATCH';
/** The same reference on a roster of one system: there is no pair, so nothing at all was computed with it. */
const CRITERION_NO_PAIRS = 'withheld: NO_PAIRS for the pair gates it is the criterion of, PACKET_MISMATCH for agreement; nothing was computed with it';
type BlockState = typeof NOT_DECLARED | typeof COMPUTED | typeof CRITERION_ONLY | `withheld: ${string}`;

export type PassRates = { old: number; new: number; change: number };

export type JudgeChangeReport = {
  /** A measurement, never a verdict: there is no pass bit, and the command never exits 1. */
  kind: 'measurement';
  tool: { name: string; version: string };
  contracts: { run: string; plan: string };
  planHash: string;
  barHash: string;
  /**
   * `packetSource` is present exactly when `packetBasis` is "declared". The slots that hold a judge retry
   * and the earlier judge attempts by reason, as counts, zero included, never a rate, twice:
   * `judgeRetriesScored` over every slot of the scored cases of the measured class, which every rate,
   * flip and pair count of the report is computed on (each reads the estimate set, the re-ask set or
   * both); `judgeRetries` over every slot record of the run file, every class and fit-only case included.
   */
  inputs: { system: string; role: 'old-judge' | 'new-judge'; name: string; sha256: string; packetBasis: string; packetSource?: string; judgeRetriesScored: JudgeRetries; judgeRetries: JudgeRetries }[];
  labelRule: LabelRule;
  measuredClass: string;
  cut: string;
  drawSets: { estimate: number[]; reask: number[] | typeof NOT_DECLARED };
  judges: { old: JudgeSide; new: JudgeSide; moved: { field: string; old: string; new: string }[]; callShapeMoved: string[] };
  /** What the stored-outputs exception left uncompared: the fields, and how many of the paired draws have a system stop unknown on either side (a draw counts once). */
  notCompared: { fields: string[]; unknownStopDraws: number; draws: number };
  /**
   * Whether the packet hashes that were found equal were recorded from what each rater was shown, or
   * declared afterwards from a documented view. Declared hashes that agree show that the declarations
   * agree, not what was shown. For a reference that is the criterion of the pair gates under a stated
   * packet difference, `reference` holds that label instead: nothing was found equal. For a reference that was
   * declared and withheld it holds the block's own text, `withheld: <code>`; it is `not declared` only when there is none.
   */
  packetEquality: { judges: PacketEquality; reference: PacketEquality | ReferencePacketLabel | typeof NOT_DECLARED | `withheld: ${string}` };
  /** `cases` are the scored cases: every number is measured on them. Fit-only cases only fit the map's cut. */
  counts: { systems: number; cases: number; fitOnlyCases: number; items: number; drawsPerSet: number };
  /** Per-draw pass rate on the estimate set, pooled over items, and its change (new minus old). No label rule enters it. */
  perDrawPassRate: PassRates;
  /** Share of items the label rule passes on the estimate set, and its change (new minus old). */
  labelPassRate: PassRates & { rule: LabelRule };
  flips: {
    rule: LabelRule;
    /** Share of items whose label differs between the two judges, on the estimate set. */
    acrossJudges: number;
    /** Mean share of items whose label differs between two draw sets of the same judge. */
    withinJudge: number | typeof NOT_DECLARED;
    /** acrossJudges − withinJudge: the flips beyond what re-asking the same judge produces. */
    beyondReask: number | typeof NOT_DECLARED;
    /** Every item whose label differs between the judges; `old` and `new` are the label's pass bit. */
    items: { system: string; caseId: string; old: boolean; new: boolean }[];
  };
  perSystem: { system: string; items: number; perDrawPassRate: PassRates; labelPassRate: PassRates; flipsAcrossJudges: number }[];
  /**
   * Non-compensable classes: cases where a draw of either judge fails. Listed by id, never pooled into a rate.
   * `worstOfNDiffers`: one judge passes every draw of the case and the other fails at least one.
   */
  nonCompensable: { klass: string; system: string; caseId: string; oldFailingDraws: number[]; newFailingDraws: number[]; worstOfNDiffers: boolean }[];
  nonCompensableClasses: string[];
  /** Compensable classes other than the measured one: the command measures one class per plan. */
  notMeasuredClasses: string[];
  /**
   * What became of each optional part of the plan: computed, not declared, or withheld with its code.
   * For a reference under a stated packet difference, `reference` says what it was used for: the
   * criterion of the pair gates with agreement withheld, or, on a roster with no pair, nothing.
   */
  blocks: { gate: BlockState; resampling: BlockState; map: BlockState; reference: BlockState };
  reference: typeof NOT_DECLARED | Withheld | ReferenceReport;
  gate: typeof NOT_DECLARED | Withheld | GateReport;
  spread: typeof NOT_DECLARED | Withheld | SpreadReport;
  map: typeof NOT_DECLARED | Withheld | MapReport;
  notes: string[];
};

export type PacketEquality = 'observed' | 'by declaration';

/** Rows that are not printed, with the code and the reason. The rest of the report stands. */
export type Withheld = { withheld: 'PACKET_MISMATCH' | 'NO_PAIRS' | 'BELOW_SPREAD_FLOOR' | 'MAP_NOT_IDENTIFIED' | 'NO_RESAMPLING'; detail: string };

export type ReferenceReport = {
  inputs: { system: string; name: string; sha256: string; packetBasis: string; packetSource?: string }[];
  /**
   * Present exactly when the reference files state that their packets differ from the judges' or are
   * unknown: the reference is then the criterion of the pair gates only. The label, the files'
   * quotation and its source, and how the verdicts were derived.
   */
  criterion?: { verdictRule: string; referencePackets: ReferencePacketLabel; quote: string; source: string };
  /**
   * Each judge's labels, under the plan's rule, against the reference verdicts. Never a lone share:
   * the count, kappa, AC1 and both pass shares are beside it. A judge that passes everything
   * agrees often with a reference that passes most. Withheld, and never computed, under `criterion`.
   * `spread` is "not declared" where no spread was computed: without a resampling block, and where the
   * block's spread is withheld. Kappa and AC1 are then withheld too, with the reason (RaterAgreement).
   */
  agreement: Withheld | { rule: LabelRule; verdictRule: string; items: number; referencePassShare: number; old: RaterAgreement; new: RaterAgreement; spread: typeof NOT_DECLARED | AgreementSpread };
};

/**
 * One judge against the reference: agreeing items, their share, Cohen's kappa, Gwet's AC1 (NA when undefined), and
 * the judge's pass share. Kappa and AC1 are numbers only where the report also holds their percentiles over
 * resamples. Where no spread was computed they are withheld, and never computed: `NO_RESAMPLING`
 * when the plan declares no resampling block, `BELOW_SPREAD_FLOOR` when the block's spread is itself withheld.
 */
export type RaterAgreement = { agree: number; share: number; kappa: Stat | Withheld; ac1: Stat | Withheld; passShare: number };
/**
 * The 2.5th and 97.5th percentiles of kappa and AC1 over resamples of whole cases, with the judge draws
 * held fixed: the same two numbers as the `p025` and `p975` of their rows in the spread table, under the
 * same label, which names them in the one wording for such a bracket, or, under supplied
 * index rows, as percentiles over the supplied resamples with no level. Present with a resampling block.
 */
export type AgreementSpread = { percentiles: [2.5, 97.5]; label: SpreadReport['label']; old: { kappa: [Stat, Stat]; ac1: [Stat, Stat] }; new: { kappa: [Stat, Stat]; ac1: [Stat, Stat] } };

/** One gate on one ordered pair: the paired counts over the cases, the statistic and its state. */
export type PairGate = { n10: number; n01: number; z: Stat; state: GateState };

export type GateReport = {
  statistic: 'tango-1998';
  margin: number;
  alpha: number;
  critical: number;
  /** The level is nominal: the test is asymptotic, and its actual error rate can exceed alpha at any n. */
  approximation: 'asymptotic';
  /** What each state says, and what it does not. */
  states: { PASS: string; REGRESSION: string; INCONCLUSIVE: string };
  /** Cases per pair. */
  n: number;
  /** The smallest n at which a table with no discordant pair passes; below it, two identical systems are INCONCLUSIVE. */
  smallestConcordantPassN: number | typeof NA;
  /**
   * The largest rate of a false PASS and of a false REGRESSION found on the null boundary at this n, margin and
   * alpha, over a grid of the nuisance share (step `grid`), each by exact enumeration of the tables; NA for a large n.
   */
  nominalCheck: { falsePass: Stat; falseRegression: Stat; grid: number };
  oneCasePerCluster: 'declared, not checked';
  /**
   * Every ordered pair (baseline, candidate), under three gates on majority labels:
   * doNothing: the baseline as the old judge labelled it, the candidate as the new judge labels it;
   * rejudged: both as the new judge labels them; reference: both as the reference labels them.
   */
  pairs: ({ baseline: string; candidate: string; doNothing: PairGate; rejudged: PairGate; reference?: PairGate } & Labelled)[];
  /** Pairs share systems, and nothing here controls for multiplicity. */
  counts: { pairs: number; passDoNothingOnly: number; passRejudgedOnly: number; passBoth: number; net: number };
  reference: typeof NOT_DECLARED | Withheld | (Labelled & {
    /** Pairs the reference gate does not pass, split by its state. "Not PASS" does not mean wrong. */
    notPass: number;
    regression: number;
    inconclusive: number;
    /** Among those pairs: passed by doing nothing, and passed by re-judging. */
    passDoNothing: number;
    passRejudged: number;
    /** passDoNothing − passRejudged, and its two components: pairs only doing nothing passes, and pairs only re-judging passes. */
    net: number;
    onlyDoNothing: number;
    onlyRejudged: number;
    /** The mirror, among pairs the reference gate passes: not passed by doing nothing, minus not passed by re-judging. */
    notPassedNet: number;
    /** Pairs the reference gate calls REGRESSION that a gate passes. Listed, never netted. */
    referenceRegressionPassed: { baseline: string; candidate: string; passedBy: ('doNothing' | 'rejudged')[] }[];
  });
};

/**
 * How one count moved when only the tie-break seed changed, and where the value the report prints sits
 * among the seeds: `reported` is that value, and `below`, `equal` and `above` count the seeds that gave
 * less, the same and more (stats.ts, placeAmong). Under the plan's first seed the reported value is one
 * of the seeds, so `equal` is at least 1; under supplied draws it is not one of them.
 */
export type OverSeeds = { min: number; median: number; max: number; reported: number } & Placement;

/**
 * The recalibration map: a cross-fitted cut on the older judge's summed scores, placed so that it
 * passes the share the newer judge's majority labels pass. It is a measured option, never a
 * recommendation, and its rows are not a correction.
 */
export type MapReport = {
  folds: number;
  scoredCases: number;
  fitOnlyCases: number;
  /** The tie-break behind every number printed here: the plan's first seed (the other seeds enter `overTieBreakSeeds` only), or the supplied draws. */
  tieBreak: { seed: number } | { suppliedSha256: string };
  assumes: string[];
  /** One cut per fold: recalibrated cuts the old judge's statistic, rejudged cuts the new judge's own by the same rule. */
  cuts: { recalibrated: FoldCut[]; rejudged: FoldCut[] };
  /** Share of labels whose sum equals the cut's, so that the tie-break decides them. */
  tieShare: { recalibrated: number; rejudged: number };
  /** The plan's limits, printed beside what was observed. */
  limits: { minSystems: number; minFitItems: number; maxTieShare: number };
  perSystem: { system: string; newJudgePasses: number; recalibratedPasses: number; rejudgedCutPasses: number }[];
  /** recalibrated: the baseline as the old judge's cut statistic labels it; rejudgedCut: as the new judge's cut statistic labels it. The candidate is the new judge's majority label in both. */
  pairs: { baseline: string; candidate: string; recalibrated: PairGate; rejudgedCut: PairGate }[];
  counts: { pairs: number; passRecalibratedOnly: number; passRejudgedCutOnly: number; passBoth: number; net: number };
  reference: typeof NOT_DECLARED | Withheld | (Labelled & {
    /** Among the pairs the reference gate does not pass. */
    passRecalibrated: number;
    passRejudgedCut: number;
    /** passRecalibrated − passRejudgedCut, and its two components. */
    net: number;
    onlyRecalibrated: number;
    onlyRejudgedCut: number;
    /** The mirror, among pairs the reference gate passes: not passed by recalibrating, minus not passed by re-judging with the cut. */
    notPassedNet: number;
    /** Doing nothing against re-judging with the cut, and against recalibrating: the same count for each. */
    doNothingMinusRejudgedCut: number;
    doNothingMinusRecalibrated: number;
    doNothingNotPassedNet: number;
    /** Re-judging on majority labels minus re-judging with the cut. */
    rejudgedMajorityMinusCut: number;
    /** Pairs the reference gate calls REGRESSION that a cut gate passes. Listed, never netted. */
    referenceRegressionPassed: { baseline: string; candidate: string; passedBy: ('recalibrated' | 'rejudgedCut')[] }[];
  });
  /** The same map from a judge's re-ask set to its own estimate set. Its counts show what re-asking alone does to the cut gates; no bar is set. */
  placebo: typeof NOT_DECLARED | { old: Placebo; new: Placebo };
  /** The minimum, median and maximum of each net count over the plan's seeds, each recomputed with the library's keyed tie-break: what the tie-break alone moves. */
  overTieBreakSeeds: { seeds: number[]; quantities: Record<string, OverSeeds & Labelled> };
};
/** Pairs the re-ask cut gate passes alone, pairs the estimate cut gate passes alone, and their difference; withheld on its own when its cuts are not identified. */
export type Placebo = Withheld | ({ net: number; onlyReask: number; onlyEstimate: number; referenceNet?: number } & Labelled);

export type SpreadReport = {
  iterations: number;
  /** Where the resamples came from: the library's generator under this seed, or the supplied index rows. */
  draws: { seed: number } | { suppliedSha256: string };
  unit: 'cases';
  /** spreadLabel(iterations) under the library's seeded generator, which names a level only from the one floor in stats.ts; SUPPLIED_SPREAD_LABEL under supplied index rows, which are not called a bootstrap. */
  label: string;
  /**
   * With a map: resamples on which it was undefined (a fold with nothing to fit on), and resamples on
   * which a cut was defined but not identified, by the test that withholds the map at the point. Both
   * are excluded from the map's rows and counted here; they also appear in those rows' undefined counts.
   */
  map?: { undefinedResamples: number; unidentifiedCutResamples: number };
  /**
   * Marginal: each quantity on its own, not adjusted for the others. Judge draws are held fixed. Pair
   * states get no spread. Kappa and AC1 with the reference have a row each, as the agreeing shares do,
   * when the reference saw the judges' packets, and none under a stated packet difference.
   */
  quantities: Record<string, { point: Stat } & Spread & Labelled>;
};

const NOTES = [
  'the report has no verdict and never exits 1; any pair state below is the outcome of a simulated decision rule on majority labels, not of `anchorset gate`',
  'nothing here shows the plan preceded the scores',
  'the measurement is conditional on the stored outputs and claims nothing about what produced them',
  'a difference of 0 can hide changes that cancel',
  'which judge is right is not measured',
];
const GATE_STATES = {
  PASS: 'the statistic is above the nominal threshold: taken as showing the candidate no more than the margin worse than the baseline; it may still be worse, and the test can pass too often',
  REGRESSION: 'the statistic is below the negative threshold: taken as showing the candidate more than the margin worse',
  INCONCLUSIVE: 'neither threshold is crossed; this does not say why',
};
const GATE_NOTES = [
  'the gate is asymptotic and its level is nominal: its actual error rate can exceed alpha at any n',
  'pairs share systems, and nothing controls for multiplicity',
  'a pair the reference gate does not pass is not thereby wrong',
  'one case per cluster is declared by the plan and not checked',
];
// Assumed by the map and not checked by it.
const MAP_ASSUMES = ['only the judge\'s severity moved, not what it ranks high or low', 'one cut fits every system', 'the cases a cut is fitted on are exchangeable with the cases it labels'];
const MAP_NOTES = ['the recalibrated rows are a measured option, not a correction and not a recommendation', 'the tie-break is held fixed across resamples, so the spread leaves it out; the table across seeds shows what it alone moves'];
// The spread's 2.5th and 97.5th percentiles are named in the one wording only on a smooth statistic: a
// share, a difference of shares, kappa or AC1. A count of pairs by gate state jumps at its thresholds, and a map row
// refits its cuts on each resample and leaves out the resamples where the map or a cut fails: neither has a level.
// A level is named only from the one floor of stats.ts (levelFloorAt), and only on a row that was defined on that many
// resamples; below it every row is percentiles of the resamples, with no level.
/** The alpha of the spread's two percentiles, the 2.5th and the 97.5th. */
export const SPREAD_ALPHA = 0.05;
/** What the spread's 2.5th and 97.5th percentiles are, over `iterations` resamples from the library's seeded generator. */
export const spreadPercentilesWording = (iterations: number): string =>
  nominalLevelOf({ iterations, alpha: SPREAD_ALPHA }) === NA
    ? `on every row they are ${fewResamplesWording('cases', 'the judge draws', iterations, SPREAD_ALPHA)}`
    : `on a share, a difference of shares, kappa or AC1 that was defined on at least ${levelFloorAt(SPREAD_ALPHA)} of the resamples they are ${intervalWording('cases', 'the judge draws', levelText(SPREAD_ALPHA))}; on such a row defined on fewer, on a count of pairs by gate state, and on every map row, they are percentiles of the resamples and carry no level`;
const spreadLabel = (iterations: number): string => `spread over resamples of cases, the judge draws held fixed; its 2.5th and 97.5th percentiles: ${spreadPercentilesWording(iterations)}`;
// Under supplied index rows the rows are checked for length and range, not for how they were drawn: no row is called a
// bootstrap interval and none carries a level. One wording source: stats.ts, beside intervalWording.
const SUPPLIED_SPREAD_LABEL = `spread over the supplied resamples of cases, the judge draws held fixed; on every row its 2.5th and 97.5th percentiles are ${suppliedPercentilesWording('cases')}` as const;
const SPREAD_NOTES = ['the spread describes resamples of cases with the judge draws and the reference verdicts held fixed; a map row refits its cuts on each resample, so its labels are not held fixed, and resamples on which the map is undefined or a cut is unidentified are left out of its rows; each quantity stands alone'];

/** The difference of two shares of items; it is not a count of items the judge change flipped. */
const BEYOND = 'labels that differ between the judges, minus between two sets of one judge';

// The rows of the spread table and of the seeds table that are counted against the reference gate.
// One list of names: the rows are built from it, and labelled by it when the reference saw another packet.
const Q_REF = {
  notPass: 'pairs the reference gate does not pass',
  net: 'of those, passed by doing nothing minus by re-judging',
  notPassedNet: 'of the pairs it passes, not passed by doing nothing minus by re-judging',
  mapNet: 'of the pairs the reference gate does not pass, passed by recalibrating minus by re-judging with the cut',
  mapDoNothingCut: 'of those, passed by doing nothing minus by re-judging with the cut',
  mapDoNothingRecalibrated: 'of those, passed by doing nothing minus by recalibrating',
  placebo: (judge: 'old' | 'new'): string => `placebo, ${judge} judge: the same among pairs the reference gate does not pass`,
} as const;
const REFERENCE_QUANTITIES: readonly string[] = [Q_REF.notPass, Q_REF.net, Q_REF.notPassedNet, Q_REF.mapNet, Q_REF.mapDoNothingCut, Q_REF.mapDoNothingRecalibrated, Q_REF.placebo('old'), Q_REF.placebo('new')];

const drawKey = (d: Pick<Draw, 'caseId' | 'drawIndex'>): string => `${d.caseId}#${d.drawIndex}`;
const refuse = (code: RefusalError['code'], fields: readonly string[], message: string): never => {
  throw new RefusalError(code, fields, message);
};

type Pair = { system: string; old: { input: HashedInput; run: RunArtifact }; new: { input: HashedInput; run: RunArtifact }; reference?: { input: HashedInput; file: ReferenceFile } };

type Supplied = { tieBreak?: { input: HashedInput; file: TieBreakFile }; resample?: { input: HashedInput; file: ResampleFile } };

/**
 * Hashes the files, matches them to the roster and parses each run. A file outside the roster, or a
 * file the roster names that is not among them, refuses.
 */
function pairRuns(inputs: readonly JudgeChangeInput[], plan: JudgeChangePlan): { pairs: Pair[]; supplied: Supplied } {
  const files: HashedInput[] = inputs.map((f) => ({ name: f.name, sha256: sha256Hex(f.bytes), bytes: f.bytes }));
  const roster = new Map<string, string>();
  // The plan field that binds each roster entry, so a refusal can say where a hash goes.
  const fieldOf = new Map<string, string>();
  for (const [label, f] of Object.entries(plan.systems)) {
    roster.set(f.old, `${label} (old judge)`);
    roster.set(f.new, `${label} (new judge)`);
    fieldOf.set(f.old, `systems.${label}.old`);
    fieldOf.set(f.new, `systems.${label}.new`);
    if (f.reference !== undefined) {
      // One reference file may serve several systems: the roster entry names them all.
      const named = roster.get(f.reference);
      roster.set(f.reference, named === undefined ? `${label} (reference)` : `${named}, ${label} (reference)`);
      fieldOf.set(f.reference, named === undefined ? `systems.${label}.reference` : `${fieldOf.get(f.reference)}, systems.${label}.reference`);
    }
  }
  // Supplied random draws are bound by hash like any other input.
  const tieSha = plan.map?.tieBreak.suppliedSha256;
  const resSha = plan.resampling !== undefined && 'suppliedSha256' in plan.resampling ? plan.resampling.suppliedSha256 : undefined;
  if (tieSha !== undefined) {
    roster.set(tieSha, 'the supplied tie-break draws');
    fieldOf.set(tieSha, 'map.tieBreak.suppliedSha256');
  }
  if (resSha !== undefined) {
    roster.set(resSha, 'the supplied resample indices');
    fieldOf.set(resSha, 'resampling.suppliedSha256');
  }
  const strangers = files.filter((f) => !roster.has(f.sha256)).map((f) => f.name).sort();
  // Each supplied file with the sha256 it computes to, in full, so the value can be pasted into the plan.
  const computed = (names: readonly string[]): string => files.filter((f) => names.includes(f.name)).map((f) => `${f.name} (sha256 ${f.sha256})`).join(', ');
  const importerLine = 'an importer prints a run\'s sha256 as its "run file sha256" line';
  if (strangers.length > 0) {
    const paste = `copy the file's sha256 into the plan field that binds it (systems.<name>.old, .new or .reference, map.tieBreak.suppliedSha256 or resampling.suppliedSha256); ${importerLine}`;
    refuse('HASH_MISMATCH', strangers, `not in the plan's roster: ${computed(strangers)}; the plan binds every run by its sha256; ${paste}`);
  }
  // The roster binds a file by its bytes, so a folder that holds the same bytes under two names cannot say which name is the file's.
  const namesOf = new Map<string, string[]>();
  for (const f of files) namesOf.set(f.sha256, [...(namesOf.get(f.sha256) ?? []), f.name]);
  const copies = [...namesOf.entries()].filter(([, names]) => names.length > 1);
  if (copies.length > 0) {
    const names = copies.flatMap(([, ns]) => ns).sort();
    refuse('HASH_MISMATCH', names, `the same bytes under two names: ${copies.map(([h, ns]) => `${[...ns].sort().join(', ')} (sha256 ${h})`).join('; ')}; keep one copy of each file, which the plan binds by its sha256`);
  }
  const bySha = new Map(files.map((f) => [f.sha256, f]));
  const runHashes = Object.values(plan.systems).flatMap((f) => [f.old, f.new]);
  // A reference file shared by several systems is read once.
  const refHashes = [...new Set(Object.values(plan.systems).flatMap((f) => (f.reference === undefined ? [] : [f.reference])))];
  const drawHashes = [tieSha, resSha].filter((h): h is string => h !== undefined);
  const absent = [...runHashes, ...refHashes, ...drawHashes].filter((h) => !bySha.has(h)).map((h) => roster.get(h) as string);
  if (absent.length > 0) {
    const missing = [...runHashes, ...refHashes, ...drawHashes].filter((h) => !bySha.has(h));
    const declared = missing.map((h) => `${roster.get(h) as string} (sha256 ${h})`);
    const paste = `where a supplied file is the right one, copy its sha256 into the plan field that binds it (${missing.map((h) => fieldOf.get(h) as string).join(', ')})${missing.some((h) => runHashes.includes(h)) ? `; ${importerLine}` : ''}`;
    refuse('HASH_MISMATCH', absent, `no input file has the sha256 the plan declares for: ${declared.join(', ')}; the files supplied hash to: ${computed(files.map((f) => f.name))}; ${paste}`);
  }
  const parsed = new Map<string, unknown>();
  const read = (hashes: readonly string[], check: (json: unknown) => string[]): string[] =>
    hashes.flatMap((h) => {
      const f = bySha.get(h) as HashedInput;
      // Not UTF-8, not JSON, nested too deep, or an object that gives a key twice: the bytes are the plan's, and what they say is still not one thing.
      const file = parseJsonBytes(f.bytes);
      if ('problem' in file) return [`${f.name}: ${file.problem}`];
      parsed.set(h, file.json);
      return check(file.json).map((p) => `${f.name}: ${p}`);
    });
  const invalid = [...read(runHashes, runArtifactProblems), ...read(refHashes, referenceProblems), ...read(tieSha === undefined ? [] : [tieSha], tieBreakProblems), ...read(resSha === undefined ? [] : [resSha], resampleProblems)];
  if (invalid.length > 0) throw new InputError('INVALID_ARTIFACT', invalid);
  const side = (h: string) => ({ input: bySha.get(h) as HashedInput, run: parsed.get(h) as RunArtifact });
  const pairs = Object.keys(plan.systems).sort().map((system) => {
    const f = plan.systems[system] as { old: string; new: string; reference?: string };
    const reference = f.reference === undefined ? {} : { reference: { input: bySha.get(f.reference) as HashedInput, file: parsed.get(f.reference) as ReferenceFile } };
    return { system, old: side(f.old), new: side(f.new), ...reference };
  });
  const supplied: Supplied = {
    ...(tieSha === undefined ? {} : { tieBreak: { input: bySha.get(tieSha) as HashedInput, file: parsed.get(tieSha) as TieBreakFile } }),
    ...(resSha === undefined ? {} : { resample: { input: bySha.get(resSha) as HashedInput, file: parsed.get(resSha) as ResampleFile } }),
  };
  return { pairs, supplied };
}

/** Each run against the plan: bar, case set, draw count and the judge of its side, all known and equal. */
function assertBoundToPlan(pairs: readonly Pair[], plan: JudgeChangePlan): void {
  const planned = (side: JudgeSide): [IdentityField, string | number][] => [
    ['barHash', plan.barHash],
    ['caseSetHash', plan.caseSetHash],
    ['drawsPerCase', plan.drawsPerCase],
    ...PLAN_JUDGE_FIELDS.map((f): [IdentityField, string] => [f, side[f]]),
  ];
  // Every field outside the system side is bound here in both modes, so the opt-in can never exempt one.
  if (planned(plan.judges.old).map(([f]) => f).join() !== PLAN_BOUND_FIELDS.join()) throw new Error('judgechange: the plan-bound field list is out of step');
  const gaps: string[] = [];
  const differ: { field: string; detail: string }[] = [];
  for (const p of pairs) {
    for (const [role, side, judge] of [['old judge', p.old, plan.judges.old], ['new judge', p.new, plan.judges.new]] as const) {
      for (const [f, want] of planned(judge)) {
        const got = side.run.identity[f];
        const field = `${f} (${p.system}, ${role})`;
        if (got === GAP) gaps.push(field);
        else if (got !== want) differ.push({ field, detail: `${field}: the run has ${String(got)}, the plan ${String(want)}` });
      }
    }
  }
  if (differ.length > 0) refuse('IDENTITY_MISMATCH', differ.map((d) => d.field), `a run differs from the plan: ${differ.map((d) => d.detail).join('; ')}`);
  if (gaps.length > 0) refuse('IDENTITY_GAP', gaps, `unknown in a run, so it cannot be bound to the plan: ${gaps.join(', ')}`);
}

/** The opt-in of the stored-outputs exception. Without it, the two runs of a system must match on the system side, with every field known. */
function assertSystemSide(pairs: readonly Pair[], plan: JudgeChangePlan): number {
  let unknownStopDraws = 0;
  for (const p of pairs) {
    const stops = [...new Set([...unknownStops(p.old.run.draws), ...unknownStops(p.new.run.draws)])];
    if (plan.storedOutputs === 'system-side-compared') {
      try {
        assertComparable(p.old.run.identity, p.new.run.identity, { allowDiffer: plan.judgeMoves });
      } catch (e) {
        if (e instanceof RefusalError) throw new RefusalError(e.code, e.fields, `system "${p.system}": ${e.message.slice(e.code.length + 2)}; the plan declares storedOutputs "system-side-compared"`);
        throw e;
      }
      if (stops.length > 0) {
        refuse('IDENTITY_GAP', stops.map((k) => `systemStop[${p.system}/${k}]`), `system "${p.system}": the system stop is unknown on ${stops.join(', ')}; only a plan that declares storedOutputs "system-side-not-compared" admits it`);
      }
    }
    unknownStopDraws += stops.length;
  }
  return unknownStopDraws;
}

/** A judge call the provider rejected (4xx) means the recorded judge call shape cannot run as stated. */
function assertJudgeRunnable(pairs: readonly Pair[]): void {
  for (const p of pairs) {
    for (const [role, side] of [['old judge', p.old], ['new judge', p.new]] as const) {
      const rejected = judgeRejected(side.run);
      if (rejected.length > 0) refuse('MEASUREMENT_NOT_RUNNABLE', rejected, `system "${p.system}", ${role}: the provider rejected the judge's call (4xx) on ${rejected.join(', ')}`);
    }
  }
}

/**
 * Two judges are compared only on items they were shown identically, and only when that is known.
 * The comparison is the one in artifact.ts (comparePackets); here a declared packet is admitted as
 * well as a recorded one, and the refusal names the system. Like the gate's, it names every run off
 * basis (old judge first) and every failing draw, sorted, and says what to do about each cause.
 *
 * Every system is read before anything is refused, so one refusal names every run off basis and every
 * failing draw of the whole roster, in the order of the systems: a user who mends what the first
 * refusal names is not refused again for the next system. A system with a run off basis is named by
 * that basis alone: what its draws hold says nothing until the basis is one that is admitted. Each
 * listing in the message stops at ten draws and says how many more there are; the fields hold all.
 * What to do is said once for each cause, after the systems.
 */
function assertSamePackets(pairs: readonly Pair[]): void {
  const fields: string[] = [];
  const parts: string[] = [];
  const causes = { basis: false, unknown: false, differs: false };
  for (const p of pairs) {
    const found = comparePackets(p.old.run, p.new.run, ['recorded', 'declared']);
    if (found.offBasis.length > 0) {
      const named = found.offBasis.map((side) => (side === 'first' ? (['old judge', p.old.run] as const) : (['new judge', p.new.run] as const)));
      appendAll(fields, named.map(([role]) => `packetBasis (${p.system}, ${role})`));
      parts.push(`system "${p.system}": ${named.map(([role, run]) => `the ${role} has packetBasis ${run.packetBasis}`).join(' and ')}`);
      causes.basis = true;
      continue;
    }
    if (found.draws.length === 0) continue;
    const differs = found.draws.filter((k) => found.why[k] === 'differs');
    const unknown = found.draws.filter((k) => found.why[k] !== 'differs');
    // A draw is unknown when either hash is: "one or both", since both runs may hold the gap marker for it.
    const clauses = [
      ...(differs.length > 0 ? [`the two judges were not shown the same packet on ${differs.length} draw(s) (${listed(differs)})`] : []),
      ...(unknown.length > 0 ? [`what one or both ${differs.length > 0 ? 'of them' : 'of the two judges'} were shown is unknown on ${unknown.length} draw(s) (${listed(unknown)})`] : []),
    ];
    appendAll(fields, found.draws.map((k) => `packetHash[${p.system}/${k}]`));
    parts.push(`system "${p.system}": ${clauses.join(', and ')}`);
    causes.unknown ||= unknown.length > 0;
    causes.differs ||= differs.length > 0;
  }
  if (fields.length === 0) return;
  const todo = [
    ...(causes.basis ? ['the basis must be recorded or declared; a run with an unknown basis has to be produced again by a harness that records what the judge was shown (packetHashOf), or its packets declared from a documented view with packetBasis: "declared" and a packetSource'] : []),
    ...(causes.unknown ? ["for the draws whose packet is unknown, the packet hash was not recorded: grade the stored outputs again with a harness that records each packet hash as it is shown, or declare it (the example importers declare it: docs/IMPORTERS.md)"] : []),
    ...(causes.differs ? ['for the draws on which the judges differ, the two judges saw different packets, so their grades are not grades of the same thing: re-grade so that both judges are shown the same packet'] : []),
  ];
  refuse('PACKET_MISMATCH', fields, `${parts.join('; ')}; ${todo.join('; ')}`);
}

/** The plan's class and cut against the bar and the cases: the command never overrides a stored expectation. */
function assertDesign(plan: JudgeChangePlan, labels: LabelSet, classes: Readonly<Record<string, ClassSpec>>, cases: readonly Case[]): void {
  // Own properties only: a measured class named "constructor" is not a class of the bar, whatever Object.prototype holds.
  const spec = Object.hasOwn(classes, plan.measuredClass) ? classes[plan.measuredClass] : undefined;
  if (spec === undefined) refuse('UNSUPPORTED_DESIGN', ['measuredClass'], `the bar has no class "${plan.measuredClass}"`);
  else if (spec.nonCompensable === true) refuse('UNSUPPORTED_DESIGN', ['measuredClass'], `class "${plan.measuredClass}" is non-compensable; it is listed case by case and never pooled into a rate`);
  else if (spec.direction !== 'floor') refuse('UNSUPPORTED_DESIGN', ['measuredClass'], `class "${plan.measuredClass}" is a ceiling class; only a floor class is measured`);
  if (!labels.includes(plan.cut)) refuse('UNSUPPORTED_DESIGN', ['cut'], `the cut "${plan.cut}" is not one of the bar's labels [${labels.join(', ')}]`);
  const measured = cases.filter((c) => c.klass === plan.measuredClass);
  if (measured.length === 0) refuse('UNSUPPORTED_DESIGN', ['measuredClass'], `no case belongs to class "${plan.measuredClass}"`);
  const other = measured.filter((c) => c.expect !== plan.cut).map((c) => c.id).sort();
  if (other.length > 0) refuse('UNSUPPORTED_DESIGN', other, `cases of class "${plan.measuredClass}" whose expected label is not the plan's cut "${plan.cut}": ${other.join(', ')}`);
  if (plan.map === undefined) return;
  const enc = plan.map.encoding;
  const increasing = labels.every((l, i) => i === 0 || (enc[l] as number) > (enc[labels[i - 1] as string] as number));
  if (Object.keys(enc).sort().join('\u0000') !== [...labels].sort().join('\u0000') || !increasing) {
    refuse('UNSUPPORTED_DESIGN', ['map.encoding'], `the map's encoding must give every label of the bar [${labels.join(', ')}] an integer, strictly increasing in that order`);
  }
  const ids = measured.map((c) => c.id);
  const strangers = plan.map.fitOnlyCaseIds.filter((id) => !ids.includes(id)).sort();
  if (strangers.length > 0) refuse('UNSUPPORTED_DESIGN', strangers, `fit-only cases that are not cases of class "${plan.measuredClass}": ${strangers.join(', ')}`);
  if (plan.map.fitOnlyCaseIds.length === ids.length) refuse('UNSUPPORTED_DESIGN', ['map.fitOnlyCaseIds'], 'every case of the measured class is fit-only, so nothing is left to measure');
}

/** The measured attempts of one case under each judge, and the one packet its graders were shown (absent when no draw reached a rater). */
type CaseRead = { old: Measured[]; new: Measured[]; packet: string | undefined };

const drawsByCase = (run: RunArtifact): Map<string, Draw[]> => {
  const m = new Map<string, Draw[]>();
  for (const d of run.draws) { const list = m.get(d.caseId); if (list === undefined) m.set(d.caseId, [d]); else list.push(d); }
  return m;
};

/**
 * Refuses unless every slot of every case of every run file holds an outcome: a slot with no grade stays counted, in a
 * class the report reads or not. A `failed` attempt is an outcome: the system failed, and the draw fails. It reads all the
 * run files before it refuses, so the refusal is a count for each one, by reason; its fields name every slot.
 */
function assertEverySlotRead(pairs: readonly Pair[], cases: readonly Case[], drawsPerCase: number): void {
  const incomplete: string[] = [];
  const counts: string[] = [];
  for (const p of pairs) {
    for (const [i, side] of [p.old, p.new].entries()) {
      const judge = i === 0 ? 'old' : 'new';
      const draws = drawsByCase(side.run);
      const short = cases.map((c) => ({ caseId: c.id, ...measuredSlots(draws.get(c.id) ?? [], drawsPerCase) }));
      for (const s of short) {
        for (const u of s.unmeasured) incomplete.push(`${p.system}/${s.caseId}#${u.drawIndex} (${judge} judge: ${u.role} ${u.reason})`);
        for (const m of s.missing) incomplete.push(`${p.system}/${s.caseId}#${m} (${judge} judge: missing)`);
      }
      if (short.some((s) => s.unmeasured.length + s.missing.length > 0)) counts.push(incompleteCounts(`system "${p.system}", ${judge} judge`, cases.length, drawsPerCase, short));
    }
  }
  if (incomplete.length > 0) refuse('INCOMPLETE_RUN', incomplete, `${counts.join('; ')}; slots that hold no grade or have no record: ${listed(incomplete)}; a label needs every draw of its set, and a run file is counted whole, every class included`);
}

/** For the cases the report reads, whose every slot holds a grade (assertEverySlotRead): one stored output per case. */
function readCases(p: Pair, cases: readonly Case[], drawsPerCase: number): Map<string, CaseRead> {
  const out = new Map<string, CaseRead>();
  const split: string[] = [];
  const views: string[] = [];
  const olds = drawsByCase(p.old.run);
  const news = drawsByCase(p.new.run);
  for (const c of cases) {
    const sides = [olds, news].map((m) => measuredSlots(m.get(c.id) ?? [], drawsPerCase));
    const [o, n] = sides as [ReturnType<typeof measuredSlots>, ReturnType<typeof measuredSlots>];
    // One stored output per case: repeated grades of it are judge noise, repeated system draws are not.
    // The stop is one wherever it is known; a draw whose stop is unknown is listed, not refused.
    // Both runs are read here, although the same-outputs check has already matched them draw by draw.
    const both = [...o.measured, ...n.measured];
    const outputs = new Set(both.map((x) => `${x.a.outputHash} ${x.a.kind === 'failed' ? `failed: ${x.a.reason}` : 'answered'}`));
    const stops = new Set(both.map((x) => x.a.systemStop).filter((s) => s !== GAP));
    if (outputs.size > 1 || stops.size > 1) split.push(`${p.system}/${c.id}`);
    // And one packet per case: two sets of one judge are compared with each other too.
    const packets = new Set(both.flatMap((x) => (x.a.kind === 'graded' ? [x.a.packetHash] : [])));
    if (packets.size > 1) views.push(`${p.system}/${c.id}`);
    out.set(c.id, { old: o.measured.map((x) => x.a), new: n.measured.map((x) => x.a), packet: [...packets][0] });
  }
  if (split.length > 0) refuse('HASH_MISMATCH', split, `a case holds more than one stored output, system outcome or known stop across its draws: ${split.join(', ')}; this measurement reads repeated grades of one stored output`);
  if (views.length > 0) refuse('PACKET_MISMATCH', views, `the draws of a case were shown different packets: ${views.join(', ')}; grades of differing views are not compared`);
  return out;
}

// The label rules. They return booleans and never a FoldedCase, and nothing passes them to a gate.
const passCount = (passes: readonly boolean[], set: readonly number[]): number => set.filter((i) => passes[i] === true).length;
/** Internal: not re-exported from index.ts. Exported so that a test can tie the 'worst' rule to the fold (test/scoring.test.ts). */
export const labelOf = (rule: LabelRule, passes: readonly boolean[], set: readonly number[]): boolean =>
  rule === 'worst' ? passCount(passes, set) === set.length : passCount(passes, set) * 2 > set.length;

const rates = (o: number, n: number, denom: number): PassRates => ({ old: o / denom, new: n / denom, change: (n - o) / denom });

/** Labels and pass counts, one row per system and one column per measured case. `ref` is empty without a usable reference. */
type Table = { oldCount: number[][]; newCount: number[][]; old: boolean[][]; new: boolean[][]; oldReask: boolean[][]; newReask: boolean[][]; ref: boolean[][] };

type PairRow = { a: number; b: number; doNothing: PairGate; rejudged: PairGate; reference?: PairGate };
/**
 * What a reference may be used for: as the criterion of the pair gates, and for agreement with the judges.
 * `coefficients`: whether kappa and AC1 are computed beside the agreeing count, which is only where their spread is.
 */
type ReferenceUse = { gates: boolean; agreement: boolean; coefficients: boolean };
const NO_REFERENCE: ReferenceUse = { gates: false, agreement: false, coefficients: false };
type Numbers = {
  perDraw: PassRates;
  label: PassRates;
  /** Σ of the case weights over every system: the denominator of every share. */
  items: number;
  across: number;
  within?: number;
  /** across − within, from the weighted counts with one division, so that an exact tie is exactly 0. */
  beyond?: number;
  /** Each judge's labels against the reference, on these weights. */
  agreement?: { old: Agreement; new: Agreement };
  gates?: {
    rows: PairRow[];
    passDoNothingOnly: number;
    passRejudgedOnly: number;
    passBoth: number;
    reference?: { notPass: number; regression: number; inconclusive: number; passDoNothing: number; passRejudged: number; net: number; onlyDoNothing: number; onlyRejudged: number; notPassedNet: number };
  };
};

/**
 * Every number of the report from the label table and a weight per case. The point estimate uses
 * weight 1 for every case; a resample uses the number of times each case was drawn.
 */
function numbers(t: Table, w: readonly number[], drawsPerSet: number, hasReask: boolean, reference: ReferenceUse, gate: { margin: number; critical: number } | undefined): Numbers {
  const hasReference = reference.gates;
  const n = w.reduce((s, x) => s + x, 0);
  const items = n * t.old.length;
  // Σ over systems and cases of weight × value.
  const total = (m: readonly (readonly (number | boolean)[])[], f: (v: number, i: number, k: number) => number = (v) => v): number =>
    m.reduce((acc: number, row, i) => acc + row.reduce((s: number, v, k) => s + (w[k] as number) * f(Number(v), i, k), 0), 0);
  // Weighted integer counts first; each share is one division, so equal counts give exactly equal shares.
  const differ = (x: readonly (readonly boolean[])[], y: readonly (readonly boolean[])[]): number => total(x, (v, i, k) => (Boolean(v) !== (y[i] as readonly boolean[])[k] ? 1 : 0));
  const acrossCount = differ(t.old, t.new);
  const out: Numbers = {
    perDraw: rates(total(t.oldCount), total(t.newCount), items * drawsPerSet),
    label: rates(total(t.old), total(t.new), items),
    items,
    across: acrossCount / items,
  };
  if (hasReask) {
    const within = differ(t.old, t.oldReask) + differ(t.new, t.newReask);
    out.within = within / (2 * items);
    out.beyond = (2 * acrossCount - within) / (2 * items);
  }
  // Agreement is computed only between raters who saw the same packet, and never under a stated difference.
  if (reference.agreement && items > 0) out.agreement = { old: agreementOf(t.old, t.ref, w, reference.coefficients), new: agreementOf(t.new, t.ref, w, reference.coefficients) };
  if (gate === undefined) return out;

  const pairGate = pairGateOf(w, gate);
  const rows: PairRow[] = [];
  for (let a = 0; a < t.old.length; a++) {
    for (let b = 0; b < t.old.length; b++) {
      if (a === b) continue;
      rows.push({
        a,
        b,
        doNothing: pairGate(t.old[a] as boolean[], t.new[b] as boolean[]),
        rejudged: pairGate(t.new[a] as boolean[], t.new[b] as boolean[]),
        ...(hasReference ? { reference: pairGate(t.ref[a] as boolean[], t.ref[b] as boolean[]) } : {}),
      });
    }
  }
  const count = (f: (r: PairRow) => boolean): number => rows.filter(f).length;
  const R = (r: PairRow): boolean => r.doNothing.state === 'PASS';
  const C = (r: PairRow): boolean => r.rejudged.state === 'PASS';
  const E = (r: PairRow): boolean => r.reference?.state === 'PASS';
  out.gates = { rows, passDoNothingOnly: count((r) => R(r) && !C(r)), passRejudgedOnly: count((r) => !R(r) && C(r)), passBoth: count((r) => R(r) && C(r)) };
  if (hasReference) {
    const onlyDoNothing = count((r) => !E(r) && R(r) && !C(r));
    const onlyRejudged = count((r) => !E(r) && !R(r) && C(r));
    out.gates.reference = {
      notPass: count((r) => !E(r)),
      regression: count((r) => r.reference?.state === 'REGRESSION'),
      inconclusive: count((r) => r.reference?.state === 'INCONCLUSIVE'),
      passDoNothing: count((r) => !E(r) && R(r)),
      passRejudged: count((r) => !E(r) && C(r)),
      net: onlyDoNothing - onlyRejudged,
      onlyDoNothing,
      onlyRejudged,
      notPassedNet: count((r) => E(r) && !R(r)) - count((r) => E(r) && !C(r)),
    };
  }
  return out;
}

/** gate(x, y) under case weights: x labels the baseline system, y the candidate. n10 counts cases the baseline passes and the candidate fails. */
function pairGateOf(w: readonly number[], gate: { margin: number; critical: number }): (x: readonly boolean[], y: readonly boolean[]) => PairGate {
  const n = w.reduce((s, x) => s + x, 0);
  return (x, y) => {
    let n10 = 0;
    let n01 = 0;
    for (let k = 0; k < w.length; k++) {
      if (x[k] === true && y[k] !== true) n10 += w[k] as number;
      else if (x[k] !== true && y[k] === true) n01 += w[k] as number;
    }
    return { n10, n01, ...tangoState({ n, n10, n01 }, gate.margin, gate.critical) };
  };
}

type Judge = 'old' | 'new';
type DrawSet = 'estimate' | 'reask';

/**
 * The tie-break draw a supplied file gives one item, or undefined when it gives none. Own properties
 * only: for a case named "constructor" that the file leaves out, an indexed read would return
 * Object.prototype.constructor, and the item would pass for covered.
 */
function suppliedU(file: TieBreakFile, judge: Judge, set: DrawSet, system: string, id: string): number | undefined {
  const bySystem = file.u[judge][set];
  const byCase = bySystem !== undefined && Object.hasOwn(bySystem, system) ? bySystem[system] : undefined;
  return byCase !== undefined && Object.hasOwn(byCase, id) ? byCase[id] : undefined;
}
/** What the map reads beyond the label table. Every matrix is [system][case], scored cases first, then fit-only cases. */
type MapData = {
  folds: number;
  foldOf: number[];
  hasReask: boolean;
  /** Σ of the encoded grades of a draw set. */
  sum: Record<Judge, Record<DrawSet, number[][]>>;
  /** The tie-break, for one seed, and the items sorted by (sum, tie-break), highest first. */
  u: Record<Judge, Record<DrawSet, number[][]>>;
  order: Record<Judge, Record<DrawSet, [number, number][]>>;
  /** Majority labels on the estimate set: what a cut is fitted to reproduce. */
  maj: Record<Judge, boolean[][]>;
};

/** `kappa` and `ac1` are absent where they are not computed (ReferenceUse.coefficients). */
type Agreement = { items: number; agree: number; share: number; passShare: number; referencePassShare: number; kappa?: Stat; ac1?: Stat };

/**
 * One judge's labels against the reference verdicts on case weights: the one place agreement is
 * computed, for the point and for every resample, through the statistics of agreement.ts. Kappa and
 * AC1 are computed only with `coefficients`: without it no coefficient exists to be printed.
 */
function agreementOf(judge: readonly (readonly boolean[])[], ref: readonly (readonly boolean[])[], w: readonly number[], coefficients: boolean): Agreement {
  const a: string[] = [];
  const b: string[] = [];
  judge.forEach((row, i) =>
    row.forEach((v, k) => {
      for (let c = 0; c < (w[k] as number); c++) {
        a.push(v ? 'pass' : 'fail');
        b.push((ref[i] as readonly boolean[])[k] ? 'pass' : 'fail');
      }
    }),
  );
  const share = (xs: readonly string[]): number => xs.filter((x) => x === 'pass').length / xs.length;
  const agree = a.filter((x, i) => x === b[i]).length;
  return {
    items: a.length,
    agree,
    share: agree / a.length,
    ...(coefficients ? { kappa: toStat(cohenKappa(a, b, ['fail', 'pass']).kappa), ac1: toStat(gwetAC1(a, b, ['fail', 'pass']).ac1) } : {}),
    passShare: share(a),
    referencePassShare: share(b),
  };
}

type MapRow = { a: number; b: number; recalibrated: PairGate; rejudgedCut: PairGate };
type MapNumbers = {
  /** False when a fold had nothing to fit on: nothing below is computed. */
  defined: boolean;
  fits: { recalibrated: CutFit; rejudged: CutFit };
  rows: MapRow[];
  passRecalibratedOnly: number;
  passRejudgedCutOnly: number;
  passBoth: number;
  reference?: { passRecalibrated: number; passRejudgedCut: number; net: number; onlyRecalibrated: number; onlyRejudgedCut: number; notPassedNet: number; doNothingMinusRejudgedCut: number; doNothingMinusRecalibrated: number; doNothingNotPassedNet: number; rejudgedMajorityMinusCut: number };
  placebo?: Record<Judge, PlaceboNumbers>;
};
type PlaceboNumbers = { defined: boolean; fits: { moved: CutFit; own: CutFit }; net: number; onlyReask: number; onlyEstimate: number; referenceNet?: number };

/**
 * The map and its gates, for one tie-break seed and one set of case weights. `base` supplies each
 * pair's states under doing nothing, re-judging on majority labels and the reference.
 */
function mapNumbers(t: Table, d: MapData, wScored: readonly number[], wFit: readonly number[], gate: { margin: number; critical: number }, base: readonly PairRow[], hasReference: boolean): MapNumbers {
  const pairGate = pairGateOf(wScored, gate);
  const cut = (judge: Judge, set: DrawSet, target: readonly (readonly boolean[])[]): CutFit =>
    fitCut({ sum: d.sum[judge][set], u: d.u[judge][set] }, d.order[judge][set], target, d.foldOf, d.folds, wScored, wFit);
  const pass = (g: PairGate): boolean => g.state === 'PASS';
  const E = (i: number): boolean => base[i]?.reference?.state === 'PASS';
  // Net and components of "passed by x but not by y" between two gates, over all pairs or over those the reference gate does not pass.
  const tally = (x: readonly PairGate[], y: readonly PairGate[]) => {
    const idx = x.map((_, i) => i);
    const n = (f: (i: number) => boolean): number => idx.filter(f).length;
    const X = (i: number): boolean => pass(x[i] as PairGate);
    const Y = (i: number): boolean => pass(y[i] as PairGate);
    return {
      onlyX: n((i) => X(i) && !Y(i)),
      onlyY: n((i) => !X(i) && Y(i)),
      both: n((i) => X(i) && Y(i)),
      refX: n((i) => !E(i) && X(i)),
      refY: n((i) => !E(i) && Y(i)),
      refOnlyX: n((i) => !E(i) && X(i) && !Y(i)),
      refOnlyY: n((i) => !E(i) && !X(i) && Y(i)),
      mirror: n((i) => E(i) && !X(i)) - n((i) => E(i) && !Y(i)),
    };
  };

  // Recalibration cuts the old judge's statistic; re-judging cuts the new judge's own, by the same rule and to the same target.
  const recalibrated = cut('old', 'estimate', d.maj.new);
  const rejudged = cut('new', 'estimate', d.maj.new);
  const rows: MapRow[] = base.map((r) => ({
    a: r.a,
    b: r.b,
    recalibrated: pairGate(recalibrated.labels[r.a] as boolean[], t.new[r.b] as boolean[]),
    rejudgedCut: pairGate(rejudged.labels[r.a] as boolean[], t.new[r.b] as boolean[]),
  }));
  const N = rows.map((r) => r.recalibrated);
  const C = rows.map((r) => r.rejudgedCut);
  const nc = tally(N, C);
  const out: MapNumbers = { defined: recalibrated.defined && rejudged.defined, fits: { recalibrated, rejudged }, rows, passRecalibratedOnly: nc.onlyX, passRejudgedCutOnly: nc.onlyY, passBoth: nc.both };
  if (hasReference) {
    const rc = tally(base.map((r) => r.doNothing), C);
    const rn = tally(base.map((r) => r.doNothing), N);
    const mc = tally(base.map((r) => r.rejudged), C);
    out.reference = {
      passRecalibrated: nc.refX,
      passRejudgedCut: nc.refY,
      net: nc.refOnlyX - nc.refOnlyY,
      onlyRecalibrated: nc.refOnlyX,
      onlyRejudgedCut: nc.refOnlyY,
      notPassedNet: nc.mirror,
      doNothingMinusRejudgedCut: rc.refX - rc.refY,
      doNothingMinusRecalibrated: rn.refX - rn.refY,
      doNothingNotPassedNet: rc.mirror,
      rejudgedMajorityMinusCut: mc.refX - mc.refY,
    };
  }
  if (d.hasReask) {
    // The placebo: the same map from a judge's re-ask set to its own estimate set. Nothing moved between them.
    const placebo = (judge: Judge): PlaceboNumbers => {
      const moved = cut(judge, 'reask', d.maj[judge]);
      const own = judge === 'new' ? rejudged : cut('old', 'estimate', d.maj.old);
      const candidate = judge === 'new' ? t.new : t.old;
      const g = tally(
        base.map((r) => pairGate(moved.labels[r.a] as boolean[], candidate[r.b] as boolean[])),
        base.map((r) => pairGate(own.labels[r.a] as boolean[], candidate[r.b] as boolean[])),
      );
      return { defined: moved.defined && own.defined, fits: { moved, own }, net: g.onlyX - g.onlyY, onlyReask: g.onlyX, onlyEstimate: g.onlyY, ...(hasReference ? { referenceNet: g.refOnlyX - g.refOnlyY } : {}) };
    };
    out.placebo = { old: placebo('old'), new: placebo('new') };
  }
  return out;
}

/** The map's counts by name, as they appear in the spread table and across tie-break seeds. NaN when the map is undefined on these weights. */
function mapQuantities(m: MapNumbers): Record<string, number> {
  const v = (x: number): number => (m.defined ? x : Number.NaN);
  const p = (judge: Judge, x: PlaceboNumbers): Record<string, number> => ({
    [`placebo, ${judge} judge: pairs passed from the re-ask set only, minus from the estimate set only`]: x.defined ? x.net : Number.NaN,
    ...(x.referenceNet === undefined ? {} : { [Q_REF.placebo(judge)]: x.defined ? x.referenceNet : Number.NaN }),
  });
  return {
    'pairs passed by recalibrating only, minus by re-judging with the cut only': v(m.passRecalibratedOnly - m.passRejudgedCutOnly),
    ...(m.reference === undefined
      ? {}
      : {
          [Q_REF.mapNet]: v(m.reference.net),
          [Q_REF.mapDoNothingCut]: v(m.reference.doNothingMinusRejudgedCut),
          [Q_REF.mapDoNothingRecalibrated]: v(m.reference.doNothingMinusRecalibrated),
        }),
    ...(m.placebo === undefined ? {} : { ...p('old', m.placebo.old), ...p('new', m.placebo.new) }),
  };
}

/**
 * Measures a judge change on stored outputs. Throws InputError for invalid input and RefusalError
 * for a comparison it will not stand behind; otherwise it returns points and provenance.
 */
export function judgeChangeRuns(files: readonly JudgeChangeInput[], barFile: BarFile, plan: JudgeChangePlan): JudgeChangeReport {
  parseBarFile(barFile);
  const planProblems = judgeChangePlanProblems(plan);
  if (planProblems.length > 0) throw new InputError('INVALID_PLAN', planProblems);
  const { labels, classes } = splitBarFile(barFile);
  const actualBar = barHash(barFile);
  if (actualBar !== plan.barHash) refuse('HASH_MISMATCH', ['barHash'], `the plan declares barHash ${plan.barHash}, the bar file hashes to ${actualBar}`);
  const moved = PLAN_JUDGE_FIELDS.filter((f) => plan.judges.old[f] !== plan.judges.new[f]);
  const undeclared = moved.filter((f) => !plan.judgeMoves.includes(f));
  const unmoved = plan.judgeMoves.filter((f) => !moved.includes(f));
  if (undeclared.length > 0 || unmoved.length > 0) {
    const why = [...(undeclared.length > 0 ? [`moved but not declared: ${undeclared.join(', ')}`] : []), ...(unmoved.length > 0 ? [`declared but did not move: ${unmoved.join(', ')}`] : [])];
    refuse('IDENTITY_MISMATCH', [...undeclared, ...unmoved], `judgeMoves must name exactly the judge fields that differ; ${why.join('; ')}`);
  }

  const { pairs, supplied } = pairRuns(files, plan);
  assertBoundToPlan(pairs, plan);
  assertJudgeRunnable(pairs);
  for (const p of pairs) assertSameOutputs(p.old.run, p.new.run, { original: `old-judge run of "${p.system}"`, rejudged: `new-judge run of "${p.system}"` });
  const unknownStopDraws = assertSystemSide(pairs, plan);
  assertSamePackets(pairs);
  // Every run declares the plan's case-set hash, and each run's stored cases hash to it, so the cases are the same.
  const cases = (pairs[0] as Pair).old.run.cases;
  const unknownClasses = cases.filter((c) => !Object.hasOwn(classes, c.klass));
  if (unknownClasses.length > 0) throw new InputError('UNKNOWN_CLASS', unknownClasses.map((c) => `case "${c.id}": class "${c.klass}" has no spec in the bar`));
  assertDesign(plan, labels, classes, cases);

  const spec = classes[plan.measuredClass] as ClassSpec;
  const nonCompClasses = Object.keys(classes).filter((k) => classes[k]?.nonCompensable === true).sort();
  // A fit-only case fits the map's cut and enters no estimand: everything below is measured on the scored cases.
  const fitOnlyIds = plan.map?.fitOnlyCaseIds ?? [];
  const classCases = cases.filter((c) => c.klass === plan.measuredClass).sort((a, b) => (a.id < b.id ? -1 : 1));
  const measuredCases = classCases.filter((c) => !fitOnlyIds.includes(c.id));
  const fitCases = classCases.filter((c) => fitOnlyIds.includes(c.id));
  const strictCases = cases.filter((c) => nonCompClasses.includes(c.klass)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const estimate = plan.drawSets.estimate;
  const reask = plan.drawSets.reask;
  const every = Array.from({ length: plan.drawsPerCase }, (_, i) => i);

  const passes = (c: Case, attempts: readonly Measured[], s: ClassSpec): boolean[] => attempts.map((a) => scoreAttempt(c, a, labels, s));
  // One row per system, one column per measured case: the labels and counts everything below is computed from.
  const table: Table = { oldCount: [], newCount: [], old: [], new: [], oldReask: [], newReask: [], ref: [] };
  const nonCompensable: JudgeChangeReport['nonCompensable'] = [];
  const measuredIds = measuredCases.map((c) => c.id);
  const scoredIds = new Set(measuredIds);
  const refPacketProblems: string[] = [];
  // Cases on which a reference's packet hash is the judges' own: a file that states a difference may have none.
  const refPacketEqual: string[] = [];
  const mapSums: MapData['sum'] = { old: { estimate: [], reask: [] }, new: { estimate: [], reask: [] } };
  const mapMaj: MapData['maj'] = { old: [], new: [] };
  const noScore: string[] = [];
  const verdictRules = new Set<string>();
  assertEverySlotRead(pairs, [...cases].sort((a, b) => (a.id < b.id ? -1 : 1)), plan.drawsPerCase);
  for (const p of pairs) {
    const read = readCases(p, [...measuredCases, ...fitCases, ...strictCases], plan.drawsPerCase);
    if (plan.map !== undefined) {
      const enc = plan.map.encoding;
      const sys = mapSums.old.estimate.length;
      for (const judge of ['old', 'new'] as const) {
        for (const set of ['estimate', 'reask'] as const) mapSums[judge][set].push([]);
        mapMaj[judge].push([]);
      }
      for (const c of [...measuredCases, ...fitCases]) {
        const r = read.get(c.id) as CaseRead;
        for (const judge of ['old', 'new'] as const) {
          const attempts = r[judge];
          if (attempts.some((a) => a.kind === 'failed')) noScore.push(`${p.system}/${c.id}`);
          const total = (set: readonly number[]): number => set.reduce((acc, i) => { const a = attempts[i]; return acc + (a?.kind === 'graded' ? (enc[a.label] as number) : 0); }, 0);
          (mapSums[judge].estimate[sys] as number[]).push(total(estimate));
          (mapSums[judge].reask[sys] as number[]).push(reask === undefined ? 0 : total(reask));
          (mapMaj[judge][sys] as boolean[]).push(labelOf('majority', passes(c, attempts, spec), estimate));
        }
      }
    }
    const rows = measuredCases.map((c) => {
      const r = read.get(c.id) as CaseRead;
      return { o: passes(c, r.old, spec), n: passes(c, r.new, spec) };
    });
    table.oldCount.push(rows.map((r) => passCount(r.o, estimate)));
    table.newCount.push(rows.map((r) => passCount(r.n, estimate)));
    table.old.push(rows.map((r) => labelOf(plan.labelRule, r.o, estimate)));
    table.new.push(rows.map((r) => labelOf(plan.labelRule, r.n, estimate)));
    table.oldReask.push(rows.map((r) => (reask === undefined ? false : labelOf(plan.labelRule, r.o, reask))));
    table.newReask.push(rows.map((r) => (reask === undefined ? false : labelOf(plan.labelRule, r.n, reask))));
    if (p.reference !== undefined) {
      const ref = p.reference.file;
      const covered = Object.keys(ref.verdicts).sort();
      if (covered.join('\u0000') !== [...measuredIds].sort().join('\u0000')) {
        const off = [...covered.filter((id) => !measuredIds.includes(id)), ...measuredIds.filter((id) => !covered.includes(id))];
        refuse('ITEM_SET_MISMATCH', off, `the reference of "${p.system}" (${p.reference.input.name}) must cover exactly the ${fitCases.length > 0 ? 'scored ' : ''}cases of class "${plan.measuredClass}"; off: ${off.join(', ')}`);
      }
      table.ref.push(measuredIds.map((id) => ref.verdicts[id] === 'pass'));
      verdictRules.add(ref.verdictRule);
      // A reference is compared with a judge only on what both were shown, and only when that is known.
      if (ref.packetBasis === GAP) refPacketProblems.push(`${p.system}: packetBasis is ${GAP}`);
      for (const id of measuredIds) {
        const judged = (read.get(id) as CaseRead).packet;
        const shown = ref.packetHashes[id];
        // An unknown reference packet is never compared, even for a case no judge was shown (every draw failed).
        if (judged === undefined ? shown === GAP : !samePacket(shown, judged)) refPacketProblems.push(`${p.system}/${id}`);
        else if (judged !== undefined) refPacketEqual.push(`${p.system}/${id}`);
      }
    }
    for (const c of strictCases) {
      const r = read.get(c.id) as CaseRead;
      const s = classes[c.klass] as ClassSpec;
      const o = passes(c, r.old, s);
      const n = passes(c, r.new, s);
      const failing = (v: readonly boolean[]): number[] => every.filter((i) => v[i] !== true);
      if (failing(o).length > 0 || failing(n).length > 0) {
        nonCompensable.push({ klass: c.klass, system: p.system, caseId: c.id, oldFailingDraws: failing(o), newFailingDraws: failing(n), worstOfNDiffers: (failing(o).length === 0) !== (failing(n).length === 0) });
      }
    }
  }
  // Two roster entries with the same outputs on every case are one system listed twice; pooling would count it double.
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const a = pairs[i] as Pair;
      const b = pairs[j] as Pair;
      const outputs = (p: Pair): string => hashOf(p.old.run.draws.map((d) => [drawKey(d), systemFacts(finalAttempt(d)).outputHash]).sort());
      if (outputs(a) === outputs(b)) refuse('HASH_MISMATCH', [a.system, b.system], `systems "${a.system}" and "${b.system}" hold the same output on every draw; a system enters the roster once`);
    }
  }

  if (verdictRules.size > 1) refuse('UNSUPPORTED_DESIGN', ['verdictRule'], `the references declare different verdict rules: ${[...verdictRules].join(' | ')}`);
  const systems = pairs.map((p) => p.system);
  const nCases = measuredCases.length;
  const ones = measuredCases.map(() => 1);
  const hasReference = pairs.every((p) => p.reference !== undefined);
  // For this measurement only: a reference whose files state that its packets differ from the judges', or are
  // unknown, is the criterion of the pair gates under a label, and no agreement statistic with it is computed.
  const statements = pairs.flatMap((p) => (p.reference === undefined ? [] : [{ system: p.system, stated: p.reference.file.packetDifference }]));
  const stated = statements.find((s) => s.stated !== undefined)?.stated;
  let criterion: { referencePackets: ReferencePacketLabel; quote: string; source: string } | undefined;
  if (hasReference && stated !== undefined) {
    const silent = statements.filter((s) => s.stated === undefined).map((s) => `packetDifference (${s.system})`);
    if (silent.length > 0) refuse('UNSUPPORTED_DESIGN', silent, `a packet difference is stated by every reference of the roster, or by none; not stated: ${silent.join(', ')}`);
    if (new Set(statements.map((s) => hashOf(s.stated))).size > 1) refuse('UNSUPPORTED_DESIGN', ['packetDifference'], 'the references state different packet differences; one roster carries one statement, with one quotation and one source');
    // A declared difference must be a real one: the file says its packets differ, and on these cases its hashes are the judges' own.
    // The code is the one that withholds a reference without a statement; here nothing is withheld, the statement is contradicted
    // and the report is refused. The fields are named packetDifference[...], and the message says "contradicted".
    if (stated.packets === 'different' && refPacketEqual.length > 0) {
      refuse('PACKET_MISMATCH', refPacketEqual.map((x) => `packetDifference[${x}]`), `the stated packet difference is contradicted: a reference states that its packets differ from the judges', and its packet hashes equal theirs on: ${refPacketEqual.join(', ')}; the report is refused, not withheld in part: remove the statement, or correct the packet hashes`);
    }
    // Under a statement the reference is the criterion of the pair gates and nothing else. With no gate block it would be read, hashed and listed, and used for nothing.
    if (plan.gate === undefined) {
      refuse('UNSUPPORTED_DESIGN', ['gate'], 'the references state a packet difference, so they can serve only as the criterion of the pair gates, and the plan declares no gate block: a stated packet difference needs a gate block; add one, or take the references out of the roster');
    }
    criterion = { referencePackets: REFERENCE_PACKET_LABELS[stated.packets], quote: stated.quote, source: stated.source };
  }
  // The label on everything computed against such a reference; nothing at all when the packets were found equal.
  const tag: Labelled = criterion === undefined ? {} : { referencePackets: criterion.referencePackets };
  const tagged = (name: string): Labelled => (REFERENCE_QUANTITIES.includes(name) ? tag : {});
  const referenceWithheld: Withheld | undefined =
    hasReference && criterion === undefined && refPacketProblems.length > 0
      ? { withheld: 'PACKET_MISMATCH', detail: `the reference's packets are unknown or differ from the judges' on: ${refPacketProblems.join(', ')}` }
      : undefined;
  // Kappa and AC1 are computed only where their spread will be: with a resampling block whose floor the cases reach.
  // The same two tests decide below whether the spread is computed, so a coefficient never stands without its percentiles.
  const spreadComputed = plan.resampling !== undefined && nCases >= plan.resampling.spreadFloor;
  const agreementUsed = hasReference && referenceWithheld === undefined && criterion === undefined;
  const use: ReferenceUse = { gates: hasReference && referenceWithheld === undefined, agreement: agreementUsed, coefficients: agreementUsed && spreadComputed };
  const gateOpts = plan.gate === undefined || systems.length < 2 ? undefined : { margin: plan.gate.margin, critical: normalQuantile(1 - plan.gate.alpha) };
  const calc = (w: readonly number[]): Numbers => numbers(table, w, estimate.length, reask !== undefined, use, gateOpts);
  const point = calc(ones);
  const perSystem = systems.map((system, i) => {
    const one: Table = { oldCount: [table.oldCount[i] as number[]], newCount: [table.newCount[i] as number[]], old: [table.old[i] as boolean[]], new: [table.new[i] as boolean[]], oldReask: [], newReask: [], ref: [] };
    const x = numbers(one, ones, estimate.length, false, NO_REFERENCE, undefined);
    return { system, items: nCases, perDrawPassRate: x.perDraw, labelPassRate: x.label, flipsAcrossJudges: x.across };
  });
  const flipped = systems.flatMap((system, i) =>
    measuredIds.flatMap((caseId, k) => {
      const o = (table.old[i] as boolean[])[k] as boolean;
      const n = (table.new[i] as boolean[])[k] as boolean;
      return o === n ? [] : [{ system, caseId, old: o, new: n }];
    }),
  );

  let gate: JudgeChangeReport['gate'] = NOT_DECLARED;
  if (plan.gate !== undefined && gateOpts === undefined) gate = { withheld: 'NO_PAIRS', detail: 'a pair gate compares two systems, and the roster has one' };
  if (plan.gate !== undefined && gateOpts !== undefined && point.gates !== undefined) {
    const g = point.gates;
    gate = {
      statistic: 'tango-1998',
      margin: plan.gate.margin,
      alpha: plan.gate.alpha,
      critical: gateOpts.critical,
      approximation: 'asymptotic',
      states: GATE_STATES,
      n: nCases,
      smallestConcordantPassN: smallestConcordantPassN(plan.gate),
      nominalCheck: nominalLevelCheck(nCases, plan.gate),
      oneCasePerCluster: 'declared, not checked',
      pairs: g.rows.map((r) => ({ baseline: systems[r.a] as string, candidate: systems[r.b] as string, doNothing: r.doNothing, rejudged: r.rejudged, ...(r.reference === undefined ? {} : { reference: r.reference, ...tag }) })),
      counts: { pairs: g.rows.length, passDoNothingOnly: g.passDoNothingOnly, passRejudgedOnly: g.passRejudgedOnly, passBoth: g.passBoth, net: g.passDoNothingOnly - g.passRejudgedOnly },
      reference:
        g.reference === undefined
          ? (referenceWithheld ?? NOT_DECLARED)
          : {
              ...tag,
              ...g.reference,
              referenceRegressionPassed: g.rows.flatMap((r) => {
                const passedBy = (['doNothing', 'rejudged'] as const).filter((k) => r[k].state === 'PASS');
                return r.reference?.state === 'REGRESSION' && passedBy.length > 0 ? [{ baseline: systems[r.a] as string, candidate: systems[r.b] as string, passedBy }] : [];
              }),
            },
    };
  }

  // The recalibration map: its point for the first tie-break seed, and its counts across every seed.
  const fitOnes = fitCases.map(() => 1);
  let map: JudgeChangeReport['map'] = NOT_DECLARED;
  let mapData: MapData | undefined;
  let placeboWithheld: Judge[] = [];
  // Why a map, or a placebo, is not identified on given weights: set with the map, and used again on every resample.
  let identify: (mm: MapNumbers) => string[] = () => [];
  let identifyPlacebo: (judge: Judge, x: PlaceboNumbers) => string[] = () => [];
  // A withheld placebo leaves no row in the seeds table or in the spread.
  const shown = (q: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(q).filter(([k]) => !placeboWithheld.some((j) => k.startsWith(`placebo, ${j} judge`))));
  const mapAt = (d: MapData, wS: readonly number[], wF: readonly number[], base: Numbers): MapNumbers | undefined =>
    gateOpts === undefined || base.gates === undefined ? undefined : mapNumbers(table, d, wS, wF, gateOpts, base.gates.rows, use.gates);
  if (plan.map !== undefined && gateOpts === undefined) map = { withheld: 'NO_PAIRS', detail: 'the map feeds the pair gates, and the roster has one system' };
  else if (plan.map !== undefined) {
    const m = plan.map;
    const given = supplied.tieBreak;
    const seeds = m.tieBreak.seeds;
    const allIds = [...measuredCases, ...fitCases].map((c) => c.id);
    if (given !== undefined) {
      const lacking = (['old', 'new'] as const).flatMap((judge) =>
        (reask === undefined ? (['estimate'] as const) : (['estimate', 'reask'] as const)).flatMap((set) =>
          systems.flatMap((system) => allIds.filter((id) => suppliedU(given.file, judge, set, system, id) === undefined).map((id) => `${judge}.${set}.${system}.${id}`)),
        ),
      );
      if (lacking.length > 0) refuse('ITEM_SET_MISMATCH', lacking.slice(0, 20), `the supplied tie-break draws (${given.input.name}) lack ${lacking.length} item(s) the map reads`);
    }
    const dataFor = (seed: number | undefined): MapData => {
      const u = (judge: Judge, set: DrawSet): number[][] =>
        systems.map((system) => allIds.map((id) => (seed !== undefined ? tieBreakU(seed, judge, set, system, id) : ((given === undefined ? undefined : suppliedU(given.file, judge, set, system, id)) as number))));
      const us: MapData['u'] = { old: { estimate: u('old', 'estimate'), reask: u('old', 'reask') }, new: { estimate: u('new', 'estimate'), reask: u('new', 'reask') } };
      const order = (judge: Judge, set: DrawSet): [number, number][] => sortItems({ sum: mapSums[judge][set], u: us[judge][set] });
      return {
        folds: m.folds,
        foldOf: measuredIds.map((id) => foldOfCase(id, m.folds)),
        hasReask: reask !== undefined,
        sum: mapSums,
        u: us,
        order: { old: { estimate: order('old', 'estimate'), reask: order('old', 'reask') }, new: { estimate: order('new', 'estimate'), reask: order('new', 'reask') } },
        maj: mapMaj,
      };
    };
    // The reported numbers use the supplied draws when there are any, and the first seed otherwise.
    const first = dataFor(given === undefined ? seeds[0] : undefined);
    const at = mapAt(first, ones, fitOnes, point) as MapNumbers;
    // What makes the cut unidentified at the point: nothing that depends on it is printed then.
    const tieShare = (f: CutFit): number => f.folds.reduce((acc, x) => acc + x.decidedByTieBreak, 0) / f.folds.reduce((acc, x) => acc + x.labelled, 0);
    // Why one fitted cut is not identified: the same test for the map's two cuts and for the placebo's.
    const unidentified = (name: string, fit: CutFit, judge: Judge, set: DrawSet): string[] => {
      const out: string[] = [];
      for (const f of fit.folds) {
        if (f.cut === 'NOTHING_TO_LABEL') continue;
        if (f.cut === 'EMPTY_FIT_SET') out.push(`${name}, fold ${f.fold}: nothing to fit on`);
        else if (f.target === 0 || f.target === f.fit) out.push(`${name}, fold ${f.fold}: the target passes ${f.target === 0 ? 'no' : 'every'} fit item, so no cut is identified`);
        if (f.cut !== 'EMPTY_FIT_SET' && f.fit < m.minFitItems) out.push(`${name}, fold ${f.fold}: ${f.fit} fit items, and the plan's minFitItems is ${m.minFitItems}`);
      }
      const distinct = new Set(mapSums[judge][set].flat()).size;
      if (distinct < 3) out.push(`${name}: the ${judge} judge's summed scores on the ${set} set take ${distinct} distinct value(s); fewer than three cannot be cut`);
      if (fit.defined && tieShare(fit) > m.maxTieShare) out.push(`${name}: the tie-break decides ${tieShare(fit).toFixed(3)} of the labels, above the plan's maxTieShare ${m.maxTieShare}`);
      return out;
    };
    const why: string[] = [];
    if (noScore.length > 0) why.push(`a failed attempt has no score: ${[...new Set(noScore)].join(', ')}`);
    if (systems.length < m.minSystems) why.push(`${systems.length} systems, and the plan's minSystems is ${m.minSystems}`);
    identify = (mm) => [...unidentified('recalibrated', mm.fits.recalibrated, 'old', 'estimate'), ...unidentified('rejudged', mm.fits.rejudged, 'new', 'estimate')];
    identifyPlacebo = (judge, x) => [...unidentified(`${judge} judge, re-ask set`, x.fits.moved, judge, 'reask'), ...unidentified(`${judge} judge, estimate set`, x.fits.own, judge, 'estimate')];
    appendAll(why, identify(at));
    if (why.length > 0) map = { withheld: 'MAP_NOT_IDENTIFIED', detail: why.join('; ') };
    else {
      mapData = first;
      // The placebo is withheld on its own when one of its cuts is not identified; the map above still stands.
      const placeboOf = (judge: Judge, x: PlaceboNumbers): Placebo => {
        const bad = identifyPlacebo(judge, x);
        if (bad.length > 0) return { withheld: 'MAP_NOT_IDENTIFIED', detail: bad.join('; ') };
        return { net: x.net, onlyReask: x.onlyReask, onlyEstimate: x.onlyEstimate, ...(x.referenceNet === undefined ? {} : { referenceNet: x.referenceNet, ...tag }) };
      };
      placeboWithheld = (['old', 'new'] as const).filter((j) => at.placebo !== undefined && 'withheld' in placeboOf(j, at.placebo[j]));
      const perSeed = seeds.map((seed) => shown(mapQuantities(mapAt(given === undefined && seed === seeds[0] ? first : dataFor(seed), ones, fitOnes, point) as MapNumbers)));
      // The values the report prints, from the first seed's draws or from the supplied ones: the same numbers as the map's own rows.
      const reportedBy = shown(mapQuantities(at));
      const overSeeds = (name: string): OverSeeds => {
        const xs = perSeed.map((q) => q[name] as number).sort((a, b) => a - b);
        const reported = reportedBy[name] as number;
        return { min: xs[0] as number, median: quantileSorted(xs, 0.5), max: xs[xs.length - 1] as number, reported, ...placeAmong(reported, xs) };
      };
      const passCountOf = (labels: readonly boolean[]): number => labels.filter(Boolean).length;
      const named = (r: { a: number; b: number }) => ({ baseline: systems[r.a] as string, candidate: systems[r.b] as string });
      map = {
        folds: m.folds,
        scoredCases: nCases,
        fitOnlyCases: fitCases.length,
        tieBreak: given === undefined ? { seed: seeds[0] as number } : { suppliedSha256: given.input.sha256 },
        assumes: MAP_ASSUMES,
        cuts: { recalibrated: at.fits.recalibrated.folds, rejudged: at.fits.rejudged.folds },
        tieShare: { recalibrated: tieShare(at.fits.recalibrated), rejudged: tieShare(at.fits.rejudged) },
        limits: { minSystems: m.minSystems, minFitItems: m.minFitItems, maxTieShare: m.maxTieShare },
        perSystem: systems.map((system, i) => ({
          system,
          newJudgePasses: passCountOf(table.new[i] as boolean[]),
          recalibratedPasses: passCountOf(at.fits.recalibrated.labels[i] as boolean[]),
          rejudgedCutPasses: passCountOf(at.fits.rejudged.labels[i] as boolean[]),
        })),
        pairs: at.rows.map((r) => ({ ...named(r), recalibrated: r.recalibrated, rejudgedCut: r.rejudgedCut })),
        counts: { pairs: at.rows.length, passRecalibratedOnly: at.passRecalibratedOnly, passRejudgedCutOnly: at.passRejudgedCutOnly, passBoth: at.passBoth, net: at.passRecalibratedOnly - at.passRejudgedCutOnly },
        reference:
          at.reference === undefined
            ? (referenceWithheld ?? NOT_DECLARED)
            : {
                ...tag,
                ...at.reference,
                referenceRegressionPassed: at.rows.flatMap((r, i) => {
                  const passedBy = (['recalibrated', 'rejudgedCut'] as const).filter((k) => r[k].state === 'PASS');
                  return point.gates?.rows[i]?.reference?.state === 'REGRESSION' && passedBy.length > 0 ? [{ ...named(r), passedBy }] : [];
                }),
              },
        placebo: at.placebo === undefined ? NOT_DECLARED : { old: placeboOf('old', at.placebo.old), new: placeboOf('new', at.placebo.new) },
        overTieBreakSeeds: { seeds: [...seeds], quantities: Object.fromEntries(Object.keys(perSeed[0] as Record<string, number>).map((k) => [k, { ...overSeeds(k), ...tagged(k) }])) },
      };
    }
  }

  // A coefficient as a spread row holds it: NaN where it is undefined. The spread is computed only with the coefficients
  // (spreadComputed), so one that was not computed cannot reach a row; if it ever did, that is a defect, not a number.
  const coefficient = (v: Stat | undefined): number => {
    if (v === undefined) throw new TypeError('judge-change: a spread row asks for kappa or AC1, which were not computed');
    return v === NA ? Number.NaN : v;
  };
  // The quantities whose spread over resamples of cases is reported, by name.
  const spreadOfPoint = (x: Numbers): Record<string, number> => ({
    'per-draw pass rate change': x.perDraw.change,
    'label pass rate change': x.label.change,
    'labels that differ between the judges': x.across,
    ...(x.within === undefined || x.beyond === undefined ? {} : { 'labels that differ between two sets of one judge': x.within, [BEYOND]: x.beyond }),
    ...(x.agreement === undefined
      ? {}
      : {
          'agreement with the reference, old judge': x.agreement.old.share,
          'agreement with the reference, new judge': x.agreement.new.share,
          'agreement with the reference, new minus old': (x.agreement.new.agree - x.agreement.old.agree) / x.items,
          'kappa with the reference, old judge': coefficient(x.agreement.old.kappa),
          'kappa with the reference, new judge': coefficient(x.agreement.new.kappa),
          'AC1 with the reference, old judge': coefficient(x.agreement.old.ac1),
          'AC1 with the reference, new judge': coefficient(x.agreement.new.ac1),
        }),
    ...(x.gates === undefined ? {} : { 'pairs passed by doing nothing only, minus by re-judging only': x.gates.passDoNothingOnly - x.gates.passRejudgedOnly }),
    ...(x.gates?.reference === undefined
      ? {}
      : {
          [Q_REF.notPass]: x.gates.reference.notPass,
          [Q_REF.net]: x.gates.reference.net,
          [Q_REF.notPassedNet]: x.gates.reference.notPassedNet,
        }),
  });
  let spread: JudgeChangeReport['spread'] = NOT_DECLARED;
  const res = plan.resampling;
  if (res !== undefined && !spreadComputed) spread = { withheld: 'BELOW_SPREAD_FLOOR', detail: `${nCases} cases, and the plan's spreadFloor is ${res.spreadFloor}` };
  else if (res !== undefined) {
    const d = mapData;
    const tallyMap = { undefinedResamples: 0, unidentifiedCutResamples: 0 };
    const all = (x: Numbers, wS: readonly number[], wF: readonly number[], count = true): Record<string, number> => {
      if (d === undefined) return spreadOfPoint(x);
      const mm = mapAt(d, wS, wF, x) as MapNumbers;
      // One test for the point and for every resample: a map that would be withheld at the point is excluded here.
      const bad = !mm.defined || identify(mm).length > 0;
      if (count && !mm.defined) tallyMap.undefinedResamples++;
      else if (count && bad) tallyMap.unidentifiedCutResamples++;
      const q = shown(mapQuantities(mm));
      for (const k of Object.keys(q)) {
        const judge = (['old', 'new'] as const).find((j) => k.startsWith(`placebo, ${j} judge`));
        if (judge === undefined ? bad : mm.placebo !== undefined && identifyPlacebo(judge, mm.placebo[judge]).length > 0) q[k] = Number.NaN;
      }
      return { ...spreadOfPoint(x), ...q };
    };
    const at = all(point, ones, fitOnes, false);
    const names = Object.keys(at);
    const values: Record<string, number[]> = Object.fromEntries(names.map((k) => [k, []]));
    const rows = supplied.resample;
    if (rows !== undefined) {
      const bad: string[] = [];
      const check = (name: string, m: readonly (readonly number[])[], n: number): void => {
        if (m.some((row) => row.length !== n || row.some((k) => k >= n))) bad.push(`${name}: every row must hold ${n} indices below ${n}`);
      };
      check('scored', rows.file.scored, nCases);
      check('fitOnly', rows.file.fitOnly, fitCases.length);
      if (rows.file.fitOnly.length !== (fitCases.length === 0 ? 0 : rows.file.scored.length)) bad.push(`fitOnly: ${fitCases.length === 0 ? 'no fit-only case, so no row' : 'one row for each row of scored'}`);
      if (bad.length > 0) refuse('ITEM_SET_MISMATCH', bad, `the supplied resample indices (${rows.input.name}) do not fit these cases: ${bad.join('; ')}`);
    }
    const iterations = rows === undefined ? (res as { iterations: number }).iterations : rows.file.scored.length;
    const weights = (idx: readonly number[], n: number): number[] => {
      const w = new Array<number>(n).fill(0);
      for (const k of idx) w[k] = (w[k] as number) + 1;
      return w;
    };
    // Whole cases are resampled, jointly across systems and judges; a case drawn twice has weight 2.
    // Each stratum is resampled on its own: the scored cases first, then the fit-only cases.
    const visit = (scored: readonly number[], fit: readonly number[]): void => {
      const wS = weights(scored, nCases);
      const wF = weights(fit, fitCases.length);
      const x = all(calc(wS), wS, wF);
      for (const k of names) (values[k] as number[]).push(x[k] as number);
    };
    if (rows === undefined) forEachResample((res as { seed: number }).seed, [nCases, fitCases.length], iterations, ([scored, fit]) => visit(scored as number[], fit as number[]));
    else rows.file.scored.forEach((scored, it) => visit(scored, fitCases.length === 0 ? [] : (rows.file.fitOnly[it] as number[])));
    spread = {
      iterations,
      draws: rows === undefined ? { seed: (res as { seed: number }).seed } : { suppliedSha256: rows.input.sha256 },
      unit: 'cases',
      label: rows === undefined ? spreadLabel(iterations) : SUPPLIED_SPREAD_LABEL,
      ...(d === undefined ? {} : { map: tallyMap }),
      quantities: Object.fromEntries(names.map((k) => [k, { point: toStat(at[k] as number), ...spreadOf(at[k] as number, values[k] as number[]), ...tagged(k) }])),
    };
  }

  const reference: JudgeChangeReport['reference'] = !hasReference
    ? NOT_DECLARED
    : (referenceWithheld ?? {
        inputs: pairs.map((p) => {
          const r = p.reference as NonNullable<Pair['reference']>;
          return { system: p.system, name: r.input.name, sha256: r.input.sha256, packetBasis: r.file.packetBasis, ...(r.file.packetSource === undefined ? {} : { packetSource: r.file.packetSource }) };
        }),
        ...(criterion === undefined ? {} : { criterion: { verdictRule: [...verdictRules][0] as string, ...criterion } }),
        agreement: ((): ReferenceReport['agreement'] => {
          // Withheld, not computed: kappa, AC1, their percentiles over resamples, and the plain agreeing share and count,
          // as the reference's packet differs or is unknown.
          if (criterion !== undefined) {
            return { withheld: 'PACKET_MISMATCH', detail: `${criterion.referencePackets}: no agreement statistic with it is computed; kappa, AC1, their intervals and the plain agreeing share and count are withheld` };
          }
          const a = point.agreement as { old: Agreement; new: Agreement };
          const sp = typeof spread === 'object' && !('withheld' in spread) ? spread : undefined;
          // Kappa and AC1 stand only beside their percentiles over resamples. Where no spread was computed they are
          // withheld with the reason and were never computed: the count, the items and both pass shares stay.
          const bare: Withheld =
            typeof spread === 'object' && 'withheld' in spread
              ? { withheld: spread.withheld, detail: `${spread.detail}: the spread is withheld, so nothing would say how uncertain kappa and AC1 are, and neither is computed` }
              : { withheld: 'NO_RESAMPLING', detail: 'plan.resampling is not declared, so nothing would say how uncertain kappa and AC1 are: neither is computed. Declare a resampling block to get both, each with its percentiles over resamples of cases' };
          const strip = (x: Agreement): RaterAgreement => ({
            agree: x.agree,
            share: x.share,
            kappa: sp === undefined || x.kappa === undefined ? bare : x.kappa,
            ac1: sp === undefined || x.ac1 === undefined ? bare : x.ac1,
            passShare: x.passShare,
          });
          const q = sp?.quantities;
          const band = (name: string): [Stat, Stat] => [q?.[name]?.p025 ?? NA, q?.[name]?.p975 ?? NA];
          return {
            rule: plan.labelRule,
            verdictRule: [...verdictRules][0] as string,
            items: a.old.items,
            referencePassShare: a.old.referencePassShare,
            old: strip(a.old),
            new: strip(a.new),
            spread:
              sp === undefined
                ? NOT_DECLARED
                : {
                    percentiles: [2.5, 97.5] as [2.5, 97.5],
                    label: sp.label,
                    old: { kappa: band('kappa with the reference, old judge'), ac1: band('AC1 with the reference, old judge') },
                    new: { kappa: band('kappa with the reference, new judge'), ac1: band('AC1 with the reference, new judge') },
                  },
          };
        })(),
      });
  const withinJudge = point.within ?? NOT_DECLARED;
  const first = pairs[0] as Pair;
  const shapes = [first.old.run.callShapes.judge, first.new.run.callShapes.judge];
  const state = (x: unknown): BlockState => (x === NOT_DECLARED ? NOT_DECLARED : isObj(x) && 'withheld' in x ? `withheld: ${String(x['withheld'])}` : COMPUTED);

  return {
    kind: 'measurement',
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    contracts: { run: RUN_SCHEMA, plan: JUDGE_CHANGE_PLAN_SCHEMA },
    planHash: hashOf(plan),
    barHash: actualBar,
    inputs: pairs.flatMap((p) =>
      ([['old-judge', p.old], ['new-judge', p.new]] as const).map(([role, s]) => ({
        system: p.system,
        role,
        name: s.input.name,
        sha256: s.input.sha256,
        packetBasis: s.run.packetBasis,
        ...(s.run.packetSource === undefined ? {} : { packetSource: s.run.packetSource }),
        judgeRetriesScored: judgeRetries(s.run.draws.filter((d) => scoredIds.has(d.caseId))),
        judgeRetries: judgeRetries(s.run.draws),
      })),
    ),
    labelRule: plan.labelRule,
    measuredClass: plan.measuredClass,
    cut: plan.cut,
    drawSets: { estimate: [...estimate], reask: reask === undefined ? NOT_DECLARED : [...reask] },
    judges: {
      old: plan.judges.old,
      new: plan.judges.new,
      moved: moved.map((f) => ({ field: f, old: plan.judges.old[f], new: plan.judges.new[f] })),
      callShapeMoved: shapes[0] === NO_JUDGE || shapes[1] === NO_JUDGE || shapes[0] === undefined || shapes[1] === undefined ? [] : callShapeDiff(shapes[0], shapes[1]),
    },
    notCompared: { fields: plan.storedOutputs === 'system-side-not-compared' ? [...SYSTEM_SIDE_FIELDS, ...(unknownStopDraws > 0 ? ['systemStop'] : [])] : [], unknownStopDraws, draws: pairs.reduce((acc, p) => acc + p.old.run.draws.length, 0) },
    packetEquality: (() => {
      const declared = (basis: string): boolean => basis !== 'recorded';
      const judges: PacketEquality = pairs.some((p) => declared(p.old.run.packetBasis) || declared(p.new.run.packetBasis)) ? 'by declaration' : 'observed';
      const refs = pairs.some((p) => p.reference !== undefined && declared(p.reference.file.packetBasis));
      // Under a stated difference nothing was found equal: the row holds the label every dependent number carries.
      if (criterion !== undefined) return { judges, reference: criterion.referencePackets };
      if (referenceWithheld !== undefined) return { judges, reference: `withheld: ${referenceWithheld.withheld}` as const };
      return { judges, reference: !use.gates ? NOT_DECLARED : judges === 'by declaration' || refs ? 'by declaration' : 'observed' };
    })(),
    counts: { systems: pairs.length, cases: nCases, fitOnlyCases: fitCases.length, items: pairs.length * nCases, drawsPerSet: estimate.length },
    perDrawPassRate: point.perDraw,
    labelPassRate: { rule: plan.labelRule, ...point.label },
    flips: {
      rule: plan.labelRule,
      acrossJudges: point.across,
      withinJudge,
      beyondReask: point.beyond ?? NOT_DECLARED,
      items: flipped,
    },
    perSystem,
    nonCompensable,
    nonCompensableClasses: nonCompClasses,
    notMeasuredClasses: Object.keys(classes).filter((k) => k !== plan.measuredClass && !nonCompClasses.includes(k)).sort(),
    // Under a stated difference the reference feeds the pair gates only: with no pair, nothing was computed with it.
    blocks: { gate: state(gate), resampling: state(spread), map: state(map), reference: criterion === undefined ? state(reference) : gateOpts === undefined ? CRITERION_NO_PAIRS : CRITERION_ONLY },
    reference,
    gate,
    spread,
    map,
    notes: [
      ...NOTES,
      ...(criterion === undefined ? [] : [`${criterion.referencePackets}: a count that sets a judge's gate against the reference's reflects the two views as well as the judge, and no agreement statistic with this reference is computed`]),
      ...(gate === NOT_DECLARED || 'withheld' in gate ? [] : GATE_NOTES), ...(typeof map === 'object' && !('withheld' in map) ? MAP_NOTES : []), ...(spread === NOT_DECLARED || 'withheld' in spread ? ['points only: no spread is computed'] : SPREAD_NOTES),
    ],
  };
}
