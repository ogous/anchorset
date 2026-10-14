# The command line and CI

For anyone who runs anchorset from a script or from CI, the service that checks each change: the five commands,
what each exit code means, and how to gate when the judge changed.

## The commands

| Command | What it reads |
|---|---|
| `gate` | Two run files and a bar file |
| `agree` | One ratings file: the labels of two or more graders |
| `drift` | Two anchor files: one judge, the same items, two dates |
| `flips` | One run file with several draws per case |
| `judge-change` | A plan, a bar file and a folder of run files |

The file formats are in [RUN_FORMAT.md](RUN_FORMAT.md), [RATINGS_FORMAT.md](RATINGS_FORMAT.md) and
[JUDGE_CHANGE.md](JUDGE_CHANGE.md). Each command on the example data, from the root of a clone:

```sh
node src/cli.ts gate --baseline examples/refund-bot/baseline.json --candidate examples/refund-bot/candidate.json --bar examples/refund-bot/bar.json --allow-differ systemModelServed,systemCallShapeHash
node src/cli.ts agree --ratings examples/refund-bot/ratings.json
node src/cli.ts drift --old examples/refund-bot/anchor_old.json --new examples/refund-bot/anchor_new.json --flag handoff
node src/cli.ts flips --run examples/refund-bot/judged.json
node src/cli.ts judge-change --plan examples/judge-change/plan.json --bar examples/judge-change/bar.json --inputs examples/judge-change/runs
```

The first exits 1, because the example holds a regression. The other four exit 0. `--help` prints every flag. When
anchorset is installed from npm, the command is `anchorset` where this page shows `node src/cli.ts`.

`--allow-differ` lists the identity fields that may differ between the two runs. Without it, `gate`
refuses runs that differ, so a new model name is refused. A judge field and `drawsPerCase` can never be listed, and
neither can `rubricHash` when a judge graded the runs.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | `gate`: no regression, and every pass bar is met. The other four: the report was printed, whatever it shows. |
| 1 | `gate` only: a regression. A case broke, a class is below its pass bar, a non-compensable class (`"nonCompensable": true` in the bar file) has a failing case, a class has no case in the run, or a case is unfinished in the candidate. |
| 2 | Refused. The comparison can't be trusted, and the message names what differs or is unknown. |
| 64 | Usage error: a flag is missing, unknown or cannot be used here. |
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

A CI shell step fails on any exit code other than 0, so this line is the whole step.

anchorset can also be called from your own code as a library. Catch its errors there: an uncaught error makes
Node exit 1, which a pipeline reads as a regression.

## When the judge changed

`gate` refuses two runs graded by different judges. To gate across a judge change:

1. Have the new judge grade the baseline's stored answers again. Write the result as a run file.
2. Run your new version and grade it with the new judge. That run file is the candidate.
3. Give `gate` the new baseline, and the baseline as first graded under `--rejudge-of`:

```sh
node src/cli.ts gate --baseline <baseline graded again> --candidate <candidate> --bar <bar file> --rejudge-of <baseline as first graded>
```

Both baselines must hold the same answers, or the command exits 2. If the candidate differs from the baseline in
system fields, as it does when you changed the system, list them with `--allow-differ` as for any gate.

The verdict compares the candidate with the baseline graded again. Above it, a block headed `judge-controlled`
shows three changes in pass rate. `reported` is the candidate minus the baseline as first graded. `judge` is the
baseline graded again minus the baseline as first graded. `system` is the candidate minus the baseline graded
again. If the two baselines do not record that both judges were shown the same thing, the block says
`not computed`, and the verdict stays the same.

`judge` is measured on the baseline's answers only; on the candidate's answers it may differ.

## Machine-readable output

Every command takes `--json` and then prints one JSON object on normal output (stdout) in place of the text
report. A refusal is also one JSON object there, with exit code 2. Usage errors and invalid input stay as text on
error output (stderr). [MIGRATIONS.md](MIGRATIONS.md) lists the version strings of these objects.

## A record of each decision

`gate`, `agree`, `drift` and `judge-change` take `--ledger <path>`; `flips` does not. Each run adds one line to
that file: the time, the anchorset version, the result and what identifies its inputs. A refused `gate` is
recorded too. The records are not signed, and anyone who can write the file can change it.
