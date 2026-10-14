import { InputError } from './errors.ts';
import { appendAll, findIllFormed, findUnhashable, GAP, hashOf, keySegment } from './identity.ts';
import type { Gap } from './identity.ts';
import { NA } from './stats.ts';
import type { Stat } from './stats.ts';
import { extraKeys, validateLabelSet } from './scoring.ts';
import type { Case, ClassSpec, FoldedCase, LabelSet } from './scoring.ts';

export type ClassBar = { minPassRate: number };

/** A case already known to fail. Annotation only: it still counts as a failure. */
export type KnownFailure = { caseId: string; since: string; note: string };

export type Bar = {
  classes: Readonly<Record<string, ClassBar>>;
  knownFailures?: readonly KnownFailure[];
};

/** The on-disk bar file: labels, per-class spec and bar, known failures. Hashed into the identity. */
export type BarFile = {
  labels: string[];
  classes: Record<string, ClassSpec & ClassBar>;
  knownFailures: KnownFailure[];
};

export type ClassResult = {
  klass: string;
  direction: ClassSpec['direction'];
  nonCompensable: boolean;
  passed: number;
  total: number;
  /** passed / total; UNKNOWN when a case of the class is missing (a rate over fewer cases is withheld); NA for an empty class. */
  rate: Stat | Gap;
  minPassRate: number;
  meetsBar: boolean;
  failedCaseIds: string[];
  /** Expected cases of this class with no folded result. */
  missingCaseIds: string[];
  /** Failures that are listed as known failures (still counted as failures). */
  knownFailureIds: string[];
  /** Listed known failures that now pass. */
  knownFailuresNowPassing: string[];
};

export type GateResult = {
  pass: boolean;
  classes: ClassResult[];
  missingCaseIds: string[];
  extraCaseIds: string[];
};

/** A case the gate expects a folded result for. */
export type ExpectedCase = Pick<Case, 'id' | 'klass'>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function parseBarFile(json: unknown): BarFile {
  if (!isRecord(json)) {
    throw new InputError('INVALID_BAR', ['bar: must be an object']);
  }
  const rec = json;
  const problems: string[] = extraKeys(rec, ['labels', 'classes', 'knownFailures'], 'bar');
  // Before anything is read or hashed, as for a run (runArtifactProblems): a caller that parsed the file itself may hand in
  // a value that has no canonical JSON (undefined, a bigint, a function, an object that is not plain, a number that is not
  // finite, a value that holds itself). barHash would throw a TypeError on it, and a walk of a value that holds itself has
  // no end. Such a bar is not read any further. A value read through parseJsonText is never one of these.
  const unhashable: string[] = [];
  findUnhashable(rec, 'bar', unhashable);
  if (unhashable.length > 0) throw new InputError('INVALID_BAR', [...problems, ...unhashable]);
  findIllFormed(rec, 'bar', problems);
  appendAll(problems, validateLabelSet(rec['labels'] as LabelSet).map((p) => `bar.${p}`));
  const classes = rec['classes'];
  if (!isRecord(classes) || Object.keys(classes).length === 0) {
    problems.push('bar.classes: must be a non-empty object');
  } else {
    for (const [name, spec] of Object.entries(classes)) {
      // A class name is a key of the file, so it is written into a message as any key is: escaped when it is not text.
      const at = `bar.classes.${name === '' ? '""' : keySegment(name)}`;
      if (name === '') problems.push(`${at}: the class name must be a non-empty string`);
      if (!isRecord(spec)) {
        problems.push(`${at}: must be an object`);
        continue;
      }
      appendAll(problems, extraKeys(spec, ['direction', 'nonCompensable', 'minPassRate'], at));
      if (spec['direction'] !== 'floor' && spec['direction'] !== 'ceiling') problems.push(`${at}.direction: must be "floor" or "ceiling"`);
      if (spec['nonCompensable'] !== undefined && typeof spec['nonCompensable'] !== 'boolean') {
        problems.push(`${at}.nonCompensable: must be a boolean`);
      }
      const r = spec['minPassRate'];
      if (typeof r !== 'number' || !(r >= 0 && r <= 1)) problems.push(`${at}.minPassRate: must be a number in [0, 1]`);
    }
  }
  const kf = rec['knownFailures'];
  if (kf === undefined) {
    problems.push('bar.knownFailures: required (write [] for none)');
  } else if (!Array.isArray(kf)) {
    problems.push('bar.knownFailures: must be an array');
  } else {
    const first = new Map<string, number>();
    kf.forEach((k: unknown, i) => {
      const at = `bar.knownFailures[${i}]`;
      if (!isRecord(k)) {
        problems.push(`${at}: must be an object { caseId, since, note }`);
        return;
      }
      // Exactly these three keys: an entry is an annotation, and a key the library does not read (a waiver, an end date)
      // would enter the bar's hash and state something no gate honours.
      appendAll(problems, extraKeys(k, ['caseId', 'since', 'note'], at));
      const id = k['caseId'];
      if (typeof id !== 'string' || id === '') problems.push(`${at}.caseId: must be a non-empty string`);
      else if (first.has(id)) problems.push(`${at}.caseId: duplicate ${JSON.stringify(id)} (also bar.knownFailures[${first.get(id)}]); a case is listed once`);
      else first.set(id, i);
      if (typeof k['since'] !== 'string' || !isValidDate(k['since'])) problems.push(`${at}.since: must be a YYYY-MM-DD date`);
      if (typeof k['note'] !== 'string' || k['note'] === '') problems.push(`${at}.note: must be a non-empty string`);
    });
  }
  if (problems.length > 0) throw new InputError('INVALID_BAR', problems);
  return { labels: rec['labels'] as string[], classes: classes as BarFile['classes'], knownFailures: kf as KnownFailure[] };
}

/** The value recorded as `RunIdentity.barHash`. */
export function barHash(bar: BarFile): string {
  return hashOf(bar);
}

export function splitBarFile(file: BarFile): { labels: LabelSet; classes: Record<string, ClassSpec>; bar: Bar } {
  // Object.fromEntries defines each class as the record's own property. An assignment (classes[name] = spec) would, for a
  // class named "__proto__", set the record's prototype and leave the class out, and an empty class would no longer fail the gate.
  const entries = Object.entries(file.classes);
  const classes: Record<string, ClassSpec> = Object.fromEntries(
    entries.map(([name, c]): [string, ClassSpec] => [name, c.nonCompensable === undefined ? { direction: c.direction } : { direction: c.direction, nonCompensable: c.nonCompensable }]),
  );
  const bars: Record<string, ClassBar> = Object.fromEntries(entries.map(([name, c]): [string, ClassBar] => [name, { minPassRate: c.minPassRate }]));
  return { labels: file.labels, classes, bar: { classes: bars, knownFailures: file.knownFailures } };
}

/**
 * Checks folded cases against per-class bars. Known failures are reported but still count as
 * failures; a non-compensable class fails on any single failure; an empty class fails; any expected
 * case without a folded result fails its class and the gate, and withholds its class's rate.
 */
export function evaluate(
  folded: readonly FoldedCase[],
  bar: Bar,
  classes: Readonly<Record<string, ClassSpec>>,
  expectedCases: readonly ExpectedCase[],
): GateResult {
  const unknown = folded.filter((f) => !Object.hasOwn(classes, f.klass) || !Object.hasOwn(bar.classes, f.klass));
  if (unknown.length > 0) {
    throw new InputError('UNKNOWN_CLASS', unknown.map((f) => `case "${f.caseId}": class "${f.klass}" has no spec or bar`));
  }
  const known = new Set((bar.knownFailures ?? []).map((k) => k.caseId));
  const seen = new Set(folded.map((f) => f.caseId));
  const results: ClassResult[] = [];
  for (const [klass, spec] of Object.entries(classes)) {
    // Own properties only: a class named "toString" with no bar would otherwise read Object.prototype.toString as its bar.
    const classBar = Object.hasOwn(bar.classes, klass) ? bar.classes[klass] : undefined;
    if (classBar === undefined) throw new InputError('UNKNOWN_CLASS', [`class "${klass}" has no bar`]);
    const inClass = folded.filter((f) => f.klass === klass);
    const failed = inClass.filter((f) => !f.pass).map((f) => f.caseId);
    const passed = inClass.length - failed.length;
    const total = inClass.length;
    const missing = expectedCases.filter((e) => e.klass === klass && !seen.has(e.id)).map((e) => e.id);
    const measured = total === 0 ? NA : passed / total;
    const nonCompensable = spec.nonCompensable === true;
    const meetsBar = missing.length === 0 && measured !== NA && measured >= classBar.minPassRate && !(nonCompensable && failed.length > 0);
    results.push({
      klass,
      direction: spec.direction,
      nonCompensable,
      passed,
      total,
      rate: missing.length > 0 ? GAP : measured,
      minPassRate: classBar.minPassRate,
      meetsBar,
      failedCaseIds: failed,
      missingCaseIds: missing,
      knownFailureIds: failed.filter((id) => known.has(id)),
      knownFailuresNowPassing: inClass.filter((f) => f.pass && known.has(f.caseId)).map((f) => f.caseId),
    });
  }
  const expected = new Set(expectedCases.map((e) => e.id));
  const missingCaseIds = expectedCases.filter((e) => !seen.has(e.id)).map((e) => e.id);
  const extraCaseIds = folded.map((f) => f.caseId).filter((id) => !expected.has(id));
  return {
    pass: missingCaseIds.length === 0 && results.every((r) => r.meetsBar),
    classes: results,
    missingCaseIds,
    extraCaseIds,
  };
}
