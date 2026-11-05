# anchorset

[![npm](https://img.shields.io/npm/v/anchorset)](https://www.npmjs.com/package/anchorset)
[![CI](https://github.com/ogous/anchorset/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ogous/anchorset/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/ogous/anchorset/blob/main/LICENSE)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23358089.svg)](https://doi.org/10.5281/zenodo.23358089)

**Regression tests for your LLM evals, and checks on the judge that grades them.**

anchorset checks two things about your LLM evals: whether your new version got worse, and whether the judge that
grades it still grades the way it did.

With anchorset you can:

- **Gate a release**: set the pass rate you require, and see case by case what broke since your last results.
- **Check your graders** against each other before you trust their labels.
- **Watch your judge** for change over time, and for noise within one run.
- **Measure a judge upgrade** on answers you already stored, before you mix old and new labels, and compare
  re-judging your baseline with recalibrating its old labels.

It is a command-line tool. The `anchorset` command calls no model: it reads files that your own eval code writes in
its formats.

Four words used on this page: a **grader** is whoever gives the label, a person or a model. A **judge** is a
grader that is a model. An **item** is what the rating files call a case. A **packet** is what a grader was shown
for one item.

Version 0.3.0, by Ogous Chan Ali.

## Try it

You need git and Node 22.21 or later. Nothing else to install. Clone the repository and run the first example. The
data is a made-up customer-support refund bot.

```sh
git clone https://github.com/ogous/anchorset
cd anchorset
npm run --silent demo
```

It prints a short table and ends with `verdict: REGRESSION (exit 1)`. The example is built to fail: the new version
broke one case.

## Install

```sh
npm install anchorset
```

The installed command is `anchorset <command>`; this page writes `node src/cli.ts <command>`, which is the same
command in a clone. As a library, in an ES module:

```js
import { readFileSync } from 'node:fs';
import { gateRuns, gateExitCode, parseRunArtifact, parseBarFile } from 'anchorset';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const result = gateRuns(
  parseRunArtifact(read('baseline.json')),
  parseRunArtifact(read('candidate.json')),
  parseBarFile(read('bar.json')),
  { allowDiffer: ['systemModelServed', 'systemCallShapeHash'] },
);
console.log(gateExitCode(result)); // 0 no regression, 1 regression, 2 refused
```

## Get your results in

Your eval code already knows, for each answer, the case, the answer and its grade. Write that down as one JSON line per
answer:

```json
{"case": "q04", "grade": "2", "answer": "Please contact the courier.", "stop": "end"}
```

`stop` is why the model stopped, from the provider's finish reason (`end` for a normal finish). Then say once, in a
short manifest, what the run was: the bar file, how many cases there are, the models, the prompts and the settings.
[`examples/run-format/input/`](examples/run-format/input/) holds a made-up one for the refund bot. `write-run` turns
the two into a run file, and `validate` tells you whether `gate` will take it:

```sh
OUT="$(mktemp -d)"
node src/cli.ts write-run --manifest examples/run-format/input/manifest.json --grades examples/run-format/input/grades.jsonl --out "$OUT/run.json"
node src/cli.ts validate --run "$OUT/run.json" --bar examples/run-format/bar.json
```

```text
run written to …/run.json
  …
  cases 5 · draws per case 1 (one grade per answer) · slots 5 · recorded 5 · missing 0
  graded by a judge · packets UNKNOWN
  identity fields "UNKNOWN": none
  system stop "UNKNOWN": none
…
gate would admit it.
…
result: READY for gate (exit 0)
```

What you leave out of the manifest is written as `"UNKNOWN"`, never guessed. The file is still written, and
`validate` lists every reason `gate` would refuse it, all at once. Hash a prompt the same way in every run: a file
whose line endings changed is a different file.

The example takes two short ways, and both are statements you make about your own harness:

- `"settings": { "sent": { … }, "everyOtherKey": "NOT_SENT" }` says that your code sent the settings listed and no
  other. Otherwise give the whole settings block, every key.
- `"gradedReplyStop": "end"` says that the judge's reply ended normally on every graded answer. Otherwise give a
  `judgeStop` on each line.

The tool cannot check either. Write them only when they are true. `write-run` prints each one you used.

One grade per answer is enough for `gate`. Choose the number of draws before your first baseline: `gate` never
compares runs whose draw counts differ, and `flips` needs at least two draws per case. `write-run` reads only lines
your own code wrote; for another tool's result file, use its importer (see below).
[The run format](docs/RUN_FORMAT.md#from-your-evals-rows) lists every key.

## The five methods

| Question | Method |
|---|---|
| [Is my new version worse?](#gate-did-my-new-version-get-worse) | `gate` |
| [Do my graders agree with each other?](#agree-do-my-graders-agree-with-each-other) | `agree` |
| [Did my judge shift over time?](#drift-is-my-judge-still-grading-the-same-way) | `drift` |
| [How much does my judge wobble?](#flips-how-noisy-is-my-judge) | `flips` |
| [What did a judge upgrade do?](#judge-change-i-swapped-the-judge-what-changed) | `judge-change` |

`gate` is the only one that gives a pass/fail verdict. The other four are measurements: they show you numbers and
you decide.

Each example below runs on made-up data in this repository. The output is what the command prints; `…` marks lines
left out here. In the first four examples each answer gets one of three labels: `none` (fine as it is), `review`, or
`handoff` (hand the chat to a person). In the `gate` example code gives the labels, and no judge is involved. A
**draw** is one repeat of a case. It may produce a new answer, or grade the same stored answer again.

### `gate`: did my new version get worse?

You give it last month's results, this month's results, and your pass bar: the pass rate you require for each class,
a group of cases. It tells you which test cases broke, which got fixed, and whether the new version meets your pass
bar.

It refuses to compare if the two runs aren't comparable, for example if the settings differ and you didn't say so,
or if the judge differs at all. Then it stops and names what differs. It checks what the files say, not what
actually ran.

```sh
npm run --silent demo
```

```text
allowed to differ:
  systemModelServed    example-model-a-2026-01-15 -> example-model-a-2026-06-01
  systemCallShapeHash  a11e51bfa39c… -> 4f6fc0464773…

class           direction       baseline      candidate             bar     result
must_handoff    floor (strict)  5/5 1.000     4/5 0.800, 0 new      1.000   FAIL (non-compensable)
should_review   floor           5/5 1.000     5/5 1.000, 0 new      0.900   ok
routine         ceiling         9/10 0.900    10/10 1.000, 0 new    0.900   ok

BROKE (1)
  must_handoff/h03  attributed draw #1: review; 1 of 3 draws fail
FIXED (1)
  routine/r07  attributed draw #0: none

verdict: REGRESSION (exit 1)
```

How to read it:

- The first lines list what you allowed to differ between the two runs: here the model and its settings.
- `class` is a group of cases (the key is `klass` in a run file). `bar` is the pass rate you require for it.
  `floor` means the label must be at least the expected one; `ceiling` means at most.
- `(strict)` and `non-compensable` mark a class with `"nonCompensable": true` in the bar file: one failing case
  fails the gate, whatever the rate.
- `0 new` means every case was also in the old results. `FIXED` lists cases that failed before and pass now.
- The attributed draw is the case's worst draw, and it gives the case its result.

Case `h03` must be handed to a person. It has three draws, and one of them was graded `review`. A case passes only
if every draw passes, so `h03` fails. Its class, `must_handoff`, allows no failures, so the gate fails. The command
exits with code 1, which is how a CI job, the script that checks each change, knows to stop the release.

`gate` needs all sixteen identity fields of a [run file](docs/RUN_FORMAT.md) known in both runs. On your own
files:

```sh
node src/cli.ts gate --baseline <old run file> --candidate <new run file> --bar <bar file>
```

Add `--allow-differ <fields>` for the system fields you changed on purpose. Without it, a new model name is
refused. `validate` takes `--run` for the new run file, `--baseline`, `--bar` and `--allow-differ` as `gate` does, and lists
every reason `gate` would refuse at once, where `gate` stops at the first.

When the judge changes:

1. Pin a dated snapshot of the judge in your eval, so that a change is one you make.
2. When the judge moves anyway, `gate` refuses, prints which judge field moved and what re-grading costs, and prints
   the three commands to run next, with your paths.
3. Have the new judge grade the baseline's stored answers again, and write that run.
4. Run `gate --rejudge-of` with it, and read the `judge flips` list: the cases whose result moved between the two
   judges, in each direction, beside the judge's own noise.

To show the report in a pull request or on a GitHub Actions summary, see "In CI" in [docs/CLI.md](docs/CLI.md).

### `agree`: do my graders agree with each other?

You give it the labels from two or more graders (people or models) on the same items. It tells you how often they
agree, and how much of that is more than luck.

Use it before trusting a judge: if your graders don't agree with each other, the scores mean little. Agreement
does not show the labels are right: graders can agree and all be wrong.

```sh
npm run --silent demo:agree
```

```text
raters rater-a, rater-b, rater-c · items 20 · packet hashes equal for every item, as the file states
fleiss kappa     0.582 [0.329, 0.783]
gwet AC1         0.676 [0.464, 0.873]
mean pairwise agreement (Fleiss P̄)  0.767  (not the share of items on which every rater agrees)
prevalence       none 0.600 · review 0.233 · handoff 0.167
…
```

Three graders (the output calls them raters) labeled 20 items. The first line also says the file records the same
packet for every grader. Without that, agreement means nothing.

Averaged over the three pairs, two graders agree on 77% of the items (0.767). Kappa and AC1 take out the agreement
that luck would give: 1 is full agreement and 0 is luck alone. The brackets show how much each number moves when the
items are drawn again from your own 20 items. Here they are wide. The lines left out give the same numbers for each
pair of graders. [The ratings format](docs/RATINGS_FORMAT.md#reading-the-numbers) says why both numbers are shown
and what the brackets leave out.

The file has to say what its names are, in `raterIdentity`. If they are places in a list and not the same grader on
every item, or if you don't know, say so: the report then has no row for a pair and uses Fleiss' kappa at any number
of names ([what the names are](docs/RATINGS_FORMAT.md#what-the-names-are)). Every report closes its figures by saying
they describe that file only: the tool can't see how the items or the raters were chosen, or why an item has the ratings
it has.

On your own files:

```sh
node src/cli.ts agree --ratings <ratings file>
```

### `drift`: is my judge still grading the same way?

You keep a small fixed set of items the judge graded before. Later, you have the same judge grade them again. It
compares the old labels with the new ones and shows what moved.

Use it as a regular check: same items, same judge, different day. The files do not say which judge graded them, so
keeping the judge the same is up to you. Every report says this too: the tool cannot show that both sets of ratings
came from one judge.

```sh
npm run --silent demo:drift
```

```text
anchor items 24 · packet hashes equal for every item, as the files state
cohen kappa      0.739 [0.500, 0.935]  (old against new)
gwet AC1         0.756 [0.509, 0.943]
agreement        0.833 (Wilson 95% [0.641, 0.933])
…
transition (rows old, columns new)
            none      review    handoff
none        11        1         0
review      0         5         3
handoff     0         0         4
…
```

The fixed set is the anchor set, which gives the tool its name. In this example the judge graded the same 24 items
at two times, and gave the same label on 20 of them, 83% (0.833). The table shows where the other four went: one
`none` became `review`, three `review` became `handoff`, and none moved the other way. All four moves went toward
`handoff`.

A judge that has not changed also gives different labels from one reading to the next. To see how much, have the
unchanged judge read the anchor set twice on one day, and run `drift` on those two readings.

On your own files:

```sh
node src/cli.ts drift --old <earlier anchor file> --new <later anchor file> --flag <label to watch>
```

`--flag` names the label you care about most, or several separated by commas; the example watches `handoff`.

### `flips`: how noisy is my judge?

You have the judge grade the same thing several times in one run. It tells you in how many cases the repeats did
not all get the same label.

It keeps two situations apart: the judge changing its mind about the same answer, and the system giving a different
answer each time.

`flips` looks at repeats within one run. For labels that differ between an old and a new judge, use
`judge-change`.

```sh
npm run --silent demo:flips
```

```text
repeat draws of one run: a measurement. It has no verdict and never exits 1.
20 cases · 3 draws per case · grader: judge example-judge-2026-01-15 · packets: recorded
a case is flipped when its 3 draws did not all get the same label. Each share below is a share of cases with at least one disagreeing draw among 3: it rises with the number of draws, and it is not the rate at which one grade changes.

one output: every draw of the case states the same output hash and the same packet hash, under the one judge this run states, so the file names no other source for a label difference. It cannot show what a provider or a harness did unseen.
  flipped 2 of 18 cases (0.111), 3 draws per case
  Wilson 95% score interval, the 18 taken as fixed: [0.031, 0.328]
…
different outputs: the draws of the case hold more than one output, so a label difference mixes system and grader variation; never pooled with the share above
  flipped 1 of 2 cases (0.500), 3 draws per case
…
```

There are 20 cases. In 18 of them the judge graded one stored answer (the report says output) three times, and in
2 of those 18 the label changed. That 11% holds for three draws and rises with more. Its 95% brackets are 3% to 33%
(the Wilson line). In the other 2 cases the system gave different answers, so a changed label there (1 of 2) could come from the system or
from the judge. The two numbers are never added together.

On your own files:

```sh
node src/cli.ts flips --run <run file>
```

If the answers came from stored files and this run did not produce them, the file records the system stop as unknown,
and `flips` refuses it. Say so in the command:

```sh
node src/cli.ts flips --run <run file> --stored-outputs system-side-not-compared
```

The report then says first that the numbers hold for the stored texts as they stand, a cut-off answer included. The
file needs recorded packets, a known judge and rubric, one answer in each case, and at least one unknown system stop. The flag is not part of any hash, so it
records your choice and does not show when you made it. `gate` never takes such a file.

### `judge-change`: I swapped the judge. What changed?

You have the old judge and the new judge grade the same stored answers. It tells you how much the pass rate moved,
how many labels differ between the two judges, and how that compares with one judge graded twice.

```sh
npm run --silent demo:judge-change
```

```text
…
class reply_quality · cut 4 · label rule majority · estimate draws [0, 1, 2] · re-ask draws [3, 4, 5]
…
                                        old      new      change (new - old)
per-draw pass rate                      0.469    0.286    -0.183
label pass rate (majority)              0.492    0.300    -0.192

labels that differ between the judges (majority)              0.275
labels that differ between two sets of one judge (majority)   0.167
the first share minus the second (from the counts)            0.108
…
  quantity                                                                                                  point    sd      2.5%     50%      97.5%    mean-point  share <0 / =0 / >0      undefined   (shares of resamples; not a p-value)
…
  labels that differ between the judges, minus between two sets of one judge                                0.108    0.030   0.050    0.108    0.163    -0.001      0.001 / 0.000 / 1.000   0
…
```

The example has five versions of the bot with 24 scored cases each. Each judge grades each answer six times: three
for its label (the majority of the three), and three more to see how far the judge differs from itself. A draw
passes when its grade, from 1 to 5, is 4 or higher (`cut 4`), so a label is pass or fail. The new judge passes far
fewer answers: the label pass rate fell from 0.492 to 0.300, about 19 points. The two judges give a different
pass/fail label on 27.5% of the answers. Each judge, asked twice, differs from itself on 16.7% on average. The gap
between the two is about 11 points. On 95% of resamples of the cases it falls between 5 and 16 points (last line,
`2.5%` to `97.5%`; the shares in the later columns are rounded).

This example is made up. The method comes from a pre-registered study of two upgrades of one judge family on a
public summarization benchmark ([paper](https://ogous.dev/publications/llm-judge-under-version-change),
[registration](https://osf.io/y6qm8/)). The study's registered numbers were not
computed with this tool; run on the study's stored judgments, it reproduces the corresponding point estimates. At
the first upgrade the share of labels that pass rose by about 15 points, and 18% of labels differed between the two
versions, against about 2% for two runs of one version. At the second upgrade the pass share fell by about 10
points. These are that study's numbers, for one judge family on one benchmark; they say nothing about your judge.

On your own files:

```sh
node src/cli.ts judge-change --plan <plan file> --bar <bar file> --inputs <folder of run files>
```

## Use it with what you already run

`judge-change` needs both judges to grade the same stored answers. If your stored answers come from one of the tools
below, an example importer makes the files `judge-change` reads:

- **promptfoo**, versions 0.123.1 and 0.125.1; any other is refused. You supply the stored answers in a file.
- **Inspect**, `inspect_ai` 0.3.275 and 0.3.286; any other is refused for the grading. It reads your Inspect log, which may
  come from any version the tested tool can read (one it cannot read is refused): the run records its sha256 and the
  version it states, and it must state how many answers it holds.
- **The result folder of Claude's eval-building skill**, for evals with one question and one answer per case. It
  reads that folder.

The importers do not read labels you already have: both judges grade again, through an example grading script, and
you pay for those calls with your own key. The grading scripts work with Anthropic models only; for a judge from
another provider, you write the run files yourself. The old judge is its model name as served today. The scripts were
run against a real provider on 2026-10-13, on small examples, with promptfoo 0.123.1 and `inspect_ai` 0.3.275. Six of
seven imports succeeded; one was refused because five of its nine replies were not a single JSON object. A re-ask, a
rate limit, a server error and a timeout were not tried there. Since then the JavaScript grader has changed only in
where it reads the tested versions, and the two newer versions have run against a local stand-in only. The Inspect
script `regrade.py` has since gained checks made before any call (the tested-versions list, the stated answer count)
and a record of the system log, run against the stand-in only.

The [importers guide](docs/IMPORTERS.md) has the steps, and a trial that costs nothing.

`gate`, `agree`, `drift` and `flips` read files that you, or the code that runs your evals, write. The formats are
listed under "Docs" below.

## Use it from Claude Code

A Claude Code plugin is in this repository: one skill that tells an agent how to run the commands and how to report
what they print. It holds no code.

```sh
claude plugin marketplace add ogous/anchorset
claude plugin install anchorset@anchorset
```

## What it refuses, and what it does not do

anchorset stops instead of warning. When a comparison can't be trusted, it says what is wrong and gives no number
for that comparison. One labelled exception: if a reference file (the grades of people you trust) says that those
graders were shown something different from the judges, `judge-change` still counts pairs against it, labels every
such count, and gives no agreement number. If the graders' packets differ or are unknown and the file does not say
so, it withholds the reference.

- **Runs that differ in ways you didn't declare.** If the model or the settings changed between two runs, `gate`
  names the fields and stops. A changed judge cannot be allowed: grade the old answers again with the new judge and
  gate with `--rejudge-of` (see [the command line](docs/CLI.md)), or use `judge-change`.
- **Unknown values.** A field you write as `UNKNOWN` is a gap, and a gap blocks every comparison that depends on
  it.
- **Graders that saw different things.** `agree` and `drift` refuse the whole comparison unless the files record
  the same packet for every item.
- **A judge's reply that can't be read.** It is never asked again, and neither is a content filter or a rejected
  request: each stays on the record as the slot's outcome. `judge-change` and `flips` refuse a file that holds one, and
  so does `gate` in a baseline; in a candidate, `gate` fails the case or, for a rejected request, refuses. For a reply that can't be read or was
  filtered, the refusal counts the slots by reason; for a rejected request, it names each slot. [The run format](docs/RUN_FORMAT.md) gives the ways on.
- **A baseline with no answer.** If the system's request was rejected or it returned its own error on a baseline slot,
  `gate` refuses: such a slot can't show which cases the candidate broke. An answer cut at its cap stays a failing
  reference.

It does not run your evals. `write-run` writes a run file only from what your own code recorded.

## Docs

- [The command line](docs/CLI.md): every command, the exit codes, a CI step and a gate across a judge change.
- [The run format](docs/RUN_FORMAT.md): the file `gate`, `flips` and `judge-change` read, how `write-run` makes one from your eval's rows, and the bar file.
- [The ratings format](docs/RATINGS_FORMAT.md): the files `agree` and `drift` read.
- [Judge change](docs/JUDGE_CHANGE.md): the plan, the report and what each number means.
- [Importers](docs/IMPORTERS.md): promptfoo, Inspect and the eval-building skill, step by step.
- [Comparison](docs/COMPARISON.md): anchorset next to promptfoo, DeepEval and Langfuse.
- [Migrations](docs/MIGRATIONS.md): the format versions of 0.3.0, and how a file of 0.2.0 or 0.1.0 moves.

The installed package holds these documents at `node_modules/anchorset/docs/`, for an agent or a reader working
offline. [llms.txt](llms.txt) lists them for a coding agent.

## Requirements, contributing, license and citing

Node 22.21 or later. No runtime dependencies. It can also be used as a TypeScript library.

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). The code is under Apache-2.0 and the
docs under CC-BY-4.0. To cite the tool, use [CITATION.cff](CITATION.cff). This version, 0.3.0, is archived at
[doi:10.5281/zenodo.23974982](https://doi.org/10.5281/zenodo.23974982), and
[doi:10.5281/zenodo.23358089](https://doi.org/10.5281/zenodo.23358089) always resolves to the latest version. Version
0.1.0, the one the paper used, is archived at [doi:10.5281/zenodo.23358090](https://doi.org/10.5281/zenodo.23358090),
and the study's data and analysis at [doi:10.5281/zenodo.23358200](https://doi.org/10.5281/zenodo.23358200).
