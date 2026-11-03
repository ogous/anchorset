# Judge change: what a new judge does to your labels

An LLM judge grades your answers, and you want to change it: a new model version, a new prompt, new settings.
You give `judge-change` a plan and the run files of both judges. It tells you what the change does to your labels.
It is a measurement, with no pass/fail verdict.

The **judge** is the model that grades. A **draw** is one repeat of a case; on this page every draw of a case
grades the same stored answer again. A **system** is one version of the thing you evaluate. A **run file** holds
one judge's labels for one system. A **packet** is what the judge was shown for one answer. The report says "item"
for one case of one system.

## What you need

- For each system, two run files: the same stored answers, graded once by the old judge and once by the new one.
  [RUN_FORMAT.md](RUN_FORMAT.md) describes the run file. If your results are in promptfoo, Inspect or the result
  folder of Claude's eval-building skill, [IMPORTERS.md](IMPORTERS.md) shows how to get run files out of them.
- A bar file: your labels in order, your classes, and the pass bar of each
  ([RUN_FORMAT.md](RUN_FORMAT.md) shows one).
- A plan: one JSON file that names the run files and says what to measure.
- Node 22.21 or later and a clone of this repository. Run every command here from the repository root.

Put the run files, and any reference files, in one folder. The plan must name every `.json` file in it.

Every run file must know `barHash`, `caseSetHash`, `drawsPerCase`, `rubricHash`, the five judge fields and its
packets. With `system-side-compared` it must also know the six system fields, `seed` and every `systemStop`. With
`system-side-not-compared` these may be `"UNKNOWN"`, and the report lists them as not compared.

## The plan

This is the plan of the example, [`examples/judge-change/plan.json`](../examples/judge-change/plan.json),
shortened: `…` cuts a hash or stands for systems `bot-v2` to `bot-v5`.

```text
{
  "schema": "anchorset.judge-change-plan/v1",
  "barHash": "350b69d36d81…",
  "caseSetHash": "dbb9df32e72a…",
  "drawsPerCase": 6,
  "judges": {
    "old": {
      "judgeDefinitionHash": "b0fadff9c769…",
      "judgeModelRequested": "example-judge",
      "judgeModelServed": "example-judge-2026-01-15",
      "judgeCallShapeHash": "cde6d59590b0…",
      "judgeHarnessVersion": "judge-harness 2.0.0",
      "rubricHash": "c4527b9966f8…"
    },
    "new": {
      "judgeDefinitionHash": "b0fadff9c769…",
      "judgeModelRequested": "example-judge",
      "judgeModelServed": "example-judge-2026-06-01",
      "judgeCallShapeHash": "cde6d59590b0…",
      "judgeHarnessVersion": "judge-harness 2.0.0",
      "rubricHash": "c4527b9966f8…"
    }
  },
  "judgeMoves": ["judgeModelServed"],
  "systems": {
    "bot-v1": { "old": "34c984138fa9…", "new": "897a75cc313d…", "reference": "7b2a5b113bf1…" },
    …
  },
  "storedOutputs": "system-side-compared",
  "measuredClass": "reply_quality",
  "cut": "4",
  "drawSets": { "estimate": [0, 1, 2], "reask": [3, 4, 5] },
  "labelRule": "majority",
  "pooling": "items-equal",
  "gate": { "statistic": "tango-1998", "margin": 0.1, "alpha": 0.05 },
  "resampling": { "iterations": 2000, "seed": 20261002, "spreadFloor": 5 },
  "oneCasePerCluster": true,
  "map": {
    "encoding": { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 },
    "folds": 2,
    "fitOnlyCaseIds": ["q02", "q06", "q10", "q14", "q18", "q22", "q26", "q30"],
    "tieBreak": { "seeds": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
    "minSystems": 4,
    "minFitItems": 40,
    "maxTieShare": 0.25
  }
}
```

You do not type the hashes, `drawsPerCase` or `judges`: the helper script `examples/importers/make-plan.ts` reads
them from your two run files and writes a plan for one system. These are your choices:

| Key | What it means | Values |
|---|---|---|
| `judgeMoves` | What you changed about the judge. It must list exactly the judge fields that differ between the two run files. | Any of the six field names under `judges` |
| `systems` | Each system's name, with the sha256 of its old-judge run file and its new-judge run file. `reference` is optional: for every system or for none. | `shasum -a 256 <file>` prints a file's sha256 |
| `storedOutputs` | Whether the two run files of a system must also match on the system's own settings. Imported run files need the second value. | `system-side-compared`, `system-side-not-compared` |
| `measuredClass` | The class to measure. | One class of your bar file; see Limits |
| `cut` | The lowest label that counts as a pass. A draw passes when its label is at or above the cut, in the bar file's order. | One label of your bar file |
| `drawSets.estimate` | The draws the numbers are computed from, by index. | An odd count under `majority`. With no `reask`, list every draw |
| `drawSets.reask` | Optional: a second set of draws, to see how far one judge differs from itself. These are whole draws, not the re-ask of the importers guide. | The same count as `estimate`; the two sets cover every draw once |
| `labelRule` | How one answer's draws become one label. `majority`: more than half of them pass. `worst`: all of them pass. | `majority`, `worst` |
| `pooling` | Every answer counts the same. | `items-equal` |
| `gate` | Optional: simulate a decision on each pair of systems. `margin` is how much worse a candidate may be; `alpha` is the error level of the test. | `statistic` is `tango-1998`; `margin` between 0 and 1, `alpha` between 0 and 0.5; needs `majority` |
| `resampling` | Optional: show how much the numbers move when cases are resampled. Below `spreadFloor` cases, no brackets are printed, and kappa and AC1 are withheld. | `iterations` from 41 to 1,000,000; `seed`; `spreadFloor` 2 or more. Or `suppliedSha256` in place of `iterations` and `seed`: see "Draws you supply" |
| `oneCasePerCluster` | Your statement that each case stands alone: no two come from one cluster, such as two questions from one conversation. It is not checked. | `true`; required with `gate` or `resampling`, refused without |
| `map` | Optional: also try moving the old judge's cut. Its keys are listed under "Reading the report". | Needs `gate` and `majority` |

The helper writes none of the optional settings. Add them, and more systems, to its plan by hand. This block
writes a plan for `bot-v1` of the example and runs it. Its report differs from the demo's: it uses `worst` on all
six draws, and scores 32 cases, since without `map` no case is set aside.

```bash
OUT="$(mktemp -d)" && mkdir "$OUT/runs"
cp examples/judge-change/runs/bot-v1.old-judge.json examples/judge-change/runs/bot-v1.new-judge.json "$OUT/runs/"
node examples/importers/make-plan.ts --old "$OUT/runs/bot-v1.old-judge.json" --new "$OUT/runs/bot-v1.new-judge.json" --bar examples/judge-change/bar.json --out "$OUT/plan.json" --system bot-v1 --stored-outputs system-side-compared --measured-class reply_quality --cut 4 --label-rule worst --pooling items-equal --estimate-draws 0,1,2,3,4,5 --judge-moves judgeModelServed
node src/cli.ts judge-change --plan "$OUT/plan.json" --bar examples/judge-change/bar.json --inputs "$OUT/runs"
```

## A reference (optional)

If people you trust have graded the same cases, you can give their pass or fail as a reference: one file for each
system, named in the plan under `systems`. One file may serve several systems: name it for each of them, and keep one
copy of it in the folder. A shared file gives those systems the same verdicts, so its column shows no difference
between them. The report then shows how each judge agrees with the graders.

```text
{
  "schema": "anchorset.reference/v2",
  "verdictRule": "the majority of three raters, each marking pass or fail against the same pass mark",
  "verdicts": { "q01": "fail", "q03": "fail", … },
  "packetHashes": { "q01": "86c56b2dd322…", "q03": "542d31d0d46f…", … },
  "packetBasis": "recorded"
}
```

| Field | What it means |
|---|---|
| `verdictRule` | In your own words, how one pass or fail came from the graders' labels. The report prints it |
| `verdicts` | `pass` or `fail` for each scored case |
| `packetHashes` | For each case, the sha256 of what the graders were shown: the packet |
| `packetBasis` | `recorded` if you kept the packets. `declared` if you took them from documentation; then name it in `packetSource`. `"UNKNOWN"` if you cannot say |
| `packetDifference` | Optional. `{ "packets": …, "quote": …, "source": … }`: your statement that the graders were shown something other than the judges were (`"different"`), or that you cannot say what they were shown (`"UNKNOWN"`). `quote` is the words that say so and `source` is where they come from. Give it in every reference of the plan, with the same words, or in none |

If a reference's packets differ from the judges' on any scored case, or are unknown, and the file has no
`packetDifference`, the report withholds the reference (`reference: withheld (PACKET_MISMATCH)`) and computes
nothing with it. With `packetDifference`, the reference serves only as the criterion of the pair decisions, so the
plan needs a `gate` block. Every count computed against it says `reference saw a different packet` (or
`reference packet unknown`), and no agreement number is printed. With `"different"`, a packet hash equal to the judges' on a
scored case refuses the report (`PACKET_MISMATCH`), and an unknown hash is invalid input (exit 65). `"UNKNOWN"` needs
`packetBasis` `"UNKNOWN"` and every entry of `packetHashes` written as `"UNKNOWN"`.

## Draws you supply (optional)

By default the report draws its own random numbers from the seeds in the plan. To use your own, put the file in the
folder with the run files and its sha256 in the plan, as for a run file.

- **Tie-break draws**: `map.tieBreak.suppliedSha256`, next to `seeds`. The file holds one number from 0 up to, not
  including, 1 for each judge, draw set, system and case of the measured class, fit-only cases included. A missing
  one is refused. `reask` is needed only if the plan has `reask` draws. These numbers give the map's reported
  values; the seeds still give the table of what the tie-break alone moves.

  ```text
  { "schema": "anchorset.tie-break/v1",
    "u": { "old": { "estimate": { "bot-v1": { "q01": 0.37, … }, … }, "reask": { … } }, "new": { … } } }
  ```

- **Resample indices**: `resampling` is `{ "suppliedSha256": …, "spreadFloor": … }`. Each row of `scored` is one
  resample: as many indices as there are scored cases, each the position of a case when the cases are sorted by id.
  There are at least 41 rows. `fitOnly` has one row for each row of `scored`, with one index for each fit-only case;
  with no fit-only case it is `[]`. The brackets are then printed with no level.

  ```text
  { "schema": "anchorset.resample-indices/v1", "scored": [[3, 0, 3, …], …], "fitOnly": [[1, 1, 0, …], …] }
  ```

## Run it

The example is made-up data: five versions of a support bot, 24 scored cases each, six draws per answer.

```bash
npm run --silent demo:judge-change
```

On your own files:

```bash
node src/cli.ts judge-change --plan <plan file> --bar <bar file> --inputs <folder of run files>
```

`judge-change` never exits 1; [CLI.md](CLI.md) lists the exit codes.

## Reading the report

The parts are in the order they print. The lines are from the example; `…` marks lines left out.

**What moved.** The judge fields that differ, old value then new.

```text
judge fields that moved:
  judgeModelServed      example-judge-2026-01-15 -> example-judge-2026-06-01
```

**The pass rate under each judge.** The per-draw rate is the share of single draws that pass, on the estimate
draws. The label rate first gives each answer one label, by your label rule.

```text
                                        old      new      change (new - old)
per-draw pass rate                      0.469    0.286    -0.183
label pass rate (majority)              0.492    0.300    -0.192
```

**Labels that differ.** The first line is the share of answers whose label differs between the two judges. The
second needs `reask`: the share whose label differs between two sets of draws by one judge, averaged over the two
judges. It shows how much labels move with no change of judge. The third is the first minus the second.

```text
labels that differ between the judges (majority)              0.275
labels that differ between two sets of one judge (majority)   0.167
the first share minus the second (from the counts)            0.108
```

Then come the same rates for each system, with two or more systems, and a list of every item whose label
differs:

```text
items whose label differs between the judges (33):
  bot-v1/q03  pass -> fail
…
```

A class that your bar file marks non-compensable gets no rate. Its cases with a failing draw are listed one by one,
although it is not the measured class.

**Agreement with a reference.** Printed if the plan names a reference file for each system. The example's are in
[`examples/judge-change/runs/`](../examples/judge-change/runs/). Kappa and AC1 are agreement beyond luck
([RATINGS_FORMAT.md](RATINGS_FORMAT.md#reading-the-numbers)). They are printed only with a `resampling` block and at
least `spreadFloor` cases. Otherwise they are withheld, with the reason, and each judge's agreeing count and pass share
are still printed.

```text
  old judge  agrees on 101 (0.842) · kappa 0.683 [0.567, 0.787] · AC1 0.683 [0.583, 0.800] · passes 0.492
  new judge  agrees on 92 (0.767) · kappa 0.533 [0.382, 0.684] · AC1 0.551 [0.391, 0.711] · passes 0.300
```

**System-pair decisions.** Printed if the plan has a `gate` block and two or more systems. Each row takes one system as the baseline and
one as the candidate, and tests whether the candidate is no more than the margin worse. "Do nothing" keeps the
old judge's labels for the baseline and takes the new judge's for the candidate. "Re-judged" takes the new
judge's labels for both. With a reference, a third column runs the same test on it.

```text
  baseline      candidate     do nothing                  re-judged                   reference   (worse/better z state)
  bot-v1        bot-v2        7/2 -0.904 INCONCLUSIVE     4/3 0.526 INCONCLUSIVE      0/4 2.667 PASS
…
  pairs 20 · passed by doing nothing only 0 · by re-judging only 5 · by both 1 · net -5
```

`7/2` means seven cases pass for the baseline only and two for the candidate only. The number after it is the
test's statistic. Read the word that follows:

- `PASS`: the test takes the candidate as no more than the margin worse.
- `REGRESSION`: the test takes the candidate as more than the margin worse.
- `INCONCLUSIVE`: neither.

These states are simulated, and the exit code ignores them. The last line counts the pairs each way passes; `net`
is doing nothing only, minus re-judging only.

With a `map` block, a third way is tried: keep the old judge's labels for the baseline, and place a cut on the sum
of the old judge's draws for a case, fitted on other cases to pass as many answers as the new judge passes there.
Every key of the block is required:

| Key | What it means | Values |
|---|---|---|
| `encoding` | The number each label counts as when a case's draws are summed | One whole number for each label of your bar file, rising with the labels' order |
| `folds` | The scored cases are split into this many groups by their ids. A group's cut is fitted on the cases outside it, and on the fit-only cases | 2 or more |
| `fitOnlyCaseIds` | Cases that only help fit the cut. They are never scored | Ids of the measured class; not all of them |
| `tieBreak` | Items with the same sum are ordered by a random number. The first of `seeds` gives the values printed; every seed goes into a table of what the tie-break alone moves. Optionally also `suppliedSha256` | At least 20 different `seeds` |
| `minSystems`, `minFitItems`, `maxTieShare` | Limits. The map is withheld with fewer systems than `minSystems`, if a group's cut is fitted on fewer than `minFitItems` items, or if the tie-break decides more than `maxTieShare` of the labels | Whole numbers of 1 or more; a number from 0 to 1 |

The map is also withheld when a draw it needs failed and has no score, or when a cut cannot be fitted: a group has
nothing to fit on, the new judge passes none or all of the cases it is fitted on, or a judge's summed scores take
fewer than three different values. The report then prints
`recalibration map: withheld (MAP_NOT_IDENTIFIED)` and the reasons. With one system it prints `withheld (NO_PAIRS)`.

**The brackets.** Printed, under the heading `spread`, if the plan has a `resampling` block. Each row is one
number of the report, computed again on many resamples of your cases.

```text
  quantity                                                                                                  point    sd      2.5%     50%      97.5%    mean-point  share <0 / =0 / >0      undefined   (shares of resamples; not a p-value)
  per-draw pass rate change                                                                                 -0.183   0.033   -0.244   -0.183   -0.117   0.001       1.000 / 0.000 / 0.000   0
```

`point` is the number printed above, and `sd` is how much it varies across the resamples. `2.5%` and `97.5%` are
the brackets: on 95% of the resamples the change fell between -0.244 and -0.117. They show what other cases could
have given, and say nothing about another day, other systems or other draws. Whether such brackets hold the true
value 95% of the time is not checked. On counts of pairs and on `map` rows the two columns carry no level.

The report ends with notes on what it does not show.

## If it stops

A refusal prints `REFUSED`, a code, the fields concerned and a sentence, and no report.

- `HASH_MISMATCH`, naming a file → the folder holds a `.json` file the plan does not name, or a run file changed
  after the plan was written, or two files in the folder have the same bytes. Remove the file, or put its sha256,
  which the message prints, in the plan.
- `HASH_MISMATCH`, naming `barHash` → the plan was written for another bar. Use that bar, or write the plan again.
- `IDENTITY_MISMATCH` → the fields named differ: a judge field against `judgeMoves`, a run file against the plan,
  or a system field under `system-side-compared`.
- `IDENTITY_GAP` → a field named is `"UNKNOWN"`; see "What you need".
- `HASH_MISMATCH`, naming an output or a case → the judges graded different answers, or one case holds two.
- `UNSUPPORTED_DESIGN` → the cut must be a label of your bar, and the class must fit the limits below.
- `PACKET_MISMATCH` → the judges were not shown the same thing on the draws listed, or a run file does not say
  what was shown. Grade again so that both see the same packet and it is recorded.
- `ITEM_SET_MISMATCH` or `INCOMPLETE_RUN` → a draw is missing, or has no label, under one judge, in any class of the
  file, measured or not. Grade it again.
  Or a reference file does not cover exactly the scored cases, or a file of draws you supplied does not fit them.
- `invalid input (INVALID_PLAN)` → each line names a key of the plan and what it must be.

## Limits

- The report does not say which judge is right, or whether to switch.
- The pair test is approximate: its error rate can be above `alpha`, and nothing corrects for testing many pairs.
- One class per plan, with one cut, which every case of the class expects. The class is a floor class (higher
  labels are better) and not non-compensable.
- All systems of a plan share one bar file, one set of cases and one number of draws.
