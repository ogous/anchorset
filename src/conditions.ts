import type { RunArtifact } from './artifact.ts';
import { callShapeDiff, EXTRAS_KEY_RE } from './callshape.ts';
import type { CallShape } from './callshape.ts';
import { InputError } from './errors.ts';
import { appendAll, diffState, GAP, IDENTITY_FIELDS, integerProblem, JUDGE_FIELDS, isSha256Hex, keySegment, NO_JUDGE, NOT_RETURNED, readsAsGap, RETURNED_NULL } from './identity.ts';
import type { DiffState, Gap, IdentityField, NotReturned, ReturnedNull } from './identity.ts';
import type { Attempt, Draw } from './scoring.ts';

/*
 * The recorded conditions of a run: the model calls each attempt made (`calls`) and, per role, how the requests went
 * out (`conditions`). Pure. The checks here are called from the one artifact validator and the one attempt-list check;
 * the table and the counts are read by the `conditions` command. Nothing here admits or refuses a comparison, and no
 * verdict, exit code, fold or ledger record reads these fields.
 */

export type Role = 'system' | 'judge';
/** A token count from a response: a non-negative integer, or why there is none. */
export type Counter = number | NotReturned | ReturnedNull | Gap;
export type Usage = { inputTokensTotal: Counter; cacheReadTokens: Counter; cacheWriteTokens: Counter; outputTokens: Counter };
/**
 * One model call of an attempt. The request side is always there; the reply side (`servedModel`, `receivedAt`, `usage`,
 * `serving`) is there exactly when the call got a reply. `submission` absent: the call was sent on its own.
 */
export type CallRecord = {
  role: Role;
  requestHash: string | Gap;
  submission?: string | Gap;
  sentAt: string | Gap;
  servedModel?: string | NotReturned | ReturnedNull | Gap;
  receivedAt?: string | Gap;
  usage?: Usage;
  serving?: Record<string, string>;
};
export const SUBMISSION_KINDS = Object.freeze(['provider-batch', 'client-group'] as const);
export type Submission = {
  id: string;
  kind: (typeof SUBMISSION_KINDS)[number];
  size: number | Gap;
  sharedWith: string[] | Gap;
  submittedAt: string | Gap;
  endedAt: string | NotReturned | Gap;
  recordedAt: string | Gap;
};
export type RoleConditions = { concurrency: number | Gap; servingKeys: string[]; submissions: Submission[] };
/**
 * `drawsPerCopy`: the draws of each case form copies of this many draws, in draw order (copy 1 is draws 0 to k-1, and
 * so on). A copy belongs to the slots, not to a role. Read only by the copies lines of `conditions`.
 */
export type RunConditions = { system?: RoleConditions; judge?: RoleConditions; drawsPerCopy?: number };

const ROLES: readonly Role[] = ['system', 'judge'];
const REQUEST_KEYS = ['role', 'requestHash', 'submission', 'sentAt'] as const;
const REPLY_KEYS = ['servedModel', 'receivedAt', 'usage', 'serving'] as const;
export const USAGE_KEYS = ['inputTokensTotal', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;
const SUBMISSION_KEYS = ['id', 'kind', 'size', 'sharedWith', 'submittedAt', 'endedAt', 'recordedAt'] as const;
const ROLE_KEYS = ['concurrency', 'servingKeys', 'submissions'] as const;
/** The markers no value of a call record may spell as text. */
const MARKERS = new Set<string>([GAP, NO_JUDGE, NOT_RETURNED, RETURNED_NULL, 'NOT_SENT', 'NO_SEED', 'NA']);

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const unknownKeys = (o: Obj, allowed: readonly string[], at: string): string[] => Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${at}.${keySegment(k)}: unknown field`);

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * A time as the run records it, in nanoseconds since 1970 (UTC), or undefined when the text is not one: RFC 3339 in UTC
 * with "Z", seconds required, a fraction of 1 to 9 digits, a real calendar date. No offset, no leap second.
 */
export function timeNanos(s: unknown): bigint | undefined {
  if (typeof s !== 'string') return undefined;
  const m = TIME_RE.exec(s);
  if (m === null) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59 || d < 1) return undefined;
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  // Date.UTC rolls 30 February into March: a date that does not survive the round trip is not a date.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  const frac = (m[7] ?? '').padEnd(9, '0');
  return BigInt(ms) * 1_000_000n + BigInt(frac === '' ? 0 : Number(frac));
}

const timeProblem = (v: unknown, at: string, also: readonly string[] = []): string[] =>
  v === GAP || also.includes(v as string) || timeNanos(v) !== undefined ? [] : [`${at}: must be a UTC time "YYYY-MM-DDTHH:MM:SS[.fraction]Z", or "${GAP}"${also.map((x) => `, or "${x}"`).join('')}`];

/**
 * A text value of a record: non-empty, and not a marker spelled as text. `verbatim`: a provider's own value, kept as it
 * came (a serving label); otherwise a value that reads as a gap ("unknown", "none", ...) is refused, as identity text is.
 */
const providerText = (v: unknown, at: string, markers: readonly string[], verbatim = false): string[] => {
  if (typeof v === 'string' && markers.includes(v)) return [];
  if (typeof v !== 'string' || v === '') return [`${at}: must be a non-empty string, or one of ${markers.join(', ')}`];
  if (MARKERS.has(v)) return [`${at}: "${v}" is a marker; it is not allowed here (allowed: ${markers.join(', ')})`];
  return !verbatim && readsAsGap(v) ? [`${at}: "${v}" reads as a gap; record a value not known as "${GAP}"`] : [];
};

const counterProblem = (v: unknown, at: string): string[] =>
  v === GAP || v === NOT_RETURNED || v === RETURNED_NULL || (Number.isSafeInteger(v) && (v as number) >= 0)
    ? []
    : [`${at}: ${integerProblem(v, `must be a non-negative integer, "${NOT_RETURNED}", "${RETURNED_NULL}" or "${GAP}"`)}`];

/** True when a call record carries the reply side. */
export const hasReply = (c: Obj | CallRecord): boolean => (c as Obj)['servedModel'] !== undefined;

/** Every problem with one call record, on its own: its keys, its values, and that the reply side is whole or absent. */
export function callProblems(c: unknown, at: string): string[] {
  if (!isObj(c)) return [`${at}: must be an object`];
  const problems = unknownKeys(c, [...REQUEST_KEYS, ...REPLY_KEYS], at);
  if (c['role'] !== 'system' && c['role'] !== 'judge') problems.push(`${at}.role: must be "system" or "judge"`);
  if (c['requestHash'] !== GAP && !isSha256Hex(c['requestHash'])) problems.push(`${at}.requestHash: must be the full sha256 of the request's parameters, or "${GAP}"`);
  if ('submission' in c) appendAll(problems, providerText(c['submission'], `${at}.submission`, [GAP]));
  if (!('sentAt' in c)) problems.push(`${at}.sentAt: required (a time, or "${GAP}")`);
  else appendAll(problems, timeProblem(c['sentAt'], `${at}.sentAt`));
  const reply = REPLY_KEYS.filter((k) => k in c);
  if (reply.length > 0 && reply.length < REPLY_KEYS.length) {
    problems.push(`${at}: a call that got a reply carries all of ${REPLY_KEYS.join(', ')}, and one that got none carries none of them; this one has ${reply.join(', ')}`);
  }
  if (reply.length === REPLY_KEYS.length) {
    appendAll(problems, providerText(c['servedModel'], `${at}.servedModel`, [NOT_RETURNED, RETURNED_NULL, GAP]));
    appendAll(problems, timeProblem(c['receivedAt'], `${at}.receivedAt`));
    const sent = timeNanos(c['sentAt']);
    const got = timeNanos(c['receivedAt']);
    if (sent !== undefined && got !== undefined && sent > got) problems.push(`${at}.receivedAt: is before sentAt`);
    const u = c['usage'];
    if (!isObj(u)) problems.push(`${at}.usage: must be { ${USAGE_KEYS.join(', ')} }`);
    else {
      appendAll(problems, unknownKeys(u, USAGE_KEYS, `${at}.usage`));
      for (const k of USAGE_KEYS) {
        if (!(k in u)) problems.push(`${at}.usage.${k}: required`);
        else appendAll(problems, counterProblem(u[k], `${at}.usage.${k}`));
      }
      const [t, r, w] = [u['inputTokensTotal'], u['cacheReadTokens'], u['cacheWriteTokens']];
      const int = (x: unknown): x is number => Number.isSafeInteger(x);
      // Each part on its own, then the two together: a part not known must not let the other pass the total.
      if (int(t) && int(r) && r > t) problems.push(`${at}.usage.cacheReadTokens: ${r} is more than inputTokensTotal (${t}), which includes it`);
      if (int(t) && int(w) && w > t) problems.push(`${at}.usage.cacheWriteTokens: ${w} is more than inputTokensTotal (${t}), which includes it`);
      if (int(t) && int(r) && int(w) && r <= t && w <= t && r + w > t) problems.push(`${at}.usage: cacheReadTokens + cacheWriteTokens (${r + w}) is more than inputTokensTotal (${t}), which includes them`);
    }
    const s = c['serving'];
    if (!isObj(s)) problems.push(`${at}.serving: must be an object of the role's servingKeys`);
    else for (const [k, v] of Object.entries(s)) appendAll(problems, providerText(v, `${at}.serving.${keySegment(k)}`, [NOT_RETURNED, RETURNED_NULL, GAP], true));
  }
  return problems;
}

/**
 * Every problem with a run's `conditions` block, on its own. `judged`: whether the run has a judge. `drawsPerCase`: the
 * identity's draw count, which a declared `drawsPerCopy` must divide into two copies or more.
 */
export function conditionsProblems(x: unknown, at: string, judged: boolean, drawsPerCase?: unknown): string[] {
  if (!isObj(x)) return [`${at}: must be { system?, judge?, drawsPerCopy? }`];
  const problems = unknownKeys(x, [...ROLES, 'drawsPerCopy'], at);
  if ('judge' in x && !judged) problems.push(`${at}.judge: a run graded by code has no judge`);
  if ('drawsPerCopy' in x) {
    const k = x['drawsPerCopy'];
    const kAt = `${at}.drawsPerCopy`;
    // No gap marker: a writer who does not know how the draws form copies leaves the key out.
    if (!(Number.isSafeInteger(k) && (k as number) >= 1)) problems.push(`${kAt}: ${integerProblem(k, 'must be a positive integer (leave the key out when the copies are not known)')}`);
    else if (!(Number.isSafeInteger(drawsPerCase) && (drawsPerCase as number) >= 1)) problems.push(`${kAt}: needs a known identity.drawsPerCase to divide; it is ${JSON.stringify(drawsPerCase)}`);
    else if ((drawsPerCase as number) % (k as number) !== 0) problems.push(`${kAt}: ${k} does not divide identity.drawsPerCase ${drawsPerCase}`);
    else if ((drawsPerCase as number) / (k as number) < 2) problems.push(`${kAt}: ${k} of identity.drawsPerCase ${drawsPerCase} is one copy per case; leave the key out when a case was asked once`);
  }
  for (const role of ROLES) {
    if (!(role in x)) continue;
    const r = x[role];
    const rAt = `${at}.${role}`;
    if (!isObj(r)) {
      problems.push(`${rAt}: must be { ${ROLE_KEYS.join(', ')} }`);
      continue;
    }
    appendAll(problems, unknownKeys(r, ROLE_KEYS, rAt));
    for (const k of ROLE_KEYS) if (!(k in r)) problems.push(`${rAt}.${k}: required`);
    const conc = r['concurrency'];
    if (conc !== undefined && conc !== GAP && !(Number.isSafeInteger(conc) && (conc as number) > 0)) problems.push(`${rAt}.concurrency: ${integerProblem(conc, `must be a positive integer, or "${GAP}"`)}`);
    const keys = r['servingKeys'];
    if (keys !== undefined) {
      if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !EXTRAS_KEY_RE.test(k))) problems.push(`${rAt}.servingKeys: must be a list of "namespace.key" names (for example "provider.service_tier")`);
      else if (keys.some((k, i) => i > 0 && (keys[i - 1] as string) >= (k as string))) problems.push(`${rAt}.servingKeys: must be sorted and unique`);
    }
    const subs = r['submissions'];
    if (subs === undefined) continue;
    if (!Array.isArray(subs)) {
      problems.push(`${rAt}.submissions: must be a list`);
      continue;
    }
    const ids = new Set<string>();
    subs.forEach((s: unknown, i) => {
      const sAt = `${rAt}.submissions[${i}]`;
      if (!isObj(s)) return void problems.push(`${sAt}: must be an object`);
      appendAll(problems, unknownKeys(s, SUBMISSION_KEYS, sAt));
      for (const k of SUBMISSION_KEYS) if (!(k in s)) problems.push(`${sAt}.${k}: required`);
      const id = s['id'];
      if (typeof id !== 'string' || id === '' || MARKERS.has(id) || readsAsGap(id)) problems.push(`${sAt}.id: must be the submission's id, a non-empty string`);
      else if (ids.has(id)) problems.push(`${sAt}.id: "${id}" is listed twice`);
      else ids.add(id);
      if ('kind' in s && !(SUBMISSION_KINDS as readonly unknown[]).includes(s['kind'])) problems.push(`${sAt}.kind: must be one of ${SUBMISSION_KINDS.join(', ')}`);
      const size = s['size'];
      if (size !== undefined && size !== GAP && !(Number.isSafeInteger(size) && (size as number) > 0)) problems.push(`${sAt}.size: ${integerProblem(size, `must be a positive integer, or "${GAP}"`)}`);
      const shared = s['sharedWith'];
      if (shared !== undefined && shared !== GAP) {
        if (!Array.isArray(shared) || shared.some((m) => typeof m !== 'string' || m === '' || MARKERS.has(m) || readsAsGap(m))) problems.push(`${sAt}.sharedWith: must be a list of model ids, or "${GAP}"`);
        else if (shared.some((m, j) => j > 0 && (shared[j - 1] as string) >= (m as string))) problems.push(`${sAt}.sharedWith: must be sorted and unique`);
      }
      if ('submittedAt' in s) appendAll(problems, timeProblem(s['submittedAt'], `${sAt}.submittedAt`));
      if ('endedAt' in s) appendAll(problems, timeProblem(s['endedAt'], `${sAt}.endedAt`, [NOT_RETURNED]));
      if ('recordedAt' in s) appendAll(problems, timeProblem(s['recordedAt'], `${sAt}.recordedAt`));
    });
  }
  return problems;
}

/** The calls of an attempt, as records; [] where the attempt carries none. */
const callsOf = (a: unknown): Obj[] => (isObj(a) && Array.isArray(a['calls']) ? a['calls'].filter(isObj) : []);

/**
 * The checks across a run's records, run by the artifact validator once each record is sound on its own: tool use for
 * several system calls on one attempt, the per-call served id against the run's known one, submission ids and sizes,
 * and the serving keys against the role's list.
 */
export function runCallProblems(run: { identity: Obj; callShapes: Obj; draws: unknown[]; conditions?: unknown }): string[] {
  const problems: string[] = [];
  const shape = run.callShapes['system'];
  // Only a declared "no tools" rules out several calls: NOT_SENT may mean the provider's default with tools sent, and
  // UNKNOWN is not a statement. A harness may also chain calls of its own; the record says what was called.
  const noTools = isObj(shape) && shape['toolChoice'] === 'none' && shape['thinkingMode'] !== 'between-tools';
  const cond: Obj = isObj(run.conditions) ? run.conditions : {};
  const served: Record<Role, unknown> = { system: run.identity['systemModelServed'], judge: run.identity['judgeModelServed'] };
  const named = new Map<string, number>();
  const nameKey = (role: Role, id: string): string => `${role}\u0000${id}`;
  run.draws.forEach((d: unknown, i) => {
    if (!isObj(d) || !Array.isArray(d['attempts'])) return;
    d['attempts'].forEach((a: unknown, j) => {
      const calls = callsOf(a);
      const at = `artifact.draws[${i}].attempts[${j}].calls`;
      if (noTools && calls.filter((c) => c['role'] === 'system').length > 1) {
        problems.push(`${at}: more than one system call on one attempt, but the system call shape declares toolChoice "none" (and no thinking between tools)`);
      }
      calls.forEach((c, k) => {
        const role = c['role'] as Role;
        const cAt = `${at}[${k}]`;
        const own = served[role];
        if (hasReply(c) && typeof own === 'string' && own !== GAP && own !== NO_JUDGE && c['servedModel'] !== own) {
          problems.push(`${cAt}.servedModel: is ${JSON.stringify(c['servedModel'])}, but the run records ${role}ModelServed ${JSON.stringify(own)}; a run whose calls name another id, or none, records ${role}ModelServed as "${GAP}"`);
        }
        const sub = c['submission'];
        const rc = cond[role];
        if (typeof sub === 'string' && sub !== GAP) {
          named.set(nameKey(role, sub), (named.get(nameKey(role, sub)) ?? 0) + 1);
          if (isObj(rc) && Array.isArray(rc['submissions']) && !rc['submissions'].some((s) => isObj(s) && s['id'] === sub)) {
            problems.push(`${cAt}.submission: "${sub}" is not in conditions.${role}.submissions`);
          }
        }
        if (hasReply(c)) {
          const keys = isObj(rc) && Array.isArray(rc['servingKeys']) ? (rc['servingKeys'] as string[]) : [];
          const got = isObj(c['serving']) ? Object.keys(c['serving']).sort() : [];
          if (got.join('\u0000') !== keys.join('\u0000')) {
            problems.push(`${cAt}.serving: holds ${got.length === 0 ? 'no key' : got.join(', ')}, but conditions.${role}.servingKeys lists ${keys.length === 0 ? 'none' : keys.join(', ')}; a call carries exactly the keys the recorder looked for`);
          }
        }
      });
    });
  });
  for (const role of ROLES) {
    const rc = cond[role];
    if (!isObj(rc) || !Array.isArray(rc['submissions'])) continue;
    rc['submissions'].forEach((s: unknown, i) => {
      if (!isObj(s) || typeof s['id'] !== 'string' || !Number.isSafeInteger(s['size'])) return;
      const n = named.get(nameKey(role, s['id'])) ?? 0;
      if (n > (s['size'] as number)) problems.push(`artifact.conditions.${role}.submissions[${i}].size: ${String(s['size'])}, but ${n} calls of this run name it`);
    });
  }
  return problems;
}

/**
 * Where calls may sit on an attempt, for the one attempt-list check. `retry`: the attempt follows one unmeasured by the
 * judge, so it re-grades an output the system already gave and makes no system call. `judged`: the run has a judge
 * (undefined: not known to the caller, and the judge side is read off the attempt).
 */
export function placementProblems(a: Obj, at: string, retry: boolean, judged: boolean | undefined, transportReasons: readonly string[]): string[] {
  const calls = a['calls'];
  if (calls === undefined) return [];
  if (!Array.isArray(calls)) return [`${at}.calls: must be a list of call records`];
  const problems: string[] = [];
  calls.forEach((c, k) => appendAll(problems, callProblems(c, `${at}.calls[${k}]`)));
  if (problems.length > 0) return problems;
  const recs = calls as Obj[];
  const judges = recs.flatMap((c, k) => (c['role'] === 'judge' ? [k] : []));
  const systems = recs.flatMap((c, k) => (c['role'] === 'system' ? [k] : []));
  const kind = a['kind'];
  const graded = kind === 'graded';
  const judgeAttempt = (graded && (judged ?? a['judgeStop'] !== NO_JUDGE) && a['judgeStop'] !== NO_JUDGE) || (kind === 'unmeasured' && a['role'] === 'judge');
  if (judgeAttempt) {
    if (judges.length !== 1 || judges[0] !== recs.length - 1) problems.push(`${at}.calls: an attempt the judge ${graded ? 'graded' : 'could not grade'} carries exactly one judge call, the last call`);
    else {
      const jc = recs[recs.length - 1] as Obj;
      const transport = kind === 'unmeasured' && transportReasons.includes(a['reason'] as string);
      if (graded && !hasReply(jc)) problems.push(`${at}.calls[${recs.length - 1}]: the judge call of a graded attempt got a reply; record it`);
      if (transport && hasReply(jc)) problems.push(`${at}.calls[${recs.length - 1}]: the reason ${String(a['reason'])} says the judge call got no reply; leave the reply side out`);
    }
  } else if (judges.length > 0) {
    problems.push(`${at}.calls: ${kind === 'failed' ? 'a failed attempt' : kind === 'unmeasured' ? 'an attempt the system gave no response on' : 'an attempt graded by code'} carries no judge call`);
  }
  if (retry && systems.length > 0) problems.push(`${at}.calls: a judge retry re-grades the output the system already gave; it carries no system call`);
  if (kind === 'unmeasured' && a['role'] === 'system') {
    // A tool-using system may get replies to its first calls and none to the last one: the last is the one that failed.
    const lastSystem = systems[systems.length - 1];
    if (lastSystem === undefined) problems.push(`${at}.calls: the system was called on this attempt and gave no response; record that call`);
    else if (hasReply(recs[lastSystem] as Obj)) problems.push(`${at}.calls[${lastSystem}]: the system gave no response on this attempt; its last call carries no reply side`);
  }
  const systemAnswered = graded || (kind === 'unmeasured' && a['role'] === 'judge');
  if (systemAnswered && systems.some((k) => !hasReply(recs[k] as Obj))) problems.push(`${at}.calls: the system answered on this attempt; each of its calls got a reply`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// The report: what one run, or two, recorded.

const keyOf = (d: Pick<Draw, 'caseId' | 'drawIndex'>): string => `${d.caseId}#${d.drawIndex}`;

/**
 * The calls a slot stands on: the judge call of its final attempt, and the system calls of the attempt that produced
 * the output the final attempt holds, found by walking back from it past the judge retries (each re-grades the output of
 * the attempt before it).
 */
export function resolvedCalls(d: Draw): { judge: CallRecord[]; system: CallRecord[]; recorded: boolean } {
  const withCalls = (a: Attempt | undefined): CallRecord[] => (a as { calls?: CallRecord[] } | undefined)?.calls ?? [];
  const recorded = d.attempts.some((a) => (a as { calls?: unknown }).calls !== undefined);
  let i = d.attempts.length - 1;
  const judge = withCalls(d.attempts[i]).filter((c) => c.role === 'judge');
  while (i > 0) {
    const prev = d.attempts[i - 1] as Attempt;
    if (!(prev.kind === 'unmeasured' && prev.role === 'judge')) break;
    i--;
  }
  return { judge, system: withCalls(d.attempts[i]).filter((c) => c.role === 'system'), recorded };
}

/** A count of values: each value with how many calls carried it, sorted by value. */
export type Tally = { value: string; calls: number }[];
const tally = (values: readonly string[]): Tally => {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([value, calls]) => ({ value, calls }));
};

/** A share from two integers: numerator, denominator and tenths of a percent, rounded half up; never a float. */
export type IntShare = { numerator: number; denominator: number; tenthsOfPercent: number };
/** Tenths of a percent of num/den, rounded half up, on integers only: floor((2000·num + den) / (2·den)). */
export function tenthsOfPercent(num: number, den: number): number {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num < 0 || den <= 0) throw new RangeError(`tenthsOfPercent: needs integers 0 <= num and 0 < den; got ${num} / ${den}`);
  return Number((2000n * BigInt(num) + BigInt(den)) / (2n * BigInt(den)));
}
export const percentText = (t: number): string => `${Math.floor(t / 10)}.${t % 10}%`;

export type CacheShare = { share: IntShare | 'none'; callsCounted: number; callsLeftOut: number };
/** Σ cacheReadTokens / Σ inputTokensTotal over the calls (with a reply) on which both are integers. */
export function cacheShare(calls: readonly CallRecord[]): CacheShare {
  let num = 0;
  let den = 0;
  let counted = 0;
  let left = 0;
  for (const c of calls) {
    if (!hasReply(c)) continue;
    const t = c.usage?.inputTokensTotal;
    const r = c.usage?.cacheReadTokens;
    if (typeof t === 'number' && typeof r === 'number') {
      num += r;
      den += t;
      counted++;
    } else left++;
  }
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) throw new InputError('INVALID_ARGUMENT', [`the token counts of the calls add up past ${Number.MAX_SAFE_INTEGER} (2^53 - 1), which cannot be read exactly`]);
  return { share: den === 0 ? 'none' : { numerator: num, denominator: den, tenthsOfPercent: tenthsOfPercent(num, den) }, callsCounted: counted, callsLeftOut: left };
}

export type DrawsTogether = { together: number; apart: number; mixed: number; unknown: number; notRecorded: number; cases: number };
export type Spread = { minMs: number; maxMs: number; cases: number } | 'none';
export type Spreads = { bySendTime: Spread; bySubmissionTime: Spread; casesLeftOut: number };

/** The role whose calls stand for a draw: the judge's in a run with a judge, the system's otherwise. */
const primaryRole = (run: RunArtifact): Role => (run.identity.judgeDefinitionHash === NO_JUDGE ? 'system' : 'judge');

/** What the copies lines report, for a run that declares `drawsPerCopy`. */
export type WithinCopies = { one: number; split: number; unknown: number; notRecorded: number; copies: number };
export type CopiesRecord = { drawsPerCopy: number; together: DrawsTogether; within: WithinCopies; spreads: Spreads };

const NANOS_PER_MS = 1_000_000n;

type GroupState = 'not recorded' | 'unknown' | Set<string>;
type Grouped = { together: DrawsTogether; within: WithinCopies; spreads: Spreads };

/**
 * The one classifier of how a case's groups of draws went out, over each draw's resolved calls of the primary role.
 * A group is one draw (the draws lines) or one copy (the copies lines: a block of `k` draws in draw order).
 *
 * - A draw is not recorded (no calls, or no resolved call of the role), unknown (a call's submission is UNKNOWN), or
 *   known with its set of submissions; a call sent on its own is its own submission, shared with no other call.
 * - A group is not recorded if any of its draws is, else unknown if any is, else the union of their sets.
 * - A case with two or more groups in the file: all in one submission (every group's set is the same single one), each
 *   in its own (no submission shared between groups), mixed, unknown or not recorded.
 * - Within: every group in the file, one submission or split across more than one.
 * - Time between a case's groups: each group's earliest first-call send time (unknown if any of its draws' is), then the
 *   latest minus the earliest, in whole milliseconds, truncated; where a send time is not known, the same from the
 *   submission times of those calls; a case with neither is left out.
 */
function classifyGroups(run: RunArtifact, groupOf: (d: Draw) => number): Grouped {
  const role = primaryRole(run);
  const subs = new Map((run.conditions?.[role]?.submissions ?? []).map((s) => [s.id, s.submittedAt]));
  const byCase = new Map<string, Map<number, Draw[]>>();
  for (const d of run.draws) {
    const groups = byCase.get(d.caseId) ?? new Map<number, Draw[]>();
    const g = groupOf(d);
    groups.set(g, [...(groups.get(g) ?? []), d]);
    byCase.set(d.caseId, groups);
  }
  const together: DrawsTogether = { together: 0, apart: 0, mixed: 0, unknown: 0, notRecorded: 0, cases: 0 };
  const within: WithinCopies = { one: 0, split: 0, unknown: 0, notRecorded: 0, copies: 0 };
  const send: number[] = [];
  const sub: number[] = [];
  let left = 0;
  let alone = 0;
  const drawState = (d: Draw): GroupState => {
    const r = resolvedCalls(d);
    const calls = role === 'judge' ? r.judge : r.system;
    if (!r.recorded || calls.length === 0) return 'not recorded';
    if (calls.some((c) => c.submission === GAP)) return 'unknown';
    return new Set(calls.map((c) => c.submission ?? `\u0000alone${alone++}`));
  };
  const groupState = (draws: readonly Draw[]): GroupState => {
    const states = draws.map(drawState);
    if (states.includes('not recorded')) return 'not recorded';
    if (states.includes('unknown')) return 'unknown';
    return new Set((states as Set<string>[]).flatMap((x) => [...x]));
  };
  const firstCall = (d: Draw): CallRecord | undefined => {
    const r = resolvedCalls(d);
    return (role === 'judge' ? r.judge : r.system)[0];
  };
  const sendOf = (d: Draw): bigint | undefined => {
    const c = firstCall(d);
    return c === undefined ? undefined : timeNanos(c.sentAt);
  };
  const submittedOf = (d: Draw): bigint | undefined => {
    const c = firstCall(d);
    return c === undefined || c.submission === undefined || c.submission === GAP ? undefined : timeNanos(subs.get(c.submission));
  };
  // A group's time: the earliest of its draws' times, and not known when any of them is not known.
  const earliest = (draws: readonly Draw[], t: (d: Draw) => bigint | undefined): bigint | undefined => {
    let lo: bigint | undefined;
    for (const d of draws) {
      const x = t(d);
      if (x === undefined) return undefined;
      if (lo === undefined || x < lo) lo = x;
    }
    return lo;
  };
  const spreadMs = (ts: readonly bigint[]): number => {
    let lo = ts[0] as bigint;
    let hi = lo;
    for (const t of ts) {
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return Number((hi - lo) / NANOS_PER_MS);
  };
  for (const groupMap of byCase.values()) {
    const groups = [...groupMap.values()];
    const states = groups.map(groupState);
    for (const st of states) {
      within.copies++;
      if (st === 'not recorded') within.notRecorded++;
      else if (st === 'unknown') within.unknown++;
      else if (st.size === 1) within.one++;
      else within.split++;
    }
    if (groups.length < 2) continue;
    together.cases++;
    if (states.includes('not recorded')) together.notRecorded++;
    else if (states.includes('unknown')) together.unknown++;
    else {
      const ss = states as Set<string>[];
      const first = [...(ss[0] as Set<string>)];
      if (ss.every((x) => x.size === 1) && ss.every((x) => x.has(first[0] as string))) together.together++;
      else {
        const seen = new Set<string>();
        let disjoint = true;
        for (const x of ss) for (const y of x) (seen.has(y) ? (disjoint = false) : seen.add(y));
        if (disjoint) together.apart++;
        else together.mixed++;
      }
    }
    const sent = groups.map((g) => earliest(g, sendOf));
    if (sent.every((t) => t !== undefined)) {
      send.push(spreadMs(sent as bigint[]));
      continue;
    }
    const subTimes = groups.map((g) => earliest(g, submittedOf));
    if (subTimes.every((t) => t !== undefined)) sub.push(spreadMs(subTimes as bigint[]));
    else left++;
  }
  const range = (xs: readonly number[]): Spread => (xs.length === 0 ? 'none' : { minMs: xs.reduce((a, b) => Math.min(a, b)), maxMs: xs.reduce((a, b) => Math.max(a, b)), cases: xs.length });
  return { together, within, spreads: { bySendTime: range(send), bySubmissionTime: range(sub), casesLeftOut: left } };
}


/**
 * How the draws of each case with two or more draws went out: all in one submission, each in its own, mixed, unknown
 * (a submission not recorded), or not recorded (no calls). The grouped classifier with each draw as its own group.
 */
export function drawsTogether(run: RunArtifact): DrawsTogether {
  return classifyGroups(run, (d) => d.drawIndex).together;
}

/** The time between the draws of a case (the grouped classifier with each draw as its own group). */
export function drawSpreads(run: RunArtifact): Spreads {
  return classifyGroups(run, (d) => d.drawIndex).spreads;
}

/** The copies lines of a run that declares `drawsPerCopy`: copy n of a case is draws (n-1)k to nk-1. */
export function copiesRecord(run: RunArtifact): CopiesRecord | 'not declared' {
  const k = run.conditions?.drawsPerCopy;
  if (k === undefined) return 'not declared';
  const g = classifyGroups(run, (d) => Math.floor(d.drawIndex / k));
  return { drawsPerCopy: k, together: g.together, within: g.within, spreads: g.spreads };
}

export type RoleRecord = {
  role: Role;
  recorded: boolean;
  calls: number;
  servedModels: Tally;
  serving: { key: string; values: Tally }[];
  cache: CacheShare;
  concurrency: number | Gap | 'not recorded';
  submissions: { count: number; byKind: Tally; sizes: (number | Gap)[]; sharedWith: Tally; submittedFirst: string | 'none'; submittedLast: string | 'none' } | 'not recorded';
};

/** What one role of one run recorded, over each slot's resolved calls. */
export function roleRecord(run: RunArtifact, role: Role): RoleRecord {
  const calls = run.draws.flatMap((d) => resolvedCalls(d)[role]);
  const recorded = run.draws.some((d) => resolvedCalls(d).recorded) || run.conditions?.[role] !== undefined;
  const replied = calls.filter(hasReply);
  const keys = run.conditions?.[role]?.servingKeys ?? [];
  const rc = run.conditions?.[role];
  const times = (rc?.submissions ?? []).map((s) => s.submittedAt).filter((t) => t !== GAP).sort((x, y) => (timeNanos(x) as bigint) < (timeNanos(y) as bigint) ? -1 : 1);
  return {
    role,
    recorded,
    calls: calls.length,
    servedModels: tally(replied.map((c) => c.servedModel as string)),
    serving: keys.map((key) => ({ key, values: tally(replied.map((c) => (c.serving ?? {})[key] as string)) })),
    cache: cacheShare(calls),
    concurrency: rc === undefined ? 'not recorded' : rc.concurrency,
    submissions: rc === undefined
      ? 'not recorded'
      : {
          count: rc.submissions.length,
          byKind: tally(rc.submissions.map((s) => s.kind)),
          sizes: rc.submissions.map((s) => s.size),
          sharedWith: tally(rc.submissions.flatMap((s) => (s.sharedWith === GAP ? [GAP] : s.sharedWith))),
          submittedFirst: times[0] ?? 'none',
          submittedLast: times[times.length - 1] ?? 'none',
        },
  };
}

export type HashPairs = { pairs: number; equal: number; differ: number; unknown: number; unpairedFirst: number; unpairedSecond: number };

/** Request hashes of two runs, paired by slot, then by role and index within role on each slot's resolved calls; never matched by hash. */
export function requestHashPairs(a: RunArtifact, b: RunArtifact): HashPairs {
  const out: HashPairs = { pairs: 0, equal: 0, differ: 0, unknown: 0, unpairedFirst: 0, unpairedSecond: 0 };
  const mb = new Map(b.draws.map((d) => [keyOf(d), resolvedCalls(d)]));
  const seen = new Set<string>();
  for (const d of a.draws) {
    const k = keyOf(d);
    seen.add(k);
    const x = resolvedCalls(d);
    const y = mb.get(k);
    for (const role of ROLES) {
      const xs = x[role];
      const ys = y === undefined ? [] : y[role];
      const n = Math.min(xs.length, ys.length);
      for (let i = 0; i < n; i++) {
        out.pairs++;
        const h1 = (xs[i] as CallRecord).requestHash;
        const h2 = (ys[i] as CallRecord).requestHash;
        if (!isSha256Hex(h1) || !isSha256Hex(h2)) out.unknown++;
        else if (h1 === h2) out.equal++;
        else out.differ++;
      }
      out.unpairedFirst += xs.length - n;
      out.unpairedSecond += ys.length - n;
    }
  }
  for (const d of b.draws) {
    if (seen.has(keyOf(d))) continue;
    const y = resolvedCalls(d);
    out.unpairedSecond += y.judge.length + y.system.length;
  }
  return out;
}

export type IdentityRow = { field: IdentityField; first: string | number; second?: string | number; state?: DiffState };

export type ConditionsReport = {
  runs: 1 | 2;
  identity: IdentityRow[];
  route: { role: Role; endpoint: [string, string?]; harnessVersion: [string, string?] }[];
  callShapeKeys: { role: Role; keys: string[] }[];
  roles: { role: Role; first: RoleRecord; second?: RoleRecord; states?: { servedModels: DiffState; serving: { key: string; state: DiffState }[]; concurrency: DiffState } }[];
  draws: { first: { together: DrawsTogether; spreads: Spreads }; second?: { together: DrawsTogether; spreads: Spreads } };
  copies: { first: CopiesRecord | 'not declared'; second?: CopiesRecord | 'not declared' };
  requestHashes?: HashPairs;
};

const tallyKey = (t: Tally): string => t.map((x) => x.value).join('\u0000');
const setState = (x: RoleRecord, y: RoleRecord, a: Tally, b: Tally): DiffState => (!x.recorded || !y.recorded || a.length === 0 || b.length === 0 || a.some((v) => v.value === GAP) || b.some((v) => v.value === GAP) ? 'unknown' : tallyKey(a) === tallyKey(b) ? 'same' : 'differs');

/** What one run recorded, or two side by side. Pure; refuses nothing. */
export function conditionsReport(a: RunArtifact, b?: RunArtifact): ConditionsReport {
  const shapeOf = (r: RunArtifact, role: Role): CallShape | typeof NO_JUDGE => r.callShapes[role];
  const roles: Role[] = a.identity.judgeDefinitionHash === NO_JUDGE && (b === undefined || b.identity.judgeDefinitionHash === NO_JUDGE) ? ['system'] : ['system', 'judge'];
  const pair = <T>(f: (r: RunArtifact) => T): [T, T?] => (b === undefined ? [f(a)] : [f(a), f(b)]);
  const endpointOf = (r: RunArtifact, role: Role): string => {
    const s = shapeOf(r, role);
    return s === NO_JUDGE ? NO_JUDGE : String(s.endpoint);
  };
  return {
    runs: b === undefined ? 1 : 2,
    identity: IDENTITY_FIELDS.map((field) => ({
      field,
      first: a.identity[field],
      ...(b === undefined ? {} : { second: b.identity[field], state: diffState(a.identity[field], b.identity[field], JUDGE_FIELDS.includes(field)) }),
    })),
    route: roles.map((role) => ({
      role,
      endpoint: pair((r) => endpointOf(r, role)),
      harnessVersion: pair((r) => String(role === 'system' ? r.identity.systemHarnessVersion : r.identity.judgeHarnessVersion)),
    })),
    callShapeKeys: b === undefined ? [] : roles.flatMap((role) => {
      const x = shapeOf(a, role);
      const y = shapeOf(b, role);
      return x === NO_JUDGE || y === NO_JUDGE ? [] : [{ role, keys: callShapeDiff(x, y) }];
    }),
    roles: roles.map((role) => {
      const first = roleRecord(a, role);
      if (b === undefined) return { role, first };
      const second = roleRecord(b, role);
      const keys = [...new Set([...first.serving.map((s) => s.key), ...second.serving.map((s) => s.key)])].sort();
      const values = (r: RoleRecord, k: string): Tally => r.serving.find((s) => s.key === k)?.values ?? [];
      const conc = (r: RoleRecord): string | number => (r.concurrency === 'not recorded' ? GAP : r.concurrency);
      return {
        role,
        first,
        second,
        states: {
          servedModels: setState(first, second, first.servedModels, second.servedModels),
          serving: keys.map((key) => ({ key, state: setState(first, second, values(first, key), values(second, key)) })),
          concurrency: diffState(conc(first), conc(second)),
        },
      };
    }),
    draws: { first: { together: drawsTogether(a), spreads: drawSpreads(a) }, ...(b === undefined ? {} : { second: { together: drawsTogether(b), spreads: drawSpreads(b) } }) },
    copies: { first: copiesRecord(a), ...(b === undefined ? {} : { second: copiesRecord(b) }) },
    ...(b === undefined ? {} : { requestHashes: requestHashPairs(a, b) }),
  };
}
