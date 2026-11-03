import { callShapeHash, validateCallShape } from './callshape.ts';
import type { CallShape } from './callshape.ts';
import { InputError, RefusalError } from './errors.ts';
import { appendAll, findIllFormed, findUnhashable, GAP, hashOf, integerProblem, isSha256Hex, MAX_DRAWS_PER_CASE, NO_JUDGE, validateIdentity } from './identity.ts';
import type { Gap, NoJudge, RunIdentity } from './identity.ts';
import { attemptsProblems, extraKeys, finalAttempt, slotProblems } from './scoring.ts';
import type { Attempt, Case, Draw, FailReason } from './scoring.ts';

export const RUN_SCHEMA = 'anchorset.run/v3';

/**
 * Where a run's packet hashes came from: recorded from what the rater was shown, declared afterwards
 * from a documented view (with `packetSource`), UNKNOWN, or NO_JUDGE in a run graded by code.
 */
export const PACKET_BASES = ['recorded', 'declared', GAP, NO_JUDGE] as const;
export type PacketBasis = 'recorded' | 'declared' | Gap | NoJudge;

/** The one run artifact: identity, the call shapes its hashes came from, the case set, and every draw. */
export type RunArtifact = {
  schema: typeof RUN_SCHEMA;
  identity: RunIdentity;
  callShapes: { system: CallShape; judge: CallShape | NoJudge };
  cases: Case[];
  draws: Draw[];
  packetBasis: PacketBasis;
  /** Required with packetBasis "declared", and absent otherwise: the documentation the view was taken from. */
  packetSource?: string;
};

/**
 * The most draw slots (cases times drawsPerCase) one run may declare. Every slot is counted, whether
 * or not the file holds a draw for it, so the bound is on what the file declares, not on its length.
 */
export const MAX_RUN_SLOTS = 1_000_000;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}


/**
 * Every problem with a candidate run artifact, empty when valid: its structure, then (only when the
 * structure is sound) every declared hash against the record stored beside it. The one validator for
 * both parseRunArtifact and gateRuns, so a caller that skips the parser gets the same checks.
 */
export function runArtifactProblems(json: unknown): string[] {
  if (!isObject(json)) return ['artifact: must be an object'];
  const problems: string[] = extraKeys(json, ['schema', 'identity', 'callShapes', 'cases', 'draws', 'packetBasis', 'packetSource'], 'artifact');
  // Before any hash is taken: a string that is not text has no hash, and the declared hashes are checked only on a sound record.
  // A value that has no canonical JSON is not read any further: a caller that parsed the file itself may hand in a number
  // that is not finite, a value nested too deep or one that holds itself, and the checks below would hash it or walk it for ever.
  // A value read through parseJsonText is never one of these.
  const unhashable: string[] = [];
  findUnhashable(json, 'artifact', unhashable);
  if (unhashable.length > 0) return [...problems, ...unhashable];
  findIllFormed(json, 'artifact', problems);
  const schema = json['schema'];
  if (schema !== RUN_SCHEMA) problems.push(`artifact.schema: must be "${RUN_SCHEMA}"`);
  appendAll(problems, validateIdentity(json['identity'], 'artifact.identity'));
  const identity = isObject(json['identity']) ? json['identity'] : {};
  const judged = identity['judgeDefinitionHash'] !== NO_JUDGE;
  const shapes = json['callShapes'];
  if (!isObject(shapes)) {
    problems.push('artifact.callShapes: must be { system, judge }');
  } else {
    appendAll(problems, extraKeys(shapes, ['system', 'judge'], 'artifact.callShapes'));
    appendAll(problems, validateCallShape(shapes['system'], 'artifact.callShapes.system'));
    const judge = shapes['judge'];
    if (judge === NO_JUDGE) {
      if (judged) problems.push(`artifact.callShapes.judge: "${NO_JUDGE}" but the identity has a judge`);
    } else if (!judged) {
      problems.push(`artifact.callShapes.judge: must be "${NO_JUDGE}" for a run graded by code`);
    } else {
      appendAll(problems, validateCallShape(judge, 'artifact.callShapes.judge'));
    }
  }

  const cases = json['cases'];
  const ids = new Set<string>();
  if (!Array.isArray(cases) || cases.length === 0) {
    problems.push('artifact.cases: must be a non-empty array');
  } else {
    cases.forEach((c: unknown, i) => {
      const at = `artifact.cases[${i}]`;
      if (!isObject(c)) {
        problems.push(`${at}: must be an object`);
        return;
      }
      appendAll(problems, extraKeys(c, ['id', 'klass', 'input', 'expect'], at));
      const id = c['id'];
      if (typeof id !== 'string' || id === '') problems.push(`${at}.id: must be a non-empty string`);
      else if (ids.has(id)) problems.push(`${at}.id: duplicate "${id}"`);
      else ids.add(id);
      if (typeof c['klass'] !== 'string' || c['klass'] === '') problems.push(`${at}.klass: must be a non-empty string`);
      if (!('input' in c) || c['input'] === null) problems.push(`${at}.input: required`);
      if (typeof c['expect'] !== 'string' || c['expect'] === '') problems.push(`${at}.expect: must be a label string`);
    });
  }

  const perCase = identity['drawsPerCase'];
  if (Array.isArray(cases) && typeof perCase === 'number' && Number.isInteger(perCase) && perCase >= 1 && perCase <= MAX_DRAWS_PER_CASE && cases.length * perCase > MAX_RUN_SLOTS) {
    problems.push(`artifact: ${cases.length} cases of ${perCase} draws each are ${cases.length * perCase} draw slots; at most ${MAX_RUN_SLOTS} are read`);
  }
  const draws = json['draws'];
  if (!Array.isArray(draws)) {
    problems.push('artifact.draws: must be an array');
  } else {
    const slotted = draws.filter((d: unknown): d is Draw => isObject(d) && typeof d['caseId'] === 'string' && Number.isSafeInteger(d['drawIndex']) && (d['drawIndex'] as number) >= 0);
    appendAll(problems, slotProblems(slotted, typeof perCase === 'number' ? perCase : undefined).map((p) => `artifact.draws: ${p}`));
    draws.forEach((d: unknown, i) => {
      const at = `artifact.draws[${i}]`;
      if (!isObject(d)) {
        problems.push(`${at}: must be an object`);
        return;
      }
      appendAll(problems, extraKeys(d, ['caseId', 'drawIndex', 'attempts'], at));
      if (typeof d['caseId'] !== 'string' || d['caseId'] === '') problems.push(`${at}.caseId: must be a non-empty string`);
      else if (ids.size > 0 && !ids.has(d['caseId'])) problems.push(`${at}.caseId: unknown case "${d['caseId']}"`);
      if (!Number.isSafeInteger(d['drawIndex']) || (d['drawIndex'] as number) < 0) problems.push(`${at}.drawIndex: ${integerProblem(d['drawIndex'], 'must be a non-negative integer')}`);
      appendAll(problems, attemptsProblems(d['attempts'], `${at}.attempts`, judged));
    });
  }

  const basis = json['packetBasis'];
  if (!(PACKET_BASES as readonly unknown[]).includes(basis)) {
    problems.push(`artifact.packetBasis: must be one of ${PACKET_BASES.join(', ')}`);
  } else if ((basis === NO_JUDGE) === judged) {
    problems.push(judged ? `artifact.packetBasis: "${NO_JUDGE}" but the identity has a judge` : `artifact.packetBasis: must be "${NO_JUDGE}" for a run graded by code`);
  }
  const source = json['packetSource'];
  if (basis === 'declared') {
    if (typeof source !== 'string' || source === '') problems.push('artifact.packetSource: required with packetBasis "declared": name the documentation the view was taken from');
  } else if (source !== undefined) {
    problems.push('artifact.packetSource: only allowed with packetBasis "declared"');
  }
  if (basis === GAP && Array.isArray(draws)) {
    const hashed = draws.some((d: unknown) => isObject(d) && Array.isArray(d['attempts']) && d['attempts'].some((a: unknown) => isObject(a) && isSha256Hex(a['packetHash'])));
    if (hashed) problems.push(`artifact.packetBasis: "${GAP}" but an attempt carries a packet hash; say whether the hashes were recorded or declared`);
  }

  if (problems.length === 0) appendAll(problems, declaredHashProblems(json as RunArtifact));
  return problems;
}

/** Validates a parsed run artifact. Throws InputError('INVALID_ARTIFACT') listing every problem. */
export function parseRunArtifact(json: unknown): RunArtifact {
  const problems = runArtifactProblems(json);
  if (problems.length > 0) throw new InputError('INVALID_ARTIFACT', problems);
  return json as RunArtifact;
}

/**
 * Every declared hash must equal the hash of the record stored beside it, exactly: a declared GAP
 * over a record that hashes to a value is as wrong as a wrong value. The cases are always stored,
 * so a valid artifact never declares caseSetHash as GAP.
 */
function declaredHashProblems(a: RunArtifact): string[] {
  const mismatch = (field: string, declared: unknown, actual: string, what: string): string[] =>
    declared === actual ? [] : [`artifact.identity.${field}: declared ${String(declared)}, but ${what} hashes to ${actual}`];
  const { system, judge } = a.callShapes;
  return [
    ...mismatch('caseSetHash', a.identity.caseSetHash, caseSetHash(a.cases), 'the stored cases'),
    ...mismatch('systemCallShapeHash', a.identity.systemCallShapeHash, callShapeHash(system, 'artifact.callShapes.system'), 'the stored system call shape'),
    ...(judge === NO_JUDGE ? [] : mismatch('judgeCallShapeHash', a.identity.judgeCallShapeHash, callShapeHash(judge, 'artifact.callShapes.judge'), 'the stored judge call shape')),
  ];
}

/** The value recorded as `RunIdentity.caseSetHash`: order-independent over case ids. */
export function caseSetHash(cases: readonly Case[]): string {
  return hashOf([...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}


const drawKey = (d: Draw): string => `${d.caseId}#${d.drawIndex}`;

/**
 * Draw keys where the provider rejected a judge call (4xx). The reason is final, so the attempt is
 * the slot's last: the recorded judge call shape describes a request the provider refused.
 */
export function judgeRejected(run: RunArtifact): string[] {
  return run.draws.filter((d) => d.attempts.some((a) => a.kind === 'unmeasured' && a.role === 'judge' && a.reason === 'client-error')).map(drawKey).sort();
}

/**
 * The slots of a run where the system gave no answer: the final attempt is `failed` with a rejected request or the
 * system's own error, each with its reason. An answer cut at its cap is an answer, and is not here. Sorted by draw key.
 */
export function systemNoAnswer(run: RunArtifact): { key: string; reason: FailReason }[] {
  const out = run.draws.flatMap((d) => {
    const last = d.attempts[d.attempts.length - 1];
    return last !== undefined && last.kind === 'failed' && last.reason !== 'truncated' ? [{ key: drawKey(d), reason: last.reason }] : [];
  });
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/**
 * What the system did on a draw, whatever any judge made of it: the output it produced (its hash),
 * whether it answered, failed on its own or gave no response, and why it stopped.
 */
export function systemFacts(a: Attempt): { outputHash: string; outcome: string } {
  // No output to compare; which transport failure it was is not a fact about the system.
  if (a.kind === 'unmeasured' && a.role === 'system') return { outputHash: '', outcome: 'no response' };
  if (a.kind === 'failed') return { outputHash: a.outputHash, outcome: `failed: ${a.reason}, stop ${a.systemStop}` };
  return { outputHash: a.outputHash, outcome: `answered, stop ${a.systemStop}` };
}

/**
 * The same-outputs check. Refuses unless `rejudged` graded exactly what the system did in
 * `original`, draw by draw. A judge that failed in one run and graded in the other is fine here:
 * that is the judge's side. `names` says what the two runs are called in the refusal.
 */
export function assertSameOutputs(original: RunArtifact, rejudged: RunArtifact, names: { original: string; rejudged: string } = { original: 'original', rejudged: 're-judged baseline' }): void {
  const a = new Map(original.draws.map((d) => [drawKey(d), systemFacts(finalAttempt(d))]));
  const b = new Map(rejudged.draws.map((d) => [drawKey(d), systemFacts(finalAttempt(d))]));
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const unmatched = keys.filter((k) => !(a.has(k) && b.has(k)));
  if (unmatched.length > 0) {
    throw new RefusalError('ITEM_SET_MISMATCH', unmatched, `draws graded in only one of the ${names.original} and the ${names.rejudged}: ${unmatched.join(', ')}`);
  }
  const hashDiffer = keys.filter((k) => a.get(k)?.outputHash !== b.get(k)?.outputHash).map((k) => `outputHash[${k}]`);
  if (hashDiffer.length > 0) {
    throw new RefusalError('HASH_MISMATCH', hashDiffer, `the ${names.rejudged} graded different system outputs than the ${names.original}`);
  }
  const outcomeDiffer = keys.filter((k) => a.get(k)?.outcome !== b.get(k)?.outcome).map((k) => `systemOutcome[${k}]`);
  if (outcomeDiffer.length > 0) {
    const detail = outcomeDiffer.map((f) => { const k = f.slice('systemOutcome['.length, -1); return `${k}: ${a.get(k)?.outcome} vs ${b.get(k)?.outcome}`; }).join('; ');
    throw new RefusalError('HASH_MISMATCH', outcomeDiffer, `the same output is recorded with a different system outcome: ${detail}`);
  }
}

/**
 * The packet a draw's rater was shown, read off its final attempt: a graded attempt and a
 * judge-unmeasured one both carry it; a draw the system failed on or never answered reached no
 * rater and has none. The final attempt is enough: every earlier attempt either reached no rater
 * (a system retry) or is a judge retry, which the attempt-list check holds to the same packet.
 */
function shownPacket(d: Draw): string | undefined {
  const a = finalAttempt(d);
  return a.kind === 'graded' || (a.kind === 'unmeasured' && a.role === 'judge') ? a.packetHash : undefined;
}

/**
 * The one rule on two packet hashes: they are the same packet only when both are a
 * full sha256 and the two are equal. Unknown is never equal, to another unknown included, and so
 * is an absent hash.
 */
export function samePacket(x: unknown, y: unknown): boolean {
  return isSha256Hex(x) && x === y;
}

/** What comparePackets found: which of the two runs stand on a basis that is not admitted, and which draws fail. */
export type PacketComparison = { offBasis: ('first' | 'second')[]; draws: string[]; why: Record<string, 'unknown' | 'differs'> };

/**
 * The one same-packets comparison of two runs, draw by draw (two raters are compared
 * only where they saw the same packet). Pure, and it refuses nothing itself: each caller turns the
 * result into its own refusal, with its own names (a draw whose attempts are invalid still throws
 * InputError, from the read of its final attempt). Every comparison of two runs' shown packets in
 * this library goes through here; a second copy is a defect.
 *
 * The one parameter is the one deliberate difference between the callers: `admitted`, the packet
 * bases a run may stand on. The gate's judge-and-system split admits "recorded" only; the
 * judge-change measurement admits "declared" too. "UNKNOWN" and "NO_JUDGE" cannot be admitted.
 *
 * The rule, the same for every caller:
 * - Which hash. The one on each draw's final attempt (see shownPacket). A slot the judge could not
 *   grade is compared like a graded one: its judge was shown a packet too.
 * - Unknown is never equal (samePacket). A hash that is not a sha256 on either side fails, both
 *   sides unknown included. So does a draw that carries a packet in one run only, or exists in one
 *   run only.
 * - A draw that reached no rater in either run (the system failed, or never answered) is skipped:
 *   there is no packet to compare.
 *
 * `offBasis` lists the runs whose basis is not admitted, first before second. `draws` lists the
 * failing draws as `<case>#<draw>`, sorted, each once; it is computed whatever the bases are. `why`
 * gives each of them its cause: `unknown` (a hash that is not a sha256 on either side, or a draw
 * present on one side only) or `differs` (both are sha256 and they are not equal).
 */
export function comparePackets(first: RunArtifact, second: RunArtifact, admitted: readonly ('recorded' | 'declared')[]): PacketComparison {
  const offBasis = ([['first', first], ['second', second]] as const).filter(([, run]) => !(admitted as readonly string[]).includes(run.packetBasis)).map(([side]) => side);
  const a = new Map(first.draws.map((d) => [drawKey(d), shownPacket(d)]));
  const b = new Map(second.draws.map((d) => [drawKey(d), shownPacket(d)]));
  const why: Record<string, 'unknown' | 'differs'> = {};
  const draws = [...new Set([...a.keys(), ...b.keys()])].sort().filter((k) => {
    const x = a.get(k);
    const y = b.get(k);
    if (a.has(k) && b.has(k) && x === undefined && y === undefined) return false;
    if (samePacket(x, y)) return false;
    why[k] = isSha256Hex(x) && isSha256Hex(y) ? 'differs' : 'unknown';
    return true;
  });
  return { offBasis, draws, why };
}

/** How many draws a packet refusal lists in its message before it says how many more there are. Its `fields` always hold every one. */
export const LISTED_DRAWS = 10;

/** The draws of one listing in the message of a packet refusal, of the gate and of judge-change alike: the first ten, and how many more. */
export function listed(keys: readonly string[]): string {
  return keys.length > LISTED_DRAWS ? `${keys.slice(0, LISTED_DRAWS).join(', ')}, and ${keys.length - LISTED_DRAWS} more` : keys.join(', ');
}

/**
 * The same-packets check of a re-judged baseline (two raters are compared only where
 * they saw the same packet). Refuses with PACKET_MISMATCH unless both runs recorded, for every draw,
 * the packet their judge was shown, and the two are equal. It is the admission of the judge-and-
 * system split of `gate --rejudge-of`, and of nothing else: the gate itself reads no packet.
 *
 * The comparison itself is comparePackets, shared with the judge-change measurement; this function
 * is its refusal for the gate. The rule, with the stricter reading taken wherever two existed:
 * - Basis. Both runs must have `packetBasis: "recorded"`. A declared packet is admitted by the
 *   judge-change measurement only: equal declared hashes show that two declarations agree, not
 *   what either judge was shown. "declared" on either side, or on both, refuses, as "UNKNOWN" does.
 *   The fields are `packetBasis (<run>)`.
 * - Which hash. The one on each draw's final attempt (see shownPacket). A slot the judge could not
 *   grade is compared like a graded one: its judge was shown a packet too.
 * - Unknown is never equal. A hash that is not a sha256 on either side refuses, both sides unknown
 *   included. So does a draw that carries a packet in one run only, or exists in one run only.
 * - A draw that reached no rater in either run (the system failed, or never answered) is skipped:
 *   there is no packet to compare.
 * - One bad draw refuses the whole split; no case is dropped to save the rest. The fields are
 *   `packetHash[<case>#<draw>]`, every one; the message lists the first ten (listed).
 *
 * The candidate's packets are not read. The candidate and the re-judged baseline were graded by one
 * judge on different outputs; a packet holds the output, so theirs differ by construction, and the
 * system effect is not an agreement between raters of one item. That the two runs were graded the
 * same way is the identity check's business (the judge fields must match).
 */
export function assertSamePackets(original: RunArtifact, rejudged: RunArtifact, names: { original: string; rejudged: string } = { original: 'original', rejudged: 're-judged baseline' }): void {
  const todo = `re-judge the baseline's stored outputs showing the current judge the packet the first judge was shown, and record each packet hash as it is shown (packetHashOf, packetBasis "recorded")`;
  const found = comparePackets(original, rejudged, ['recorded']);
  const runs = { first: [names.original, original], second: [names.rejudged, rejudged] } as const;
  const offBasis = found.offBasis.map((side) => runs[side]);
  if (offBasis.length > 0) {
    const detail = offBasis.map(([name, run]) => `the ${name} has packetBasis ${run.packetBasis}`).join(', ');
    throw new RefusalError(
      'PACKET_MISMATCH',
      offBasis.map(([name]) => `packetBasis (${name})`),
      `the two judges are compared only on packets both runs recorded, and ${detail} (a declared packet is admitted by judge-change only); ${todo}`,
    );
  }
  const bad = found.draws.map((k) => `packetHash[${k}]`);
  if (bad.length > 0) {
    throw new RefusalError(
      'PACKET_MISMATCH',
      bad,
      `the two judges were not shown the same packet, or what one or both were shown is unknown, on ${listed(bad)}; the ${names.original} and the ${names.rejudged} are compared only where both recorded the same packet; ${todo}`,
    );
  }
}
