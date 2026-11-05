import { InputError } from './errors.ts';
import { appendAll, canonicalJson, findInexactIntegers, findNulls, GAP, hashOf, integerProblem, readsAsGap } from './identity.ts';
import type { Gap } from './identity.ts';

export const CALL_SHAPE_SCHEMA = 'anchorset.callshape/v1';

/**
 * A knob the harness did not send. It is a known value: it records the request, not the provider's
 * effective default. A default that changes under the same served model id is invisible to the hash:
 * on the judge's side the anchor set catches it as drift; on the system's side it reads as system
 * movement.
 */
export const NOT_SENT = 'NOT_SENT';
export type NotSent = typeof NOT_SENT;
type Knob<T> = T | NotSent | Gap;

export const THINKING_MODES = Object.freeze(['off', 'adaptive', 'budgeted', 'between-tools'] as const);
export const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const);
export const TOOL_CHOICES = Object.freeze(['none', 'auto', 'any', 'named'] as const);
export const CONTEXT_POLICIES = Object.freeze(['none', 'truncate-head', 'truncate-tail', 'compact'] as const);

/** Names the output the call must produce. Its schema belongs to the tools hash, never to the call shape. */
export type ResponseFormat = { kind: 'text' } | { kind: 'tool'; name: string } | { kind: 'json-schema'; name: string };

/**
 * Everything that shapes one model call for one role, apart from the prompt and the tools, which are
 * identity fields of their own. The values are what the caller requested; they are not proof of what ran.
 */
export type CallShape = {
  schema: typeof CALL_SHAPE_SCHEMA;
  endpoint: string | Gap;
  apiVersion: Knob<string>;
  betaFlags: Knob<string[]>;
  thinkingMode: Knob<(typeof THINKING_MODES)[number]>;
  thinkingBudgetTokens: Knob<number>;
  effort: Knob<(typeof EFFORTS)[number]>;
  toolChoice: Knob<(typeof TOOL_CHOICES)[number]>;
  toolChoiceName: Knob<string>;
  strictTools: Knob<boolean>;
  parallelToolUse: Knob<boolean>;
  temperature: Knob<number>;
  topP: Knob<number>;
  topK: Knob<number>;
  frequencyPenalty: Knob<number>;
  presencePenalty: Knob<number>;
  /** The provider-side sampling seed, not the run seed in the identity. */
  samplingSeed: Knob<number>;
  maxOutputTokens: Knob<number>;
  stopSequences: Knob<string[]>;
  responseFormat: Knob<ResponseFormat>;
  /** How long inputs are truncated or compacted before the call. */
  contextPolicy: Knob<(typeof CONTEXT_POLICIES)[number]>;
  stream: Knob<boolean>;
  /** The harness deadline per call, in milliseconds. */
  timeoutMs: Knob<number>;
  /** Provider-specific knobs keyed "namespace.name", or GAP when the harness cannot list them. */
  extras: Record<string, unknown> | Gap;
};

type NamedKey = Exclude<keyof CallShape, 'schema' | 'extras'>;
type Check = (v: unknown) => string | undefined;

const TOKEN_RE = /^[a-z0-9][a-z0-9._-]*$/;
const EXTRAS_KEY_RE = /^[a-z0-9_]+(\.[A-Za-z0-9_-]+)+$/;
const norm = (s: string): string => s.toLowerCase().replace(/[-_ ./]/g, '');

const oneOf = (allowed: readonly string[]): Check => (v) => (typeof v === 'string' && allowed.includes(v) ? undefined : `must be one of ${allowed.join(', ')}`);
/** A free-text value: non-empty, and never a spelling of "unknown" or "not sent". */
const text: Check = (v) => {
  if (typeof v !== 'string' || v.trim() === '') return 'must be a non-empty string';
  return readsAsGap(v) ? `"${v}" reads as a gap; use "${GAP}" or "${NOT_SENT}"` : undefined;
};
const bool: Check = (v) => (typeof v === 'boolean' ? undefined : 'must be a boolean');
const range = (lo: number, hi: number): Check => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? undefined : `must be a number in [${lo}, ${hi}]`);
const finite: Check = (v) => (typeof v === 'number' && Number.isFinite(v) ? undefined : 'must be a finite number');
// Safe integers only: a larger one cannot be read exactly, and two different call shapes would hash as one.
const posInt: Check = (v) => (Number.isSafeInteger(v) && (v as number) > 0 ? undefined : integerProblem(v, 'must be a positive integer'));
const int: Check = (v) => (Number.isSafeInteger(v) ? undefined : integerProblem(v, 'must be an integer'));
/** An array of items, sorted and unique. A GAP element is allowed (the hash becomes UNKNOWN, so order is moot). */
const sortedUnique = (item: Check, what: string): Check => (v) => {
  if (!Array.isArray(v)) return `must be an array of ${what}`;
  const known = v.filter((x) => x !== GAP);
  if (known.some((x) => item(x) !== undefined)) return `must be an array of ${what}`;
  if (known.length < v.length) return undefined;
  return v.every((x, i) => i === 0 || (v[i - 1] as string) < (x as string)) ? undefined : 'must be sorted and unique';
};
const token: Check = (v) => (typeof v === 'string' && TOKEN_RE.test(v) ? undefined : 'must be a lowercase token');
const nonEmpty: Check = (v) => (typeof v === 'string' && v.length > 0 ? undefined : 'must be a non-empty string');
const responseFormat: Check = (v) => {
  const r = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const keys = r === undefined ? [] : Object.keys(r).sort().join();
  if (r?.['kind'] === 'text' && keys === 'kind') return undefined;
  if ((r?.['kind'] === 'tool' || r?.['kind'] === 'json-schema') && keys === 'kind,name') {
    const why = r['name'] === GAP ? undefined : text(r['name']);
    return why === undefined ? undefined : `name ${why}`;
  }
  return 'must be { kind: "text" }, { kind: "tool", name } or { kind: "json-schema", name }';
};

const KEYS: Readonly<Record<NamedKey, Check>> = {
  endpoint: text,
  apiVersion: text,
  betaFlags: sortedUnique(token, 'lowercase tokens'),
  thinkingMode: oneOf(THINKING_MODES),
  thinkingBudgetTokens: posInt,
  effort: oneOf(EFFORTS),
  toolChoice: oneOf(TOOL_CHOICES),
  toolChoiceName: text,
  strictTools: bool,
  parallelToolUse: bool,
  temperature: range(0, 2),
  topP: range(0, 1),
  topK: posInt,
  frequencyPenalty: finite,
  presencePenalty: finite,
  samplingSeed: int,
  maxOutputTokens: posInt,
  stopSequences: sortedUnique(nonEmpty, 'non-empty strings'),
  responseFormat,
  contextPolicy: oneOf(CONTEXT_POLICIES),
  stream: bool,
  timeoutMs: posInt,
};

/** Every key of a call shape but `schema`, in the schema's order: the named keys, then `extras`. Internal: not re-exported from index.ts. */
export const CALL_SHAPE_FIELDS: readonly string[] = Object.freeze([...Object.keys(KEYS), 'extras']);

/** Wire spellings of each named key, compared after lowercasing and dropping "-", "_", "." and spaces. */
const ALIASES: Readonly<Record<NamedKey | 'schema' | 'extras', readonly string[]>> = {
  schema: ['schema'],
  extras: ['extras'],
  endpoint: ['endpoint', 'url', 'base_url'],
  apiVersion: ['api_version', 'anthropic_version'],
  betaFlags: ['beta_flags', 'betas', 'beta', 'anthropic_beta'],
  thinkingMode: ['thinking_mode', 'thinking', 'reasoning', 'reasoning_mode'],
  thinkingBudgetTokens: ['thinking_budget_tokens', 'budget_tokens', 'thinking_budget', 'reasoning_budget', 'reasoning_tokens'],
  effort: ['effort', 'reasoning_effort'],
  toolChoice: ['tool_choice', 'tool_mode', 'function_call'],
  toolChoiceName: ['tool_choice_name'],
  strictTools: ['strict_tools', 'strict'],
  parallelToolUse: ['parallel_tool_use', 'parallel_tool_calls', 'disable_parallel_tool_use'],
  temperature: ['temperature', 'temp'],
  topP: ['top_p', 'nucleus'],
  topK: ['top_k'],
  frequencyPenalty: ['frequency_penalty'],
  presencePenalty: ['presence_penalty'],
  samplingSeed: ['sampling_seed', 'seed', 'random_seed'],
  maxOutputTokens: ['max_output_tokens', 'max_tokens', 'max_completion_tokens', 'max_new_tokens', 'max_tokens_to_sample'],
  stopSequences: ['stop_sequences', 'stop', 'stop_sequence'],
  responseFormat: ['response_format', 'output_format', 'response_schema'],
  contextPolicy: ['context_policy', 'context_management', 'truncation', 'compaction'],
  stream: ['stream', 'streaming'],
  timeoutMs: ['timeout_ms', 'timeout', 'deadline', 'deadline_ms'],
};
const SHADOWED = new Map<string, string>(Object.entries(ALIASES).flatMap(([key, spellings]) => spellings.map((s): [string, string] => [norm(s), key])));

/** True when GAP appears anywhere in the value, at any depth. Internal: not re-exported from index.ts. */
export function containsGap(v: unknown): boolean {
  if (v === GAP) return true;
  if (Array.isArray(v)) return v.some(containsGap);
  if (typeof v === 'object' && v !== null) return Object.values(v).some(containsGap);
  return false;
}

/** Every object key at any depth of `v` that spells a named key, as "path: key". */
function shadowingKeys(v: unknown, path: string, out: string[]): void {
  if (Array.isArray(v)) v.forEach((x, i) => shadowingKeys(x, `${path}[${i}]`, out));
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      const hit = SHADOWED.get(norm(k));
      if (hit !== undefined) out.push(`${path}.${k}: shadows the named key ${hit}; use the named key`);
      shadowingKeys(x, `${path}.${k}`, out);
    }
  }
}

function extrasProblems(extras: unknown, at: string): string[] {
  if (extras === GAP) return [];
  if (typeof extras !== 'object' || extras === null || Array.isArray(extras)) return [`${at}: must be an object ({} for none) or "${GAP}"`];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(extras as Record<string, unknown>)) {
    const kAt = `${at}.${k}`;
    if (!EXTRAS_KEY_RE.test(k)) {
      problems.push(`${kAt}: key must be "namespace.name"`);
      continue;
    }
    const hit = k.split('.').slice(1).map((seg) => SHADOWED.get(norm(seg))).find((x) => x !== undefined);
    if (hit !== undefined) problems.push(`${kAt}: shadows the named key ${hit}; use the named key`);
    shadowingKeys(v, kAt, problems);
    findNulls(v, kAt, problems);
    findInexactIntegers(v, kAt, problems);
    try {
      canonicalJson(v);
    } catch (e) {
      problems.push(`${kAt}: ${(e as Error).message}`);
    }
  }
  return problems;
}

/** Every problem with a candidate call shape; empty when valid. A GAP at any depth of a key is accepted. */
export function validateCallShape(x: unknown, prefix = 'callShape'): string[] {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return [`${prefix}: must be an object`];
  const r = x as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(r)) {
    if (k !== 'schema' && k !== 'extras' && !Object.hasOwn(KEYS, k)) problems.push(`${prefix}.${k}: unknown field`);
  }
  if (r['schema'] !== CALL_SHAPE_SCHEMA) problems.push(`${prefix}.schema: must be "${CALL_SHAPE_SCHEMA}"`);
  for (const [k, check] of Object.entries(KEYS) as [NamedKey, Check][]) {
    const v = r[k];
    if (v === undefined) problems.push(`${prefix}.${k}: missing (use "${NOT_SENT}" or "${GAP}")`);
    else if (v === null) problems.push(`${prefix}.${k}: null is not allowed`);
    else if (v === NOT_SENT && k === 'endpoint') problems.push(`${prefix}.endpoint: a call always has an endpoint; use a value or "${GAP}"`);
    else if (v !== NOT_SENT && v !== GAP) {
      // A gap inside a value leaves its grammar and the null check on; each check accepts GAP leaves.
      const nulls: string[] = [];
      findNulls(v, `${prefix}.${k}`, nulls);
      appendAll(problems, nulls);
      const why = nulls.length === 0 ? check(v) : undefined;
      if (why !== undefined) problems.push(`${prefix}.${k}: ${why}`);
    }
  }
  const known = (k: NamedKey): boolean => r[k] !== undefined && r[k] !== GAP;
  if (known('thinkingMode') && known('thinkingBudgetTokens')) {
    const budgeted = r['thinkingMode'] === 'budgeted';
    const sent = r['thinkingBudgetTokens'] !== NOT_SENT;
    if (budgeted && !sent) problems.push(`${prefix}.thinkingBudgetTokens: required when thinkingMode is "budgeted"`);
    if (!budgeted && sent) problems.push(`${prefix}.thinkingBudgetTokens: must be "${NOT_SENT}" unless thinkingMode is "budgeted"`);
  }
  if (known('toolChoice') && known('toolChoiceName')) {
    const named = r['toolChoice'] === 'named';
    const sent = r['toolChoiceName'] !== NOT_SENT;
    if (named && !sent) problems.push(`${prefix}.toolChoiceName: required when toolChoice is "named"`);
    if (!named && sent) problems.push(`${prefix}.toolChoiceName: must be "${NOT_SENT}" unless toolChoice is "named"`);
  }
  if (r['extras'] === undefined) problems.push(`${prefix}.extras: missing (use {} for none, or "${GAP}")`);
  else appendAll(problems, extrasProblems(r['extras'], `${prefix}.extras`));
  return problems;
}

/**
 * The value recorded as `systemCallShapeHash` / `judgeCallShapeHash`: the sha256 of the shape's
 * canonical JSON, or GAP when a gap appears anywhere in it, so an unknown knob never compares equal
 * to itself. Throws InputError('INVALID_CALL_SHAPE') listing every problem.
 */
export function callShapeHash(shape: CallShape, prefix = 'callShape'): string | Gap {
  const problems = validateCallShape(shape, prefix);
  if (problems.length > 0) throw new InputError('INVALID_CALL_SHAPE', problems);
  return containsGap(shape) ? GAP : hashOf(shape);
}

/**
 * The keys two call shapes disagree on ("temperature 0 -> 0.3"), and the keys that are unknown on
 * either side ("effort unknown"), so a refusal can say what moved rather than only that a hash did.
 */
export function callShapeDiff(a: CallShape, b: CallShape): string[] {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) {
    const x = ra[k] === undefined ? 'missing' : canonicalJson(ra[k]);
    const y = rb[k] === undefined ? 'missing' : canonicalJson(rb[k]);
    if (x !== y) out.push(`${k} ${x} -> ${y}`);
    else if (containsGap(ra[k])) out.push(`${k} unknown`);
  }
  return out;
}
