---
name: anchorset
description: Use when the user wants to compare two LLM eval runs, gate a change on an eval, measure what replacing or changing an LLM judge does to the labels, check agreement between raters or a judge's drift on anchor items, or count label flips between repeat draws. Runs the anchorset CLI and reports what it printed.
---

# anchorset

anchorset is a command-line tool for LLM eval regression gates. It refuses a comparison it cannot stand behind and
names the fields that block it, and it measures what a judge change does on stored outputs.

This skill is a guide for running that tool. It holds no code and decides nothing. The refusals are in the tool,
not in this text: in a pipeline, call the tool directly.

## Running it

Always run this exact version, never a range and never `latest`:

```
npx anchorset@0.2.0 <command> ...
```

It needs Node 22.21 or later. `npx anchorset@0.2.0 --help` prints the usage text and exits 0; read it before the first
call of a session, and follow it where it differs from this page. If the package cannot be fetched, stop and report that; never fall back
to another version or to `latest`.

| The user wants | Command |
|---|---|
| to know whether a candidate run regressed against a baseline, under a bar file | `gate --baseline <run.json> --candidate <run.json> --bar <bar.json>` |
| the same, when the judge also changed: `--baseline` is then the baseline's outputs graded again by the candidate's judge, and `--rejudge-of` is the baseline as first graded | `gate ... --rejudge-of <run.json>` |
| what replacing a judge did to the labels of the same stored outputs | `judge-change --plan <plan.json> --bar <bar.json> --inputs <dir>` |
| agreement between raters who were shown the same packets | `agree --ratings <file.json>` |
| one judge's verdicts on the same anchor items, before and after | `drift --old <file.json> --new <file.json> --flag <label,...>` |
| label flips among the repeat draws of one run | `flips --run <run.json>` |
| to measure a judge change on stored outputs of promptfoo, Inspect or a skill-evals flow | These tools' result files are not accepted directly, and the importers never read grades the user already has: an example importer in the `examples/importers/` folder of https://github.com/ogous/anchorset (run from a checkout at the release tag) is a re-grading bridge. The stored outputs are graded again, by the old judge and by the new judge, through the repository's recording grader, and the importer reads the file of that re-grade and turns it into runs for `judge-change`. The report is about that re-grade, not about the grades the user already holds. Start with the offline check where the flow has one (`check.ts` for a skill-evals flow, the check mode of the Inspect re-grade script), which makes no call and costs nothing; promptfoo has none, and its free pass in `docs/IMPORTERS.md` grades through a local stand-in of the API and makes no paid call. promptfoo and Inspect each have a list of tested releases (`examples/importers/tested-versions.json`, named in the guide), and a re-grade or an import made with any other release is refused; the system's own Inspect log may come from any version. Report the refusal and the releases the list names. Never edit that list, an importer or a grading script, never try an untested release to get around it, and install a listed release only at the user's word. Never start a paid re-grade without the user's word and the amount they allow for that run. |

Every command takes `--json`, which prints one JSON object on stdout instead of the text report when the command
exits 0; `gate` also prints its regression (exit 1) as that object. A refusal (exit 2) from any command is one JSON
object on stdout under `--json` (`"schema": "anchorset.refusal/v1"`, with `code`, `fields` and `message`), and
nothing is written to stderr but, under `--ledger`, the `ledger:` line. A usage error (64) and invalid input (65) are text on stderr, under `--json` too. Run files, bar files, plans and rating files have documented formats in the
`docs/` folder of https://github.com/ogous/anchorset. Result files of other eval tools do not go into these commands
directly: the repository has example importers, run from a checkout at the release tag, and each one says what it needs.

## Rules

1. **Report exit codes for what they are, per command.**
   - `gate`: 0 is no regression, 1 is a regression, 2 is a refused comparison.
   - `judge-change`, `flips`, `agree`, `drift`: these are measurements. 0 means a report was printed, and 2 means
     refused. They never exit 1. Never call their exit 0 "passed", and never call their report a gate.
   - 64 is a usage error and 65 is invalid input. Neither is a result about the runs, and neither is any other
     exit code.
2. **A verdict needs the tool's own verdict.** In the text output, the last line `gate` prints, or the line before
   its `ledger:` line under `--ledger`, starts with `verdict: OK` or `verdict: REGRESSION`; quote that line whole, with any suffix such as `(exit 1)`. With `--json`, the verdict is the object's `kind` and `exitCode`:
   `"kind": "evaluated"` with `"exitCode": 0` or `1`, or `"kind": "refused"` with `"exitCode": 2`. A refusal in
   text mode is the tool's verdict too: exit 2 with `REFUSED <CODE>` and a `fields:` line on stderr, so read
   stderr as well as stdout. If none of these is there (the package could not be fetched, the process crashed, the
   output was cut, the JSON does not parse), say that there is no result, whatever the exit code was. The same holds for a measurement: its report counts only
   when the process exited 0 and the output is whole.
3. **After exit 2, report the refusal as printed, with the fields it names, and stop.** Present no number from that
   run. Do not compute one from the files.
4. **Do not work around a refusal.** Do not edit a run file, the plan, the bar, a ratings or anchor file, a
   reference file, a cases file, a template or any file the runs came from. After exit 64 or 65, report the
   message; do not edit an input file to make it parse. Do not delete or repeat a grading run to get a cleaner file. Do not reach the refused
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
   and never drop an interval that the report prints beside a point.
7. **Never write a run file, a bar, or a ratings or anchor file** unless the user asks for that file by name. In such a
   file, every value the tool reads as a statement is what the user states: a run's identity fields, a ratings
   file's `raterIdentity` and `categories`, an anchor file's `labels`, and every packet hash. Never choose, infer or
   fill one in, and compute a packet hash only as the sha256 of the file the user says that grader was shown. Write
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
