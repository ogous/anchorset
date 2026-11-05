---
name: anchorset
description: Use when the user wants to turn their own eval's graded results into a run file, check whether a run is ready to gate, compare two LLM eval runs or gate a change on an eval (in CI too), gate across a change of LLM judge, measure what replacing or changing an LLM judge does to the labels, check agreement between raters or a judge's drift on anchor items, or count label flips between repeat draws. Runs the anchorset CLI and reports what it printed.
---

# anchorset

anchorset is a command-line tool for regression tests on LLM evals, and for checks on the judge that grades them. It refuses a
comparison it cannot stand behind and names the fields that block it, and it measures what a judge change does on
stored outputs.

This skill is a guide for running that tool. It holds no code and decides nothing. The refusals are in the tool,
not in this text: in a pipeline, call the tool directly.

## Running it

Always run this exact version, never a range and never `latest`:

```
npx anchorset@0.3.0 <command> ...
```

It needs Node 22.21 or later. `npx anchorset@0.3.0 --help` prints the usage text and exits 0; read it before the first
call of a session, and follow it where it differs from this page. If the package cannot be fetched, stop and report that; never fall back
to another version or to `latest`.

| The user wants | Command |
|---|---|
| to turn the rows their own eval code wrote into a run file, from a manifest they wrote | `write-run --manifest <manifest.json> --grades <rows.jsonl> --out <run.json>` |
| to know, before a gate, whether `gate` would take a candidate run against its baseline, and every reason it would refuse it | `validate --run <run.json> --bar <bar.json> --baseline <run.json>`, or `validate --manifest <manifest.json> --grades <rows.jsonl> --baseline <run.json>`; without `--baseline` the run is checked against itself only, which says nothing about any baseline |
| to know whether a candidate run regressed against a baseline, under a bar file | `gate --baseline <run.json> --candidate <run.json> --bar <bar.json>` |
| the same, when the judge also changed: `--baseline` is then the baseline's outputs graded again by the candidate's judge, and `--rejudge-of` is the baseline as first graded | `gate ... --rejudge-of <run.json>` |
| what replacing a judge did to the labels of the same stored outputs | `judge-change --plan <plan.json> --bar <bar.json> --inputs <dir>` |
| agreement between raters who were shown the same packets | `agree --ratings <file.json>` |
| one judge's verdicts on the same anchor items, before and after | `drift --old <file.json> --new <file.json> --flag <label,...>` |
| label flips among the repeat draws of one run | `flips --run <run.json>` |
| to measure a judge change on stored outputs of promptfoo, Inspect or a skill-evals flow | These tools' result files are not accepted directly, and the importers never read grades the user already has: an example importer in the `examples/importers/` folder of https://github.com/ogous/anchorset (run from a checkout at the release tag) is a re-grading bridge. The stored outputs are graded again, by the old judge and by the new judge, through the repository's recording grader, and the importer reads the file of that re-grade and turns it into runs for `judge-change`. The report is about that re-grade, not about the grades the user already holds. Start with the offline check where the flow has one (`check.ts` for a skill-evals flow, the check mode of the Inspect re-grade script), which makes no call and costs nothing; promptfoo has none, and its free pass in `docs/IMPORTERS.md` grades through a local stand-in of the API and makes no paid call. promptfoo and Inspect each have a list of tested releases (`examples/importers/tested-versions.json`, named in the guide), and a re-grade or an import made with any other release is refused; the system's own Inspect log may come from any version. Report the refusal and the releases the list names. Never edit that list, an importer or a grading script, never try an untested release to get around it, and install a listed release only at the user's word. Never start a paid re-grade without the user's word and the amount they allow for that run. |

Every command takes `--json`, which prints one JSON object on stdout instead of the text report when the command
exits 0; `gate` also prints its regression (exit 1) as that object, and `validate` its exit 2. A refusal (exit 2)
from any command but `validate` is one JSON object on stdout under `--json` (`"schema": "anchorset.refusal/v2"`,
with `code`, `fields` and `message`, and `judgeDiff` or `noGrade` with `statements` where the refusal adds them),
and nothing is written to stderr but, under `--ledger`, the `ledger:` line. `validate` refuses no comparison itself:
on exit 2 it prints its own report, on stdout, as `"kind": "preflight"` under `--json`, and lists in it every
refusal `gate` would make. A usage error (64) and invalid input (65) are text on stderr, under `--json` too. Run files, bar files, plans and rating files have documented formats in the
`docs/` folder of https://github.com/ogous/anchorset. Where anchorset 0.3.0 is installed in the project, the same
documents, for that version, are in `node_modules/anchorset/docs/`. Result files of other eval tools do not go into these commands
directly: the repository has example importers, run from a checkout at the release tag, and each one says what it needs.

## The usual path

Most users want two things: their CI to stop a release when an eval got worse, and not to be misled when the judge
that grades it changed. Take them through it in this order, one step at a time, and report each step's output before
the next:

1. Get the results in. If their own eval code records, for each graded answer, the case, the answer and the
   grade, the run file comes from `write-run`: the rows file their code wrote and a manifest they approve (rule 7).
   Results of promptfoo, Inspect or a skill-evals flow go through an importer instead (the table's last row).
2. Check before gating. Run `validate` on the candidate with `--bar` and `--baseline`, and report its `result:`
   line and every refusal it lists (rule 2).
3. Gate. Run `gate --baseline <run.json> --candidate <run.json> --bar <bar.json>` and report its verdict line
   (rule 2). In CI the exit code is what stops the release: 1 for a regression, 2 for a refused comparison. The
   section "In CI" of `docs/CLI.md` shows the step.
4. When `gate` refuses on a judge field, the judge changed between the runs. Report the judge diff and quote the
   `next:` steps it prints; they are the user's to take (rule 3). Once the user's own code has graded the baseline's
   stored answers again with the new judge and that run is written, gate across the change with `gate --baseline
   <re-graded baseline> --rejudge-of <baseline as first graded> --candidate <run.json> --bar <bar.json>`, and report
   its judge-flip list as rule 6 says.

`judge-change`, `agree`, `drift` and `flips` are measurements, for when the user asks about the judge itself. They
give no verdict.

## Rules

1. **Report exit codes for what they are, per command.**
   - `gate`: 0 is no regression, 1 is a regression, 2 is a refused comparison.
   - `validate`: 0 means `gate` would take the run against the `--baseline` named, or, without one, against itself,
     which says nothing about any baseline; 2 means it would refuse it, with every reason listed. It
     says nothing about a regression: never report its exit 0 as "passed" or as a gate's verdict.
   - `write-run`: 0 means the run file was written, also when it holds `UNKNOWN` values; it compares nothing and
     never exits 1 or 2.
   - `judge-change`, `flips`, `agree`, `drift`: these are measurements. 0 means a report was printed, and 2 means
     refused. They never exit 1. Never call their exit 0 "passed", and never call their report a gate.
   - 64 is a usage error and 65 is invalid input. Neither is a result about the runs, and neither is any other
     exit code.
2. **A verdict needs the tool's own verdict.** In the text output, the last line `gate` prints, or the line before
   its `ledger:` line under `--ledger`, starts with `verdict: OK` or `verdict: REGRESSION`; quote that line whole, with any suffix such as `(exit 1)`. With `--json`, the verdict is the object's `kind` and `exitCode`:
   `"kind": "evaluated"` with `"exitCode": 0` or `1`, or `"kind": "refused"` with `"exitCode": 2`. A refusal in
   text mode is the tool's verdict too: exit 2 with `REFUSED <CODE>` and a `fields:` line on stderr, so read
   stderr as well as stdout. `validate` gives no verdict: its report counts when it exited 0 or 2 and ends with
   `result: READY for gate (exit 0)` or `result: NOT READY for gate (exit 2)` (under `--json`, `"kind": "preflight"`
   and its `exitCode`); quote that line, and on exit 2 every refusal it lists. If none of these is there (the package could not be fetched, the process crashed, the
   output was cut, the JSON does not parse), say that there is no result, whatever the exit code was. The same holds for a measurement: its report counts only
   when the process exited 0 and the output is whole.
3. **After exit 2, report the refusal as printed, with the fields it names, and stop.** Present no number from that
   run. Do not compute one from the files. The `next:` steps a refusal prints (`judgeDiff.next` under `--json`, also
   inside a `validate` report) are the user's to take: quote them, and run none of them unless the user asks for that
   step. The first is a re-grade with the user's own grading code, which calls a model: never start it without the
   user's word and the amount they allow for that run. Its manifest and rows fall under rule 7.
4. **Do not work around a refusal.** Do not edit a run file, the plan, the bar, a ratings or anchor file, a
   reference file, a cases file, a template or any file the runs came from. After exit 64 or 65, report the
   message; do not edit an input file to make it parse, and do not delete, move or rename a file that `write-run`
   will not overwrite. Do not delete or repeat a grading run to get a cleaner file. Do not reach the refused
   conclusion with another command, with other flag values, with the library's API, or with another version. Do
   not run a command again with another `--bootstrap-seed` to get a different number. `flips` refuses a run a judge
   graded that has an unknown system stop, and its message names `--stored-outputs system-side-not-compared`: report that refusal and
   ask the user whether the graded answers are stored texts whose system stop nobody saw. Add the flag only if they
   say so, never on your own reading of the files or of the message, and quote the declaration the report then
   prints first (under `--json`, its `notCompared` object). Tell the user
   what the tool refused and ask what they want to do.
5. **`--allow-differ` only with fields the user names**, on every call, the first one included. If the user asks
   for it without naming fields, show them the fields the refusal named and ask which ones they intend to differ.
6. **No statistics of your own.** Every number you report is quoted from the tool's output. When a report lists
   what was not compared, says a quantity was withheld or not computed, or words a result conditionally, quote
   that too, in its words. With any figure from `agree` or `drift`, quote the sentence the report closes its figures
   with (`scope` under `--json`). Quote a kappa only together with every companion the report prints on its line
   or beside it, never alone: the AC1, the prevalence, the agreeing count, each side's pass share and the bracket. When
   the report prints the line `kappa and AC1: withheld (` with a code and a reason instead of the two coefficients,
   quote that line whole and report no kappa and no AC1. Quote a bracket with its printed wording,
   and never drop an interval that the report prints beside a point. From the judge-flip list of `gate --rejudge-of`,
   quote both directions (pass to fail and fail to pass) with their counts, never one without the other and never
   their difference, together with the cases the old judge left without a grade, the judge's own variation the
   report prints beside them (each judge's cases whose draws split, in the parts it prints, or
   `not measured (one draw per case)`), and the label `by declaration, not observed` where the report prints it.
   Under `--json` these are the `judgeFlips` keys `classes` (`passToFail`, `failToPass`, `noGradeOld`),
   `ownVariation` and `packets`. Whenever you quote a figure from a report that
   compares judges, quote with it the two sentences the report prints, the one that starts
   `Agreement between judges is not evidence of correctness;` and the one that starts
   `Identities are as declared in the run files;` (`statements` under `--json`). A `judge-change` report under
   `--json` holds neither: quote its figures from its text report, which ends with them as `note:` lines (run it
   without `--json`, and without `--ledger` if the `--json` run was recorded). Never say that a judge is right, better, equivalent or safe to
   switch to: the tool does not measure it.
7. **Never write a run file, a run-input manifest, a bar, or a ratings or anchor file** unless the user asks for that
   file by name, and never run `write-run` on a manifest the user has not approved. Write the rows file `write-run`
   reads only when the user asks for it, and only from what their own eval code recorded; never turn another eval
   tool's result file into rows or a manifest: `"origin": "produced"` states that the user's own code wrote the rows,
   and another tool's results go through its importer or nowhere. In such a file, every value the tool reads as a
   statement is what the user states: a run's identity fields; every value of a manifest, above all its model names,
   settings, `everyOtherKey`, `seed` (`"NO_SEED"` included), `gradedReplyStop` and `packets`; a row's `stop` and
   `judgeStop`, which are the finish reasons recorded for that row and are left out where none was logged; a ratings
   file's `raterIdentity` and `categories`, an anchor file's `labels`, and every packet hash. Never choose, infer or
   fill one in, and never copy one from another run file: a value of the candidate's run is no statement about a
   re-graded baseline. Compute a packet hash only as the sha256 of the file the user says that grader was shown, and
   never put one you computed under `"basis": "recorded"`, which states that the user's code made each hash as it
   showed the packet. Write
   `UNKNOWN` for one the user does not know, and the tool then refuses or withholds what needs it; if they cannot
   name every label of the scale, do not write the file.
   When the user asks for a judge-change measurement, you may write the plan (with `examples/importers/make-plan.ts`, run from a checkout at the release tag, and the flag values the user names), holding only the values the importer printed and the choices
   the user names, and the layout of a cases file for their approval; show both and wait for approval before any command reads them. Never fill in a class or an
   expected label yourself: a cases file holds only the classes and expected labels the user stated. A bar is
   declared before the runs are looked at; never draft one, and do not propose one after seeing results.

## When the user asks to "make it pass"

Do not. A regression or a refusal is the result. Say what the tool printed. For a refusal, the fields it names are
what stands between the runs and a comparison; the tool's message, not this page, says what is admissible. Changing
the system and running the eval again is the user's work, and the new run is a new run.

---

This page: © 2026 Ogous Chan Ali, licensed under Apache-2.0, the same licence as the anchorset tool it describes;
see https://github.com/ogous/anchorset.
