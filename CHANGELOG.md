# Changelog

All notable changes to this project are recorded here. Each file format carries its own schema string;
`docs/MIGRATIONS.md` lists them, and from 0.1.0 on it says how a file moves when one changes.

## 0.4.0 (2026-11-07)

What changed since 0.3.0. The library and its seven commands are unchanged: every format `anchorset` reads or writes
keeps its version string, and every file the 0.3.0 commands read, the 0.4.0 commands still read. The changes are in the example importers and grading
scripts under `examples/importers/` (run from a checkout; the npm package does not hold them), in a new guide for
promptfoo users, and in how the Claude Code plugin is served. One grader record moves up, so a grader result written
before this version must be graded again or imported with the checkout that wrote it; `docs/MIGRATIONS.md` says how.

### Example grading scripts: a second API

- **The example grading scripts speak a second API.** `grader-provider.cjs` (promptfoo and the skill's folder) and
  `recording_grader.py` (Inspect) take a required setting `wire`: `anthropic-messages/v1` (Anthropic's Messages API) or
  `openai-responses/v1` (OpenAI's own Responses API). It has no default. An OpenAI judge states `max_output_tokens` (16
  or more; `--max-tokens` on `regrade.py` and `regrade.ts`), `effort`, `verbosity` and `maxReasks`; the key is read from
  `OPENAI_API_KEY`. Every OpenAI request sends `store: false` and `truncation: "disabled"`.
- **The grader record is `example.grader-evidence/v8`.** It adds `wire`. `judgeHarnessVersion` now ends with
  `; wire <name>` (the skill's folder keeps its `script-files` part last), so a switch from a Claude judge to a GPT
  judge moves `judgeModelRequested`, `judgeModelServed`, `judgeCallShapeHash` and `judgeHarnessVersion`, and not
  `judgeDefinitionHash`. One run file holds one wire.
- **`regrade.py` and `skill-evals/regrade.ts` require `--wire`.** A flag of the other wire is a usage error (exit 64):
  `--thinking` and `--api-version` belong to Anthropic's wire, `--verbosity` to OpenAI's.
- **Every importer prints `wire: <name>`**, a statement of the served model name (the same text as the requested name,
  or the name the provider gave), and a reasoning line in place of the thinking line: asks with reasoning, and the
  total, median and largest reasoning-token count, each provider's own count.
- **What the importers read of an OpenAI reply.** A completed message whose `phase` is absent or exactly
  `final_answer`; any other phase is refused at import. A reply that is `incomplete` for a reason other than the output
  cap, or that holds a refusal part, is never graded and never asked again; the import refuses the file and names the
  draw.
- **`examples/importers/make-plan.ts` prints a note on standard error** when the two run files were graded through
  different APIs, or when one names no wire. The plan is still written.
- **The grading scripts check four OpenAI address variables**, in all three paths (promptfoo's grader, `regrade.py`
  and `skill-evals/regrade.ts`): `OPENAI_BASE_URL`, `OPENAI_API_BASE_URL` and `OPENAI_API_HOST`, the three that
  promptfoo's code reads for an OpenAI address, as read on 2026-11-07 in 0.125.1, and `OPENAI_HOST`. Any one that is
  set and differs from the address you give, or is set when you give none, stops the grader before any call. For the
  two `HOST` variables the message says to unset the variable.
- **The stand-in** (`fake-endpoint.ts`) answers the Responses route (`/v1/responses`) with the modes the tests need.
- **What ran against OpenAI's API**, on 2026-11-06, in two short checks with one draw per call: 13 requests through the
  JavaScript grading script and 2 through the Python one, with `inspect_ai` 0.3.286; the second check imported one case
  on each of the eval-skill and Inspect paths. Not run against OpenAI's API: a `promptfoo eval` run, a comparison of two
  judges, more than one draw, and the rate-limit, server-error and timeout paths. `docs/IMPORTERS.md` lists the models
  and what each answered.

### promptfoo

- **`docs/PROMPTFOO.md`** is new: for a promptfoo user whose `llm-rubric` judge is about to change, the steps from a
  result file of their own system to the `judge-change` report, with an OpenAI config line and the `--judge-moves` of
  a switch from a Claude judge to a GPT judge.
- **`examples/importers/promptfoo/stored-from-result.ts`** is new: `--in <result.json> --out <stored.json>` writes the
  stored answers, one per case, from a result file of a run of your system (`promptfoo eval -o`), and prints the
  stored file's sha256. It copies none of the grades the file may hold, never overwrites `--out`, and refuses a file from an untested promptfoo
  version, with more than one prompt or provider, with a tool error, with two different answers for one case, or with
  a case whose variables differ between rows.
- The promptfoo importer, and `stored-from-result.ts`, refuse a file in which `defaultTest`, a test, or a row's
  `testCase` names its own `provider` or a fixed `providerOutput`, since that answer does not come from the suite's one
  provider.

### Claude Code plugin

- The catalog (`.claude-plugin/marketplace.json`) no longer serves the default branch. It names one commit of the
  repository by its full hash (`git-subdir`, the repository's URL, path `plugin`, `sha`), so an install gets the plugin
  text of one release, and an update comes with a new plugin version. In this release's commit the catalog names, by
  `sha` alone, a commit after the v0.3.0 tag that holds 0.3.0's plugin, so an install from it gets 0.3.0's skill,
  which runs `npx anchorset@0.3.0`. A later commit, made once npm serves 0.4.0, moves the pin to this release's commit
  and adds its tag as `ref`.
- The plugin's skill in `plugin/` runs `npx anchorset@0.4.0` and names the OpenAI path and `stored-from-result.ts`;
  the catalog serves it from that later commit on.

### Docs

- `docs/IMPORTERS.md` has a new section, "Two APIs, and a switch between them": each API's settings, what a switch
  moves, and what ran.
- `docs/RUN_FORMAT.md`, under "Finish reasons", has a table for OpenAI's Responses API.
- `docs/JUDGE_CHANGE.md`, under Limits: across two providers the report measures the change of the grading path, not of
  the model alone.
- README and `llms.txt` name the promptfoo guide; the npm package holds it at `node_modules/anchorset/docs/`.

## 0.3.0 (2026-11-05)

What changed since 0.2.0. `anchorset.run/v3` and the other formats you write keep their version strings, and every
file that 0.2.0 read still reads but one: an original baseline under `--rejudge-of` holding a label the bar does not
have now exits 65 whatever its packets (below). Two report formats move up because they gain keys;
`docs/MIGRATIONS.md` lists them.

### Commands

- **`anchorset write-run`** is new: `write-run --manifest <manifest.json> --grades <rows.jsonl> --out <run.json>`
  writes one `anchorset.run/v3` file from a manifest you write (`anchorset.run-input/v1`) and one JSON line per
  attempt. It never overwrites `--out`, lists every input problem with its place, and writes nothing on invalid input
  (exit 65). The manifest can state which call settings were sent (`settings.sent`, with every other key `NOT_SENT`)
  and how the judge's reply stopped (`judge.gradedReplyStop`); `write-run` and `validate` print each statement used.
- **`anchorset validate`** is new. Given `--run` and `--bar`, or `--manifest` and `--grades`, it says whether `gate`
  would admit the run, listing every reason it would refuse it (exit 0 or 2), and whether `flips`, the re-judge split
  and `judge-change` would read it. It counts the slots with no grade in every run it reads, by reason, beside the
  judge's retries.
- **`gate`**, when it refuses on a judge field, or on the rubric of judged runs, prints the judge diff: the six judge
  fields, each the same, different or unknown; a separate line when the served model changed under the same requested
  name; the judge settings that moved; how much a re-grade takes, as counts; and the next three commands, with your
  own paths.
- **`gate --rejudge-of`** prints the judge-flip list: per class, with non-compensable classes first, the baseline cases
  whose result moved from pass to fail and from fail to pass between the two judges, each direction counted apart and
  never netted, the cases the old judge left without a grade in their own column, and each judge's own variation
  between draws beside them. It is computed only where both baselines state the same packets; where either declares
  its packets rather than recording them, the list says "by declaration, not observed".
- With one draw per case, `gate` says under its table that each effect includes the judge's own variation, which one
  draw cannot measure, and its BROKE and FIXED rows name the draw. `flips` says how to measure the change (draw each
  case at least twice). Codes and fields are unchanged.
- **`judge-change`**: the text report adds the counts in each direction, the counts behind the share of one judge
  graded twice, the judge's own variation, and two closing notes, and puts the non-compensable classes before the list
  of items. It reads `not measured (…)` where 0.2.0 read `not declared`. The `--json` report is unchanged.

### Reports

- `anchorset.gate-report/v2`, in place of `v1`: with `--rejudge-of` it adds `judgeFlips`. The ledger record of such a
  gate holds it too; `anchorset.ledger/v3` is unchanged.
- `anchorset.refusal/v2`, in place of `v1`: a `gate` refusal on a judge field, or on the rubric of judged runs,
  between the baseline and the candidate adds `judgeDiff`, and a refusal on slots with no grade (`INCOMPLETE_RUN` from
  `gate`, `flips` or `judge-change`) adds `noGrade`, the counts per run file and reason. Both add `statements`, the two
  sentences the text prints. Every key that `v1` had keeps its meaning, and its value too except `message`, which
  gains a hint on two refusals (the rubric-only refusal of `gate` and the one-draw refusal of `flips`, below).
- New: `anchorset.write-run-report/v1` (`write-run --json`) and `anchorset.validate-report/v1` (`validate --json`, on
  exit 0 and on exit 2).
- Two sentences, that agreement between judges is not evidence of correctness and that identities are as declared in
  the run files (anchorset calls no model and cannot verify what was sent), close the `judge flips` block of
  `gate --rejudge-of`, the `judge-change` and `validate` text reports, and every refusal that carries a judge diff or
  no-grade counts. Under `--json` they are the `statements` key of `judgeFlips`, of the `validate` report and of those
  refusals. `agree`, `drift`, `flips` and the `judge-change --json` report do not carry them.

### Refusals

- A refusal on the rubric alone, between two judged runs, now ends with the hint to re-judge, as a refusal on any
  other judge field does.
- The split of `gate --rejudge-of` refuses an original baseline, or a candidate, holding a draw with no grade as
  `INCOMPLETE_RUN`, naming the draws (`case#draw`), where it was `ITEM_SET_MISMATCH`, naming the cases. A candidate's
  cases with no grade are listed on a line of their own, apart from `missing cases:`.
- An original baseline that is invalid input (a label the bar does not have) stops `gate --rejudge-of` with exit 65
  whatever its packets, and also where its judge's call was rejected. 0.2.0 read only an original with recorded packets
  that far.
- Exit codes, refusal codes and field lists are otherwise unchanged.

### Library

- `gateRuns` with `rejudgeOf` adds `judgeFlips` to its result, present exactly when `judgeControl` is.
- New export: `RUN_INPUT_SCHEMA`.

### Examples and docs

- `examples/run-format/write-run.ts` and its input `examples/run-format/input/recorded.json` are removed; `write-run`
  replaces them, and `examples/run-format/input/` now holds a manifest and rows. Run files the script wrote still read.
- The judge-change example names its non-compensable class `refund_policy`; no number in it moved.
- `docs/CLI.md` has a recipe for putting a report into a pull request comment or a GitHub step summary.
- `llms.txt` indexes the shipped docs and names the seven commands.

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
- **A Claude Code plugin**: one skill file that tells an agent how to run `npx anchorset@0.2.0` and how to report
  what it printed, with its two manifests. It holds no code and decides nothing: every verdict and every number
  comes from the CLI. It runs the published package, so it is committed to the repository after the `v0.2.0` tag
  and the npm release: the tagged tree and the package do not hold it.

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
