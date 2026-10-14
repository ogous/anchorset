import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as api from '../src/index.ts';

test('TOOL_VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(api.TOOL_VERSION, pkg.version);
});

/** The exact public surface, in `test/public-api.json`. Adding or removing an export is a change to that file, in the same commit, and a semver event. */
const pinned = JSON.parse(readFileSync(join(import.meta.dirname, 'public-api.json'), 'utf8')) as { values: string[]; types: string[] };

/**
 * Every type name that an index source exports, read from its text. The only statement form allowed is
 * `export { ... } from '...'` or `export type { ... } from '...'`; inside either brace, an item is a type
 * when the statement is `export type` or the item carries an inline `type ` modifier. A renaming (`a as b`),
 * a star export and any other form are refused, so that no export can sit outside the pin.
 */
function exportedTypes(source: string): string[] {
  const statements = source.split(';').map((x) => x.trim()).filter((x) => x !== '');
  assert.ok(statements.length > 0);
  const types: string[] = [];
  for (const st of statements) {
    const m = /^export (type )?\{([^}]*)\} from '[^']+'$/.exec(st);
    assert.ok(m !== null, `an export form the pin does not read: ${st.slice(0, 60)}`);
    for (const raw of (m[2] as string).split(',').map((x) => x.trim()).filter((x) => x !== '')) {
      assert.ok(!/\bas\b/.test(raw), `a renamed export is not read by the pin: ${raw}`);
      const inline = /^type\s+(\S+)$/.exec(raw);
      if (m[1] !== undefined || inline !== null) types.push(inline === null ? raw : (inline[1] as string));
    }
  }
  return types;
}

test('the public API is exactly the pinned list of values', () => {
  assert.deepEqual(Object.keys(api).sort(), pinned.values);
  assert.deepEqual([...pinned.values].sort(), pinned.values, 'the pin is kept sorted');
});

test('the public API is exactly the pinned list of types', () => {
  const types = exportedTypes(readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8'));
  assert.equal(new Set(types).size, types.length, 'no type is exported twice');
  assert.deepEqual(types.sort(), pinned.types);
  assert.deepEqual([...pinned.types].sort(), pinned.types, 'the pin is kept sorted');
});

test('a type exported through the value brace, with an inline type modifier, is read by the type pin', () => {
  // The escape this test closes: appending this line to the index left every test green and the type unpinned.
  const escaped = `export type { A } from './a.ts';\nexport { type CutFit, B } from './cutmap.ts';`;
  assert.deepEqual(exportedTypes(escaped), ['A', 'CutFit']);
  assert.throws(() => exportedTypes(`export { B as C } from './b.ts';`), /renamed export/);
  assert.throws(() => exportedTypes(`export * from './b.ts';`), /export form the pin does not read/);
  assert.throws(() => exportedTypes(`export type { A as B } from './b.ts';`), /renamed export/);
});

test('the gate entry points are exported, and the old makeRecord, which took an identity apart from its inputs, is not', () => {
  // gateExitCode takes the result of gateRuns, whose refused arm holds the RefusalError (that gateExitCode takes nothing else is checked by the type test in test/regression.test.ts).
  assert.equal(typeof api.gateRuns, 'function');
  assert.equal(typeof api.gateExitCode, 'function');
  assert.equal((api as Record<string, unknown>)['makeRecord'], undefined, 'makeRecord is gone');
});

test('no export lets a caller write a verdict, a fold, a lone coefficient or a ledger record without the check of its entry point', () => {
  const bypass = [
    // a verdict, a diff or a fold without the identity check
    'evaluate', 'splitBarFile', 'diffRuns', 'foldRun', 'foldDraws', 'scoreAttempt', 'finalAttempt', 'rank', 'judgeControlledDelta',
    // a lone coefficient or a pooled share
    'cohenKappa', 'fleissKappa', 'gwetAC1', 'gwetAC1Multi', 'percentAgreement', 'jaccard', 'prevalence', 'toCountMatrix', 'flipRate', 'groupDraws',
    // a check without its refusal
    'validateIdentity', 'parseIdentity', 'identityDiff', 'canonicalJson', 'validateRecord', 'runArtifactProblems', 'attemptsProblems', 'slotProblems',
    'validateLabelSet', 'judgeChangePlanProblems', 'referenceProblems', 'resampleProblems', 'tieBreakProblems', 'callShapeDiff',
    // lone statistics, the generator and the removed converter
    'bootstrapCI', 'nonInferiority', 'wilson', 'toStat', 'quantileSorted', 'NA', 'Z_95', 'mulberry32', 'randomInt', 'seedFromString', 'shuffle', 'convertRunV2', 'DRIFT_DEFAULTS',
    // ledger writers, and the check a writer makes before it appends: a record is written by the command's --ledger, and read through readLedger
    'appendRecord', 'makeGateRecord', 'makeJudgeChangeRecord', 'makeRatingsRecord', 'checkLedgerFile',
  ];
  for (const name of bypass) assert.equal(Object.hasOwn(api, name), false, `${name} is exported`);
  assert.equal(typeof api.readLedger, 'function');
});

test('the public API exposes the schema ids and the documented defaults, not the internal field lists', () => {
  assert.equal(typeof api.outputHashOf, 'function');
  assert.deepEqual(api.REJUDGE_BOOTSTRAP_DEFAULTS, { iterations: 2000, seed: 1, alpha: 0.05 });
  assert.equal(api.RUN_SCHEMA, 'anchorset.run/v3');
  assert.equal((api as Record<string, unknown>)['LEDGER_SCHEMA'], 'anchorset.ledger/v3');
  assert.equal((api as Record<string, unknown>)['JUDGE_FIELDS'], undefined);
  // The wrappers behind the reports stay internal.
  for (const internal of ['pairAgreement', 'percentileInterval', 'unknownOutputHashes']) assert.equal((api as Record<string, unknown>)[internal], undefined, internal);
});

test('the strict reader is public: parseJsonBytes names a key given twice, and its result feeds parseRunArtifact', () => {
  const dup = api.parseJsonBytes(Buffer.from('{"a":1,"a":2}'));
  assert.deepEqual(dup, { problem: 'the key "a" is given twice in the top-level object', notJson: false });
  // findIllFormed, parseJsonText and utf8Text stay public for now: examples/importers/shared.ts reads text that is not a whole file through them.
  for (const name of ['findIllFormed', 'parseJsonBytes', 'parseJsonText', 'utf8Text']) assert.equal(typeof (api as Record<string, unknown>)[name], 'function', name);
  // The scan for a repeated key lives inside parseJsonText; it is not a second public entry.
  assert.equal((api as Record<string, unknown>)['duplicateKeyProblem'], undefined);
  const read = api.parseJsonBytes(readFileSync(join(import.meta.dirname, '..', 'examples', 'refund-bot', 'baseline.json')));
  assert.ok('json' in read);
  if ('json' in read) assert.equal(api.parseRunArtifact(read.json).schema, api.RUN_SCHEMA);
});

test('the three contract constants of the ratings, anchor and report files are public', () => {
  assert.equal(api.RATINGS_SCHEMA, 'anchorset.ratings/v1');
  assert.equal(api.ANCHOR_SCHEMA, 'anchorset.anchor/v1');
  assert.deepEqual(api.REPORT_SCHEMAS, {
    gate: 'anchorset.gate-report/v1',
    agree: 'anchorset.agree-report/v1',
    drift: 'anchorset.drift-report/v1',
    flips: 'anchorset.flips-report/v1',
    refusal: 'anchorset.refusal/v1',
  });
});

// --- The pages a caller reads name only what a caller can reach -------------------------------------
// A page that tells a library caller to use a function the index does not export sends them to a name they cannot
// import. Every name a source file exports and the index does not is internal; none may stand in code marks in the
// format pages, the migrations page or the changelog. (The README and the importer guide are held to
// this by the rows that own them.)
const repo = join(import.meta.dirname, '..');
const CALLER_PAGES = ['docs/RUN_FORMAT.md', 'docs/JUDGE_CHANGE.md', 'docs/RATINGS_FORMAT.md', 'docs/MIGRATIONS.md', 'CHANGELOG.md'];
const internalNames = (): string[] => {
  const exported = new Set<string>();
  for (const f of readdirSync(join(repo, 'src')).filter((x) => x.endsWith('.ts') && x !== 'index.ts')) {
    const text = readFileSync(join(repo, 'src', f), 'utf8');
    for (const m of text.matchAll(/^export (?:async )?(?:function|const|class) ([A-Za-z_$][\w$]*)/gm)) exported.add(m[1] as string);
  }
  return [...exported].filter((n) => !pinned.values.includes(n)).sort();
};
// Keys of a report that an internal function happens to share its name with. A page names them as fields of the
// JSON; one written as a call (`prevalence(`) is still refused below.
const REPORT_FIELDS = ['percentAgreement', 'prevalence', 'rateShiftMinItems'];

test('the format pages, the migrations page and the changelog name no function or constant that the package does not export', () => {
  const internal = internalNames();
  // The scan sees the names this check exists for: each was exported once, and is internal now.
  for (const known of ['runArtifactProblems', 'makeJudgeChangeRecord', 'makeRatingsRecord', 'makeGateRecord', 'appendRecord', 'checkLedgerFile', 'gwetAC1']) assert.ok(internal.includes(known), known);
  // The converter of the one earlier run schema is in no source file: the package holds no converter, exported or not.
  for (const f of readdirSync(join(repo, 'src'))) assert.doesNotMatch(readFileSync(join(repo, 'src', f), 'utf8'), /convertRunV2/, `src/${f}`);
  for (const page of CALLER_PAGES) {
    const text = readFileSync(join(repo, page), 'utf8');
    const marked = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
    // A name in double quotes is a value a file holds ("NOT_RELEASED"), not something to import.
    const named = internal.filter((n) => marked.some((code) => new RegExp(`(^|[^\\w$."])${n.replace(/\$/g, '\\$')}($|[^\\w$"])`).test(code)));
    const refused = named.filter((n) => !REPORT_FIELDS.includes(n) || marked.some((code) => code.includes(`${n}(`)));
    assert.deepEqual(refused, [], `${page} names, in code marks, what the package does not export: ${refused.join(', ')}`);
    // The retired name of the gate record writer is in no source file any more, so it is looked for by itself.
    assert.doesNotMatch(text, /\bmakeRecord\b/, page);
  }
});

test('docs/MIGRATIONS.md is the list of the schema strings of this version: every string the package exports is in it, and each constant it names is exported', () => {
  const page = readFileSync(join(repo, 'docs', 'MIGRATIONS.md'), 'utf8');
  const strings = [
    api.RUN_SCHEMA, api.CALL_SHAPE_SCHEMA, api.LEDGER_SCHEMA, api.JUDGE_CHANGE_PLAN_SCHEMA, api.REFERENCE_SCHEMA, api.TIE_BREAK_SCHEMA,
    api.RESAMPLE_SCHEMA, api.RATINGS_SCHEMA, api.ANCHOR_SCHEMA, ...Object.values(api.REPORT_SCHEMAS),
  ];
  assert.equal(strings.length, 14);
  for (const x of strings) assert.ok(page.includes(`\`${x}\``), `docs/MIGRATIONS.md does not list ${x}`);
  for (const m of page.matchAll(/`([A-Z][A-Z_]*_SCHEMAS?)(?:\.(\w+))?`/g)) {
    const [, name, key] = m as unknown as [string, string, string | undefined];
    assert.ok(pinned.values.includes(name), `docs/MIGRATIONS.md names ${name}, which the package does not export`);
    if (key !== undefined) assert.ok(Object.hasOwn(api.REPORT_SCHEMAS, key), `REPORT_SCHEMAS.${key}`);
  }
  // The run schema versions the bar: a change of the bar format did not move a string of its own.
  assert.equal(api.RUN_SCHEMA, 'anchorset.run/v3');
  assert.match(page.replace(/\s+/g, ' '), /A change of the bar format is a change of the run schema/);
});

// --- An exported constant is the constant, not an object a caller can change -------------------------
const deeplyFrozen = (value: unknown): boolean =>
  value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));

test('every exported value that is an object or an array is frozen, and so is every object inside it', () => {
  const objects = Object.entries(api).filter(([, value]) => value !== null && typeof value === 'object');
  // The thirteen of this version, by name: a new exported object is added here and frozen in the same commit.
  assert.deepEqual(objects.map(([name]) => name).sort(), [
    'CONTEXT_POLICIES', 'DEFAULT_BOOTSTRAP', 'EFFORTS', 'EXIT_CODES', 'FAIL_REASONS', 'IDENTITY_FIELDS', 'JUDGE_UNMEASURED_REASONS',
    'REJUDGE_BOOTSTRAP_DEFAULTS', 'REPORT_SCHEMAS', 'STOPS', 'THINKING_MODES', 'TOOL_CHOICES', 'TRANSPORT_REASONS',
  ]);
  for (const [name, value] of objects) assert.ok(deeplyFrozen(value), `${name} can be changed by a caller`);
});

test('a caller cannot change a default or an exit code: the write throws, and the next report states the documented resampling', () => {
  const writable = api as unknown as { DEFAULT_BOOTSTRAP: Record<string, number>; EXIT_CODES: Record<string, number>; IDENTITY_FIELDS: string[] };
  assert.throws(() => { writable.DEFAULT_BOOTSTRAP['iterations'] = 50; }, TypeError);
  assert.throws(() => { writable.DEFAULT_BOOTSTRAP['seed'] = 99; }, TypeError);
  assert.throws(() => { writable.EXIT_CODES['REGRESSION'] = 0; }, TypeError);
  assert.throws(() => { writable.IDENTITY_FIELDS.pop(); }, TypeError);
  const h = api.sha256Hex('one packet');
  const packetHashes = { a: { i1: h, i2: h, i3: h }, b: { i1: h, i2: h, i3: h } };
  const report = api.agreementReport({ a: { i1: 'x', i2: 'y', i3: 'x' }, b: { i1: 'x', i2: 'y', i3: 'y' } }, { packetHashes, categories: ['x', 'y'] });
  assert.deepEqual(report.bootstrap, { iterations: 2000, seed: 0, alpha: 0.05 });
  assert.equal(api.EXIT_CODES.REGRESSION, 1);
  assert.equal(api.IDENTITY_FIELDS.length, 16);
});
