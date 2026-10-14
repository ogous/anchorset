import { NOT_SENT } from './callshape.ts';
import type { NotSent } from './callshape.ts';
import { InputError, RefusalError } from './errors.ts';
import { NA } from './stats.ts';
import { appendAll, GAP, INEXACT_INTEGER, isSha256Hex, keySegment, MAX_DRAWS_PER_CASE, NO_JUDGE } from './identity.ts';
import type { Gap, NoJudge } from './identity.ts';

/** Ordered labels, lowest first. */
export type LabelSet = readonly string[];

/** floor: output must rank at or above the expected label; ceiling: at or below it. */
export type Direction = 'floor' | 'ceiling';

export type ClassSpec = { direction: Direction; nonCompensable?: boolean };

export type Case = { id: string; klass: string; input: unknown; expect: string };

/** Why a call stopped, in a provider-neutral vocabulary. The adapter maps the provider's own reason onto it. */
export const STOPS = Object.freeze(['end', 'stop-sequence', 'tool-use', 'max-tokens', 'content-filter', 'refusal', 'other'] as const);
export type Stop = (typeof STOPS)[number];
/** Stops after which a system answer is complete. A content filter or a refusal is graded through the fold. */
const COMPLETING_SYSTEM_STOPS: readonly Stop[] = ['end', 'stop-sequence', 'tool-use', 'content-filter', 'refusal'];
/** Stops after which a judge's grade is complete. Anything else means the judge did not grade. */
const COMPLETING_JUDGE_STOPS: readonly Stop[] = ['end', 'tool-use'];

/** The system's own failures. Each one fails the draw: they are behaviour under the declared call shape. */
export const FAIL_REASONS = Object.freeze(['truncated', 'client-error', 'system-error'] as const);
export type FailReason = (typeof FAIL_REASONS)[number];

/**
 * What the rater was shown for this item: a sha256 (see docs/JUDGE_CHANGE.md), UNKNOWN when nobody
 * recorded it, or NO_JUDGE in a run graded by code.
 */
export type PacketHash = string | Gap | NoJudge;

/**
 * The system answered and was graded, by the judge or (judgeStop NO_JUDGE) by code. A stored output
 * may record its system stop as UNKNOWN; that is not completion, and the fold refuses it.
 */
export type GradedAttempt = { kind: 'graded'; label: string; outputHash: string; systemStop: Stop | Gap; judgeStop: Stop | NoJudge; packetHash: PacketHash };
/**
 * The system failed on its own: truncated (it hit the declared output budget), client-error (the
 * provider rejected the system's request, 4xx) or system-error (the system under test returned its
 * own error). `outputHash` is the hash of the failure record when there is no output (see outputHashOf).
 */
export type FailedAttempt = { kind: 'failed'; reason: FailReason; detail: string; outputHash: string; systemStop: Stop | NotSent };
/** No response from the provider. Nothing about the system or the judge was measured. */
export const TRANSPORT_REASONS = Object.freeze(['timeout', 'transport', 'server-error', 'rate-limited'] as const);
export type TransportReason = (typeof TRANSPORT_REASONS)[number];
/** Why a judge could not grade an output the system did produce. A judge's 4xx is 'client-error'. */
export const JUDGE_UNMEASURED_REASONS = Object.freeze([...TRANSPORT_REASONS, 'truncated', 'content-filter', 'client-error', 'parse-failure'] as const);
export type JudgeUnmeasuredReason = (typeof JUDGE_UNMEASURED_REASONS)[number];

/**
 * An attempt that measured nothing. role 'system': the system gave no response. role 'judge': the
 * system answered (its output and stop are recorded) but the judge could not grade it; a retry
 * re-grades that same output.
 */
export type UnmeasuredAttempt =
  | { kind: 'unmeasured'; role: 'system'; reason: TransportReason; detail: string }
  | { kind: 'unmeasured'; role: 'judge'; reason: JudgeUnmeasuredReason; detail: string; outputHash: string; systemStop: Stop | Gap; packetHash: string | Gap };
export type Attempt = GradedAttempt | FailedAttempt | UnmeasuredAttempt;
/** An attempt that measured the system. */
export type Measured = GradedAttempt | FailedAttempt;
/** One draw slot. Its outcome is the last attempt; every earlier attempt must be unmeasured (a retry). */
export type Draw = { caseId: string; drawIndex: number; attempts: Attempt[] };

export type FoldedCase = {
  caseId: string;
  klass: string;
  pass: boolean;
  attributedDraw: Draw;
  drawCount: number;
  /**
   * How many of the `drawCount` draws fail the case on their own, each scored as the fold scores it. A count
   * of draws beside a case id: it is never a rate, carries no interval and enters no comparison. Worst-of-N
   * means `pass` is true exactly when it is 0.
   */
  failingDraws: number;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** "at.key: unknown field" for every key of `r` outside `allowed`. A key that is not well-formed text is written as findIllFormed writes it, in its JSON form, so the problem can be printed. */
export function extraKeys(r: Record<string, unknown>, allowed: readonly string[], at: string): string[] {
  return Object.keys(r).filter((k) => !allowed.includes(k)).map((k) => `${at}.${keySegment(k)}: unknown field`);
}

/** A judged attempt carries a packet sha256 or UNKNOWN; an attempt graded by code carries NO_JUDGE. */
function packetProblems(packet: unknown, judged: boolean, at: string): string[] {
  if (!judged) return packet === NO_JUDGE ? [] : [`${at}.packetHash: must be "${NO_JUDGE}" for an attempt graded by code`];
  return packet === GAP || isSha256Hex(packet) ? [] : [`${at}.packetHash: must be the full sha256 of what the judge was shown, or "${GAP}"`];
}

/**
 * Every problem with one draw's attempt list: the one check behind both the parser and the fold.
 * `judged` says whether the run has a judge; when it is not given (a fold called without the
 * identity), the judge side of each attempt is not checked, and everything else still is.
 */
export function attemptsProblems(attempts: unknown, at: string, judged?: boolean): string[] {
  if (!Array.isArray(attempts) || attempts.length === 0) return [`${at}: must be a non-empty array of attempts`];
  const problems: string[] = [];
  attempts.forEach((a: unknown, i) => {
    const aAt = `${at}[${i}]`;
    if (!isObj(a)) {
      problems.push(`${aAt}: must be an object`);
      return;
    }
    const last = i === attempts.length - 1;
    if (a['kind'] === 'graded' || a['kind'] === 'failed') {
      if (!last) problems.push(`${aAt}: only an unmeasured attempt may be retried; a measured attempt must be the last`);
      if (!isSha256Hex(a['outputHash'])) problems.push(`${aAt}.outputHash: must be a full sha256 of the output (or of the failure record)`);
    }
    if (a['kind'] === 'graded') {
      appendAll(problems, extraKeys(a, ['kind', 'label', 'outputHash', 'systemStop', 'judgeStop', 'packetHash'], aAt));
      if (typeof a['label'] !== 'string' || a['label'] === '') problems.push(`${aAt}.label: must be a non-empty label`);
      const stop = a['systemStop'];
      if (stop === 'max-tokens') problems.push(`${aAt}.systemStop: a truncated answer is recorded as failed: truncated, not graded`);
      else if (stop !== GAP && !COMPLETING_SYSTEM_STOPS.includes(stop as Stop)) problems.push(`${aAt}.systemStop: must be a completing stop (${COMPLETING_SYSTEM_STOPS.join(', ')}) or "${GAP}"; completion is never assumed`);
      const judge = a['judgeStop'];
      if (judged === false && judge !== NO_JUDGE) problems.push(`${aAt}.judgeStop: must be "${NO_JUDGE}" in a run graded by code`);
      if (judged === true && !COMPLETING_JUDGE_STOPS.includes(judge as Stop)) {
        problems.push(`${aAt}.judgeStop: must be a completing judge stop (${COMPLETING_JUDGE_STOPS.join(', ')}); a judge that did not finish did not grade`);
      }
      if (judged === undefined && judge !== NO_JUDGE && !COMPLETING_JUDGE_STOPS.includes(judge as Stop)) {
        problems.push(`${aAt}.judgeStop: must be "${NO_JUDGE}" or a completing judge stop (${COMPLETING_JUDGE_STOPS.join(', ')}); a judge that did not finish did not grade`);
      }
      // Without the identity, the attempt's own judgeStop says whether a judge graded it.
      appendAll(problems, packetProblems(a['packetHash'], judged ?? judge !== NO_JUDGE, aAt));
    } else if (a['kind'] === 'failed') {
      appendAll(problems, extraKeys(a, ['kind', 'reason', 'detail', 'outputHash', 'systemStop'], aAt));
      const reason = a['reason'];
      if (!FAIL_REASONS.includes(reason as FailReason)) problems.push(`${aAt}.reason: must be one of ${FAIL_REASONS.join(', ')}`);
      if (typeof a['detail'] !== 'string') problems.push(`${aAt}.detail: must be a string`);
      const want = reason === 'truncated' ? 'max-tokens' : NOT_SENT;
      if (a['systemStop'] !== want) problems.push(`${aAt}.systemStop: must be "${want}" for reason ${String(reason)}`);
    } else if (a['kind'] === 'unmeasured') {
      if (a['role'] === 'system') {
        appendAll(problems, extraKeys(a, ['kind', 'role', 'reason', 'detail'], aAt));
        if (!TRANSPORT_REASONS.includes(a['reason'] as TransportReason)) problems.push(`${aAt}.reason: must be one of ${TRANSPORT_REASONS.join(', ')} for a system that gave no response`);
      } else if (a['role'] === 'judge') {
        appendAll(problems, extraKeys(a, ['kind', 'role', 'reason', 'detail', 'outputHash', 'systemStop', 'packetHash'], aAt));
        if (judged === false) problems.push(`${aAt}: a run graded by code has no judge attempt`);
        if (!JUDGE_UNMEASURED_REASONS.includes(a['reason'] as JudgeUnmeasuredReason)) problems.push(`${aAt}.reason: must be one of ${JUDGE_UNMEASURED_REASONS.join(', ')}`);
        if (!isSha256Hex(a['outputHash'])) problems.push(`${aAt}.outputHash: must be the full sha256 of the output the judge could not grade`);
        if (a['systemStop'] !== GAP && !COMPLETING_SYSTEM_STOPS.includes(a['systemStop'] as Stop)) problems.push(`${aAt}.systemStop: must be the system's completing stop, or "${GAP}"`);
        appendAll(problems, packetProblems(a['packetHash'], true, aAt));
      } else {
        problems.push(`${aAt}.role: must be "system" or "judge"`);
      }
      if (typeof a['detail'] !== 'string') problems.push(`${aAt}.detail: must be a string`);
    } else {
      problems.push(`${aAt}.kind: must be "graded", "failed" or "unmeasured"`);
    }
  });
  // A judge retry re-grades the output the system already produced. Calling the system again after a
  // judge failure would drop that output, and judge failures (a content filter above all) can
  // correlate with exactly the outputs that matter.
  attempts.forEach((a: unknown, i) => {
    const next: unknown = attempts[i + 1];
    if (!isObj(a) || a['kind'] !== 'unmeasured' || a['role'] !== 'judge' || next === undefined) return;
    const sameOutput = isObj(next) && (next['kind'] === 'graded' || (next['kind'] === 'unmeasured' && next['role'] === 'judge'))
      && next['outputHash'] === a['outputHash'] && next['systemStop'] === a['systemStop'] && next['packetHash'] === a['packetHash'];
    if (!sameOutput) problems.push(`${at}[${i + 1}]: a judge retry re-grades the same output (same outputHash, systemStop and packetHash); the system may be called again only after a system-unmeasured attempt`);
  });
  return problems;
}

/**
 * Every problem with the slot structure of a set of draws: an index that is not a non-negative
 * integer, two records for one (case, index) slot (a retry belongs in the slot's attempts), an
 * index at or past drawsPerCase, or a drawsPerCase above MAX_DRAWS_PER_CASE. The one slot check
 * behind the parser, the fold and stability: each of them counts every slot of a case one by one,
 * and none of them does so before this check has passed.
 */
export function slotProblems(draws: readonly Pick<Draw, 'caseId' | 'drawIndex'>[], drawsPerCase: number | undefined): string[] {
  const problems: string[] = [];
  if (drawsPerCase !== undefined && !(drawsPerCase <= MAX_DRAWS_PER_CASE)) problems.push(`drawsPerCase ${drawsPerCase}: at most ${MAX_DRAWS_PER_CASE} draws per case are read`);
  const seen = new Set<string>();
  for (const d of draws) {
    if (!Number.isSafeInteger(d.drawIndex) || d.drawIndex < 0) {
      // A whole number past 2^53 - 1 is printed as it was read, which may not be as it was written: the reason says so.
      problems.push(`case "${d.caseId}": invalid drawIndex ${d.drawIndex}${Number.isInteger(d.drawIndex) && d.drawIndex > 0 ? `: ${INEXACT_INTEGER}` : ''}`);
      continue;
    }
    const key = `${d.caseId}#${d.drawIndex}`;
    if (seen.has(key)) problems.push(`case "${d.caseId}": duplicate drawIndex ${d.drawIndex}; a retry belongs in the slot's attempts`);
    seen.add(key);
    if (drawsPerCase !== undefined && d.drawIndex >= drawsPerCase) problems.push(`case "${d.caseId}": drawIndex ${d.drawIndex} >= drawsPerCase ${drawsPerCase}`);
  }
  return problems;
}

const slotKey = (d: Pick<Draw, 'caseId' | 'drawIndex'>): string => `${d.caseId}#${d.drawIndex}`;

/** Slots ("case#draw") where any attempt records its system stop as UNKNOWN. */
export function unknownStops(draws: readonly Draw[]): string[] {
  return draws.filter((d) => Array.isArray(d.attempts) && d.attempts.some((a: unknown) => isObj(a) && a['systemStop'] === GAP)).map(slotKey).sort();
}

/**
 * Refuses draws that hold an unknown system stop: nobody observed that the answer completed,
 * so neither the fold nor the flip rate may read it. `what` names the run in the message.
 */
export function assertStopsKnown(draws: readonly Draw[], what = 'draws', packetSource?: string): void {
  const slots = unknownStops(draws);
  if (slots.length > 0) {
    // A run an importer wrote never records its system's stop, so the gate can never take it; say where it can go.
    const hint = packetSource !== undefined && packetSource.startsWith(IMPORTED_PACKET_SOURCE_PREFIX) ? '; imported run: use judge-change (docs/IMPORTERS.md)' : '';
    throw new RefusalError('IDENTITY_GAP', slots.map((k) => `systemStop[${k}]`), `${what}: the system stop is unknown on ${slots.join(', ')}; completion is never assumed${hint}`);
  }
}

/** How the `packetSource` of every run an importer writes begins (the three importers under examples/importers). */
const IMPORTED_PACKET_SOURCE_PREFIX = 'computed at import from ';

/**
 * The judge retries of one run, as counts and never as a rate: of the slot records given
 * (`slots`), how many hold a judge retry, that is an earlier attempt that is unmeasured by the judge
 * (`slotsWithRetry`); and those earlier attempts by reason, every reason that occurs and no other,
 * sorted by reason. The last attempt of a slot is its outcome and is never counted here, and an
 * earlier attempt unmeasured by the system is not a judge retry. Reads draws that have passed the
 * attempt-list check. The function is internal: index.ts re-exports the type only.
 */
export type JudgeRetries = { slotsWithRetry: number; slots: number; earlierAttemptsByReason: { reason: JudgeUnmeasuredReason; attempts: number }[] };

export function judgeRetries(draws: readonly Draw[]): JudgeRetries {
  const byReason = new Map<JudgeUnmeasuredReason, number>();
  let slotsWithRetry = 0;
  for (const d of draws) {
    const earlier = d.attempts.slice(0, -1).filter((a): a is Extract<UnmeasuredAttempt, { role: 'judge' }> => a.kind === 'unmeasured' && a.role === 'judge');
    if (earlier.length > 0) slotsWithRetry++;
    for (const a of earlier) byReason.set(a.reason, (byReason.get(a.reason) ?? 0) + 1);
  }
  const earlierAttemptsByReason = [...byReason].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([reason, attempts]) => ({ reason, attempts }));
  return { slotsWithRetry, slots: draws.length, earlierAttemptsByReason };
}

/** The outcome of a draw: its last attempt. Throws InputError('INVALID_DRAWS') on an invalid attempt list. */
export function finalAttempt(d: Draw): Attempt {
  const problems = attemptsProblems(d.attempts, `case "${d.caseId}" draw ${d.drawIndex} attempts`);
  if (problems.length > 0) throw new InputError('INVALID_DRAWS', problems);
  return d.attempts[d.attempts.length - 1] as Attempt;
}

/** Values the library uses as markers; a label that spelled one would be read as the marker. */
const RESERVED = new Set<string>([GAP, NO_JUDGE, NOT_SENT, NA]);

/**
 * The most labels one label set, or the categories of one agreement report, may hold. A table of
 * label against label is built and printed, so its cost is the square of this number: 150,000
 * labels would be a table of 22,500,000,000 cells.
 */
export const MAX_LABELS = 1_000;

export function validateLabelSet(labels: LabelSet): string[] {
  const problems: string[] = [];
  if (!Array.isArray(labels) || labels.length === 0) return ['labels: must be a non-empty array'];
  if (labels.length > MAX_LABELS) return [`labels: ${labels.length} labels; at most ${MAX_LABELS} are read`];
  const seen = new Set<string>();
  labels.forEach((l, i) => {
    if (typeof l !== 'string' || l.length === 0) problems.push(`labels[${i}]: must be a non-empty string`);
    else if (RESERVED.has(l)) problems.push(`labels[${i}]: "${l}" is reserved by the library`);
    else if (seen.has(l)) problems.push(`labels[${i}]: duplicate "${l}"`);
    else seen.add(l);
  });
  return problems;
}

/** Position of `label` in the set; throws InputError('UNKNOWN_LABEL') for a label outside it. */
export function rank(labels: LabelSet, label: string): number {
  const i = labels.indexOf(label);
  if (i < 0) throw new InputError('UNKNOWN_LABEL', [`"${label}" is not in [${labels.join(', ')}]`]);
  return i;
}

/** Whether one measured outcome passes the case. A failed attempt never does. */
export function scoreAttempt(c: Case, a: Measured, labels: LabelSet, spec: ClassSpec): boolean {
  const expected = rank(labels, c.expect);
  if (a.kind === 'failed') return false;
  const got = rank(labels, a.label);
  return spec.direction === 'floor' ? got >= expected : got <= expected;
}

/** A case whose draws do not all measure the system; it is never folded, whatever the measured draws say. */
export type IncompleteCase = {
  caseId: string;
  klass: string;
  expected: number;
  /** Slots with a measured outcome. */
  got: number;
  /** Slot indices with no draw record at all. */
  missing: number[];
  /** Slots whose final attempt measured nothing, and why. */
  unmeasured: { drawIndex: number; role: 'system' | 'judge'; reason: string }[];
  /** True when a measured draw already fails the case: shown, never folded away. */
  measuredFailure: boolean;
};

/** "2 of 3 draws measured (#2 system timeout; #0 missing; a measured draw already fails)". */
export function incompleteDetail(x: IncompleteCase): string {
  const why = [
    ...x.unmeasured.map((u) => `#${u.drawIndex} ${u.role} ${u.reason}`),
    ...x.missing.map((i) => `#${i} missing`),
    ...(x.measuredFailure ? ['a measured draw already fails'] : []),
  ];
  return `${x.got} of ${x.expected} draws measured${why.length > 0 ? ` (${why.join('; ')})` : ''}`;
}

/** Which slots of one case measured the system, which measured nothing, and which have no record. */
export type SlotCount = {
  expected: number;
  measured: { d: Draw; a: Measured }[];
  unmeasured: { drawIndex: number; role: 'system' | 'judge'; reason: string }[];
  missing: number[];
};

/**
 * Refuses a draw count that is not one. The fold and the measured-slots step have no default for it: a count read off
 * the draws that were handed in would make any case complete, and one passing draw of a case that declares three would
 * fold as a pass. A count past MAX_DRAWS_PER_CASE, or not a number at all (NaN), is the slot check's to refuse
 * (INVALID_DRAWS, slotProblems); any other value that is not a positive whole number is INVALID_ARGUMENT.
 */
function assertDrawCount(drawsPerCase: unknown): asserts drawsPerCase is number {
  if (typeof drawsPerCase === 'number') {
    const bound = slotProblems([], drawsPerCase);
    if (bound.length > 0) throw new InputError('INVALID_DRAWS', bound);
  }
  if (typeof drawsPerCase !== 'number' || !Number.isInteger(drawsPerCase) || drawsPerCase < 1) {
    throw new InputError('INVALID_ARGUMENT', [`drawsPerCase: must be a positive integer, the run's declared draw count; got ${typeof drawsPerCase === 'string' ? JSON.stringify(drawsPerCase) : String(drawsPerCase)}`]);
  }
}

/**
 * The one measured-slots step, shared by the fold and by any measurement that labels a case from
 * its draws. It counts the given slots of one case's (already validated) draws once each and
 * scores nothing. `drawsPerCase` is the run's declared count and is required; `slots` defaults to
 * every slot, 0..drawsPerCase-1, and names slots of that count only, each once.
 */
export function measuredSlots(draws: readonly Draw[], drawsPerCase: number, slots?: readonly number[]): SlotCount {
  assertDrawCount(drawsPerCase);
  const outside = (slots ?? []).filter((i) => !Number.isInteger(i) || i < 0 || i >= drawsPerCase);
  if (outside.length > 0) throw new InputError('INVALID_ARGUMENT', outside.map((i) => `slots: ${String(i)} is not a slot of a case with ${drawsPerCase} draws`));
  // One pass: the list is as long as the caller made it.
  const named = new Set<number>();
  const twice = new Set<number>();
  for (const i of slots ?? []) (named.has(i) ? twice : named).add(i);
  if (twice.size > 0) throw new InputError('INVALID_ARGUMENT', [...twice].map((i) => `slots: ${String(i)} is named twice; each slot is counted once`));
  const wanted = slots ?? Array.from({ length: drawsPerCase }, (_, i) => i);
  const inScope = slots === undefined ? draws : draws.filter((d) => named.has(d.drawIndex));
  const indices = new Set(inScope.map((d) => d.drawIndex));
  const sorted = [...inScope].sort((x, y) => x.drawIndex - y.drawIndex).map((d) => ({ d, a: finalAttempt(d) }));
  return {
    expected: wanted.length,
    measured: sorted.filter((x): x is { d: Draw; a: Measured } => x.a.kind !== 'unmeasured'),
    unmeasured: sorted.flatMap((x) => (x.a.kind === 'unmeasured' ? [{ drawIndex: x.d.drawIndex, role: x.a.role, reason: x.a.reason }] : [])),
    missing: wanted.filter((i) => !indices.has(i)),
  };
}

/**
 * The one fold. Validates the draws, counts every slot once, and folds worst-of-N only when every
 * slot measured the system: completeness is independent of the outcome, so a case with a missing or
 * unmeasured slot is incomplete even when a measured draw already fails it.
 */
function foldCase(
  c: Case,
  draws: readonly Draw[],
  labels: LabelSet,
  spec: ClassSpec,
  drawsPerCase: number,
): { kind: 'folded'; folded: FoldedCase } | { kind: 'incomplete'; incomplete: IncompleteCase } {
  assertDrawCount(drawsPerCase);
  const bad: string[] = [];
  for (const d of draws) {
    if (d.caseId !== c.id) bad.push(`draw for "${d.caseId}" passed to case "${c.id}"`);
    appendAll(bad, attemptsProblems(d.attempts, `case "${c.id}" draw ${d.drawIndex} attempts`));
  }
  appendAll(bad, slotProblems(draws, drawsPerCase));
  if (bad.length > 0) throw new InputError('INVALID_DRAWS', bad);
  assertStopsKnown(draws, `case "${c.id}"`);
  rank(labels, c.expect);

  const { expected, measured, unmeasured, missing } = measuredSlots(draws, drawsPerCase);
  // Scored before any short-circuit, so an unknown label on any measured draw still throws.
  const failing = measured.filter((x) => !scoreAttempt(c, x.a, labels, spec));
  if (missing.length > 0 || unmeasured.length > 0) {
    return { kind: 'incomplete', incomplete: { caseId: c.id, klass: c.klass, expected, got: measured.length, missing, unmeasured, measuredFailure: failing.length > 0 } };
  }

  let attributed = measured.find((x) => x.a.kind === 'failed');
  if (attributed === undefined) {
    let worstRank = 0;
    for (const x of measured) {
      const r = rank(labels, (x.a as GradedAttempt).label);
      const worse = spec.direction === 'floor' ? r < worstRank : r > worstRank;
      if (attributed === undefined || worse) {
        attributed = x;
        worstRank = r;
      }
    }
  }
  const chosen = attributed as { d: Draw; a: Measured };
  return {
    kind: 'folded',
    folded: { caseId: c.id, klass: c.klass, pass: scoreAttempt(c, chosen.a, labels, spec), attributedDraw: chosen.d, drawCount: draws.length, failingDraws: failing.length },
  };
}

/**
 * Worst-of-N fold over each draw's final attempt. Any failed attempt is attributed and fails the
 * case; otherwise floor attributes the lowest-ranked label and ceiling the highest (ties: lowest
 * drawIndex). `drawsPerCase` is the run's declared draw count and has no default: draw indices must be
 * exactly 0..drawsPerCase-1, and a case with a missing or unmeasured slot is InputError('INCOMPLETE_DRAWS').
 */
export function foldDraws(
  c: Case,
  draws: readonly Draw[],
  labels: LabelSet,
  spec: ClassSpec,
  drawsPerCase: number,
): FoldedCase {
  const r = foldCase(c, draws, labels, spec, drawsPerCase);
  if (r.kind === 'incomplete') throw new InputError('INCOMPLETE_DRAWS', [`case "${c.id}": ${incompleteDetail(r.incomplete)}`]);
  return r.folded;
}

export type FoldRunResult = {
  folded: FoldedCase[];
  /** Cases with a missing or unmeasured slot; they are excluded from `folded`. */
  incomplete: IncompleteCase[];
};

/**
 * Folds every case of a run. Draws for unknown cases, unknown classes and unknown labels throw;
 * incomplete cases are listed so a gate can fail them as missing.
 */
export function foldRun(
  cases: readonly Case[],
  draws: readonly Draw[],
  labels: LabelSet,
  classes: Readonly<Record<string, ClassSpec>>,
  drawsPerCase: number,
): FoldRunResult {
  assertDrawCount(drawsPerCase);
  const byCase = new Map<string, Draw[]>();
  for (const c of cases) byCase.set(c.id, []);
  const problems: string[] = [];
  for (const d of draws) {
    const list = byCase.get(d.caseId);
    if (list === undefined) problems.push(`draw references unknown case "${d.caseId}"`);
    else list.push(d);
  }
  if (problems.length > 0) throw new InputError('UNKNOWN_CASE', problems);
  const unknownClasses = cases.filter((c) => !Object.hasOwn(classes, c.klass));
  if (unknownClasses.length > 0) {
    throw new InputError(
      'UNKNOWN_CLASS',
      unknownClasses.map((c) => `case "${c.id}": class "${c.klass}" has no spec`),
    );
  }
  const folded: FoldedCase[] = [];
  const incomplete: IncompleteCase[] = [];
  for (const c of cases) {
    const r = foldCase(c, byCase.get(c.id) ?? [], labels, classes[c.klass] as ClassSpec, drawsPerCase);
    if (r.kind === 'folded') folded.push(r.folded);
    else incomplete.push(r.incomplete);
  }
  return { folded, incomplete };
}
