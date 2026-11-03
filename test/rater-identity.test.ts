// What a ratings file states about its names, and the sentence each `agree` and `drift` report carries on what it cannot
// show. Every number here is pinned elsewhere or by a hash of the report as it stood before the key existed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agreementReport } from '../src/agreement.ts';
import type { RaterIdentity } from '../src/agreement.ts';
import { InputError, RefusalError } from '../src/errors.ts';
import { GAP, hashOf, sha256Hex } from '../src/identity.ts';
import { makeRatingsRecord, readLedger, validateRecord } from '../src/ledger.ts';
import { RATINGS_SCHEMA, REPORT_SCHEMAS, TOOL_NAME, TOOL_VERSION } from '../src/version.ts';

const root = join(import.meta.dirname, '..');
const ex = (f: string): string => join(root, 'examples', 'refund-bot', f);
const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'anchorset-rater-identity-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let serial = 0;
const file = (body: unknown): string => {
  const path = join(dir, `f${serial++}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
};
const json = (r: { status: number | null; stdout: string; stderr: string }): Record<string, unknown> => {
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown>;
};
const flat = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\s+/g, ' ');

const SCOPE = 'These figures describe this file only: the tool cannot see how the items or the raters were chosen, or why an item has the ratings it has.';
const DRIFT_LIMIT = 'A rating file names no judge, so the tool cannot show that both sets of ratings came from one judge.';
const NOT_PERSISTENT: RaterIdentity[] = ['positional', GAP];

const HASH = 'a'.repeat(64);
const COLUMNS = {
  two: ['yes yes yes yes yes yes yes yes no no no no no no', 'yes yes yes yes yes yes no no yes yes yes no no no'],
  three: ['yes yes yes yes yes yes yes yes no no no no no no', 'yes yes yes yes yes yes no no yes yes yes no no no', 'yes yes no no yes yes no yes no no yes no no yes'],
} as const;
const ITEMS = COLUMNS.two[0].split(' ').map((_, i) => `i${i}`);
const byItem = (values: readonly string[]): Record<string, string> => Object.fromEntries(ITEMS.map((id, i) => [id, values[i] as string]));
const NAMES = ['p1', 'p2', 'p3'];
const ratingsOf = (columns: readonly (readonly string[])[]): Record<string, Record<string, string>> => Object.fromEntries(columns.map((c, j) => [NAMES[j] as string, byItem(c)]));
const packetsFor = (count: number): Record<string, Record<string, string>> => Object.fromEntries(NAMES.slice(0, count).map((n) => [n, byItem(ITEMS.map(() => HASH))]));
const columnsOf = (key: keyof typeof COLUMNS): string[][] => COLUMNS[key].map((c) => c.split(' '));
const body = (columns: readonly (readonly string[])[], raterIdentity: unknown, bootstrap: unknown = { iterations: 2000, seed: 3, alpha: 0.05 }): Record<string, unknown> => ({
  schema: RATINGS_SCHEMA,
  ...(raterIdentity === undefined ? {} : { raterIdentity }),
  categories: ['no', 'yes'],
  ratings: ratingsOf(columns),
  packetHashes: packetsFor(columns.length),
  bootstrap,
});
/** How far each item's labels move round its positions. Items 6 and 7 are split items, so moving them changes each position's own share of labels. */
const STEPS = [0, 1, 0, 2, 1, 0, 1, 1, 0, 0, 0, 2, 1, 0];
const shuffled = (columns: readonly (readonly string[])[]): string[][] => {
  const m = columns.length;
  return columns.map((_, j) => ITEMS.map((_item, i) => (columns[(j + (STEPS[i] as number)) % m] as readonly string[])[i] as string));
};

test('a file without raterIdentity, or with another value, is invalid input naming the field; a v1 file is refused by its schema; the library function refuses too', () => {
  const columns = columnsOf('two');
  for (const value of [undefined, 'rater', 'unknown', '', null, 1, ['persistent']]) {
    const r = run('agree', '--ratings', file(body(columns, value)));
    assert.equal(r.status, 65, `${String(value)}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^ {2}- raterIdentity: required: "persistent", "positional" or "UNKNOWN"$/m);
  }
  const v1 = run('agree', '--ratings', file({ ...body(columns, 'persistent'), schema: 'anchorset.ratings/v1' }));
  assert.equal(v1.status, 65, v1.stderr);
  assert.match(v1.stderr, /ratings\.schema: required, and must be "anchorset\.ratings\/v2"/);
  const call = agreementReport as (r: unknown, o: unknown) => unknown;
  for (const value of [undefined, 'rater', null]) {
    assert.throws(
      () => call(ratingsOf(columns), { packetHashes: packetsFor(2), categories: ['no', 'yes'], raterIdentity: value }),
      (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /raterIdentity: required/.test(e.problems[0] as string),
    );
  }
});

/** A report with the version in `tool` set to 0.1.0, every key in its place: the hashes below were taken at that version. */
const atVersion010 = (o: Record<string, unknown>): Record<string, unknown> => ({ ...o, tool: { ...(o['tool'] as Record<string, unknown>), version: '0.1.0' } });

// The three hashes were taken from the commit before the key existed: the sha256 of JSON.stringify of its `--json` report,
// without `schema`, on the same labels, the file changed only in its schema string and the new key. That commit was
// version 0.1.0, and the report names its version in `tool`, so the version is set back to 0.1.0 before hashing.
test('persistent keeps every number of the report before the key, at three names and at two; only the new keys differ', () => {
  const strip = (o: Record<string, unknown>): string => {
    const { schema: _schema, raterIdentity, scope, ...rest } = o;
    assert.equal(raterIdentity, 'persistent');
    assert.equal(scope, SCOPE);
    assert.ok(!('identityNote' in rest));
    return JSON.stringify(atVersion010(rest));
  };
  const three = json(run('agree', '--ratings', ex('ratings.json'), '--json'));
  assert.equal(sha256Hex(strip(three)), '6d2e4a2bd6fc9961f250571e3fa911ef8cb5401f52bc0e9ef86927c0bb728630');
  const two = json(run('agree', '--ratings', file(body(columnsOf('two'), 'persistent')), '--json'));
  assert.equal(sha256Hex(strip(two)), '461cb458da32fdf26496975c6eb9c6abc9c992e823b6e56801a1f43d85fb6178');
  assert.equal((two['pairwise'] as unknown[]).length, 1);
  assert.equal(two['kappaKind'], 'cohen');
});

test('positional and UNKNOWN have no pair row and use Fleiss at any count, and text and --json agree', () => {
  for (const raterIdentity of NOT_PERSISTENT) {
    for (const key of ['two', 'three'] as const) {
      const path = file(body(columnsOf(key), raterIdentity));
      const o = json(run('agree', '--ratings', path, '--json'));
      assert.equal(o['raterIdentity'], raterIdentity);
      assert.deepEqual(o['pairwise'], []);
      assert.equal(o['kappaKind'], 'fleiss');
      assert.equal(o['percentAgreementKind'], 'mean-pairwise');
      const text = run('agree', '--ratings', path).stdout;
      assert.doesNotMatch(text, / vs /);
      assert.doesNotMatch(text, /cohen/);
      assert.match(text, new RegExp(`^fleiss kappa {5}${(o['kappa'] as number).toFixed(3)} `, 'm'));
      assert.match(text, new RegExp(`^gwet AC1 {9}${(o['ac1'] as number).toFixed(3)} `, 'm'));
      assert.match(text, new RegExp(`\\(Fleiss P̄\\) {2}${(o['percentAgreement'] as number).toFixed(3)} `));
      assert.ok(text.split('\n').includes(o['identityNote'] as string), 'the note of the JSON is printed');
    }
  }
});

// `wilson` is reached from agreement.ts only through pairAgreement, so counting its calls counts the pair rows. The persistent
// run is the control: it shows that the count moves when a pair row is computed.
test('pairAgreement is not called for a positional or UNKNOWN file (a counted stand-in for what only it calls)', () => {
  const stats = join(root, 'src', 'stats.ts');
  const agreement = join(root, 'src', 'agreement.ts');
  const script = `
    import { mock } from 'node:test';
    const real = await import(${JSON.stringify(stats)});
    let calls = 0;
    mock.module(${JSON.stringify(stats)}, { namedExports: { ...real, wilson: (...a) => { calls++; return real.wilson(...a); } } });
    const { agreementReport } = await import(${JSON.stringify(agreement)});
    const h = 'a'.repeat(64);
    const out = {};
    for (const raterIdentity of ['persistent', 'positional', 'UNKNOWN']) {
      calls = 0;
      agreementReport({ a: { i: 'x', j: 'y' }, b: { i: 'x', j: 'x' } }, { packetHashes: { a: { i: h, j: h }, b: { i: h, j: h } }, categories: ['x', 'y'], raterIdentity, bootstrap: { iterations: 20 } });
      out[raterIdentity] = calls;
    }
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { persistent: 1, positional: 0, UNKNOWN: 0 });
});

test('shuffling labels within items leaves the whole positional report byte-identical, at two and three positions, on one seed, in text, in --json and from the library', () => {
  for (const key of ['two', 'three'] as const) {
    const columns = columnsOf(key);
    const moved = shuffled(columns);
    assert.notDeepEqual(moved, columns, 'the shuffle moved labels between positions');
    const a = file(body(columns, 'positional'));
    const b = file(body(moved, 'positional'));
    const text = run('agree', '--ratings', a);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(run('agree', '--ratings', b).stdout, text.stdout, `${key}: text`);
    assert.equal(run('agree', '--ratings', b, '--json').stdout, run('agree', '--ratings', a, '--json').stdout, `${key}: JSON`);
    const options = { packetHashes: packetsFor(columns.length), categories: ['no', 'yes'], raterIdentity: 'positional' as const, bootstrap: { iterations: 300, seed: 9 } };
    assert.equal(JSON.stringify(agreementReport(ratingsOf(moved), options)), JSON.stringify(agreementReport(ratingsOf(columns), options)), `${key}: library`);
    // The control: the same shuffle under `persistent` does move the report, so the identity above is not an empty one.
    assert.notEqual(run('agree', '--ratings', file(body(moved, 'persistent'))).stdout, run('agree', '--ratings', file(body(columns, 'persistent'))).stdout, `${key}: control`);
  }
});

test('the same two lists give Cohen under persistent and Fleiss under positional', () => {
  const columns = columnsOf('two');
  const of = (raterIdentity: RaterIdentity) => agreementReport(ratingsOf(columns), { packetHashes: packetsFor(2), categories: ['no', 'yes'], raterIdentity, bootstrap: { iterations: 50 } });
  assert.equal(of('persistent').kappaKind, 'cohen');
  assert.equal(of('positional').kappaKind, 'fleiss');
  assert.notEqual(of('persistent').kappa, of('positional').kappa);
  // Observed agreement is the same share on two lists, under two names for it.
  assert.equal(of('persistent').percentAgreement, of('positional').percentAgreement);
  assert.equal(of('persistent').percentAgreementKind, 'agreeing-share');
  assert.equal(of('positional').percentAgreementKind, 'mean-pairwise');
});

test('packet checks, item-set checks and categories behave alike in all three modes', () => {
  const columns = columnsOf('two');
  for (const raterIdentity of ['persistent', 'positional', GAP]) {
    const good = body(columns, raterIdentity);
    const packets = packetsFor(2);
    (packets['p2'] as Record<string, string>)['i3'] = 'b'.repeat(64);
    const differing = run('agree', '--ratings', file({ ...good, packetHashes: packets }));
    assert.equal(differing.status, 2, raterIdentity);
    assert.match(differing.stderr, /REFUSED PACKET_MISMATCH\n {2}fields: i3/);

    const ratings = ratingsOf(columns);
    delete (ratings['p2'] as Record<string, string>)['i0'];
    const lacking = run('agree', '--ratings', file({ ...good, ratings }));
    assert.equal(lacking.status, 2, raterIdentity);
    assert.match(lacking.stderr, /REFUSED ITEM_SET_MISMATCH/);

    const { categories: _categories, ...noScale } = good;
    const unscaled = run('agree', '--ratings', file(noScale));
    assert.equal(unscaled.status, 65, raterIdentity);
    assert.match(unscaled.stderr, /categories: required/);
    const narrow = run('agree', '--ratings', file({ ...good, categories: ['no'] }));
    assert.notEqual(narrow.status, 0, raterIdentity);
    assert.match(narrow.stderr, /"yes" is not a declared category/);

    assert.throws(
      () => agreementReport({ p1: { i: 'yes' } }, { packetHashes: {}, categories: ['yes'], raterIdentity: raterIdentity as RaterIdentity }),
      (e: unknown) => e instanceof InputError && /at least 2 raters/.test(e.problems[0] as string),
    );
    assert.throws(
      () => agreementReport({ p1: { i: 'yes' }, p2: { i: 'yes' } }, { packetHashes: {}, categories: ['yes'], raterIdentity: raterIdentity as RaterIdentity }),
      (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH',
    );
  }
});

test('the exact words of a positional report: header, overall row, what it says instead of pair rows, and the bracket line', () => {
  const lines = run('agree', '--ratings', file(body(columnsOf('three'), 'positional'))).stdout.split('\n');
  assert.equal(lines[0], '3 rating positions per item, no rater identity · items 14 · packet hashes equal for every item, as the file states');
  assert.ok(lines.some((l) => /^mean pairwise agreement among positions \(Fleiss P̄\) {2}\d\.\d{3} {2}\(not the share of items on which all of them agree\)$/.test(l)), lines.join('\n'));
  assert.ok(lines.includes("no row for a pair: a list position is not a rater, so the figures are Fleiss' kappa, multi-rater AC1 and mean pairwise observed agreement at any number of positions, two included"));
  assert.ok(lines.includes('brackets: a percentile bootstrap interval over items, the labels held fixed: nominal 95%, coverage not checked; 2000 resamples, seed 3, 2 categories; it says nothing about another draw of a judge; the raters behind the positions are resampled only with their items and may recur across items, so the brackets may be too narrow or too wide'), lines.join('\n'));
  assert.ok(!lines.some((l) => l.startsWith('raters ')));
  // Two names read the same way: the count in the header is the only difference there.
  assert.match(run('agree', '--ratings', file(body(columnsOf('two'), 'positional'))).stdout, /^2 rating positions per item, no rater identity · items 14/);
});

test('an UNKNOWN report says the names are unknown, and its header and overall row never call them positions', () => {
  const lines = run('agree', '--ratings', file(body(columnsOf('two'), GAP))).stdout.split('\n');
  assert.equal(lines[0], '2 names per item, and the names are unknown: the file does not say who or what they stand for · items 14 · packet hashes equal for every item, as the file states');
  const overall = lines.find((l) => l.startsWith('mean pairwise agreement')) as string;
  assert.match(overall, /^mean pairwise agreement among unknown names \(Fleiss P̄\) {2}\d\.\d{3} {2}\(not the share of items on which all of them agree\)$/);
  assert.doesNotMatch(lines[0] as string, /position/);
  assert.doesNotMatch(overall, /position/);
  assert.ok(lines.includes("no row for a pair: the names are unknown, not shown to be raters or positions, so the figures are Fleiss' kappa, multi-rater AC1 and mean pairwise observed agreement at any number of names, two included"));
  assert.ok(lines.includes('brackets: a percentile bootstrap interval over items, the labels held fixed: nominal 95%, coverage not checked; 2000 resamples, seed 3, 2 categories; it says nothing about another draw of a judge; whoever rated under these names is resampled only with their items and may recur across items, so the brackets may be too narrow or too wide'), lines.join('\n'));
});

test('the fixed line closes every text report and is `scope` in every --json, in all three modes, and a positional record reads back from a ledger', () => {
  for (const raterIdentity of ['persistent', 'positional', GAP]) {
    const path = file(body(columnsOf('three'), raterIdentity));
    const lines = run('agree', '--ratings', path).stdout.trimEnd().split('\n');
    assert.equal(lines.at(-1), SCOPE, raterIdentity);
    assert.equal(json(run('agree', '--ratings', path, '--json'))['scope'], SCOPE, raterIdentity);
  }
  const ledger = join(dir, 'positional.jsonl');
  const path = file(body(columnsOf('two'), 'positional'));
  const printed = json(run('agree', '--ratings', path, '--ledger', ledger, '--json'));
  assert.equal(printed['schema'], REPORT_SCHEMAS.agree);
  const [record] = readLedger(ledger);
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual((record as { result: unknown }).result, printed);
});

test('a ledger record keeps what the report states: no statement, a pair row beside a statement that withholds it, or another sentence is a problem', () => {
  const tool = { name: TOOL_NAME, version: TOOL_VERSION };
  const columns = columnsOf('two');
  const report = (raterIdentity: RaterIdentity) => ({ schema: REPORT_SCHEMAS.agree, tool, ...agreementReport(ratingsOf(columns), { packetHashes: packetsFor(2), categories: ['no', 'yes'], raterIdentity, bootstrap: { iterations: 50, seed: 1 } }) });
  const recordOf = (r: ReturnType<typeof report>) => makeRatingsRecord({ kind: 'agreement', ratingsFile: new TextEncoder().encode('{}'), report: r }) as unknown as Record<string, unknown>;
  const withResult = (change: (r: Record<string, unknown>) => void): string[] => {
    const record = recordOf(report('positional'));
    const result = { ...(record['result'] as Record<string, unknown>) };
    change(result);
    return validateRecord({ ...record, result, resultHash: hashOf(result) });
  };
  assert.deepEqual(withResult(() => undefined), []);
  assert.ok(withResult((r) => delete r['raterIdentity']).some((p) => p.includes('record.result.raterIdentity')));
  assert.ok(withResult((r) => (r['raterIdentity'] = 'someone')).some((p) => p.includes('record.result.raterIdentity')));
  assert.ok(withResult((r) => delete r['scope']).some((p) => p.includes('record.result.scope')));
  assert.ok(withResult((r) => (r['pairwise'] = report('persistent').pairwise)).some((p) => p.includes('holds no pair row')));
  assert.ok(withResult((r) => (r['kappaKind'] = 'cohen')).some((p) => p.includes('holds no pair row')));
});

test('the ratings format states the three values and its limits, and the refund-bot file says persistent', () => {
  const doc = flat('docs/RATINGS_FORMAT.md');
  for (const needle of [
    '`raterIdentity`', '`persistent`', '`positional`', '`UNKNOWN`',
    'A list position is not a rater',
    'cannot see whether ratings were added or dropped depending on earlier ratings',
    'cannot see whether a set was filtered on agreement',
    "A file's rater names and packet hashes are its own statement, and the tool checks neither",
    SCOPE,
    DRIFT_LIMIT,
  ]) assert.ok(doc.includes(needle), needle);
  const example = JSON.parse(readFileSync(ex('ratings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(example['schema'], RATINGS_SCHEMA);
  assert.equal(example['raterIdentity'], 'persistent');
});

test('drift states its limit in text and as `scope`, under its own report version, with every number as before', () => {
  const args = ['drift', '--old', ex('anchor_old.json'), '--new', ex('anchor_new.json'), '--flag', 'handoff'];
  const text = run(...args);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.trimEnd().split('\n').at(-1), DRIFT_LIMIT);
  const { schema, scope, ...rest } = json(run(...args, '--json'));
  assert.equal(schema, REPORT_SCHEMAS.drift);
  assert.equal(scope, DRIFT_LIMIT);
  // The sha256 of JSON.stringify of the `--json` report of the commit before this sentence existed, without `schema`,
  // with the version in `tool` set back to that commit's 0.1.0.
  assert.equal(sha256Hex(JSON.stringify(atVersion010(rest))), 'ec90b92b39de9daea00220eb2dce91b0cbdd3e9d8583dfc0980d33417d760c74');
});

// Each case edits a real record and recomputes its resultHash, so only the disagreement is left to find.
test('a ledger record\'s statement about its names agrees with its contents, in every direction, and what the record holds is recomputed', () => {
  const tool = { name: TOOL_NAME, version: TOOL_VERSION };
  const recordOf = (shape: 'two' | 'three', raterIdentity: RaterIdentity) => {
    const n = shape === 'two' ? 2 : 3;
    const report = { schema: REPORT_SCHEMAS.agree, tool, ...agreementReport(ratingsOf(columnsOf(shape)), { packetHashes: packetsFor(n), categories: ['no', 'yes'], raterIdentity, bootstrap: { iterations: 50, seed: 1, alpha: 0.05 } }) };
    return makeRatingsRecord({ kind: 'agreement', ratingsFile: new TextEncoder().encode('{}'), report }) as unknown as Record<string, unknown>;
  };
  const problems = (shape: 'two' | 'three', raterIdentity: RaterIdentity, change: (r: Record<string, any>) => void): string[] => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const record = recordOf(shape, raterIdentity);
    const result = structuredClone(record['result']) as Record<string, unknown>;
    change(result);
    return validateRecord({ ...record, result, resultHash: hashOf(result) });
  };
  const named = (fragment: string, shape: 'two' | 'three', raterIdentity: RaterIdentity, change: (r: Record<string, any>) => void): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const found = problems(shape, raterIdentity, change);
    assert.ok(found.some((p) => p.includes(fragment)), `${fragment} not in: ${found.join(' | ')}`);
  };
  // Six cases where the statement and the contents disagree, then what can be recomputed.
  named('record.result.identityNote', 'three', 'positional', (r) => delete r['identityNote']);
  named('record.result.pairwise', 'three', 'positional', (r) => (r['raterIdentity'] = 'persistent'));
  named('record.result.identityNote', 'three', 'positional', (r) => (r['identityNote'] = 'anything'));
  named('record.result.identityNote', 'three', GAP, (r) => (r['identityNote'] = (recordOf('three', 'positional')['result'] as Record<string, unknown>)['identityNote']));
  named('record.result.pairwise', 'three', 'persistent', (r) => (r['pairwise'] = []));
  named('record.result.identityNote', 'three', 'persistent', (r) => (r['identityNote'] = 'x'));
  named('record.result.percentAgreementKind', 'three', 'positional', (r) => (r['percentAgreementKind'] = 'agreeing-share'));
  named('record.result.percentAgreementKind', 'two', 'persistent', (r) => (r['percentAgreementKind'] = 'mean-pairwise'));
  named('record.result.percentAgreementKind', 'three', 'persistent', (r) => (r['percentAgreementKind'] = 'agreeing-share'));
  named('record.result.kappaKind', 'two', 'persistent', (r) => (r['kappaKind'] = 'fleiss'));
  named('record.result.kappaKind', 'three', 'persistent', (r) => (r['kappaKind'] = 'cohen'));
  // A pair row that is not a pair of the names, is given twice, or is out of order.
  named('record.result.pairwise', 'three', 'persistent', (r) => { r['pairwise'][1].b = 'someone'; });
  named('record.result.pairwise', 'three', 'persistent', (r) => { r['pairwise'][1] = r['pairwise'][0]; });
  named('record.result.pairwise', 'three', 'persistent', (r) => { r['pairwise'].reverse(); });
  named('record.result.raters', 'three', 'persistent', (r) => { r['raters'] = [...r['raters']].reverse(); });
  named('record.result.raters', 'three', 'positional', (r) => { r['raters'] = ['only']; });
  // The figures the record holds the parts of.
  for (const identity of ['persistent', 'positional', GAP] as const) {
    named('record.result.kappa', 'three', identity, (r) => (r['kappa'] = 0.123));
    named('record.result.ac1', 'three', identity, (r) => (r['ac1'] = 0.123));
    named('record.result.percentAgreement', 'three', identity, (r) => (r['percentAgreement'] = 0.123));
    named('record.result.prevalence', 'three', identity, (r) => { r['prevalence'].no = 0.123; });
    named('record.result.prevalence', 'three', identity, (r) => { r['prevalence'].other = 0; });
    named('record.result.itemCount', 'three', identity, (r) => (r['itemCount'] = 0));
  }
  named('record.result.kappa', 'two', 'persistent', (r) => (r['kappa'] = 0.123));
  named('record.result.ac1', 'two', 'persistent', (r) => (r['ac1'] = 0.123));
  named('record.result.percentAgreement', 'two', 'persistent', (r) => (r['percentAgreement'] = 0.123));
  named('record.result.pairwise[0].kappa', 'three', 'persistent', (r) => { r['pairwise'][0].kappa = 0.123; });
  named('record.result.pairwise[0].ac1', 'three', 'persistent', (r) => { r['pairwise'][0].ac1 = 0.123; });
  named('record.result.pairwise[0].prevalence', 'three', 'persistent', (r) => { r['pairwise'][0].prevalence.no = 0.123; });
  named('record.result.pairwise[0].marginals', 'three', 'persistent', (r) => { r['pairwise'][0].marginals.a.no = 0.123; });
  // Every real report reads back, at either number of names, and where a coefficient is not defined.
  for (const shape of ['two', 'three'] as const) for (const identity of ['persistent', 'positional', GAP] as const) assert.deepEqual(validateRecord(recordOf(shape, identity)), [], `${shape} ${identity}`);
  for (const identity of ['persistent', 'positional', GAP] as const) {
    const same = Array.from({ length: 6 }, () => 'yes');
    const report = { schema: REPORT_SCHEMAS.agree, tool, ...agreementReport({ a: Object.fromEntries(same.map((l, i) => [`i${i}`, l])), b: Object.fromEntries(same.map((l, i) => [`i${i}`, l])) }, { packetHashes: Object.fromEntries(['a', 'b'].map((r) => [r, Object.fromEntries(same.map((_, i) => [`i${i}`, HASH]))])), categories: ['no', 'yes'], raterIdentity: identity, bootstrap: { iterations: 50, seed: 1, alpha: 0.05 } }) };
    assert.deepEqual(validateRecord(makeRatingsRecord({ kind: 'agreement', ratingsFile: new TextEncoder().encode('{}'), report })), [], `all alike ${identity}`);
  }
});

test('drift reads no identity key: an anchor file holding one is invalid input, and a ledger record of a drift report keeps its limit', () => {
  const anchor = JSON.parse(readFileSync(ex('anchor_old.json'), 'utf8')) as Record<string, unknown>;
  const r = run('drift', '--old', file({ ...anchor, raterIdentity: 'persistent' }), '--new', ex('anchor_new.json'), '--flag', 'handoff');
  assert.equal(r.status, 65, r.stderr);
  assert.match(r.stderr, /old\.raterIdentity: unknown field/);
  const ledger = join(dir, 'drift.jsonl');
  const printed = json(run('drift', '--old', ex('anchor_old.json'), '--new', ex('anchor_new.json'), '--flag', 'handoff', '--ledger', ledger, '--json'));
  const [record] = readLedger(ledger) as unknown as [Record<string, unknown>];
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual(record['result'], printed);
  const { scope: _scope, ...result } = record['result'] as Record<string, unknown>;
  assert.ok(validateRecord({ ...record, result, resultHash: hashOf(result) }).some((p) => p.includes('record.result.scope')));
});
