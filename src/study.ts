import { InputError } from './errors.ts';
import { appendAll, findIllFormed, findNulls, hashOf, isSha256Hex } from './identity.ts';
import { JUDGE_CHANGE_FILE_ROLES } from './judgechange.ts';
import { extraKeys } from './scoring.ts';

/**
 * A study manifest: the inputs of one published judge-change
 * measurement by hash, and the cells a later version of the library must still recompute. It lives
 * with the study's data. A later version that no longer matches says so; it does not rewrite the
 * expected values. The cell list's hash sits in the manifest itself, so it detects an edit to the
 * list only against a copy of that hash kept elsewhere (a registration, a DOI deposit). Internal to
 * the release tooling; nothing here is re-exported from index.ts.
 */
export const STUDY_SCHEMA = 'anchorset.study/v1';
export const STUDY_ROLES = [...JUDGE_CHANGE_FILE_ROLES, 'converter'] as const;
export type StudyRole = (typeof STUDY_ROLES)[number];
/** The data's DOI, or this marker for a study that is not released. */
export const NOT_RELEASED = 'NOT_RELEASED';

/**
 * Why a manifest path is not portable; empty when it is. A manifest travels with its data to other
 * machines, so a path is written one way everywhere: relative to the manifest, with "/" between its
 * parts, and inside the manifest's folder. Refused: a backslash, a drive prefix ("C:"), an absolute
 * path, an empty component ("a//b", a trailing "/"), and a "." or ".." component.
 */
export function studyPathProblems(path: string): string[] {
  const why: string[] = [];
  if (path.includes('\\')) why.push('holds a backslash');
  if (/^[A-Za-z]:/.test(path)) why.push('starts with a drive prefix');
  if (path.startsWith('/')) why.push('is absolute');
  const parts = path.split('/');
  // The leading empty component of an absolute path is already named.
  if (parts.slice(path.startsWith('/') ? 1 : 0).includes('')) why.push('has an empty component');
  if (parts.includes('.') || parts.includes('..')) why.push('has a "." or ".." component');
  return why;
}

/**
 * The name a file of the manifest carries into the measurement: its own name, without its folder, as
 * `anchorset judge-change --inputs <dir>` names it. The report holds these names, so its hash is one
 * quantity whichever tool computed it. Defined for a portable path only (studyPathProblems): there
 * the last "/"-separated part is the file's name on every platform.
 */
export const studyInputName = (path: string): string => path.split('/').at(-1) as string;

export type StudyCell = {
  /** What the cell is called where it was published, for example "Table 1, step 1, SD_B". */
  name: string;
  /** JSON Pointer (RFC 6901) to a number in the report. */
  path: string;
  /** The published value is the report's number times this: 1, or 100 for a share printed in points. */
  scale: number;
  /** Decimal places as printed. */
  precision: number;
  /** The value as printed. */
  expected: string;
};

export type StudyManifest = {
  schema: typeof STUDY_SCHEMA;
  study: string;
  dataDoi: string;
  /** The library that first recomputed the cells, frozen before that run. */
  library: { name: string; version: string; commit: string };
  contracts: { run: string; plan: string; manifest: typeof STUDY_SCHEMA };
  /** Every file by path (POSIX-relative to the manifest, see studyPathProblems), role and sha256. Exactly one plan and one bar, and no two files of one name. */
  inputs: { path: string; role: StudyRole; sha256: string }[];
  cells: StudyCell[];
  /** hashOf(cells): the cell list as it stood before the first run. */
  cellsSha256: string;
  /** Published cells this library does not compute, each with the reason. */
  excluded: { name: string; reason: string }[];
  firstRun: { date: string; commit: string; resultSha256: string; outcome: string };
  /** The last library version that recomputed every cell. */
  lastVerified: { version: string; commit: string; date: string };
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x !== '';

/** Every problem with a candidate manifest; empty when valid. */
export function studyManifestProblems(json: unknown): string[] {
  if (!isObj(json)) return ['manifest: must be an object'];
  const problems = extraKeys(json, ['schema', 'study', 'dataDoi', 'library', 'contracts', 'inputs', 'cells', 'cellsSha256', 'excluded', 'firstRun', 'lastVerified'], 'manifest');
  findNulls(json, 'manifest', problems);
  findIllFormed(json, 'manifest', problems);
  if (json['schema'] !== STUDY_SCHEMA) problems.push(`manifest.schema: must be "${STUDY_SCHEMA}"`);
  for (const k of ['study', 'dataDoi']) if (!isText(json[k])) problems.push(`manifest.${k}: must be a non-empty string${k === 'dataDoi' ? ` ("${NOT_RELEASED}" for a study that is not released)` : ''}`);
  const record = (k: string, keys: readonly string[]): void => {
    const r = json[k];
    if (!isObj(r)) problems.push(`manifest.${k}: must be { ${keys.join(', ')} }`);
    else {
      appendAll(problems, extraKeys(r, keys, `manifest.${k}`));
      for (const f of keys) if (!isText(r[f])) problems.push(`manifest.${k}.${f}: must be a non-empty string`);
    }
  };
  record('library', ['name', 'version', 'commit']);
  record('contracts', ['run', 'plan', 'manifest']);
  record('firstRun', ['date', 'commit', 'resultSha256', 'outcome']);
  // The first run's report is named by its hash, so that a later run can be told apart from it.
  if (isObj(json['firstRun']) && !isSha256Hex(json['firstRun']['resultSha256'])) problems.push('manifest.firstRun.resultSha256: must be the full sha256 of the first run\'s report');
  record('lastVerified', ['version', 'commit', 'date']);
  const inputs = json['inputs'];
  if (!Array.isArray(inputs) || inputs.length === 0) problems.push('manifest.inputs: must be a non-empty list');
  else {
    const paths = new Set<string>();
    const names = new Map<string, string>();
    inputs.forEach((f: unknown, i) => {
      const at = `manifest.inputs[${i}]`;
      if (!isObj(f)) return void problems.push(`${at}: must be { path, role, sha256 }`);
      appendAll(problems, extraKeys(f, ['path', 'role', 'sha256'], at));
      const unportable = isText(f['path']) ? studyPathProblems(f['path']) : ['is not a non-empty string'];
      if (!isText(f['path']) || unportable.length > 0) problems.push(`${at}.path: must be a path relative to the manifest, inside its folder, written with "/" between its parts; this one ${unportable.join(', ')}`);
      else if (paths.has(f['path'])) problems.push(`${at}.path: listed twice`);
      else {
        paths.add(f['path']);
        // The report names a file without its folder, so two files of one name could not be told apart in it.
        const name = studyInputName(f['path']);
        const twin = names.get(name);
        if (twin !== undefined) problems.push(`${at}.path: the same file name as ${twin} ("${name}"); every file of a manifest has its own name`);
        else names.set(name, f['path']);
      }
      if (!(STUDY_ROLES as readonly unknown[]).includes(f['role'])) problems.push(`${at}.role: must be one of ${STUDY_ROLES.join(', ')}`);
      if (!isSha256Hex(f['sha256'])) problems.push(`${at}.sha256: must be the full sha256 of the file`);
    });
    for (const role of ['plan', 'bar']) {
      const n = inputs.filter((f: unknown) => isObj(f) && f['role'] === role).length;
      if (n !== 1) problems.push(`manifest.inputs: exactly one file with role "${role}", found ${n}`);
    }
  }
  const cells = json['cells'];
  if (!Array.isArray(cells) || cells.length === 0) problems.push('manifest.cells: must be a non-empty list');
  else {
    const before = problems.length;
    cells.forEach((c: unknown, i) => {
      const at = `manifest.cells[${i}]`;
      if (!isObj(c)) return void problems.push(`${at}: must be { name, path, scale, precision, expected }`);
      appendAll(problems, extraKeys(c, ['name', 'path', 'scale', 'precision', 'expected'], at));
      if (!isText(c['name'])) problems.push(`${at}.name: must be a non-empty string`);
      if (!isText(c['path']) || !c['path'].startsWith('/')) problems.push(`${at}.path: must be a JSON Pointer starting with "/"`);
      if (c['scale'] !== 1 && c['scale'] !== 100) problems.push(`${at}.scale: must be 1 or 100`);
      if (!Number.isInteger(c['precision']) || (c['precision'] as number) < 0 || (c['precision'] as number) > 15) problems.push(`${at}.precision: must be an integer from 0 to 15`);
      if (typeof c['expected'] !== 'string' || !/^-?\d+(\.\d+)?$/.test(c['expected'])) problems.push(`${at}.expected: must be the number as printed, for example "-0.93"`);
      else if (Number.isInteger(c['precision']) && (c['expected'].split('.')[1] ?? '').length !== c['precision']) problems.push(`${at}.expected: must have exactly ${String(c['precision'])} decimal place(s)`);
    });
    // Whenever the cells themselves are valid, whatever else is wrong with the manifest: a changed cell list is never left unsaid.
    if (problems.length === before && json['cellsSha256'] !== hashOf(cells)) problems.push(`manifest.cellsSha256: declared ${String(json['cellsSha256'])}, but the cell list hashes to ${hashOf(cells)}`);
  }
  if (!isSha256Hex(json['cellsSha256'])) problems.push('manifest.cellsSha256: must be a full sha256');
  const excluded = json['excluded'];
  if (!Array.isArray(excluded) || !excluded.every((x) => isObj(x) && isText(x['name']) && isText(x['reason']) && Object.keys(x).length === 2)) problems.push('manifest.excluded: must be a list of { name, reason }');
  return problems;
}

export function parseStudyManifest(json: unknown): StudyManifest {
  const problems = studyManifestProblems(json);
  if (problems.length > 0) throw new InputError('INVALID_ARTIFACT', problems);
  return json as StudyManifest;
}

/** The value a JSON Pointer names in `doc`, or undefined when a step of the path is missing. */
export function atPointer(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) cur = /^\d+$/.test(key) ? cur[Number(key)] : undefined;
    else if (isObj(cur)) cur = Object.hasOwn(cur, key) ? cur[key] : undefined;
    else return undefined;
  }
  return cur;
}

/** A number as a table prints it: scaled, to a fixed number of decimals, with no negative zero. */
export function printed(value: number, scale: number, precision: number): string {
  const s = (value * scale).toFixed(precision);
  return Number(s) === 0 ? s.replace('-', '') : s;
}

export type CellMismatch = { name: string; path: string; expected: string; got: string };

/** Every cell of the manifest against a report. A cell that is missing or is not a number is a mismatch, never skipped. */
export function checkStudyCells(manifest: StudyManifest, report: unknown): { matched: number; mismatches: CellMismatch[] } {
  const mismatches: CellMismatch[] = [];
  for (const c of manifest.cells) {
    const v = atPointer(report, c.path);
    const got = typeof v === 'number' && Number.isFinite(v) ? printed(v, c.scale, c.precision) : v === undefined ? 'missing' : `not a number (${JSON.stringify(v)?.slice(0, 40)})`;
    if (got !== c.expected) mismatches.push({ name: c.name, path: c.path, expected: c.expected, got });
  }
  return { matched: manifest.cells.length - mismatches.length, mismatches };
}
