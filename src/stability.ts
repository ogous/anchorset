import { listed, systemFacts } from './artifact.ts';
import { InputError, RefusalError } from './errors.ts';
import { appendAll, GAP } from './identity.ts';
import type { Gap } from './identity.ts';
import { assertStopsKnown, finalAttempt, incompleteCounts, measuredSlots, slotProblems } from './scoring.ts';
import type { Draw } from './scoring.ts';
import { NA, percentileInterval, wilson } from './stats.ts';
import type { BootstrapOptions, PercentileInterval, Stat } from './stats.ts';

/**
 * One slot's outcome for stability: its label, the failed bucket (every failed draw counts as one
 * output), or absent (the slot holds no grade, or has no draw record).
 */
export type Outcome = { kind: 'label'; label: string } | { kind: 'failed' } | { kind: 'absent' };
/** A modal output: a label, or the failed bucket. */
export type ModalOutput = Exclude<Outcome, { kind: 'absent' }>;

export type CaseStability = {
  caseId: string;
  /** Measured slots. */
  draws: number;
  /** Slots that hold no grade or have no record. Any one withholds flipped and disagreeShare. */
  unmeasured: number;
  distinctOutputs: number;
  mode: ModalOutput | Gap;
  /** Share of draws whose output differs from the mode. */
  disagreeShare: number | Gap;
  flipped: boolean | Gap;
};

export type StabilityReport = {
  cases: CaseStability[];
  caseCount: number;
  flippedCases: number;
  /** Cases whose flip is withheld because a slot holds no grade. */
  withheldCases: number;
  /** Share of cases with more than one distinct output; UNKNOWN when any case is withheld. */
  flipShare: number | Gap;
};

const FAILED_KEY = '\u0000failed';

/**
 * How a caller of the flip measurement reads unknown system stops. By default they are refused, and `hint` is added to
 * the refusal. `admitUnknown` is set only by the stored-output declaration of `src/flips.ts`, which holds the conditions.
 */
export type StopReading = { admitUnknown?: boolean; hint?: string };

/**
 * Every slot of every case, 0..drawsPerCase-1, read from its final attempt. A slot with no draw
 * record, and a case with no draws at all, are absent: never dropped. Invalid slots or attempt
 * lists throw InputError('INVALID_DRAWS'), through the same checks the fold uses, and an unknown
 * system stop is refused as the fold refuses it, unless `stops` admits it. Which slots measured the system is decided by
 * `measuredSlots`, the step the fold uses: a slot it does not list as measured is absent.
 */
export function groupDraws(draws: readonly Draw[], drawsPerCase: number, caseIds: readonly string[], stops: StopReading = {}): Map<string, Outcome[]> {
  const byCase = new Map<string, Draw[]>(caseIds.map((id) => [id, []]));
  const unknown: string[] = [];
  for (const d of draws) {
    const list = byCase.get(d.caseId);
    if (list === undefined) unknown.push(`draw references unknown case "${d.caseId}"`);
    else list.push(d);
  }
  const problems = [...unknown, ...slotProblems(draws, drawsPerCase)];
  if (problems.length > 0) throw new InputError('INVALID_DRAWS', problems);
  if (stops.admitUnknown !== true) assertStopsKnown(draws, 'draws', undefined, stops.hint);
  return new Map(caseIds.map((id) => {
    const counted = measuredSlots(byCase.get(id) as Draw[], drawsPerCase);
    const slots = Array.from({ length: counted.expected }, (): Outcome => ({ kind: 'absent' }));
    for (const { d, a } of counted.measured) {
      slots[d.drawIndex] = a.kind === 'graded' ? { kind: 'label', label: a.label } : { kind: 'failed' };
    }
    return [id, slots];
  }));
}

/** Repeat-draw stability over slots. Mode ties go to the output seen first in draw order. */
export function flipRate(drawsByCase: ReadonlyMap<string, readonly Outcome[]>): StabilityReport {
  if (drawsByCase.size === 0) throw new InputError('EMPTY_SAMPLE', ['no cases']);
  const cases: CaseStability[] = [];
  for (const caseId of [...drawsByCase.keys()].sort()) {
    const slots = drawsByCase.get(caseId) as readonly Outcome[];
    if (slots.length === 0) throw new InputError('EMPTY_SAMPLE', [`case "${caseId}": no draws`]);
    const outputs = slots.filter((o): o is ModalOutput => o.kind !== 'absent');
    const absent = slots.length - outputs.length;
    const counts = new Map<string, number>();
    for (const o of outputs) {
      const key = o.kind === 'failed' ? FAILED_KEY : o.label;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let modeKey = '';
    let modeCount = 0;
    for (const [k, c] of counts) {
      if (c > modeCount) {
        modeKey = k;
        modeCount = c;
      }
    }
    const mode: ModalOutput | Gap = outputs.length === 0 ? GAP : modeKey === FAILED_KEY ? { kind: 'failed' } : { kind: 'label', label: modeKey };
    cases.push({
      caseId,
      draws: outputs.length,
      unmeasured: absent,
      distinctOutputs: counts.size,
      mode,
      // A slot that holds no grade could have been a flip: withhold rather than read it as agreement.
      disagreeShare: absent > 0 ? GAP : (outputs.length - modeCount) / outputs.length,
      flipped: absent > 0 ? GAP : counts.size > 1,
    });
  }
  const flippedCases = cases.filter((c) => c.flipped === true).length;
  const withheldCases = cases.filter((c) => c.flipped === GAP).length;
  return { cases, caseCount: cases.length, flippedCases, withheldCases, flipShare: withheldCases > 0 ? GAP : flippedCases / cases.length };
}

/**
 * What the repeat draws of one case held. 'one-output': every draw states the same output (one output
 * hash, one system outcome, one stop) and the same packet, under the one grader the run states, so the
 * file names no other source for a label difference. 'different-outputs': the draws hold more than one output, so a label
 * difference mixes system and grader variation. 'ungraded': every draw is the system's own
 * failure, and nothing was graded.
 */
export type RepeatBasis = 'one-output' | 'different-outputs' | 'ungraded';

export type RepeatCase = {
  caseId: string;
  draws: number;
  basis: RepeatBasis;
  /** Distinct stored outputs among the draws: output hash together with the system's outcome and stop. */
  distinctOutputs: number;
  /** Each draw's outcome, in draw order. */
  outcomes: ModalOutput[];
  /** Share of draws whose outcome differs from the modal one: the per-case flip rate. */
  disagreeShare: number;
  /** The draws did not all get the same outcome. */
  flipped: boolean;
};

/**
 * Cases of one basis, and how many flipped. The share is a share of cases with at least one
 * disagreeing draw among `drawsPerCase`: it rises with the number of draws and is not a per-grade
 * rate. `wilson` is the 95% score interval with the case count taken as fixed. `bootstrap` is the
 * seeded percentile bootstrap over all cases of the run, on which the count of this basis varies;
 * with no flip, or nothing but flips, no resample can differ from the sample, and `degenerate` says so.
 */
export type FlipShare = {
  cases: number;
  flipped: number;
  share: Stat;
  wilson: { lo: number; hi: number } | typeof NA;
  bootstrap: PercentileInterval | typeof NA;
  degenerate: boolean;
};

export type RepeatFlipReport = {
  caseCount: number;
  drawsPerCase: number;
  /** The grader's variation alone. */
  oneOutput: FlipShare;
  /** System and grader variation mixed. Never pooled with oneOutput. */
  differentOutputs: FlipShare;
  /** Cases in neither figure. */
  ungradedCases: number;
  bootstrap: BootstrapOptions;
  cases: RepeatCase[];
  /** What the stored-output declaration leaves out. Always present, and empty without the declaration. */
  notCompared: { fields: string[]; unknownStopDraws: number; draws: number };
};

/** Slots ("case#draw") of a draw list, parsed or not, where any attempt records its output hash as UNKNOWN: the field is always known, on every kind of attempt that carries it, an earlier attempt included. */
export function unknownOutputHashes(draws: unknown): string[] {
  if (!Array.isArray(draws)) return [];
  const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  return draws
    .filter((d: unknown): d is Record<string, unknown> => isRec(d) && Array.isArray(d['attempts']) && d['attempts'].some((a: unknown) => isRec(a) && a['outputHash'] === GAP))
    .map((d) => `${String(d['caseId'])}#${String(d['drawIndex'])}`)
    .sort();
}

/**
 * How many distinct stored answers the draws of one case hold: the output hash together with the system's outcome and
 * stop, read off each draw's final attempt (systemFacts). A draw where the system gave no response counts as one answer
 * of its own kind. The one count behind the one-output basis of `flips` and the answer count of the judge-flip list of
 * `gate --rejudge-of`. Internal: not re-exported from index.ts.
 */
export function storedAnswerCount(draws: readonly Draw[]): number {
  return new Set(draws.map((d) => {
    const f = systemFacts(finalAttempt(d));
    return `${f.outputHash}\u0000${f.outcome}`;
  })).size;
}

/**
 * Label flips among the repeat draws of one run, split by what the draws held (see RepeatBasis).
 * The two shares are never pooled: only a one-output case isolates the grader. Built on groupDraws
 * and flipRate, so "the draws did not all get the same outcome" has one implementation.
 *
 * Refuses (RefusalError): one draw per case (UNSUPPORTED_DESIGN); an unknown output hash or system
 * stop, and an unknown packet on a one-output case (IDENTITY_GAP); a slot that holds no grade or
 * has no record (INCOMPLETE_RUN: the missing grade could have been the flip); one output shown in
 * different packets (PACKET_MISMATCH: the grades then differ by what the judge saw as well).
 * When `stops` admits an unknown stop, a case with more than one output refuses too (HASH_MISMATCH): a flip on stored
 * outputs is a label difference on one text, and a known stop beside an unknown one is not shown to be one text.
 */
export function repeatFlips(draws: readonly Draw[], drawsPerCase: number, caseIds: readonly string[], bootstrap: BootstrapOptions, stops: StopReading = {}): RepeatFlipReport {
  if (!Number.isInteger(drawsPerCase) || drawsPerCase < 1) throw new InputError('INVALID_ARGUMENT', [`drawsPerCase must be a positive integer, got ${drawsPerCase}`]);
  if (drawsPerCase < 2) {
    throw new RefusalError('UNSUPPORTED_DESIGN', ['drawsPerCase'], 'the run has one draw per case; a flip needs at least two draws of a case: draw each case at least twice (drawsPerCase 2 or more) to measure how often the grade changes on a repeat');
  }
  const unhashed = unknownOutputHashes(draws);
  if (unhashed.length > 0) {
    throw new RefusalError('IDENTITY_GAP', unhashed.map((k) => `outputHash[${k}]`), `the output hash is unknown on ${unhashed.join(', ')}; draws cannot be shown to share an output nobody hashed`);
  }
  const outcomes = groupDraws(draws, drawsPerCase, caseIds, stops);
  const stability = flipRate(outcomes);
  const byCase = new Map<string, Draw[]>(caseIds.map((id) => [id, []]));
  for (const d of draws) (byCase.get(d.caseId) as Draw[]).push(d);
  if (stops.admitUnknown === true) {
    // Before the slots are read for a grade: the declaration's one condition on a case comes before the locks every run meets.
    const many = caseIds.filter((id) => storedAnswerCount(byCase.get(id) as Draw[]) > 1).sort();
    if (many.length > 0) {
      throw new RefusalError('HASH_MISMATCH', many, `stored outputs were declared, but the draws of ${listed(many)} hold more than one output (output hash, outcome or stop); a stored output is one text`);
    }
  }
  const absent = [...outcomes].flatMap(([id, slots]) => slots.flatMap((o, i) => (o.kind === 'absent' ? [`${id}#${i}`] : []))).sort();
  if (absent.length > 0) {
    const counts = incompleteCounts('run', caseIds.length, drawsPerCase, caseIds.map((caseId) => ({ caseId, ...measuredSlots(byCase.get(caseId) as Draw[], drawsPerCase) })));
    throw new RefusalError('INCOMPLETE_RUN', absent, `${counts}; slots that hold no grade or have no record: ${listed(absent)}; a missing grade could have been the flip, so no share is formed`);
  }

  const unknownPackets: string[] = [];
  const mixedPackets: string[] = [];
  const cases: RepeatCase[] = stability.cases.map((c) => {
    const finals = (byCase.get(c.caseId) as Draw[]).slice().sort((x, y) => x.drawIndex - y.drawIndex).map((d) => ({ d, a: finalAttempt(d) }));
    const outputs = storedAnswerCount(finals.map(({ d }) => d));
    const graded = finals.flatMap(({ d, a }) => (a.kind === 'graded' ? [{ d, a }] : []));
    const basis: RepeatBasis = graded.length === 0 ? 'ungraded' : outputs === 1 ? 'one-output' : 'different-outputs';
    if (basis === 'one-output') {
      const gaps = graded.filter(({ a }) => a.packetHash === GAP).map(({ d }) => `packetHash[${c.caseId}#${d.drawIndex}]`);
      appendAll(unknownPackets, gaps);
      if (gaps.length === 0 && new Set(graded.map(({ a }) => a.packetHash)).size > 1) mixedPackets.push(c.caseId);
    }
    return {
      caseId: c.caseId,
      draws: c.draws,
      basis,
      distinctOutputs: outputs,
      outcomes: (outcomes.get(c.caseId) as readonly Outcome[]).filter((o): o is ModalOutput => o.kind !== 'absent'),
      disagreeShare: c.disagreeShare as number,
      flipped: c.flipped === true,
    };
  });
  if (unknownPackets.length > 0) {
    throw new RefusalError('IDENTITY_GAP', unknownPackets, `nobody recorded what the judge was shown on ${unknownPackets.length} draw(s) of a case with one output; the same output in an unknown packet is not shown to be the same question`);
  }
  if (mixedPackets.length > 0) {
    throw new RefusalError('PACKET_MISMATCH', mixedPackets, `the draws of ${mixedPackets.join(', ')} graded one output shown in different packets; their labels differ by what the judge saw as well as by the judge`);
  }

  const shareOf = (basis: RepeatBasis): FlipShare => {
    const of = cases.filter((c) => c.basis === basis);
    const flipped = of.filter((c) => c.flipped).length;
    if (of.length === 0) return { cases: 0, flipped: 0, share: NA, wilson: NA, bootstrap: NA, degenerate: false };
    const w = wilson(flipped, of.length);
    const stat = (sample: readonly RepeatCase[]): number => {
      const s = sample.filter((c) => c.basis === basis);
      return s.length === 0 ? Number.NaN : s.filter((c) => c.flipped).length / s.length;
    };
    return {
      cases: of.length,
      flipped,
      share: flipped / of.length,
      wilson: { lo: w.lo, hi: w.hi },
      bootstrap: percentileInterval(cases, stat, bootstrap),
      degenerate: flipped === 0 || flipped === of.length,
    };
  };
  return {
    caseCount: cases.length,
    drawsPerCase,
    oneOutput: shareOf('one-output'),
    differentOutputs: shareOf('different-outputs'),
    ungradedCases: cases.filter((c) => c.basis === 'ungraded').length,
    bootstrap,
    cases,
    notCompared: { fields: [], unknownStopDraws: 0, draws: 0 },
  };
}

