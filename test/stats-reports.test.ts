// What `agree`, `drift` and `judge-change` print about the statistics of stats.ts, agreement.ts and drift.ts: the
// level of a bracket, the name of the agreement row, the basis of a drift classification, the required scale, and
// where a reported count sits among the tie-break seeds. The numbers themselves are pinned in the modules' own tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MIN_LEVEL_RESAMPLES, placeAmong } from '../src/stats.ts';
import { RATINGS_SCHEMA } from '../src/version.ts';

const root = join(import.meta.dirname, '..');
const ex = (...f: string[]): string => join(root, 'examples', ...f);
const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'anchorset-stats-reports-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, body: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};
const demoRatings = (): Record<string, unknown> => JSON.parse(readFileSync(ex('refund-bot', 'ratings.json'), 'utf8')) as Record<string, unknown>;
const demoAnchor = (which: 'old' | 'new'): Record<string, unknown> => JSON.parse(readFileSync(ex('refund-bot', `anchor_${which}.json`), 'utf8')) as Record<string, unknown>;

test('agree: a ratings file asking for 1, 2 or 3 resamples (or 999) gets its brackets as percentiles with no level; never the words "nominal", "interval" or a percentage', () => {
  for (const iterations of [1, 2, 3, MIN_LEVEL_RESAMPLES - 1]) {
    const r = run('agree', '--ratings', file(`few-${iterations}.json`, { ...demoRatings(), bootstrap: { iterations, seed: 7, alpha: 0.05 } }));
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith('brackets: '));
    assert.equal(
      line,
      `brackets: percentiles over ${iterations} resample${iterations === 1 ? '' : 's'} of items, the raters and their labels held fixed, with no level: a level is named from 1000 resamples on which the statistic is defined; ${iterations} resample${iterations === 1 ? '' : 's'}, seed 7, 3 categories; it says nothing about another draw of a judge`,
    );
    // The only level left in the report is the Wilson interval of an agreeing share, which is not a resampling bracket.
    assert.doesNotMatch(r.stdout, /nominal|bootstrap interval|confidence/, `${iterations} resamples`);
    assert.doesNotMatch(r.stdout.replaceAll('Wilson 95%', ''), /%/, `${iterations} resamples`);
    // The JSON a ledger would hash says the same: the percentiles are there, the level is not.
    const j = JSON.parse(run('agree', '--ratings', file(`few-${iterations}.json`, { ...demoRatings(), bootstrap: { iterations, seed: 7, alpha: 0.05 } }), '--json').stdout) as { kappaCI: { nominalLevel: unknown; iterations: number }; ac1CI: { nominalLevel: unknown }; pairwise: { kappaCI: { nominalLevel: unknown } }[] };
    assert.deepEqual([j.kappaCI.nominalLevel, j.ac1CI.nominalLevel, j.kappaCI.iterations, ...j.pairwise.map((p) => p.kappaCI.nominalLevel)], ['NA', 'NA', iterations, 'NA', 'NA', 'NA']);
  }
});

// On the demo ratings at seed 7, one pairwise kappa (rater-a against rater-c) is undefined on 1 of 1,000 resamples, so
// its bracket is read from 999 and has no level; the other seven keep theirs. The count is the seeded generator's.
test('agree: at 1,000 resamples a bracket carries its nominal level only if its statistic was defined on all 1,000; the row that was not is marked, and the brackets line counts it', () => {
  const path = file('floor.json', { ...demoRatings(), bootstrap: { iterations: MIN_LEVEL_RESAMPLES, seed: 7, alpha: 0.1 } });
  const r = run('agree', '--ratings', path);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.ok(lines.includes('brackets: a percentile bootstrap interval over items, the raters and their labels held fixed: nominal 90%, coverage not checked; 1 of the 8 brackets above is marked "no level" and is not such an interval: the statistic was undefined on too many resamples; 1000 resamples, seed 7, 3 categories; it says nothing about another draw of a judge'), r.stdout);
  const marked = lines.filter((l) => l.includes('no level:'));
  assert.equal(marked.length, 1);
  assert.match(marked[0] as string, /^ {2}rater-a vs rater-c: kappa \d\.\d{3} \[\d\.\d{3}, \d\.\d{3}\] \(undefined on 1 of 1000 resamples, which are left out\) \(no level: read from 999 resamples, and a level is named from 1000\) · AC1 /);
  const at1000 = JSON.parse(run('agree', '--ratings', path, '--json').stdout) as { kappaCI: { nominalLevel: unknown }; ac1CI: { nominalLevel: unknown }; pairwise: { a: string; b: string; kappaCI: { nominalLevel: unknown; undefinedResamples: number }; ac1CI: { nominalLevel: unknown } }[] };
  assert.deepEqual([at1000.kappaCI.nominalLevel, at1000.ac1CI.nominalLevel], [0.9, 0.9]);
  assert.deepEqual(at1000.pairwise.map((p) => [p.a, p.b, p.kappaCI.undefinedResamples, p.kappaCI.nominalLevel, p.ac1CI.nominalLevel]), [['rater-a', 'rater-b', 0, 0.9, 0.9], ['rater-a', 'rater-c', 1, 'NA', 0.9], ['rater-b', 'rater-c', 0, 0.9, 0.9]]);
  // The demo file itself asks for 2,000: every bracket has its level, and the line marks none.
  const demo = run('agree', '--ratings', ex('refund-bot', 'ratings.json'));
  assert.match(demo.stdout, /^brackets: a percentile bootstrap interval over items, the raters and their labels held fixed: nominal 95%, coverage not checked; 2000 resamples, seed 7, 3 categories; it says nothing about another draw of a judge$/m);
  assert.doesNotMatch(demo.stdout, /no level/);
  const j = JSON.parse(run('agree', '--ratings', ex('refund-bot', 'ratings.json'), '--json').stdout) as { kappaCI: { nominalLevel: unknown }; ac1CI: { nominalLevel: unknown } };
  assert.deepEqual([j.kappaCI.nominalLevel, j.ac1CI.nominalLevel], [0.95, 0.95]);
});

// Two runs, as the command prints them (hand-worked in test/agreement.test.ts and test/stats.test.ts).
test('agree at high prevalence: kappa undefined on 367 of 1,000 resamples is printed with "no level", never under "nominal 95%" alone; and alpha 0.0001 at 1,000 resamples names no level at all', () => {
  const items = Array.from({ length: 20 }, (_, i) => `i${i}`);
  const hash = 'a'.repeat(64);
  const body = (bootstrap: unknown): unknown => ({
    schema: RATINGS_SCHEMA,
    raterIdentity: 'persistent',
    categories: ['ok', 'bad'],
    ratings: { A: Object.fromEntries(items.map((id) => [id, 'ok'])), B: Object.fromEntries(items.map((id, i) => [id, i === 0 ? 'bad' : 'ok'])) },
    packetHashes: { A: Object.fromEntries(items.map((id) => [id, hash])), B: Object.fromEntries(items.map((id) => [id, hash])) },
    bootstrap,
  });
  const r = run('agree', '--ratings', file('prevalent.json', body({ iterations: 1000, seed: 1, alpha: 0.05 })));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.ok(lines.includes('cohen kappa      0.000 [0.000, 0.000] (undefined on 367 of 1000 resamples, which are left out) (degenerate: every resample gave this value; not a bound) (no level: read from 633 resamples, and a level is named from 1000)'), r.stdout);
  assert.ok(lines.some((l) => l.startsWith('brackets: a percentile bootstrap interval over items') && l.includes('; 2 of the 4 brackets above are marked "no level" and are not such an interval: the statistic was undefined on too many resamples; 1000 resamples, seed 1, 2 categories;')), r.stdout);
  assert.match(r.stdout, /^gwet AC1 {9}0\.947 \[\d\.\d{3}, 1\.000\]$/m);
  const tiny = run('agree', '--ratings', file('tiny-alpha.json', body({ iterations: 1000, seed: 1, alpha: 0.0001 })));
  assert.equal(tiny.status, 0, tiny.stderr);
  assert.ok(tiny.stdout.split('\n').includes('brackets: percentiles over 1000 resamples of items, the raters and their labels held fixed, with no level: a level is named from 500000 resamples on which the statistic is defined; 1000 resamples, seed 1, 2 categories; it says nothing about another draw of a judge'), tiny.stdout);
  assert.doesNotMatch(tiny.stdout, /nominal|99\.99|bootstrap interval/);
  const j = JSON.parse(run('agree', '--ratings', file('tiny-alpha.json', body({ iterations: 1000, seed: 1, alpha: 0.0001 })), '--json').stdout) as { kappaCI: { nominalLevel: unknown }; ac1CI: { nominalLevel: unknown } };
  assert.deepEqual([j.kappaCI.nominalLevel, j.ac1CI.nominalLevel], ['NA', 'NA']);
  // The recorded level is the printed one: alpha 0.07 is 0.93 in the JSON, not 0.9299999999999999.
  const odd = JSON.parse(run('agree', '--ratings', file('odd-alpha.json', body({ iterations: 1000, seed: 1, alpha: 0.07 })), '--json').stdout) as { ac1CI: { nominalLevel: unknown } };
  assert.equal(odd.ac1CI.nominalLevel, 0.93);
  // One resample is "1 resample", in the wording and in the count beside the seed.
  const one = run('agree', '--ratings', file('one.json', body({ iterations: 1, seed: 1, alpha: 0.05 })));
  assert.match(one.stdout, /; 1 resample, seed 1, 2 categories;/);
  assert.doesNotMatch(one.stdout, /1 resamples/);
});

test('agree: an alpha above 0.2 is invalid input (65) at any number of resamples; nothing is printed', () => {
  for (const alpha of [0.5, 0.9, 1, 0]) {
    const r = run('agree', '--ratings', file(`alpha-${alpha}.json`, { ...demoRatings(), bootstrap: { iterations: 2000, seed: 7, alpha } }));
    assert.equal(r.status, 65, `${alpha}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /bootstrap: alpha must be in \(0, 0\.2\]/);
  }
});

// The demo's three raters: the mean pairwise agreement is 0.767 and the raters all agree on 13 of 20 items, 0.650
// (counted here from the file, an independent recomputation of the second number).
test('agree with three raters names its agreement row "mean pairwise agreement (Fleiss P-bar)", which is not the share of items on which all agree (0.767 against 13 of 20 = 0.650 on the demo)', () => {
  const r = run('agree', '--ratings', ex('refund-bot', 'ratings.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^mean pairwise agreement \(Fleiss P̄\) {2}0\.767 {2}\(not the share of items on which every rater agrees\)$/m);
  assert.doesNotMatch(r.stdout, /^agreement /m);
  const ratings = demoRatings()['ratings'] as Record<string, Record<string, string>>;
  const raters = Object.keys(ratings);
  const items = Object.keys(ratings[raters[0] as string] as Record<string, string>);
  const allAgree = items.filter((id) => new Set(raters.map((x) => (ratings[x] as Record<string, string>)[id])).size === 1).length;
  assert.deepEqual([allAgree, items.length], [13, 20]);
  const j = JSON.parse(run('agree', '--ratings', ex('refund-bot', 'ratings.json'), '--json').stdout) as { percentAgreementKind: string; percentAgreement: number };
  assert.equal(j.percentAgreementKind, 'mean-pairwise');
  assert.ok(Math.abs(j.percentAgreement - 0.767) < 5e-4 && j.percentAgreement > allAgree / items.length);
  // Two raters: the row is the plain agreeing share, under its plain name.
  const two = demoRatings();
  const drop = (m: unknown): unknown => Object.fromEntries(Object.entries(m as Record<string, unknown>).filter(([k]) => k !== 'rater-c'));
  const pair = file('two.json', { ...two, ratings: drop(two['ratings']), packetHashes: drop(two['packetHashes']) });
  assert.match(run('agree', '--ratings', pair).stdout, /^agreement {8}0\.\d{3}$/m);
  assert.equal((JSON.parse(run('agree', '--ratings', pair, '--json').stdout) as { percentAgreementKind: string }).percentAgreementKind, 'agreeing-share');
});

test('agree and drift require the declared scale: a ratings file without categories, or an anchor file without labels, is invalid input (65)', () => {
  const { categories: _c, ...noCategories } = demoRatings();
  const a = run('agree', '--ratings', file('no-categories.json', noCategories));
  assert.equal(a.status, 65, a.stdout + a.stderr);
  assert.equal(a.stdout, '');
  assert.match(a.stderr, /^ {2}- categories: required: the declared scale as a string array, every category listed whether or not it was used$/m);

  const { labels: _l, ...oldNoLabels } = demoAnchor('old');
  const { labels: _m, ...newNoLabels } = demoAnchor('new');
  const full = { old: ex('refund-bot', 'anchor_old.json'), new: ex('refund-bot', 'anchor_new.json') };
  const bare = { old: file('old-no-labels.json', oldNoLabels), new: file('new-no-labels.json', newNoLabels) };
  // Either file without its labels is refused as invalid input: the other file's list is not borrowed.
  for (const [o, n, named] of [[bare.old, full.new, ['old']], [full.old, bare.new, ['new']], [bare.old, bare.new, ['old']]] as const) {
    const d = run('drift', '--old', o, '--new', n, '--flag', 'handoff');
    assert.equal(d.status, 65, d.stdout + d.stderr);
    assert.equal(d.stdout, '');
    for (const name of named) assert.match(d.stderr, new RegExp(`^ {2}- ${name}\\.labels: required: the declared, ordered labels as a string array, every label listed whether or not it was used$`, 'm'));
  }
  // With one more declared category the same ratings give another AC1 and the same kappa: why the scale is never guessed.
  const base = JSON.parse(run('agree', '--ratings', ex('refund-bot', 'ratings.json'), '--json').stdout) as { ac1: number; kappa: number };
  const wider = JSON.parse(run('agree', '--ratings', file('wider.json', { ...demoRatings(), categories: [...(demoRatings()['categories'] as string[]), 'escalate'] }), '--json').stdout) as { ac1: number; kappa: number };
  assert.ok(Math.abs(base.ac1 - 0.676) < 5e-4 && Math.abs(wider.ac1 - 0.713) < 5e-4, `${base.ac1} ${wider.ac1}`);
  assert.equal(wider.kappa, base.kappa);
});

test('drift never prints a bare classification: the line says it is a description by fixed thresholds with no repeat-reading baseline; the rate threshold is shown as a net change in one label\'s count, and the line says the overlap rule is checked first; the JSON carries the caveat and the count', () => {
  const args = ['drift', '--old', ex('refund-bot', 'anchor_old.json'), '--new', ex('refund-bot', 'anchor_new.json'), '--flag', 'review,handoff'];
  const r = run(...args);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines.find((l) => l.startsWith('classification')), 'classification   threshold-shift · 4 of 24 items changed label  (fixed thresholds; a description, not a test; no repeat-reading baseline)');
  // 24 anchor items at threshold 0.05: 1 / 24 = 0.0417 is below it and 2 / 24 = 0.0833 is not, so two items.
  assert.equal(lines.find((l) => l.startsWith('max rate shift')), "max rate shift   0.125 (threshold 0.05: a net change of 2 or more in one label's count, of 24 items, reaches it; the overlap rule is checked first)");
  for (const l of lines.filter((x) => /classification/.test(x))) assert.match(l, /a description, not a test/);
  const j = JSON.parse(run(...args, '--json').stdout) as { classification: string; classificationBasis: string; rateShiftMinItems: number; itemCount: number };
  assert.deepEqual([j.classification, j.classificationBasis, j.rateShiftMinItems, j.itemCount], ['threshold-shift', 'fixed thresholds; a description, not a test; no repeat-reading baseline', 2, 24]);
  // A judge compared with itself is "counts-stable", and the same sentence stands beside it.
  const same = run('drift', '--old', ex('refund-bot', 'anchor_old.json'), '--new', ex('refund-bot', 'anchor_old.json'), '--flag', 'handoff');
  assert.match(same.stdout, /^classification {3}counts-stable · 0 of 24 items changed label {2}\(fixed thresholds; a description, not a test; no repeat-reading baseline\)$/m);
});

// A hand-worked fixture, not a published reference. 100 items, labels [ok, good, flagged], flagged label "flagged".
// Old reading: items 1-50 are ok, items 51-100 are good. New reading: items 1-50 are good, items 51-100 are ok.
// Every item changed label: the off-diagonal sum of the transition table is 50 + 50 = 100. Each label's count is
// 50 before and 50 after, so every net change is 0 and maxRateShift is 0. No item is flagged on either side, and
// an empty flagged set is contained in any other, so the overlap rule gives 1. Neither rule fires: counts-stable.
test('drift: a 100-item swap in which every item changed label and every count stayed the same is counts-stable, and the line says 100 of 100 items changed label', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `i${String(i + 1).padStart(3, '0')}`);
  const hashes = Object.fromEntries(ids.map((id) => [id, 'a'.repeat(64)]));
  const reading = (firstHalf: string, secondHalf: string) => ({ schema: 'anchorset.anchor/v1', labels: ['ok', 'good', 'flagged'], verdicts: Object.fromEntries(ids.map((id, i) => [id, i < 50 ? firstHalf : secondHalf])), packetHashes: hashes });
  const oldFile = file('swap-old.json', reading('ok', 'good'));
  const newFile = file('swap-new.json', reading('good', 'ok'));
  const swap = run('drift', '--old', oldFile, '--new', newFile, '--flag', 'flagged');
  assert.equal(swap.status, 0, swap.stderr);
  assert.match(swap.stdout, /^classification {3}counts-stable · 100 of 100 items changed label {2}\(fixed thresholds; a description, not a test; no repeat-reading baseline\)$/m);
  const j = JSON.parse(run('drift', '--old', oldFile, '--new', newFile, '--flag', 'flagged', '--json').stdout) as { classification: string; maxRateShift: number };
  assert.deepEqual([j.classification, j.maxRateShift], ['counts-stable', 0]);
  // The same reading against itself: no item changed label.
  const same = run('drift', '--old', oldFile, '--new', oldFile, '--flag', 'flagged');
  assert.match(same.stdout, /^classification {3}counts-stable · 0 of 100 items changed label /m);
});

test('judge-change: each row of the table across tie-break seeds says where the reported value sits (seeds below, equal, above), in text and in JSON', () => {
  const args = ['judge-change', '--plan', ex('judge-change', 'plan.json'), '--bar', ex('judge-change', 'bar.json'), '--inputs', ex('judge-change', 'runs')];
  const j = JSON.parse(run(...args, '--json').stdout) as { map: { tieBreak: { seed: number }; overTieBreakSeeds: { seeds: number[]; quantities: Record<string, { min: number; median: number; max: number; reported: number; below: number; equal: number; above: number }> } } };
  const over = j.map.overTieBreakSeeds;
  const n = over.seeds.length;
  assert.ok(n >= 2);
  // The reported numbers are the first seed's, so that seed is always among the "equal".
  assert.equal(j.map.tieBreak.seed, over.seeds[0]);
  const text = run(...args).stdout;
  assert.match(text, new RegExp(`what the tie-break alone moves, across the ${n} seeds .* \\(min / median / max; then the value reported above, and how many seeds gave less, the same and more\\):`));
  const rows = Object.entries(over.quantities);
  assert.ok(rows.length >= 1);
  for (const [name, q] of rows) {
    assert.equal(q.below + q.equal + q.above, n, name);
    assert.ok(q.equal >= 1 && q.reported >= q.min && q.reported <= q.max, name);
    // The counts are consistent with the row's own minimum and maximum.
    assert.equal(q.below === 0, q.reported === q.min, name);
    assert.equal(q.above === 0, q.reported === q.max, name);
    assert.ok(text.includes(`${q.min} / ${q.median} / ${q.max}  reported ${q.reported}: ${q.below} below, ${q.equal} equal, ${q.above} above`), name);
  }
  // The counting itself is stats.ts's placeAmong, pinned by hand in test/stats.test.ts.
  assert.deepEqual(placeAmong(2, [1, 2, 2, 3]), { below: 1, equal: 2, above: 1 });
});

// No report, template or page of this tree that quotes a report states a direction for the error of a percentile
// bracket. The files are the ones that print or quote the wording; the root README is checked by the
// rows that own it.
// The two phrases are put together here, so that a search of the tree for either finds no file but one that still says it.
const WIDTH_CLAIMS = new RegExp([['narrow', 'at small n'].join(' '), ['near', 'the ceiling'].join(' ')].join('|'), 'i');
test('no source file, format page, example page or changelog says which way a bracket errs (the two phrases an earlier wording used)', () => {
  const files = [
    ...readdirSync(join(root, 'src')).map((f) => join('src', f)),
    'docs/JUDGE_CHANGE.md', 'docs/RATINGS_FORMAT.md', 'docs/RUN_FORMAT.md', 'docs/MIGRATIONS.md', 'CHANGELOG.md',
    'examples/refund-bot/README.md', 'examples/judge-change/README.md',
  ];
  for (const f of files) assert.doesNotMatch(readFileSync(join(root, f), 'utf8').replace(/\s+/g, ' '), WIDTH_CLAIMS, f);
  for (const args of [['agree', '--ratings', ex('refund-bot', 'ratings.json')], ['drift', '--old', ex('refund-bot', 'anchor_old.json'), '--new', ex('refund-bot', 'anchor_new.json'), '--flag', 'review,handoff'], ['flips', '--run', ex('refund-bot', 'judged.json')]]) {
    const r = run(...args);
    assert.match(r.stdout, /coverage not checked[;,:]/, args[0]);
    assert.doesNotMatch(r.stdout, /narrow|ceiling/, args[0]);
  }
});
