# Migrations

Look up here the version string a file should carry in anchorset 0.2.0, and how a file of 0.1.0 moves. Each format
names its version in a `schema` field, and a file with any other version string is invalid input (exit 65). Later
changes of a format will be listed here.

## The version strings at 0.2.0

Files you write:

| Format | Version string | Read by |
|---|---|---|
| Run file | `anchorset.run/v3` | `gate`, `flips`, `judge-change` |
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
| `gate` report | `anchorset.gate-report/v1` | `gate --json` |
| `agree` report | `anchorset.agree-report/v2` | `agree --json` |
| `drift` report | `anchorset.drift-report/v2` | `drift --json` |
| `flips` report | `anchorset.flips-report/v2` | `flips --json` |
| Refusal | `anchorset.refusal/v1` | Any command with `--json`, when it refuses |

The files you write are described in [RUN_FORMAT.md](RUN_FORMAT.md), [RATINGS_FORMAT.md](RATINGS_FORMAT.md) and
[JUDGE_CHANGE.md](JUDGE_CHANGE.md), the tie-break draws and resample indices under "Draws you supply". The study
manifest has no page; [`examples/judge-change/manifest.json`](../examples/judge-change/manifest.json) is an example.

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
