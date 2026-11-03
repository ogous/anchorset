import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agreementReport,
  cohenKappa,
  fleissKappa,
  gwetAC1,
  gwetAC1Multi,
  jaccard,
  percentAgreement,
  prevalence,
  toCountMatrix,
} from '../src/agreement.ts';
import { InputError, RefusalError } from '../src/errors.ts';
import { hashOf } from '../src/identity.ts';

const close = (a: number | string, b: number, dp: number): void =>
  assert.ok(typeof a === 'number' && Math.abs(a - b) < 0.5 * 10 ** -dp, `${a} != ${b} to ${dp} dp`);

const packets = (raters: string[], items: string[]): Record<string, Record<string, string>> =>
  Object.fromEntries(raters.map((r) => [r, Object.fromEntries(items.map((i) => [i, hashOf({ packet: i })]))]));

/** Two raters from a 2x2 table: both yes, A yes/B no, A no/B yes, both no. */
function table(yy: number, yn: number, ny: number, nn: number, yes = 'yes', no = 'no'): [string[], string[]] {
  const a: string[] = [];
  const b: string[] = [];
  const push = (n: number, x: string, y: string): void => {
    for (let i = 0; i < n; i++) {
      a.push(x);
      b.push(y);
    }
  };
  push(yy, yes, yes);
  push(yn, yes, no);
  push(ny, no, yes);
  push(nn, no, no);
  return [a, b];
}

// The worked example of an encyclopedia article on Fleiss' kappa (10 subjects, 5 categories, 14 raters): a second
// fixture, not a published reference value. The reference is FLEISS_1971 below.
const FLEISS = [
  [0, 0, 0, 0, 14],
  [0, 2, 6, 4, 2],
  [0, 0, 3, 5, 6],
  [0, 3, 9, 2, 0],
  [2, 2, 8, 1, 1],
  [7, 7, 0, 0, 0],
  [3, 2, 6, 3, 0],
  [2, 5, 3, 2, 2],
  [6, 5, 2, 1, 0],
  [0, 2, 2, 3, 7],
];

// The published reference values for Cohen's kappa and for Gwet's AC1, on one table. W. Vach and O. Gerke, "Gwet's AC1
// is not a substitute for Cohen's kappa - A comparison of basic properties", MethodsX 10 (2023), article 102212,
// doi:10.1016/j.mex.2023.102212 (read in full, 2026-10-07). The example is its Table 3, "Minimal agreement and maximal
// disagreement between two raters with a prevalence of 90%", as worked in the section "Gwet's AC1 can be high in the
// case of the minimal possible agreement": "In this case we have gamma = 2 x 0.9 x 0.1 = 0.18 and
// g = (0.8 - 0.18)/(1 - 0.18) = 0.76. Cohen's kappa is, by the way, -0.11 here." (g is the paper's symbol for AC1 and
// gamma for its chance term.) The paper prints the three values to two places, and the pins hold to two places.
//
// The table's cells are not copied from the paper: its Table 3 is an image in the copy that was read. They follow from
// what the text states. Both raters rate 90% positive; the agreement rate is the least possible, 0.8, because "the
// raters can maximally disagree in 20% of the subjects": each rater's 10% negatives fall on the other's positives. So
// of 100 units: both positive 80, A only 10, B only 10, both negative 0. That reading of the table is this test's.
//
// What the pin cannot tell apart: in this table, and in the independence table of the next test, the two raters have
// the same marginal shares, and with equal marginals Cohen's kappa and Scott's pi are the same number. So these two
// pins would also pass on Scott's pi. The test that separates them is the hand-worked 20 / 5 / 10 / 15 fixture below,
// where the raters differ (25 and 30 of 50): Cohen's kappa is 0.400 and Scott's pi, with the pooled share 0.55, is
// (0.70 - 0.505) / (1 - 0.505) = 0.394. The paper prints two places, so each pin holds to within 0.005 and no closer.
//
// What the pin covers: Cohen's kappa for two raters, and AC1 for two raters and two categories, where the chance term
// sum of pi(1 - pi) over (K - 1) is the paper's 2 pi (1 - pi). It does not cover AC1 with three or more categories or
// raters; those rest on the hand-worked fixtures below. Not yet pinned: a worked example in the papers
// that define the coefficients, J. Cohen, "A coefficient of agreement for nominal scales" (1960), 20(1):37-46,
// doi:10.1177/001316446002000104, and K. L. Gwet, "Computing inter-rater reliability and its variance in the presence
// of high agreement" (2008), 61(1):29-48, doi:10.1348/000711006X126600 (each journal is the one its DOI names; the
// records were checked on Crossref, 2026-10-07). Neither paper was read for this test, so no value of theirs is
// written here.
test('Cohen kappa and Gwet AC1 match Vach & Gerke (2023, MethodsX 10:102212), the example of its Table 3 with the cells rebuilt from the text: chance term 0.18, AC1 0.76, kappa -0.11', () => {
  const [a, b] = table(80, 10, 10, 0, 'positive', 'negative');
  const cats = ['negative', 'positive'];
  // The premises the paper states: each rater positive on 90%, agreement 0.8.
  assert.deepEqual(prevalence(a, cats), { negative: 0.1, positive: 0.9 });
  assert.deepEqual(prevalence(b, cats), { negative: 0.1, positive: 0.9 });
  assert.equal(percentAgreement(a, b), 0.8);
  const g = gwetAC1(a, b, cats);
  close(g.pe, 0.18, 2);
  close(g.ac1, 0.76, 2);
  close(cohenKappa(a, b, cats).kappa, -0.11, 2);
  // The same section's premise for kappa, the expected agreement e = piA piB + (1 - piA)(1 - piB), printed as 0.82 for
  // two raters at 90% ("0.9^2 + (1 - 0.9)^2 = 0.82", in the section on why prevalence must be taken into account).
  close(cohenKappa(a, b, cats).pe, 0.82, 2);
});

// The same paper, the section "The need to take the prevalence of positive ratings into account": two raters who rate
// independently, each positive on 70%, agree on 0.7^2 + (1 - 0.7)^2 = 0.58 of the units, and "Cohen's kappa is by
// definition 0, if there is no statistical association between the decisions of the raters". Of 100 units: 49 both
// positive, 21 and 21 split, 9 both negative. The paper prints 0.58; the 0 is its statement of the definition.
test('Cohen kappa is 0 under independence, Vach & Gerke (2023): two raters at 70% positive agree on 0.58 by chance', () => {
  const [a, b] = table(49, 21, 21, 9);
  const k = cohenKappa(a, b, ['no', 'yes']);
  close(k.po, 0.58, 2);
  close(k.pe, 0.58, 2);
  assert.ok(Math.abs(k.kappa) < 1e-12);
});

// A second table, kept as a hand-worked fixture. The 2x2 table 20 / 5 / 10 / 15 (both yes, A yes and B no,
// A no and B yes, both no) with kappa 0.40 is recalled as the worked example of the Wikipedia article "Cohen's kappa"; the article
// was not opened again when this label was written. It is a named source, and it is not a textbook or a paper, which
// is what a published reference value must be here. So the test stands as a hand-worked fixture; the
// published reference value for kappa is the test above. The arithmetic:
//   po = (20 + 15) / 50                      = 0.70
//   A says yes 25 of 50, B says yes 30 of 50
//   pe = 0.5 · 0.6 + 0.5 · 0.4               = 0.50
//   kappa = (0.70 − 0.50) / (1 − 0.50)       = 0.40
test('Cohen: 20/5/10/15 of 50 gives po 0.70, pe 0.50, kappa 0.40 (a hand-worked fixture; the table is the Wikipedia article\'s example)', () => {
  const [a, b] = table(20, 5, 10, 15);
  const k = cohenKappa(a, b);
  close(k.po, 0.7, 3);
  close(k.pe, 0.5, 3);
  close(k.kappa, 0.4, 3);
  close(percentAgreement(a, b), 0.7, 3);
  // This is the table that tells Cohen's kappa from Scott's pi (the raters' marginals differ): pi would be
  // (0.70 − (0.55^2 + 0.45^2)) / (1 − 0.505) = 0.195 / 0.495 = 0.3939, and the value is not that.
  const scottPi = (0.7 - (0.55 ** 2 + 0.45 ** 2)) / (1 - (0.55 ** 2 + 0.45 ** 2));
  close(scottPi, 0.3939, 4);
  assert.ok(Math.abs(k.kappa - scottPi) > 0.005);
});

// The published reference value. J. L. Fleiss, "Measuring nominal scale agreement among many raters",
// 76(5):378-382 (1971), doi:10.1037/h0031619 (the journal is the one the DOI names; volume, issue, pages and DOI
// checked against the Crossref record, 2026-10-07), Table 1 (p. 379): 30 subjects, six raters per subject, five categories. The counts are
// the table's, row by row; its five category names are replaced by their column numbers, j = 1 to 5. The table's own
// checks hold here: every row sums to 6 and the column totals are 26, 26, 30, 55, 43.
const FLEISS_1971 = [
  [0, 0, 0, 6, 0], [0, 3, 0, 0, 3], [0, 1, 4, 0, 1], [0, 0, 0, 0, 6], [0, 3, 0, 3, 0],
  [2, 0, 4, 0, 0], [0, 0, 4, 0, 2], [2, 0, 3, 1, 0], [2, 0, 0, 4, 0], [0, 0, 0, 0, 6],
  [1, 0, 0, 5, 0], [1, 1, 0, 4, 0], [0, 3, 3, 0, 0], [1, 0, 0, 5, 0], [0, 2, 0, 3, 1],
  [0, 0, 5, 0, 1], [3, 0, 0, 1, 2], [5, 1, 0, 0, 0], [0, 2, 0, 4, 0], [1, 0, 2, 0, 3],
  [0, 0, 0, 0, 6], [0, 1, 0, 5, 0], [0, 2, 0, 1, 3], [2, 0, 0, 4, 0], [1, 0, 0, 4, 1],
  [0, 5, 0, 1, 0], [4, 0, 0, 0, 2], [0, 2, 0, 4, 0], [1, 0, 5, 0, 0], [0, 0, 0, 0, 6],
];

test('Fleiss (1971), Table 1: mean agreement .5556 (eq. 4), chance agreement .2201 (eq. 6), kappa .430 (eq. 8)', () => {
  assert.ok(FLEISS_1971.every((row) => row.reduce((s, x) => s + x, 0) === 6));
  assert.deepEqual([0, 1, 2, 3, 4].map((j) => FLEISS_1971.reduce((s, row) => s + (row[j] as number), 0)), [26, 26, 30, 55, 43]);
  // Equation 4 prints the sum of squared counts as 680.
  assert.equal(FLEISS_1971.flat().reduce((s, x) => s + x * x, 0), 680);
  const f = fleissKappa(FLEISS_1971);
  close(f.pBar, 0.5556, 4);
  // The paper squares the category shares as printed to three places (.144, .144, .167, .306, .239) and gets .2201.
  // From the counts the value is 7126 / 32400 = .21994, so this pin holds to three places, not four.
  close(f.peBar, 0.2201, 3);
  close(f.kappa, 0.43, 3);
});

// A hand-worked fixture, not a published reference value: the table is an encyclopedia article's example, and an
// encyclopedia page is not a published worked example. A gap: a published worked example may exist for this
// table, and this test is not pinned to one. Kept because the AC1 and item-pairing tests below use the same table.
test('Fleiss on the encyclopedia table (a hand-worked fixture): P-bar 0.378, Pe-bar 0.213, kappa 0.210', () => {
  const f = fleissKappa(FLEISS);
  // Column totals 20, 28, 39, 21, 32 (140 ratings); sum of squared counts 828; 10 subjects, 14 raters each.
  //   P-bar = 688 / (10·14·13) = 0.37802; Pe-bar = (20²+28²+39²+21²+32²) / 140² = 4170/19600 = 0.21276; kappa = (0.37802 − 0.21276) / (1 − 0.21276) = 0.2099
  close(f.pBar, 0.378, 3);
  close(f.peBar, 0.213, 3);
  close(f.kappa, 0.21, 3);
});

// A hand-worked fixture, not a published reference value: Fleiss' kappa at two ratings per subject, which the report uses
// for two names that are not persistent raters. The data are the Cohen table above (20 both yes, 5 and 10 split, 15 both no).
//   an agreeing subject contributes (2^2 + 0 - 2) / (2 · 1) = 1, a split one (1 + 1 - 2) / (2 · 1) = 0
//   P-bar = (20 + 15) / 50                                 = 0.70
//   shares of all 100 ratings: yes (2·20 + 5 + 10) / 100 = 0.55, no 0.45
//   Pe-bar = 0.55^2 + 0.45^2 = 0.3025 + 0.2025             = 0.505
//   kappa = (0.70 - 0.505) / (1 - 0.505) = 0.195 / 0.495   = 0.39394      (Cohen's kappa on this table is 0.40)
//   AC1, multi-rater form: pe = 2 · 0.55 · 0.45 / (2 - 1)  = 0.495; (0.70 - 0.495) / 0.505 = 0.40594
test('Fleiss kappa at a count of two, a hand-worked fixture: 0.3939 on the Cohen table, with P-bar 0.70, multi-rater AC1 0.4059, and agreementReport gives the same for two positions', () => {
  const [a, b] = table(20, 5, 10, 15);
  const cats = ['no', 'yes'];
  const f = fleissKappa(toCountMatrix(a.map((x, i) => [x, b[i] as string]), cats));
  close(f.pBar, 0.7, 9);
  close(f.peBar, 0.505, 9);
  close(f.kappa, 0.39394, 5);
  const items = a.map((_, i) => `i${i}`);
  const ratings = { r1: Object.fromEntries(items.map((id, i) => [id, a[i] as string])), r2: Object.fromEntries(items.map((id, i) => [id, b[i] as string])) };
  const rep = agreementReport(ratings, { raterIdentity: 'positional', packetHashes: packets(['r1', 'r2'], items), categories: cats, bootstrap: { iterations: 50 } });
  assert.equal(rep.kappaKind, 'fleiss');
  close(rep.kappa, 0.39394, 5);
  close(rep.ac1, 0.40594, 5);
  close(rep.percentAgreement, 0.7, 9);
  assert.deepEqual(rep.pairwise, []);
});

test('Fleiss rejects a varying number of raters per subject', () => {
  assert.throws(() => fleissKappa([[1, 2], [2, 2]]), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
  assert.throws(() => fleissKappa([[1, 0]]), InputError);
  assert.throws(() => fleissKappa([]), InputError);
});

// A hand-worked fixture, not a published reference value; the published one for two-category AC1 is the Vach & Gerke
// test above.
//   po = 0.70, as above
//   share of "yes" over both raters: (25/50 + 30/50) / 2 = 0.55
//   pe = 2 · 0.55 · (1 − 0.55)               = 0.495       (two categories: the sum of pi(1 − pi) over (K − 1) = 1)
//   AC1 = (0.70 − 0.495) / (1 − 0.495)       = 0.205 / 0.505 = 0.40594
test('Gwet AC1 two raters on the Cohen data, a hand-worked fixture: pe 0.495, AC1 0.4059', () => {
  const [a, b] = table(20, 5, 10, 15);
  const g = gwetAC1(a, b, ['no', 'yes']);
  close(g.pe, 0.495, 4);
  close(g.ac1, 0.4059, 4);
});

// A hand-worked fixture, not a published reference value: the same 50 ratings on a scale declared with a third
// category that neither rater used. K enters AC1 and does not enter kappa.
//   shares over both raters: yes 0.55, no 0.45, unsure 0
//   pe = (0.55 · 0.45 + 0.45 · 0.55 + 0 · 1) / (3 − 1) = 0.495 / 2 = 0.2475
//   AC1 = (0.70 − 0.2475) / (1 − 0.2475) = 0.4525 / 0.7525 = 0.60133      (0.40594 on the two-category scale)
//   kappa: the unused category adds 0 · 0 to pe, so it stays 0.40
test('Gwet AC1 depends on the declared number of categories, a hand-worked fixture: 0.4059 on two, 0.6013 on three, kappa 0.40 on both; so the categories are required', () => {
  const [a, b] = table(20, 5, 10, 15);
  const three = ['no', 'unsure', 'yes'];
  close(gwetAC1(a, b, three).pe, 0.2475, 4);
  close(gwetAC1(a, b, three).ac1, 0.6013, 4);
  close(cohenKappa(a, b, three).kappa, 0.4, 9);
  close(cohenKappa(a, b).kappa, 0.4, 9);
  const required = (e: unknown): boolean => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /categories: required/.test(e.problems[0] as string);
  // A caller without the type check (plain JavaScript) is refused, not given the observed labels as the scale.
  assert.throws(() => (gwetAC1 as unknown as (x: string[], y: string[]) => unknown)(a, b), required);
  const items = a.map((_, i) => `i${i}`);
  const ratings = { r1: Object.fromEntries(items.map((id, i) => [id, a[i] as string])), r2: Object.fromEntries(items.map((id, i) => [id, b[i] as string])) };
  assert.throws(() => (agreementReport as (r: unknown, o: unknown) => unknown)(ratings, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2'], items) }), required);
  // The report carries the scale it used, and its AC1 moves with it while its kappa does not.
  const on = (categories: string[]) => agreementReport(ratings, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2'], items), categories, bootstrap: { iterations: 20 } });
  assert.deepEqual(on(three).categories, three);
  close(on(three).ac1, 0.6013, 4);
  close(on(['no', 'yes']).ac1, 0.4059, 4);
  assert.equal(on(three).kappa, on(['no', 'yes']).kappa);
});

test('Gwet AC1 multi-rater equals the two-rater form on two raters', () => {
  const [a, b] = table(20, 5, 10, 15);
  const cats = ['no', 'yes'];
  const matrix = toCountMatrix(a.map((x, i) => [x, b[i] as string]), cats);
  close(gwetAC1Multi(matrix).ac1, gwetAC1(a, b, cats).ac1, 12);
  close(fleissKappa(matrix).pBar, percentAgreement(a, b), 12);
});

// A hand-worked fixture, not a published reference value: the data are the Fleiss example above, and the AC1 on
// them was computed by hand here, from Gwet's multi-rater form pe = sum of pi(1 − pi) over (K − 1).
//   pa: the sum over subjects of sum_k n_k(n_k − 1) is 688, over 10 subjects · 14 · 13 = 1820     = 0.378022
//   column totals 20, 28, 39, 21, 32 of 140 ratings; their squares sum to 4170, and 140^2 = 19600
//   pe = (1 − 4170 / 19600) / (5 − 1)        = 0.787245 / 4 = 0.196811
//   AC1 = (0.378022 − 0.196811) / (1 − 0.196811) = 0.181211 / 0.803189 = 0.22561
test('Gwet AC1 multi-rater on the Fleiss example, a hand-worked fixture (pe = sum pi(1-pi)/(K-1)): AC1 0.2256', () => {
  const g = gwetAC1Multi(FLEISS);
  // Column totals 20, 28, 39, 21, 32 of 140 ratings; sum of P_i numerators 688 over 10 * 14 * 13.
  close(g.pa, 688 / 1820, 9);
  close(g.pe, (1 - 4170 / 19600) / 4, 9);
  close(g.ac1, 0.2256, 4);
});

// The high-prevalence toy, a hand-worked fixture: 90 / 5 / 5 / 0 of 100 (both pass, A only, B only, both fail).
//   po = 90 / 100 = 0.90; each rater says pass 95 of 100
//   kappa: pe = 0.95 · 0.95 + 0.05 · 0.05 = 0.905;  (0.90 − 0.905) / (1 − 0.905) = −0.005 / 0.095 = −0.0526
//   AC1:   pe = 2 · 0.95 · 0.05 = 0.095;            (0.90 − 0.095) / (1 − 0.095) =  0.805 / 0.905 =  0.8895
test('high-prevalence paradox, a hand-worked fixture: kappa is negative while AC1 is high', () => {
  const [a, b] = table(90, 5, 5, 0, 'pass', 'fail');
  const k = cohenKappa(a, b);
  const g = gwetAC1(a, b, ['fail', 'pass']);
  close(k.po, 0.9, 3);
  close(k.kappa, -0.0526, 4);
  close(g.ac1, 0.8895, 4);
  assert.ok(k.kappa < 0);
  assert.ok(g.ac1 > 0.85);
});

test('kappa is NaN when chance agreement is 1', () => {
  assert.ok(Number.isNaN(cohenKappa(['a', 'a'], ['a', 'a']).kappa));
});

test('declared categories are checked', () => {
  assert.throws(() => cohenKappa(['a'], ['z'], ['a', 'b']), (e: unknown) => e instanceof InputError && e.code === 'UNKNOWN_LABEL');
  assert.throws(() => cohenKappa(['a'], ['a', 'b']), InputError);
});

// Hand-worked fixtures, not published reference values; no published reference is claimed for either.
// prevalence is the share of each category among the labels:
//   a, b, a, a: a is 3 of 4                                  = 0.75;  b is 1 of 4 = 0.25
//   a alone, with the categories declared as a and b: a is 1 of 1 = 1;  b is 0 of 1 = 0
// jaccard is |A ∩ B| / |A ∪ B|:
//   {a, b, c} and {b, c, d}: both hold b and c, so 2; together a, b, c, d, so 4; 2 / 4 = 0.5
//   {a} and {}: 0 shared of 1 together                        = 0
//   {} and {}: 0 / 0 has no value; defined by this library as 1 (two empty sets are identical)
test('prevalence and jaccard, hand-worked fixtures: shares 0.75 / 0.25 and 1 / 0; jaccard 2 of 4 = 0.5, 0 of 1 = 0, and 1 for two empty sets by this library\'s definition', () => {
  assert.deepEqual(prevalence(['a', 'b', 'a', 'a']), { a: 0.75, b: 0.25 });
  assert.deepEqual(prevalence(['a'], ['a', 'b']), { a: 1, b: 0 });
  assert.equal(jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  assert.equal(jaccard([], []), 1);
  assert.equal(jaccard(['a'], []), 0);
});


test('agreementReport: two raters give Cohen kappa, AC1, prevalence and a seeded CI', () => {
  const [a, b] = table(20, 5, 10, 15);
  const items = a.map((_, i) => `i${i}`);
  const ratings = { r1: Object.fromEntries(items.map((id, i) => [id, a[i] as string])), r2: Object.fromEntries(items.map((id, i) => [id, b[i] as string])) };
  const rep = agreementReport(ratings, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2'], items), categories: ['no', 'yes'], bootstrap: { iterations: 500, seed: 11 } });
  assert.equal(rep.kappaKind, 'cohen');
  // Two raters: the agreement row is the share of items on which they agree, and the report says which kind it is.
  assert.equal(rep.percentAgreementKind, 'agreeing-share');
  // 500 resamples are below the floor for a level: the two percentiles are kept, and no level is attached to them.
  assert.deepEqual([rep.kappaCI, rep.ac1CI].map((ci) => ci !== 'NA' && ci.nominalLevel), ['NA', 'NA']);
  close(rep.kappa, 0.4, 3);
  close(rep.ac1, 0.4059, 4);
  close(rep.percentAgreement, 0.7, 3);
  close(rep.prevalence['yes'] as number, 0.55, 3);
  assert.ok(rep.kappaCI !== 'NA' && rep.kappaCI.lo < 0.4 && rep.kappaCI.hi > 0.4 && rep.kappaCI.seed === 11);
  // AC1 gets an interval like kappa's, from the same seed, and the resampling is stated on the report.
  assert.ok(rep.ac1CI !== 'NA' && rep.ac1CI.lo < 0.4059 && rep.ac1CI.hi > 0.4059 && rep.ac1CI.seed === 11 && rep.ac1CI.iterations === 500);
  assert.deepEqual(rep.bootstrap, { iterations: 500, seed: 11, alpha: 0.05 });
  // With two raters the one pairwise row is the headline: the same block, the same resamples.
  const [row] = rep.pairwise;
  assert.ok(row !== undefined);
  assert.deepEqual([row.a, row.b, row.kappa, row.ac1, row.percentAgreement, row.prevalence, row.kappaCI, row.ac1CI], ['r1', 'r2', rep.kappa, rep.ac1, rep.percentAgreement, rep.prevalence, rep.kappaCI, rep.ac1CI]);
  // Each reader's own shares: A says yes 25 of 50, B says yes 30 of 50 (the chance term of kappa uses these).
  assert.deepEqual(row.marginals, { a: { no: 0.5, yes: 0.5 }, b: { no: 0.4, yes: 0.6 } });
  // Wilson on the agreeing share 35/50, a hand-worked fixture (the formula's arithmetic, not a published value): centre (0.7 + 3.8415/100) / (1 + 3.8415/50) = 0.68573;
  //   half-width (1.95996 / 1.07683) · sqrt(0.7·0.3/50 + 3.8415/10000) = 1.82012 · 0.067708 = 0.12324; so [0.5625, 0.8090].
  close(row.percentAgreementWilson.lo, 0.5625, 4);
  close(row.percentAgreementWilson.hi, 0.809, 4);
  assert.deepEqual(agreementReport(ratings, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2'], items), categories: ['no', 'yes'], bootstrap: { iterations: 500, seed: 11 } }), rep);
  // From 1,000 resamples the brackets carry their nominal level, 1 − alpha.
  const levelled = agreementReport(ratings, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2'], items), categories: ['no', 'yes'], bootstrap: { iterations: 1000, seed: 11 } });
  assert.ok(levelled.kappaCI !== 'NA' && levelled.kappaCI.nominalLevel === 0.95 && levelled.ac1CI !== 'NA' && levelled.ac1CI.nominalLevel === 0.95);
  for (const p of levelled.pairwise) assert.ok(p.kappaCI !== 'NA' && p.kappaCI.nominalLevel === 0.95);
});

// The high-prevalence case, a hand-worked fixture: two raters, 20 items, every label "ok" except one of rater B's.
// Kappa is undefined on a resample that misses that one item, since both raters are then constant: (19/20)^20 = 0.358
// of resamples. So of 1,000 resamples about 640 are left for kappa's percentiles, fewer than the 1,000 a level is
// named from, while AC1 is defined on every one. On seed 1 the count is 367 (the seeded generator's, pinned as such).
test('agreementReport: at high prevalence kappa is undefined on about a third of resamples, so its bracket from 1,000 resamples has no level while AC1 keeps 95% (a hand-worked fixture)', () => {
  const items = Array.from({ length: 20 }, (_, i) => `i${i}`);
  const ratings = { A: Object.fromEntries(items.map((id) => [id, 'ok'])), B: Object.fromEntries(items.map((id, i) => [id, i === 0 ? 'bad' : 'ok'])) };
  const at = (iterations: number) => agreementReport(ratings, { raterIdentity: 'persistent', packetHashes: packets(['A', 'B'], items), categories: ['ok', 'bad'], bootstrap: { iterations, seed: 1 } });
  const rep = at(1000);
  assert.ok(rep.kappaCI !== 'NA' && rep.ac1CI !== 'NA');
  assert.deepEqual([rep.kappaCI.iterations, rep.kappaCI.undefinedResamples, rep.kappaCI.nominalLevel], [1000, 367, 'NA']);
  assert.ok(Math.abs(rep.kappaCI.undefinedResamples / 1000 - 0.95 ** 20) < 0.03);
  assert.deepEqual([rep.ac1CI.undefinedResamples, rep.ac1CI.nominalLevel], [0, 0.95]);
  const [row] = rep.pairwise;
  assert.ok(row !== undefined && row.kappaCI !== 'NA' && row.kappaCI.nominalLevel === 'NA' && row.ac1CI !== 'NA' && row.ac1CI.nominalLevel === 0.95);
  // 2,000 resamples leave about 1,280 for kappa, above the floor: the level is back.
  const more = at(2000);
  assert.ok(more.kappaCI !== 'NA' && 2000 - more.kappaCI.undefinedResamples >= 1000 && more.kappaCI.nominalLevel === 0.95);
});

// A hand-worked fixture, not a published reference value: four items, three raters, two categories.
//   item 1: a a a   three agreeing pairs of three                 P_1 = 1
//   item 2: a a b   one agreeing pair of three                    P_2 = 1/3
//   item 3: a b b   one agreeing pair of three                    P_3 = 1/3
//   item 4: b b b                                                 P_4 = 1
//   mean pairwise agreement (Fleiss' P-bar) = (1 + 1/3 + 1/3 + 1) / 4 = 2/3 = 0.6667
//   items on which all three agree: 2 of 4 = 0.5, which is a different number and is not what the report holds
test('agreementReport with three raters, a hand-worked fixture: the agreement row is the mean pairwise agreement 0.6667, named as such, not the all-agree share 0.5', () => {
  const items = ['i1', 'i2', 'i3', 'i4'];
  const col = (v: string): Record<string, string> => Object.fromEntries(items.map((id, i) => [id, v[i] as string]));
  const ratings = { r1: col('aaab'), r2: col('aabb'), r3: col('abbb') };
  const rep = agreementReport(ratings, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2', 'r3'], items), categories: ['a', 'b'], bootstrap: { iterations: 20 } });
  assert.equal(rep.kappaKind, 'fleiss');
  assert.equal(rep.percentAgreementKind, 'mean-pairwise');
  close(rep.percentAgreement, 2 / 3, 9);
  const allAgree = items.filter((id) => new Set([ratings.r1[id], ratings.r2[id], ratings.r3[id]]).size === 1).length / items.length;
  assert.equal(allAgree, 0.5);
  assert.ok(rep.percentAgreement > allAgree);
  // The pairwise rows stay plain agreeing shares: r1 and r2 differ on i3 only, r1 and r3 on i2 and i3.
  assert.deepEqual(rep.pairwise.map((p) => [p.a, p.b, p.percentAgreement]), [['r1', 'r2', 0.75], ['r1', 'r3', 0.5], ['r2', 'r3', 0.75]]);
});

// Pinned to the encyclopedia table (FLEISS above): a cross-check fixture, not a published reference value. Its kappa
// 0.210 and its hand-worked AC1 0.2256 are the values of the two tests above that use the same table.
test('agreementReport: three or more raters use Fleiss kappa and multi-rater AC1 (on the encyclopedia table, a fixture and not the reference)', () => {
  const items = FLEISS.map((_, i) => `s${i}`);
  const cats = ['c1', 'c2', 'c3', 'c4', 'c5'];
  const ratings: Record<string, Record<string, string>> = {};
  for (let r = 0; r < 14; r++) ratings[`r${String(r).padStart(2, '0')}`] = {};
  FLEISS.forEach((row, i) => {
    const labels = row.flatMap((n, j) => Array.from({ length: n }, () => cats[j] as string));
    labels.forEach((l, r) => ((ratings[`r${String(r).padStart(2, '0')}`] as Record<string, string>)[items[i] as string] = l));
  });
  const rep = agreementReport(ratings, { raterIdentity: 'persistent', packetHashes: packets(Object.keys(ratings), items), categories: cats, bootstrap: { iterations: 200 } });
  assert.equal(rep.kappaKind, 'fleiss');
  close(rep.kappa, 0.21, 3);
  assert.equal(rep.pairwise.length, 91);
  close(rep.ac1, 0.2256, 4);
  assert.ok(rep.ac1CI !== 'NA' && rep.ac1CI.lo <= 0.2256 && rep.ac1CI.hi >= 0.2256 && rep.ac1CI.seed === 0);
});

// The high-prevalence toy as a pairwise row, a hand-worked fixture (arithmetic above): 90 / 5 / 5 / 0 of 100.
//   pooled prevalence: pass (95 + 95) / 200 = 0.95, fail 0.05
test('no pairwise row is a lone kappa: each carries AC1, prevalence and a seeded interval for both; kappa -0.0526 sits beside AC1 0.8895 and prevalence 0.95', () => {
  const [a, b] = table(90, 5, 5, 0, 'pass', 'fail');
  const items = a.map((_, i) => `i${String(i).padStart(3, '0')}`);
  const col = (v: string[]): Record<string, string> => Object.fromEntries(items.map((id, i) => [id, v[i] as string]));
  // A third rater who agrees with the first, so the report has three pairwise rows.
  const ratings = { r1: col(a), r2: col(b), r3: col(a) };
  const rep = agreementReport(ratings, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2', 'r3'], items), categories: ['fail', 'pass'], bootstrap: { iterations: 300, seed: 5 } });
  assert.equal(rep.pairwise.length, 3);
  const row = rep.pairwise.find((p) => p.a === 'r1' && p.b === 'r2');
  assert.ok(row !== undefined);
  close(row.kappa, -0.0526, 4);
  close(row.ac1, 0.8895, 4);
  close(row.percentAgreement, 0.9, 3);
  assert.deepEqual(row.prevalence, { fail: 0.05, pass: 0.95 });
  for (const p of rep.pairwise) {
    assert.equal(typeof p.ac1, 'number');
    assert.deepEqual(Object.keys(p.prevalence), ['fail', 'pass']);
    for (const ci of [p.kappaCI, p.ac1CI]) assert.ok(ci !== 'NA' && ci.seed === 5 && ci.iterations === 300 && ci.lo <= ci.hi);
  }
  // Identical raters: kappa 1 on every resample where it is defined; a resample with one label only is counted, not hidden.
  const same = rep.pairwise.find((p) => p.a === 'r1' && p.b === 'r3');
  assert.ok(same !== undefined && same.kappa === 1 && same.kappaCI !== 'NA' && same.kappaCI.lo === 1 && same.kappaCI.hi === 1);
  assert.ok(same.kappaCI.undefinedResamples >= 0);
  // No item disagrees: the bootstrap is degenerate at 1, and the Wilson interval of 100/100 still has width: 100 / (100 + 3.8415) = 0.9630.
  assert.equal(same.percentAgreement, 1);
  close(same.percentAgreementWilson.lo, 0.963, 4);
  assert.equal(same.percentAgreementWilson.hi, 1);
  // Relabelling the categories moves no coefficient and no interval.
  const swap = (r: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === 'pass' ? 'P' : 'F']));
  const relabelled = agreementReport({ r1: swap(ratings.r1), r2: swap(ratings.r2), r3: swap(ratings.r3) }, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2', 'r3'], items), categories: ['F', 'P'], bootstrap: { iterations: 300, seed: 5 } });
  assert.deepEqual([relabelled.kappa, relabelled.ac1, relabelled.kappaCI, relabelled.ac1CI], [rep.kappa, rep.ac1, rep.kappaCI, rep.ac1CI]);
  assert.deepEqual(relabelled.pairwise.map((p) => [p.kappa, p.ac1, p.kappaCI, p.ac1CI]), rep.pairwise.map((p) => [p.kappa, p.ac1, p.kappaCI, p.ac1CI]));
});

test('agreementReport refuses differing packet hashes', () => {
  const items = ['i1', 'i2'];
  const ph = packets(['r1', 'r2'], items);
  (ph['r2'] as Record<string, string>)['i2'] = hashOf({ packet: 'i2', view: 'different' });
  assert.throws(
    () => agreementReport({ r1: { i1: 'a', i2: 'b' }, r2: { i1: 'a', i2: 'a' } }, { raterIdentity: 'persistent', packetHashes: ph, categories: ['a', 'b'] }),
    (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH' && e.fields.join() === 'i2',
  );
  const missing = packets(['r1'], items);
  assert.throws(() => agreementReport({ r1: { i1: 'a', i2: 'b' }, r2: { i1: 'a', i2: 'a' } }, { raterIdentity: 'persistent', packetHashes: missing, categories: ['a', 'b'] }), RefusalError);
});

test('agreementReport refuses raters who rated different items', () => {
  assert.throws(
    () => agreementReport({ r1: { i1: 'a', i2: 'b' }, r2: { i1: 'a' } }, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2'], ['i1', 'i2']), categories: ['a', 'b'] }),
    (e: unknown) => e instanceof RefusalError && e.code === 'ITEM_SET_MISMATCH',
  );
});

test('agreementReport: a caller that omits the packet hashes is refused as a missing hash is, and a rater map that is not rater -> item -> label is invalid input; never a bare TypeError', () => {
  const items = ['i1', 'i2'];
  const ratings = { r1: { i1: 'yes', i2: 'no' }, r2: { i1: 'yes', i2: 'yes' } };
  const categories = ['no', 'yes'];
  // No hashes at all is a gap like any other (driftReport refuses it the same way), naming every item.
  for (const packetHashes of [undefined, null, 'abc', {}]) {
    assert.throws(
      () => agreementReport(ratings, { packetHashes, categories, raterIdentity: 'persistent' } as never),
      (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH' && e.fields.join(',') === 'i1,i2',
      String(packetHashes),
    );
  }
  assert.throws(() => agreementReport(ratings, { categories, raterIdentity: 'persistent' } as never), (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH');
  // A rater map of another shape names the argument.
  for (const bad of [undefined, null, 'ab', [], { r1: null, r2: { i1: 'x' } }, { r1: { i1: 'yes' }, r2: 'no' }, { r1: [], r2: {} }]) {
    assert.throws(
      () => agreementReport(bad as never, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2'], items), categories }),
      (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems.length === 1 && e.problems[0]?.startsWith('agreementReport: ratingsByRater: must map rater -> item -> label') === true,
      JSON.stringify(bad),
    );
  }
});

test('agreementReport names the items that are not rated by every rater, and the raters that lack them, whichever rater is first by name', () => {
  const items = ['t1', 't2', 't3'];
  const full = { t1: 'a', t2: 'b', t3: 'a' };
  const fewer = { t1: 'a', t2: 'b' };
  for (const [lacking, odd] of [['rater-a', true], ['rater-c', false]] as const) {
    const ratings = { 'rater-a': odd ? fewer : full, 'rater-b': full, 'rater-c': odd ? full : fewer };
    assert.throws(
      () => agreementReport(ratings, { raterIdentity: 'persistent', packetHashes: packets(['rater-a', 'rater-b', 'rater-c'], items), categories: ['a', 'b'] }),
      (e: unknown) =>
        e instanceof RefusalError &&
        e.code === 'ITEM_SET_MISMATCH' &&
        e.fields.join() === 't3' &&
        e.message === `ITEM_SET_MISMATCH: raters did not rate the same items: t3 (not rated by ${lacking})`,
      `the rater that lacks t3 is ${lacking}`,
    );
  }
  // Several items and several raters: each item once, sorted, with its own raters.
  assert.throws(
    () => agreementReport({ r1: { i1: 'a', i2: 'b', i3: 'a' }, r2: { i1: 'a', i3: 'a' }, r3: { i2: 'b', i3: 'a' } }, { raterIdentity: 'persistent', packetHashes: packets(['r1', 'r2', 'r3'], ['i1', 'i2', 'i3']), categories: ['a', 'b'] }),
    (e: unknown) => e instanceof RefusalError && e.fields.join() === 'i1,i2' && e.message === 'ITEM_SET_MISMATCH: raters did not rate the same items: i1 (not rated by r3), i2 (not rated by r2)',
  );
});
