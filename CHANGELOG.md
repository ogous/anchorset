# Changelog

All notable changes to this project are recorded here. Each file format carries its own schema string;
`docs/MIGRATIONS.md` lists them, and from 0.1.0 on it says how a file moves when one changes.

## 0.2.0 (2026-11-03)

What changed since 0.1.0. A file that 0.1.0 read may need a change before 0.2.0 reads it: `docs/MIGRATIONS.md` says
which, and how to move it.

### Commands

- **`anchorset flips`** refuses a run with a judge unless its rubric and judge are known. 0.1.0 printed figures for
  such a run.
- **`anchorset flips --stored-outputs system-side-not-compared`** is new: it reads answers from stored files, whose
  system stop nobody saw, and says so first.

### File formats

- Ratings files are `anchorset.ratings/v2`, in place of `anchorset.ratings/v1`. A ratings file must say what its names
  are (`raterIdentity`). Where they are not persistent raters, `agree` prints no row for a pair and uses Fleiss' kappa,
  multi-rater AC1 and mean pairwise observed agreement at any number of names.
- The run file keeps `anchorset.run/v3`, with one rule tightened: a judge's `parse-failure`, `content-filter` and
  `client-error` are final, and an attempt after one is invalid input. A file that 0.1.0 read and that asked again
  after one must be written again.
- A call shape may state `effort: "none"`.

### Reports

- Every `agree` report says that its figures describe that file only, and every `drift` report says that the tool
  cannot show that both sets of ratings came from one judge. In `--json` each sentence is `scope`, under
  `anchorset.agree-report/v2` and `anchorset.drift-report/v2`.
- `anchorset.flips-report/v2` adds `notCompared`.
- A ledger holding an `agree` or `drift` record of 0.1.0 no longer reads: start a new ledger file for those records.

### Refusals

- `gate` refuses a baseline holding a slot where the system gave no answer (a rejected request or its own error); an
  answer cut at its cap stays a failing reference.
- `INCOMPLETE_RUN`, for slots that hold no grade, counts each run file by reason, and on `gate` its fields name every
  slot rather than every case.
- `judge-change` refuses a run file with a slot that holds no grade in any class, including classes the report does
  not read. 0.1.0 checked only the classes it measured.

### Library

- `agreementReport` requires `raterIdentity` in its options (`"persistent"`, `"positional"` or `"UNKNOWN"`) and
  refuses a call without it. Its report adds `raterIdentity` and `scope`, and `identityNote` where the names are not
  persistent raters.
- `repeatFlips` refuses a run with a judge unless its rubric and judge are known, and takes an optional third
  argument, `{ storedOutputs }`.
- New type exports: `RaterIdentity` and `RepeatFlipOptions`.

### Example importers

- promptfoo 0.125.1 and inspect_ai 0.3.286 are tested beside 0.123.1 and 0.3.275, against a local stand-in of the
  provider. The list is
  `examples/importers/tested-versions.json`; any other version is refused, and a later removal is a line here.
- The re-ask bound the user states now also enters `judgeDefinitionHash`; it already entered `judgeHarnessVersion`.
  The example plans are re-pinned.
- The Inspect script checks the tested-versions list and the answer count the log states before any call, and records
  the system log.
- The logs that record the grading prompts of the newly tested versions carry the same terms as the earlier ones
  (`Apache-2.0 AND MIT`; `NOTICE`, `REUSE.toml`).

### In the repository

- CI runs the importer tests once for each pair of tested versions in `examples/importers/tested-versions.json`.
- A weekly workflow (`.github/workflows/tool-watch.yml`) asks whether promptfoo or inspect_ai has a release the list
  does not hold, and tries it at zero spend with `examples/importers/watch-candidate.sh`. It reports and never adds to
  the list.
- `tools/study-check.ts` says when a report equals the first run's but for the tool version.

## 0.1.0 (2026-10-16)

The first public version. Nothing was published before it, so this entry is an inventory of what ships, not a list
of changes.

### Commands

- **`anchorset gate`**: did the new version get worse? A pass or fail verdict on a pass bar, case by case.
- **`anchorset agree`**: do the graders agree with each other?
- **`anchorset drift`**: how do two readings of a fixed set of items by one judge differ?
- **`anchorset flips`**: in how many cases do repeat gradings not all get the same label?
- **`anchorset judge-change`**: what does replacing the judge do to the labels, on the same stored answers?

`gate` is the only one with a verdict. The other four are measurements. `docs/CLI.md` has the options and the exit
codes.

### File formats

- The run file, `anchorset.run/v3` (`docs/RUN_FORMAT.md`), read by `gate`, `flips` and `judge-change`.
- The rating files, `anchorset.ratings/v1` and `anchorset.anchor/v1` (`docs/RATINGS_FORMAT.md`), read by `agree` and
  `drift`.
- The judge-change plan and the reference file (`docs/JUDGE_CHANGE.md`).
- `docs/MIGRATIONS.md` lists every version string.

### The package

- Node 22.21 or later. No runtime dependencies. The package ships compiled JavaScript with type declarations.

### In the repository, mostly not in the npm package

- **Examples** on made-up data: a refund bot (`examples/refund-bot/`), a judge change (`examples/judge-change/`)
  and a script that writes a run file (`examples/run-format/`). The package ships only the `.json` files and README
  of the refund bot, and the `.json` files directly in `examples/run-format/` (`run.json` and `bar.json`). The
  scripts, the judge-change example and `examples/run-format/input/` need a clone.
- **Example importers** (`examples/importers/`, guide in `docs/IMPORTERS.md`): for promptfoo 0.123.1, for
  inspect_ai 0.3.275 and for the result folder of Claude's eval-building skill. They work with Anthropic models
  only.

### Licence

Apache-2.0 for the code; CC-BY-4.0 for the documentation (the READMEs under `examples/` follow the code licence). Two
files copied from inspect_ai 0.3.275 (its grading texts) are under that tool's MIT licence; the logs that record the
grading prompts of that tool and of promptfoo 0.123.1 carry the MIT licence of those tools beside Apache-2.0 for the rest
of each file (`Apache-2.0 AND MIT`), with their copyright lines (`NOTICE`, `LICENSES/MIT.txt`). `REUSE.toml` maps every path to its licence.
