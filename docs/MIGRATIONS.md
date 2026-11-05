# Migrations

Look up here the version string a file should carry in anchorset 0.3.0, and how a file of 0.2.0 or 0.1.0 moves. Each
format names its version in a `schema` field, and a file with any other version string is invalid input (exit 65).
Later changes of a format will be listed here.

## The version strings at 0.3.0

Files you write:

| Format | Version string | Read by |
|---|---|---|
| Run file | `anchorset.run/v3` | `gate`, `flips`, `judge-change`, `validate` |
| Run-input manifest, from which `write-run` writes a run file | `anchorset.run-input/v1` | `write-run`, `validate --manifest` |
| Settings of a model call (`callShapes`), a part of a run file | `anchorset.callshape/v1` | `gate`, `flips`, `judge-change` |
| Ratings file | `anchorset.ratings/v2` | `agree` |
| Anchor file | `anchorset.anchor/v1` | `drift` |
| Judge-change plan | `anchorset.judge-change-plan/v1` | `judge-change` |
| Reference file | `anchorset.reference/v2` | `judge-change`, when the plan names one |
| Tie-break draws | `anchorset.tie-break/v1` | `judge-change`, when the plan names them |
| Resample indices | `anchorset.resample-indices/v1` | `judge-change`, when the plan names them |
| Study manifest | `anchorset.study/v1` | `node tools/study-check.ts`, in a clone |

Files and output anchorset writes:

| Format | Version string | Written by |
|---|---|---|
| Ledger record | `anchorset.ledger/v3` | `--ledger` |
| `gate` report | `anchorset.gate-report/v2` | `gate --json` |
| `agree` report | `anchorset.agree-report/v2` | `agree --json` |
| `drift` report | `anchorset.drift-report/v2` | `drift --json` |
| `flips` report | `anchorset.flips-report/v2` | `flips --json` |
| `write-run` report | `anchorset.write-run-report/v1` | `write-run --json` |
| `validate` report | `anchorset.validate-report/v1` | `validate --json`, on exit 0 and on exit 2 |
| Refusal | `anchorset.refusal/v2` | Any command with `--json`, when it refuses |

The files you write are described in [RUN_FORMAT.md](RUN_FORMAT.md) (the run-input manifest under "From your eval's
rows"), [RATINGS_FORMAT.md](RATINGS_FORMAT.md) and [JUDGE_CHANGE.md](JUDGE_CHANGE.md), the tie-break draws and resample
indices under "Draws you supply". The study manifest has no page; [`examples/judge-change/manifest.json`](../examples/judge-change/manifest.json) is an example.

## From 0.2.0 to 0.3.0

0.3.0 adds two commands, `write-run` and `validate`, and three version strings. `anchorset.run/v3` and every other
format you write keep their version strings. Two files you may have need a change: an original baseline under
`--rejudge-of` that holds a label the bar does not have, and an input written for the removed example script (both
below).

| Format | Version string | Read or written by |
|---|---|---|
| Run-input manifest, which you write ([RUN_FORMAT.md](RUN_FORMAT.md), "From your eval's rows") | `anchorset.run-input/v1` | `write-run`, `validate --manifest` |
| `write-run` report | `anchorset.write-run-report/v1` | `write-run --json` |
| `validate` report | `anchorset.validate-report/v1` | `validate --json`, on exit 0 and on exit 2 |

The rows file beside the manifest has no version string of its own: it is versioned with the manifest.

`validate --json` prints `"kind": "preflight"`.

Two version strings of reports anchorset writes move up, because each object gains keys. Every key they had keeps its
meaning, and every refusal a command returns keeps its code, its list of fields and its exit code. Three values move:
the code of a split that is not computed, and the `message` of two refusals, which gains a hint (the rubric-only
refusal of `gate`, the one-draw refusal of `flips`). One input now exits 65. All are below:

| Format | Version string | Written by |
|---|---|---|
| `gate` report | `anchorset.gate-report/v2` | `gate --json` |
| Refusal | `anchorset.refusal/v2` | Any command with `--json`, when it refuses |

- **Refusal.** A `gate` refusal on a judge field, or on the rubric of judged runs, between the baseline (or the
  re-judged baseline) and the candidate adds `judgeDiff`; other refusals on a judge field, from `flips` or on the
  original baseline of `--rejudge-of`, do not. `judgeDiff` holds the six judge rows, each
  `same`, `differs`, `unknown` or `no-judge`; whether the served model changed under the same requested name; the
  settings keys that moved; the re-grading size as counts; the other fields that differ or are unknown; and the next
  commands. A refusal on draws that hold no grade (`INCOMPLETE_RUN` from `gate`, `flips` or `judge-change`) adds
  `noGrade`, the counts for each run file by reason. Both add `statements`, the two sentences the text prints. A
  refusal where the system gave no answer adds neither.
- **`gate` report.** With `--rejudge-of`, it adds `judgeFlips`: per class, the baseline cases whose result moved from
  pass to fail and from fail to pass between the two judges, the cases the old judge left without a grade, those cases
  one by one, each judge's own split draws, and `packets`: `recorded`, or `by declaration, not observed` where either
  baseline declares its packets. It is `{ "refused": … }` where the two baselines do not state the same packets, or
  where the old judge's call was rejected (`MEASUREMENT_NOT_RUNNABLE`). When the original baseline, or the candidate,
  holds a draw with no grade or no record, `judgeControl` is now refused as `INCOMPLETE_RUN`, naming the draws
  (`case#draw`), where it was `ITEM_SET_MISMATCH`, naming the cases. `ITEM_SET_MISMATCH` stays for a case that the
  baseline or the candidate holds and the other does not. A draw with no grade in the original baseline is named first,
  as `INCOMPLETE_RUN`; then a case that one run holds and another does not, as `ITEM_SET_MISMATCH`; then a draw with no
  grade in the candidate, as `INCOMPLETE_RUN`. The verdict and the exit code are as
  before, with one exception: an original baseline that is invalid input (a label the bar does not have) now stops
  `gate --rejudge-of` and `validate --rejudge-of` with exit 65 (invalid input) whatever its packets, and also where its
  judge's call was rejected. Before, only an original with recorded packets was read that far, and one with declared or
  unknown packets, or a rejected judge call, gave a verdict over a file that is not valid.
- **`validate` report.** It adds `noGradeByRun` (each run it read, with its judge, its draws that hold no grade by
  reason, and how often its judge was asked again), `judgeFlips` beside `split` (with `packets` when it is computed),
  and `statements`; each entry of `gate.refusals` may add `judgeDiff` or `noGrade`.
- **Ledger.** A `gate` record made with `--rejudge-of` holds `judgeFlips` in its `result`, with its `packets`. `anchorset.ledger/v3` is
  unchanged, and older records still read.
- **`judge-change`.** Its `--json` report is unchanged. The text report adds the counts of each direction, the counts
  behind the share of one judge graded twice, the judge's own variation, and two closing notes; it puts the
  non-compensable classes before the list of items, and reads `not measured (…)` where 0.2.0 read
  `not declared`.

A refusal on the rubric alone, between two judged runs, now ends with the hint to re-judge, as a refusal on any other
judge field does. Its code and fields are as before.

The example script `examples/run-format/write-run.ts` and its input `examples/run-format/input/recorded.json` are
removed; `write-run` takes their place. An input written for the script does not move as it is: write its contents as
a manifest and rows. The run files the script wrote are ordinary `anchorset.run/v3` files and still read.

## From 0.1.0 to 0.2.0

`anchorset.run/v3` keeps its version string, but 0.2.0 holds one rule that 0.1.0 did not: an attempt after a judge's
`parse-failure`, `content-filter` or `client-error` is invalid input ([RUN_FORMAT.md](RUN_FORMAT.md), "What may be
asked again"). A run file that 0.1.0 read and that asked again after one of these must be written again. A call shape
may also state `effort: "none"`; 0.1.0 refuses a file that does, as invalid input. `judge-change` now refuses a run
file with a slot that holds no grade in any class, including classes the report does not read; 0.1.0 checked only
the classes it measured. Under the unchanged `anchorset.refusal/v1`, the `fields` of a `gate` `INCOMPLETE_RUN` now name
slots (`case#draw`) rather than cases.

0.2.0 reads `anchorset.ratings/v2` and refuses a file of `anchorset.ratings/v1`, the version 0.1.0 read. To move one,
change its `schema` and add `raterIdentity` ([RATINGS_FORMAT.md](RATINGS_FORMAT.md), "What the names are").

The reports of 0.1.0 differ too: `agree-report/v2` adds `raterIdentity` and `scope`, and `identityNote` where the names
are not persistent raters; `drift-report/v2` adds `scope`. A ledger holding an `agree` or `drift` record of 0.1.0 no
longer reads; start a new ledger file for those records.

`flips-report/v2` adds `notCompared`. It is always present; unless the run was read with `--stored-outputs`, it holds an
empty `fields` list and zero counts. Nothing else in the report moved.

Two formats have no version string of their own:

- **The bar file.** It is versioned with the run file. A change of the bar format is a change of the run schema,
  so it would change `anchorset.run/v3`.
- **The `judge-change` report.** Its JSON names the run and plan versions it was made under, in `contracts`.
