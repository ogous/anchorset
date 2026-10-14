# Migrations

Look up here the version string a file should carry in anchorset 0.1.0. These version numbers are the first public
ones. Each format names its version in a `schema` field, and a file with any other version string is invalid input
(exit 65). Later changes of a format will be listed here.

## The version strings at 0.1.0

Files you write:

| Format | Version string | Read by |
|---|---|---|
| Run file | `anchorset.run/v3` | `gate`, `flips`, `judge-change` |
| Settings of a model call (`callShapes`), a part of a run file | `anchorset.callshape/v1` | `gate`, `flips`, `judge-change` |
| Ratings file | `anchorset.ratings/v1` | `agree` |
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
| `agree` report | `anchorset.agree-report/v1` | `agree --json` |
| `drift` report | `anchorset.drift-report/v1` | `drift --json` |
| `flips` report | `anchorset.flips-report/v1` | `flips --json` |
| Refusal | `anchorset.refusal/v1` | Any command with `--json`, when it refuses |

The files you write are described in [RUN_FORMAT.md](RUN_FORMAT.md), [RATINGS_FORMAT.md](RATINGS_FORMAT.md) and
[JUDGE_CHANGE.md](JUDGE_CHANGE.md), the tie-break draws and resample indices under "Draws you supply". The study
manifest has no page; [`examples/judge-change/manifest.json`](../examples/judge-change/manifest.json) is an example.

Two formats have no version string of their own:

- **The bar file.** It is versioned with the run file. A change of the bar format is a change of the run schema,
  so it would change `anchorset.run/v3`.
- **The `judge-change` report.** Its JSON names the run and plan versions it was made under, in `contracts`.
