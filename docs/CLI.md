# The command line and CI

For anyone who runs anchorset from a script or from CI, the service that checks each change: the seven commands,
what each exit code means, and how to gate when the judge changed.

## The commands

| Command | What it reads |
|---|---|
| `write-run` | A manifest and the rows your eval code wrote; it writes one run file |
| `validate` | One run file and a bar file, or a manifest and its rows; with `--baseline`, a second run file |
| `gate` | Two run files and a bar file |
| `agree` | One ratings file: the labels of two or more graders |
| `drift` | Two anchor files: one judge, the same items, two dates |
| `flips` | One run file with several draws per case |
| `judge-change` | A plan, a bar file and a folder of run files |

The file formats are in [RUN_FORMAT.md](RUN_FORMAT.md), [RATINGS_FORMAT.md](RATINGS_FORMAT.md) and
[JUDGE_CHANGE.md](JUDGE_CHANGE.md). Each command on the example data, from the root of a clone:

```sh
node src/cli.ts write-run --manifest examples/run-format/input/manifest.json --grades examples/run-format/input/grades.jsonl --out <new run file>
node src/cli.ts validate --manifest examples/run-format/input/manifest.json --grades examples/run-format/input/grades.jsonl
node src/cli.ts gate --baseline examples/refund-bot/baseline.json --candidate examples/refund-bot/candidate.json --bar examples/refund-bot/bar.json --allow-differ systemModelServed,systemCallShapeHash
node src/cli.ts agree --ratings examples/refund-bot/ratings.json
node src/cli.ts drift --old examples/refund-bot/anchor_old.json --new examples/refund-bot/anchor_new.json --flag handoff
node src/cli.ts flips --run examples/refund-bot/judged.json
node src/cli.ts judge-change --plan examples/judge-change/plan.json --bar examples/judge-change/bar.json --inputs examples/judge-change/runs
```

`write-run` and `validate` exit 0. `gate` exits 1, because the example holds a regression. The other four exit 0. `--help` prints every flag. When
anchorset is installed from npm, the command is `anchorset` where this page shows `node src/cli.ts`.

`flips --stored-outputs system-side-not-compared` says that the graded answers are stored ones whose system stop nobody saw. The report says so first, and `gate` never takes such a file. [RUN_FORMAT.md](RUN_FORMAT.md) lists what the file needs.

`--allow-differ` lists the identity fields that may differ between the two runs. Without it, `gate`
refuses runs that differ, so a new model name is refused. A judge field and `drawsPerCase` can never be listed, and
neither can `rubricHash` when a judge graded the runs.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | `gate`: no regression, and every pass bar is met. `write-run`: the run file was written, also when it holds `"UNKNOWN"` values. `validate`: `gate` would take the run. The other four: the report was printed, whatever it shows. |
| 1 | `gate` only: a regression. A case broke, a class is below its pass bar, a non-compensable class (`"nonCompensable": true` in the bar file) has a failing case, a class has no case in the run, or a case is unfinished in the candidate. |
| 2 | Refused. The comparison can't be trusted, and the message names what differs or is unknown. From `validate`: `gate` would refuse the run, and every reason is listed. `write-run` never exits 2: it compares nothing. |
| 64 | Usage error: a flag is missing, unknown or cannot be used here. For `write-run`, also: `--out` exists, or cannot be written. |
| 65 | Invalid input: a file can't be read or is not in its format, or `--flag` names a label the files do not have. |
| 70 | Internal error in anchorset. It says nothing about your runs. |

A baseline with an unfinished case (a draw with no result) is refused, with exit 2. So is a candidate with a case
added or removed, unless `--allow-differ` lists `caseSetHash`. Then a removed case is a regression, and an added
one counts in its class's pass rate.

## In CI

Here anchorset is cloned into `anchorset/`, next to your three files:

```sh
node anchorset/src/cli.ts gate --baseline baseline.json --candidate candidate.json --bar bar.json
```

A CI shell step fails on any exit code other than 0, so this line is the whole step. To see every reason at once
when the gate would refuse, run `validate` with the same files first:

```sh
node anchorset/src/cli.ts validate --run candidate.json --bar bar.json --baseline baseline.json
node anchorset/src/cli.ts gate --baseline baseline.json --candidate candidate.json --bar bar.json
```

If your eval writes rows rather than run files, `write-run` comes first, once for each run.

To show the report in a pull request or on the summary page of a GitHub Actions run, put it in a code block.
A refusal is printed on error output, hence `2>&1`:

```sh
code=0; { echo '```text'; node anchorset/src/cli.ts gate --baseline baseline.json --candidate candidate.json --bar bar.json 2>&1 || code=$?; echo '```'; } >> "$GITHUB_STEP_SUMMARY"; exit $code
```

The step still ends with the gate's own exit code: `|| code=$?` keeps it while the block is closed, and `exit $code`
returns it. Without them, a shell that stops at the first failing command leaves the block unclosed, and one that does not ends
the step with the code of the last `echo`, so a regression would pass.

anchorset can also be called from your own code as a library. Catch its errors there: an uncaught error makes
Node exit 1, which a pipeline reads as a regression.

## When the judge changed

`gate` refuses two runs graded by different judges. The refusal shows which judge field moved, what re-grading
costs, and the commands to type next, with your own paths:

```text
REFUSED IDENTITY_MISMATCH
  fields: judgeModelServed
  judgeModelServed example-judge-2026-01-15 != example-judge-2026-06-01; the judge differs between these runs; …

the judge, baseline -> candidate:
  model requested    example-judge -> example-judge                          same
  model served       example-judge-2026-01-15 -> example-judge-2026-06-01    DIFFERS
  judge definition   b0fadff9c769… -> b0fadff9c769…                          same
  rubric             c4527b9966f8… -> c4527b9966f8…                          same
  judge call shape   cde6d59590b0… -> cde6d59590b0…                          same
  judge harness      judge-harness 2.0.0 -> judge-harness 2.0.0              same
  SERVED MODEL CHANGED UNDER THE SAME REQUESTED NAME: both runs asked for "example-judge"; …
  An edit of the judge's prompt or rubric is a judge change too, also when the model is the same.

re-judge size: the baseline holds 34 cases x 6 draws per case = 204 slots, 204 of them with an answer to grade: at least 204 judge calls; …

next:
  1. Re-grade the baseline's stored answers with the candidate's judge, in your own grading code. …
  2. anchorset validate --run … --baseline <baseline>.rejudged.json --rejudge-of <baseline> …
  3. anchorset gate --baseline <baseline>.rejudged.json --rejudge-of <baseline> --candidate … --bar …
```

A model name can stay the same while the model behind it changes; the loud line says when that happened. A row
reading `UNKNOWN` asks you to state the field first: an unknown value never counts as unchanged. When other fields
differ too, they are named, and the commands carry your `--allow-differ` as you gave it, never with a field added.
anchorset knows no prices: the size is a count of judge calls, and retries come on top.

To gate across a judge change:

1. Have the new judge grade the baseline's stored answers again. Write the result as a run file.
2. Run your new version and grade it with the new judge. That run file is the candidate.
3. Give `gate` the new baseline, and the baseline as first graded under `--rejudge-of`:

```sh
node src/cli.ts gate --baseline <baseline graded again> --candidate <candidate> --bar <bar file> --rejudge-of <baseline as first graded>
```

Both baselines must hold the same answers, or the command exits 2. If the candidate differs from the baseline in
system fields, as it does when you changed the system, list them with `--allow-differ` as for any gate.

The verdict compares the candidate with the baseline graded again. Under the list of broken and fixed cases, a block
headed `judge flips` lists the baseline's cases whose result moved between the two judges, each folded as the gate
folds it:

```text
judge flips: the baseline's stored answers, original baseline (old judge) -> re-judged baseline (new judge), each folded worst of 6 draws as the gate folds; each direction counted, never netted
  old judge: example-judge, served example-judge-2026-01-15 · new judge: example-judge, served example-judge-2026-06-01 · packets equal as recorded
  class                    n     pass -> fail   fail -> pass   no grade (old judge)
  refund_policy (strict)   2     0              0              0
  reply_quality            32    7              2              0
  pass -> fail (7):
    reply_quality/q10  expect >= 4 · old 4 4 5 4 4 4 (0 of 6 fail) -> new 4 4 3 3 3 2 (4 of 6 fail) · answer d6ad7c5354f3…
        input {"message":"The backpack I ordered is the wrong size. How do I return it?"}
…
  the judge's own variation on the same answers, beside the flips: cases whose draws split between pass and fail
    old judge  17 of 34 cases (refund_policy 2 of 2, reply_quality 15 of 32)
    new judge  14 of 34 cases (refund_policy 1 of 2, reply_quality 13 of 32)
```

The two directions are counted apart: a pass rate that fell by 5 of 32 may be 7 cases down and 2 up. A
non-compensable class comes first. A case the old judge left without a grade on some draw is in its own column, never
a pass, a fail or a flip. The judge's own variation counts the cases on which one judge both passed and failed one
stored answer across its draws, so you can set the flips beside the judge's noise. Where a case's draws hold different
answers, its split mixes the system's variation with the judge's: such cases are counted apart, in every class, and
never added to the others. With one draw per case it reads `not measured (one draw per case)`.

Below it, a block headed `judge-controlled` shows three changes in pass rate. `reported` is the candidate minus the
baseline as first graded. `judge` is the baseline graded again minus the baseline as first graded. `system` is the
candidate minus the baseline graded again. If the original baseline or the candidate holds a draw with no grade or no
record, this block says `not computed (INCOMPLETE_RUN: …)` and names the draws.

Both blocks need the two baselines to show that both judges were shown the same thing (`packets` in
[RUN_FORMAT.md](RUN_FORMAT.md)). The `judge-controlled` block takes recorded packets only. The `judge flips` list also
takes packets a run declares, and then says `packets equal by declaration, not observed`. Where a block cannot read the
packets, it says `not computed`, and the verdict stays the same.

`judge` is measured on the baseline's answers only; on the candidate's answers it may differ. Neither block says
which judge is closer to the truth: the `judge flips` block ends by saying that agreement between judges is not evidence
of correctness, and that the identities are as the run files declare them.

A judge can also break: a reply that cannot be read, a content filter, a timeout. `validate` counts, for every run it
reads, the draws that hold no grade, by reason, beside how often the judge was asked again:

```text
slots that hold no grade, per run (counted; never a pass, a fail or a flip):
  run          judge served            no grade      by reason                                      judge asked again
  run          judge-model-2026-06-01  1 of 8        judge parse-failure 1                          0 of 8 slots
  baseline     judge-model-2026-06-01  2 of 8        judge parse-failure 1, judge truncated 1       0 of 8 slots
  rejudge-of   judge-model-2026-01-15  2 of 8        judge content-filter 1, judge parse-failure 1  0 of 8 slots
```

A refusal on such draws (`INCOMPLETE_RUN` from `gate`, `flips` or `judge-change`) prints the same counts for the
files it read, where the counts cover exactly the draws it names. A reply that cannot be read is final: it usually means the judge's output budget or response format
does not fit the model. Change the judge's call and grade again.

## Machine-readable output

Every command takes `--json` and then prints one JSON object on normal output (stdout) in place of the text
report. A refusal is also one JSON object there, with exit code 2: `schema`, `tool`, `kind`, `command`, `code`,
`fields`, `message` and `exitCode`. A `gate` refusal on a judge field between the baseline and the candidate adds
`judgeDiff` (the rows, the size and the next commands), a refusal on draws that hold no grade adds `noGrade` (the counts by run file and reason), and both add
`statements`, the two sentences the text prints. `validate` is the one exception: it predicts
refusals and refuses nothing itself, so on exit 2 it prints its own report, which lists every reason. Usage errors and invalid input stay as text on
error output (stderr). [MIGRATIONS.md](MIGRATIONS.md) lists the version strings of these objects. The `agree` and
`drift` objects hold the sentence that closes the figures of their text report as `scope`: what the figures cannot show.

## A record of each decision

`gate`, `agree`, `drift` and `judge-change` take `--ledger <path>`; `flips` does not. Each run adds one line to
that file: the time, the anchorset version, the result and what identifies its inputs. A refused `gate` is
recorded too. The records are not signed, and anyone who can write the file can change it.
