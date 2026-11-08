# Importers: promptfoo, Inspect and the eval-building skill

Your eval results are in promptfoo, in Inspect (`inspect_ai`), or in the result folder of Claude's eval-building
skill, and you want to know what a change of judge does to your labels. You grade your stored answers again with
the old judge and with the new one, turn both results into run files, and run `judge-change` on them.

The **grading script** is the example script that sends each stored answer, with your rubric and (Inspect, the
skill) the question, to the judge and records the call. A **draw** is one more grading of the same stored answer.
A **run file** holds one judge's labels ([RUN_FORMAT.md](RUN_FORMAT.md)). A **plan** names the two run files and
says what to measure.

An importer is for another tool's result file. If your own eval code wrote the grades, `write-run` turns its rows into
a run file instead ([RUN_FORMAT.md](RUN_FORMAT.md), "From your eval's rows").

## Before you start

You need:

- Node 22.21 or later.
- A clone of this repository. The importers are examples under `examples/importers/`. Run every command on this
  page from the repository root.
- For promptfoo: version 0.123.1 or 0.125.1 exactly (`npm install -g promptfoo@0.125.1`). Any other version is refused.
- For Inspect: `inspect_ai` 0.3.275 or 0.3.286 exactly (`pip install inspect_ai==0.3.286`), on Python 3.10 or later. Any
  other version is refused. The log of your system's own run may come from any version: see
  [What is and is not pinned](#what-is-and-is-not-pinned).
- For the skill's result folder: no tool.
- An API key for the judge's provider, for the paid step only: `ANTHROPIC_API_KEY` for Anthropic's Messages API,
  `OPENAI_API_KEY` for OpenAI's Responses API.

Before you pay for a call:

- The grading scripts speak two APIs: Anthropic's Messages API (`anthropic-messages/v1`) and OpenAI's own Responses
  API (`openai-responses/v1`). A judge from any other provider cannot be used through them. The settings of each, and
  what to know before you switch from one to the other, are under [Two APIs, and a switch between
  them](#two-apis-and-a-switch-between-them).
- Every OpenAI request sends `store: false` and `truncation: "disabled"`. What those mean for your data and for a long
  input is stated in that section.
- The importers never read labels you already have. Both judges grade again, and you pay for those calls with your
  own key: at least one call per draw, for each judge.
- The old judge is whatever its model name serves today. It may not be the judge that gave your earlier labels.
- One draw without a finished, readable reply refuses the whole file, and the calls made up to then are paid for.
- A draw whose call fails leaves no record of its calls. They may be billed, and the error message is the only trace
  of them. promptfoo also keeps no record of a draw whose last reply was cut at the cap.
- Imported run files work with `judge-change` only. `gate` and `flips` refuse them.
- The scripts were run against Anthropic's API on 2026-10-13, on the small example of each source, with promptfoo
  0.123.1 and `inspect_ai` 0.3.275. Six of seven imports succeeded; one promptfoo import was refused because five of its
  nine replies were not a single JSON object. Since then the JavaScript grader has changed in where it reads the
  tested versions and, in this version, gained OpenAI's wire and a record that names the wire. Its Anthropic requests are
  built as before. The Inspect script `regrade.py` has since gained checks made before any call (the tested-versions
  list, the stated answer count) and a record of the system log. On Anthropic's wire, these changes, promptfoo 0.125.1
  and `inspect_ai` 0.3.286 have run against the stand-in only. Not tried against Anthropic's API: a re-ask, a rate limit, a server error, a timeout, a
  model that rejects a thinking or effort setting, or `judge-change` on real imported files. OpenAI's wire ran against
  OpenAI's API on 2026-11-06 in two short checks ([what ran](#two-apis-and-a-switch-between-them)).

## Try it first, at no cost

These commands need Node and nothing else. They import two result files that ship with the repository, run
`judge-change` on them, and then show `gate` refusing them.

```bash
OUT="$(mktemp -d)" && mkdir "$OUT/runs"
node examples/importers/promptfoo/import.ts --in examples/importers/promptfoo/fixtures/old-judge.json --cases examples/importers/promptfoo/cases.json --bar examples/importers/promptfoo/bar.json --out "$OUT/runs/old.json" --reading one-json-object-boolean-pass/v1
node examples/importers/promptfoo/import.ts --in examples/importers/promptfoo/fixtures/new-judge.json --cases examples/importers/promptfoo/cases.json --bar examples/importers/promptfoo/bar.json --out "$OUT/runs/new.json" --reading one-json-object-boolean-pass/v1
node src/cli.ts judge-change --plan examples/importers/promptfoo/plan.json --bar examples/importers/promptfoo/bar.json --inputs "$OUT/runs"
node src/cli.ts gate --baseline "$OUT/runs/old.json" --candidate "$OUT/runs/new.json" --bar examples/importers/promptfoo/bar.json
```

Each import prints a `run file sha256:` line and exits 0. `judge-change` prints a report: only the judge's model
changed, the pass rate of the measured class is 1.000 under both judges, and the new judge alone fails case `c3` on
all three draws. `c3` is in another class, which the bar file marks non-compensable. `gate` exits 2 with
`IDENTITY_GAP`: an imported file does not record how the system ended each answer.

## Your own results

As printed, the commands run on the example files and call a stand-in for the API on your own machine, so a first
pass costs nothing once promptfoo or Inspect is installed. Start the stand-in in a second terminal:

```bash
node examples/importers/fake-endpoint.ts
```

It prints `fake-endpoint listening on 127.0.0.1:18765`. A judge whose model name contains `strict` fails the
answers the examples mark for it; any other judge passes every answer. Stop it with Ctrl-C.

The blocks below use `$OUT`. If you skipped the trial above, set it first, in the terminal you will use. For
results you want to keep, name a folder of your own in place of `mktemp`:

```bash
OUT="$(mktemp -d)"
```

Every grading script takes the same kinds of setting: `wire` (which API: `anthropic-messages/v1` or
`openai-responses/v1`), the judge's model name, the API address, the cap on the judge's output, `temperature`,
`effort` (`NOT_SENT` sends no such setting), `thinking` on Anthropic's API or `verbosity` on OpenAI's, and the number
of re-asks, 0 to 3. `wire`, the model, the output cap, `effort`, `thinking` or `verbosity` and the number of re-asks
have no default. A re-ask is one more try after a call got no reply or a reply cut at the cap. The scripts call
one case and draw a slot. Between the two judges, change only what you mean to measure. Usually that is the model
name. The settings of each API are in the table under [Two APIs](#two-apis-and-a-switch-between-them); the commands
below use Anthropic's.

If `ANTHROPIC_BASE_URL` is set in your shell and differs from the address you give, no grading script makes a
call, and promptfoo reports every row as an error. Unset it. For an OpenAI judge the variables are `OPENAI_BASE_URL`,
`OPENAI_API_BASE_URL`, `OPENAI_API_HOST` and `OPENAI_HOST`: each one that is set and differs from the address you
give, or is set when you give none, stops the grader the same way.

An importer never overwrites its `--out`. Use a new name to import again.

Grade both judges on the same tool version, the same Node or Python version and with the same number of re-asks.
Otherwise the two run files differ in one more judge field, `judgeHarnessVersion`, and `judge-change` refuses them
unless you list it in `--judge-moves`. Two numbers of re-asks, or two tool versions, differ in `judgeDefinitionHash` as
well, so a run under another number, or a saved run from an older install, needs both fields listed. To measure a tool upgrade, grade the same model under the two tool versions with the same template, reading rule, re-ask
bound and runtime, and list those two fields as the moves. The report shows that the two fields moved, not what moved
inside them, so keeping the rest the same is up to you. A second draw set of one judge (`drawSets.reask`) shows how far
the judge differs from itself.

For a real judge, the address is `https://api.anthropic.com`, or `https://api.openai.com/v1` for OpenAI. Export
`ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) once in your shell, from your secret store, and drop the inline
`ANTHROPIC_API_KEY=dummy` from the commands below. Do not type a key into a
command: it would stay in your shell history.

### promptfoo

You start from your stored answers, one per case. `stored-from-result.ts` writes `stored.json` from the result file of
an earlier run of your system ([PROMPTFOO.md](PROMPTFOO.md), step 1); or you write it by hand.

1. Copy the example folder. The `export` line keeps promptfoo's data in the scratch folder and turns off its
   telemetry, update check and sharing.

```bash
cp -R examples/importers/promptfoo "$OUT/pf"
cp examples/importers/tested-versions.json "$OUT/"
export PROMPTFOO_CONFIG_DIR="$OUT/pfcfg" PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 PROMPTFOO_DISABLE_SHARING=1 PROMPTFOO_DISABLE_REMOTE_GENERATION=true
```

With your own data, now replace the example's values in four files of the copy, `"$OUT/pf"`:

- `stored.json`: one JSON object from case id to answer text, `{ "c1": "the answer", … }`.
- `promptfooconfig.yaml`: your tests, each with a `case_id`; your rubric, as the `value` of the one `llm-rubric`
  check; the old judge's settings on the `config:` line (`wire`, `model`, `baseUrl`, `max_tokens`, `temperature`,
  `thinking`, `effort`, `maxReasks`; on OpenAI's API `max_output_tokens` and `verbosity` in place of `max_tokens`
  and `thinking`). With no `baseUrl`, the grading script sends your key to `https://api.anthropic.com`, or to
  `https://api.openai.com/v1` on the OpenAI wire.
- `cases.json`: each case id, its class (`klass`) and the label you expect (`expect`).
- `bar.json`: the labels, the classes and the pass bar of each.

The judge can only reply pass or fail here, so the labels are `fail` and `pass`: `labels` lists the lowest first.

2. Make a second config for the new judge. The `sed` line copies the config with the new model name in place of
   the old one. With your own judges, put their two model names in it.

```bash
sed 's/fake-judge-old/fake-judge-strict-new/' "$OUT/pf/promptfooconfig.yaml" > "$OUT/pf/new-judge.yaml"
```

3. Grade with the old judge, then with the new one. `--repeat 3` asks for three draws. Give the config as a full
   path and keep `--no-cache`. With a real judge, import the old judge's file (step 4) before you pay for the new
   judge.

```bash
(cd "$OUT" && ANTHROPIC_API_KEY=dummy promptfoo eval -c "$OUT/pf/promptfooconfig.yaml" --repeat 3 --no-cache -o old-judge.json)
(cd "$OUT" && ANTHROPIC_API_KEY=dummy promptfoo eval -c "$OUT/pf/new-judge.yaml" --repeat 3 --no-cache -o new-judge.json)
```

The first run reports 9 passed. The second reports 6 passed and 3 failed, and exits 100. Exit 100 means some rows
failed; the run is complete.

4. Import each result. `--reading` says how the judge's reply is read. `one-json-object-boolean-pass/v1` expects
   one JSON object with a true-or-false `pass`. `one-json-object-boolean-pass-or-json-fence/v1` also takes that
   object inside one `json` code fence. Use one rule for both judges.

```bash
mkdir "$OUT/pf-runs"
node examples/importers/promptfoo/import.ts --in "$OUT/old-judge.json" --cases "$OUT/pf/cases.json" --bar "$OUT/pf/bar.json" --out "$OUT/pf-runs/old.json" --reading one-json-object-boolean-pass/v1
node examples/importers/promptfoo/import.ts --in "$OUT/new-judge.json" --cases "$OUT/pf/cases.json" --bar "$OUT/pf/bar.json" --out "$OUT/pf-runs/new.json" --reading one-json-object-boolean-pass/v1
```

5. Write the plan. The helper reads the two run files; the other flags are your choices. Among them: the class to
   measure, the label that counts as a pass (`--cut`), the draws by number, and what you changed about the judge
   (`--judge-moves`; for a new model, `judgeModelRequested` and `judgeModelServed`).
   [JUDGE_CHANGE.md](JUDGE_CHANGE.md) describes each.

```bash
node examples/importers/make-plan.ts --old "$OUT/pf-runs/old.json" --new "$OUT/pf-runs/new.json" --bar "$OUT/pf/bar.json" --out "$OUT/pf-plan.json" --system refund-bot --stored-outputs system-side-not-compared --measured-class refund_policy --cut pass --label-rule majority --pooling items-equal --estimate-draws 0,1,2 --judge-moves judgeModelRequested,judgeModelServed
```

6. Run `judge-change`. The `--inputs` folder must hold only files the plan names: here, the two run files.

```bash
node src/cli.ts judge-change --plan "$OUT/pf-plan.json" --bar "$OUT/pf/bar.json" --inputs "$OUT/pf-runs"
```

**If it stops:**

- promptfoo exits 1 and writes no file → give the config as a full path, as above.
- `IMPORT_TOOL_VERSION` → the file comes from another promptfoo. Install a tested one and grade again. Your
  `stored.json` does not change.
- `grader: promptfoo <version> is running this grader` → grade from a separate environment, as the message says:
  `npm install --prefix .anchorset-grade promptfoo@0.125.1`, then run `.anchorset-grade/node_modules/.bin/promptfoo`.
- `IMPORT_NO_RECORD` → the file was not graded through the example grading script. Name `grader-provider.cjs` in
  the config, as the example does, and grade again.
- `IMPORT_CACHE` → the run lacked `--no-cache`. Grade again with it.
- `IMPORT_UNGRADED` → the listed draws have no finished reply that the rule can read, and nothing is imported. If
  replies were cut, raise `max_tokens`. If the message names the other reading rule, use it for both judges.

### Inspect

You start from an Inspect log of your system's run, with one answer per case. The example script `regrade.py`
grades it with Inspect's `model_graded_qa` scorer. The judge replies with a letter, so the labels in your bar file
are letters: see [`cases.json`](../examples/importers/inspect/cases.json) and
[`bar.json`](../examples/importers/inspect/bar.json). `python` below is the Python that has `inspect_ai`. For your own eval,
[INSPECT.md](INSPECT.md) walks through it, from your log to the `judge-change` report.

For the free pass, set `$OUT` if it is not set (`OUT="$(mktemp -d)"`). Then stop the stand-in if it runs, and
start it in a second terminal so that it answers with grade letters:

```bash
node examples/importers/fake-endpoint.ts --reply-format grade
```

1. Check the log. This makes no call.

```bash
python examples/importers/inspect/regrade.py --log examples/importers/inspect/fixtures/source.json --epochs 3 --check
```

2. Grade with the old judge, then with the new one. `--epochs 3` asks for three draws. Each run writes a log into
   its `--out-dir` and prints `status: success`. Give every run a new `--out-dir`: step 3 expects one log in each.

```bash
ANTHROPIC_API_KEY=dummy python examples/importers/inspect/regrade.py --wire anthropic-messages/v1 --log examples/importers/inspect/fixtures/source.json --epochs 3 --judge-model fake-judge-old --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --out-dir "$OUT/in-old"
ANTHROPIC_API_KEY=dummy python examples/importers/inspect/regrade.py --wire anthropic-messages/v1 --log examples/importers/inspect/fixtures/source.json --epochs 3 --judge-model fake-judge-strict-new --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --out-dir "$OUT/in-new"
```

3. Import each log. This importer takes no `--reading`: the last non-empty line of the judge's reply must be
   `GRADE: ` and one capital letter.

```bash
mkdir "$OUT/in-runs"
node examples/importers/inspect/import.ts --in "$(ls "$OUT"/in-old/*.json)" --cases examples/importers/inspect/cases.json --bar examples/importers/inspect/bar.json --out "$OUT/in-runs/old.json"
node examples/importers/inspect/import.ts --in "$(ls "$OUT"/in-new/*.json)" --cases examples/importers/inspect/cases.json --bar examples/importers/inspect/bar.json --out "$OUT/in-runs/new.json"
```

4. Write the plan and run `judge-change`. The cut is a label of this bar, `C`.

```bash
node examples/importers/make-plan.ts --old "$OUT/in-runs/old.json" --new "$OUT/in-runs/new.json" --bar examples/importers/inspect/bar.json --out "$OUT/in-plan.json" --system refund-bot --stored-outputs system-side-not-compared --measured-class refund_policy --cut C --label-rule majority --pooling items-equal --estimate-draws 0,1,2 --judge-moves judgeModelRequested,judgeModelServed
node src/cli.ts judge-change --plan "$OUT/in-plan.json" --bar examples/importers/inspect/bar.json --inputs "$OUT/in-runs"
```

**With your own data and a real judge:** give your log to `--log`, with your own `cases.json` and `bar.json`. Set
`--wire`, `--judge-model`, `--base-url`, `--max-tokens`, `--temperature`, `--thinking`, `--effort` and `--max-reasks`
(on the OpenAI wire `--verbosity` in place of `--thinking`). For your own grading prompt, add `--template-file` and
`--instructions-file`.

**If it stops:**

- `usage error: inspect_ai <version> is installed` → your own log does not need to change. Grade from a separate
  environment: `python -m venv .anchorset-grade && .anchorset-grade/bin/pip install inspect_ai==0.3.286`. A graded file
  from an untested version gives `IMPORT_TOOL_VERSION` at import.
- `refused: the source log cannot be replayed` → the message lists each sample and the reason. Every sample needs
  one question, one target and one answer, each as plain text, and the log must state how many answers it holds:
  it is refused when it does not state `results.total_samples`, or when that number differs from what is read.
- `REFUSED the re-grade stopped at the first slot the importer will refuse` → usually a reply was cut or did not
  end in a grade line. `regrade.py` stops there and exits 2, unless you pass `--go-on-and-count`, which goes on and
  counts such slots instead. No later call was made. Raise `--max-tokens` or fix the instructions, and grade again with
  a new `--out-dir`.
- `IMPORT_NO_RECORD`, or `IMPORT_SHAPE` naming `/eval/scorers` → the log was not graded through the example
  grading script. Grade again with `regrade.py`.
- `IMPORT_SHAPE`, "this is the packed log format" → import the JSON log that `regrade.py` wrote.

### What is and is not pinned

| Thing | Status |
|---|---|
| The tool that re-grades, and the file an importer reads | Pinned to the tested versions. Refused otherwise |
| The file format the importer reads | Pinned, for each tool |
| Your system's log and the tool that wrote it | Not pinned. The run records its sha256 and the version it states. Refused if the tested tool cannot read it, if it cannot be replayed, or if it does not state how many answers it holds or holds another number. A log the tested tool cannot read is refused; one it misreads may not be detected. |
| What wrote the stated version | Not checked: the value is what the log says, and it is a recorded claim, which nothing compares |
| Python and Node | Not pinned. Recorded in `judgeHarnessVersion` |

The run's `packetSource` ends with what it knows of the system log:

| Ending | When |
|---|---|
| `; system log sha256:<hash>, stated version inspect_ai <version>` | `regrade.py` read the log, which states that version |
| `; system log sha256:<hash>, stated version UNKNOWN` | The log states none, or one that is unprintable, holds `;` or `,`, or spells a gap |
| `; system log UNKNOWN` | A graded Inspect file with no marker |
| `; no system log` | promptfoo: the run does not record where the stored answers came from, whether `stored-from-result.ts` wrote them or you did |

A malformed or duplicate marker refuses. A file with no marker records `; system log UNKNOWN`. A marker does not show who wrote it: a hand-written file can carry one, which stays a stated limit.

An entry in `examples/importers/tested-versions.json` means the fixtures were run on that version against the stand-in and
that someone read the tool's changes to its grading path. A run against the stand-in cannot show how a real reply is
judged, which is why the read is there. There is no flag to go outside the list. Anyone can edit the file in their own
clone, and a run made that way carries no claim from this repository.

Where a tool's own file states no version, as the eval-building skill's result folder does, its importer pins a row
profile, the set of row shapes its reader accepts, refuses a file outside it and records the tool's version as `UNKNOWN`.
A changed tool that writes the same row shapes is not detected.

### The eval-building skill

You start from the result folder the skill left on disk. The skill is `claude-api` in Anthropic's public
`anthropics/skills` repository (`skills/claude-api`); its guide `shared/evals/build-eval.md` was read on 2026-10-07.
It states no version for the folder, so the importer pins its own row profile, `skill-evals/1`, written against
Claude Code CLI 2.1.288; nothing is claimed about other versions. anchorset is not affiliated with Anthropic.

For each variant (`baseline`, or `v1`, `v2` and so on) the folder holds `results.jsonl` and a `traces/` folder. A
**rep** is one repeated run of your system in that folder. You grade the answers of one rep. You also write:

- a template file for the judge's prompt, with `{question}`, `{answer}` and `{criterion}` once each and no other
  curly brace;
- a criterion file, and a system text if you want one;
- `cases.json` and `bar.json`, as for promptfoo.

Examples of each are in [`examples/importers/skill-evals/`](../examples/importers/skill-evals/). For the free
pass, set `$OUT` if it is not set (`OUT="$(mktemp -d)"`). Then stop the stand-in if it runs, and start it in a
second terminal without `--reply-format`:

```bash
node examples/importers/fake-endpoint.ts
```

1. Check the folder. `--reps` is the number of reps the folder holds. The check makes no call and says which reps
   can be graded.

```bash
node examples/importers/skill-evals/check.ts --flow examples/importers/skill-evals/example-flow --variant baseline --cases examples/importers/skill-evals/cases.json --reps 2 --select /reply --bar examples/importers/skill-evals/bar.json
```

2. Grade with the old judge, then with the new one. `--rep 0` picks the rep and `--draws 3` asks for three draws.

```bash
ANTHROPIC_API_KEY=dummy node examples/importers/skill-evals/regrade.ts --wire anthropic-messages/v1 --flow examples/importers/skill-evals/example-flow --variant baseline --cases examples/importers/skill-evals/cases.json --reps 2 --rep 0 --draws 3 --template examples/importers/skill-evals/template.txt --criterion examples/importers/skill-evals/criterion.txt --system examples/importers/skill-evals/system.txt --select /reply --model fake-judge-old --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --reading one-json-object-boolean-pass/v1 --out "$OUT/sk-old.regrade.jsonl"
ANTHROPIC_API_KEY=dummy node examples/importers/skill-evals/regrade.ts --wire anthropic-messages/v1 --flow examples/importers/skill-evals/example-flow --variant baseline --cases examples/importers/skill-evals/cases.json --reps 2 --rep 0 --draws 3 --template examples/importers/skill-evals/template.txt --criterion examples/importers/skill-evals/criterion.txt --system examples/importers/skill-evals/system.txt --select /reply --model fake-judge-strict-new --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --reading one-json-object-boolean-pass/v1 --out "$OUT/sk-new.regrade.jsonl"
```

Each run prints `slots graded: 9 of 9` and `slots the importer will refuse: 0`.

3. Import each file, with the same `--reading` and the same folder.

```bash
mkdir "$OUT/sk-runs"
node examples/importers/skill-evals/import.ts --in "$OUT/sk-old.regrade.jsonl" --cases examples/importers/skill-evals/cases.json --bar examples/importers/skill-evals/bar.json --out "$OUT/sk-runs/old.json" --reading one-json-object-boolean-pass/v1 --flow examples/importers/skill-evals/example-flow
node examples/importers/skill-evals/import.ts --in "$OUT/sk-new.regrade.jsonl" --cases examples/importers/skill-evals/cases.json --bar examples/importers/skill-evals/bar.json --out "$OUT/sk-runs/new.json" --reading one-json-object-boolean-pass/v1 --flow examples/importers/skill-evals/example-flow
```

4. Write the plan and run `judge-change`.

```bash
node examples/importers/make-plan.ts --old "$OUT/sk-runs/old.json" --new "$OUT/sk-runs/new.json" --bar examples/importers/skill-evals/bar.json --out "$OUT/sk-plan.json" --system refund-bot --stored-outputs system-side-not-compared --measured-class refund_policy --cut pass --label-rule majority --pooling items-equal --estimate-draws 0,1,2 --judge-moves judgeModelRequested,judgeModelServed
node src/cli.ts judge-change --plan "$OUT/sk-plan.json" --bar examples/importers/skill-evals/bar.json --inputs "$OUT/sk-runs"
```

**With your own data and a real judge:** point `--flow`, `--variant`, `--reps` and `--rep` at your folder, and give
your own template, criterion, `cases.json` and bar. Set `--wire`, `--model`, `--base-url`, `--max-tokens`, `--temperature`,
`--thinking`, `--effort` and `--max-reasks` (on the OpenAI wire `--verbosity` in place of `--thinking`). In the example each stored answer is a JSON object, and
`--select /reply` shows the judge its `reply` text. Leave `--select` out to show the whole answer. A case you leave
out of `cases.json` is not graded: the result is on fewer cases, and the re-grade file records which ones were
left out.

**If it stops:**

- `IMPORT_OUTPUT_UNFINISHED` → a stored answer was cut short. Grade a rep that the check calls whole, or leave
  that case out of `cases.json`.
- `IMPORT_PACKET` → the message says which: a trace this importer does not read (a tool turn, an attachment), the
  template, or `--select`.
- `REFUSED the re-grade stopped at slot` → the judge's reply was cut, or the rule could not read it. No later call
  was made. Raise `--max-tokens` or fix the prompt, and grade again with a new `--out`.
- `IMPORT_EVIDENCE`, naming `header/reading` → import with the `--reading` you graded with.

### If the plan or `judge-change` stops

- `IDENTITY_MISMATCH`, naming judge fields → `--judge-moves` must list exactly the judge fields that differ between
  the two run files. The message names the ones that do not match.
- `UNSUPPORTED_DESIGN`, naming `cut` → `--cut` must be one of the labels of your bar file.
- `HASH_MISMATCH` → the `--inputs` folder holds a file the plan does not name. Keep only the two run files there.

## Two APIs, and a switch between them

A grading script talks to Anthropic's Messages API (`wire: anthropic-messages/v1`) or to OpenAI's own Responses API
(`wire: openai-responses/v1`). The wire is a required setting with no default. Every importer prints the wire it read,
`wire: <name>`, and one file holds one wire. The settings of each:

| Setting | `anthropic-messages/v1` | `openai-responses/v1` |
|---|---|---|
| Address | `baseUrl` (`--base-url`; posts to `/v1/messages`). In promptfoo the default is `https://api.anthropic.com`; `regrade.py` and `regrade.ts` require `--base-url` | `baseUrl` (`--base-url`; posts to `/responses`). In promptfoo the default is `https://api.openai.com/v1`; `regrade.py` and `regrade.ts` require `--base-url` |
| Key variable | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` |
| Address variables that stop the grader | `ANTHROPIC_BASE_URL` | `OPENAI_BASE_URL`, `OPENAI_API_BASE_URL`, `OPENAI_API_HOST`, `OPENAI_HOST` |
| Output cap | `max_tokens` (`--max-tokens`) | `max_output_tokens` (`--max-tokens`), 16 or more |
| `temperature` | optional, 0 to 1 | optional, 0 to 2 |
| `thinking` (`--thinking`) | required: `NOT_SENT` or a thinking object | not accepted |
| `effort` | required: `NOT_SENT`, or `low`, `medium`, `high`, `xhigh`, `max` | required: `NOT_SENT`, or `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `verbosity` (`--verbosity`) | not accepted | required: `NOT_SENT`, `low`, `medium` or `high` |
| `apiVersion` (`--api-version`) | optional | not accepted |
| `maxReasks` | required, 0 to 3 | required, 0 to 3 |
| `timeoutMs` (`--timeout-ms`) | optional, default 60000, at most 3600000 | optional, default 60000, at most 3600000 |
| `apiKeyEnv` (`--api-key-env`) | optional, default `ANTHROPIC_API_KEY` | optional, default `OPENAI_API_KEY` |

A setting of the other API, or one that is not in the table (`top_p`, `seed`, `tools`, `stream` and the like), is
refused before any call. `--wire` is required by `regrade.py` and `regrade.ts`; a flag of the other wire is a usage
error (exit 64). Nothing checks an `effort` word against a model: a model that refuses the word rejects the first call,
and that draw ends with no record.

Grade a judge on OpenAI's API like this, with the skill's folder and the stand-in (start it as in the skill's section,
`node examples/importers/fake-endpoint.ts`). It imports the old judge from the Anthropic steps above and the new one
from OpenAI's wire, then measures the change. The OpenAI address ends in `/v1`. The `--max-tokens 256` in the commands suits the stand-in only; for a real OpenAI
reasoning model use a much larger cap (see the cap under "Settings across providers" below).

```bash
mkdir "$OUT/sk-x-runs" && cp "$OUT/sk-runs/old.json" "$OUT/sk-x-runs/old.json"
OPENAI_API_KEY=dummy node examples/importers/skill-evals/regrade.ts --wire openai-responses/v1 --flow examples/importers/skill-evals/example-flow --variant baseline --cases examples/importers/skill-evals/cases.json --reps 2 --rep 0 --draws 3 --template examples/importers/skill-evals/template.txt --criterion examples/importers/skill-evals/criterion.txt --system examples/importers/skill-evals/system.txt --select /reply --model fake-judge-strict-new --max-tokens 256 --temperature 0 --verbosity NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765/v1 --reading one-json-object-boolean-pass/v1 --out "$OUT/sk-gpt.regrade.jsonl"
node examples/importers/skill-evals/import.ts --in "$OUT/sk-gpt.regrade.jsonl" --cases examples/importers/skill-evals/cases.json --bar examples/importers/skill-evals/bar.json --out "$OUT/sk-x-runs/new.json" --reading one-json-object-boolean-pass/v1 --flow examples/importers/skill-evals/example-flow
node examples/importers/make-plan.ts --old "$OUT/sk-x-runs/old.json" --new "$OUT/sk-x-runs/new.json" --bar examples/importers/skill-evals/bar.json --out "$OUT/sk-x-plan.json" --system refund-bot --stored-outputs system-side-not-compared --measured-class refund_policy --cut pass --label-rule majority --pooling items-equal --estimate-draws 0,1,2 --judge-moves judgeModelRequested,judgeModelServed,judgeCallShapeHash,judgeHarnessVersion
node src/cli.ts judge-change --plan "$OUT/sk-x-plan.json" --bar examples/importers/skill-evals/bar.json --inputs "$OUT/sk-x-runs"
```

The same for an Inspect log. The old judge is the one you graded in the Inspect steps above; stop the stand-in and
start it again with `node examples/importers/fake-endpoint.ts --reply-format grade`, then:

```bash
mkdir "$OUT/in-x-runs" && cp "$OUT/in-runs/old.json" "$OUT/in-x-runs/old.json"
OPENAI_API_KEY=dummy python examples/importers/inspect/regrade.py --wire openai-responses/v1 --log examples/importers/inspect/fixtures/source.json --epochs 3 --judge-model fake-judge-strict-new --max-tokens 256 --temperature 0 --verbosity NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765/v1 --out-dir "$OUT/in-gpt"
node examples/importers/inspect/import.ts --in "$(ls "$OUT"/in-gpt/*.json)" --cases examples/importers/inspect/cases.json --bar examples/importers/inspect/bar.json --out "$OUT/in-x-runs/new.json"
node examples/importers/make-plan.ts --old "$OUT/in-x-runs/old.json" --new "$OUT/in-x-runs/new.json" --bar examples/importers/inspect/bar.json --out "$OUT/in-x-plan.json" --system refund-bot --stored-outputs system-side-not-compared --measured-class refund_policy --cut C --label-rule majority --pooling items-equal --estimate-draws 0,1,2 --judge-moves judgeModelRequested,judgeModelServed,judgeCallShapeHash,judgeHarnessVersion
node src/cli.ts judge-change --plan "$OUT/in-x-plan.json" --bar examples/importers/inspect/bar.json --inputs "$OUT/in-x-runs"
```

For a switch from a Claude judge to a GPT judge the moves are `judgeModelRequested`, `judgeModelServed`,
`judgeCallShapeHash` and `judgeHarnessVersion`; [PROMPTFOO.md](PROMPTFOO.md) says why each moves. `judgeDefinitionHash`
does not move when the template, the reading rule and the re-ask bound are the same text.

The helper `make-plan.ts` reads the `wire` part of the two runs' `judgeHarnessVersion`. When the two differ, or when
one run file does not name a wire (a file imported before the wire was recorded), it prints this note on standard error
before it writes the plan. The note does not stop the plan:

> The two run files were graded through two APIs (`<wire old>` and `<wire new>`). The report measures the change of the
> whole grading path: the model, the provider's API, the provider's defaults for every setting not sent, and how the
> reply is taken from the response. It does not separate the model from the rest. A setting with the same value in both
> files is the same text in the record, not the same setting: `effort`, `temperature`, the output cap and `NOT_SENT`
> mean different things to the two providers. Compare the two imports' reasoning and re-ask lines.

When one run file names no wire, `<wire …>` prints as `not named in the run file`.

What to know when you grade on OpenAI's API:

- **Storage.** Every OpenAI request sends `store: false`. OpenAI's pages, as read on 2026-11-06, say that a response
  sent with `store: true` (the default) is kept for at least 30 days. They do not say whether `store: false` is honoured
  for every model. They also say that abuse-monitoring logs are kept for up to 30 days unless your organisation has Zero
  Data Retention or Modified Abuse Monitoring, and that prompt caching may keep data for up to 24 hours. Nothing here
  has checked what OpenAI keeps.
- **Input.** Every OpenAI request sends `truncation: "disabled"`, so an input longer than the model's context window is not cut to fit:
  OpenAI's API reference, as read on 2026-11-06, says such a request fails with status 400. The draw then ends with no
  record.
- **The model name in the run file.** `judgeModelServed` is the model name in the provider's reply, copied as given. It
  records what the provider said, not which model graded. OpenAI's API reference, as read on 2026-11-06, does not say
  whether a request by a name without a date returns a dated name, and the GPT-6 and GPT-5.6 names listed there have no
  dated form. When the served name is the requested name, the run file cannot show which version of the model graded
  it: two files with the same served name may come from different versions, and `judge-change` then shows no move of
  the model, so a change of labels between them is reported against the fields that did move. Grade both judges close
  together. Each import prints which of the two cases holds.
- **Settings across providers.** On OpenAI's API the output cap counts the model's reasoning tokens as well as the
  reply. The same number on the two APIs is not the same room for the reply. With `effort` or `thinking` not sent, each
  provider applies its own defaults, which this page does not describe; an OpenAI reasoning model may reason at its own
  default effort. The cap in an OpenAI config is not the Anthropic example's: OpenAI's reasoning guide, as read on
  2026-11-06, advises reserving at least 25,000 tokens for reasoning and output, which is why [PROMPTFOO.md](PROMPTFOO.md)
  uses 25000. It is OpenAI's advice, not a figure measured on your judge.
- **Counters.** `thinkingTokens` and the `replies with reasoning` line hold each provider's own count, in its own
  tokens; they are not comparable across providers as amounts.
- **Re-asks.** A re-ask is made only after a call that got no reply, or a reply cut at the cap (on OpenAI's API, status
  `incomplete` with the reason `max_output_tokens`), and never after a finished reply, whatever it says. If the two
  judges' re-ask lines differ, part of the label change may come from which replies were kept.
- **Cut and filtered replies.** On OpenAI's API a reply that is `incomplete` for any other reason (for example
  `content_filter`), or that holds a refusal part, is never graded and never asked again; the import refuses the file
  and names the draw.
- **What ran against OpenAI's API, on 2026-11-06.** Two short checks, one draw per call: 13 requests through the
  JavaScript grading script (12 on gpt-6-luna, gpt-6-astra, gpt-5.5 and gpt-5.5-2026-04-23, one to a model name that
  does not exist, answered 404) and 2 through the Python one, with `inspect_ai` 0.3.286. In the first check the grading
  scripts recorded each message's phase, `final_answer`, but the importers then read only a message with no phase, so
  its two imports were refused; the second, through the shipped importers, and through grading scripts that differ
  from the shipped ones in comments only, imported one case on each of the eval-skill and Inspect paths. A cut at the
  output cap was asked again once, with the same request bytes, and a wrong key was answered 401. Each reply that held a message (six through the JavaScript
  script, two through the Python one) carried `phase: "final_answer"` on it. The importers read a completed message whose
  phase is absent or exactly that value, and refuse any other phase. A request for `gpt-5.5` returned the model name
  `gpt-5.5-2026-04-23`; `gpt-6-luna` and `gpt-6-astra` returned their own names. `gpt-6-luna` refused `temperature: 0`,
  and `gpt-6-astra` refused `effort: "none"`, each with status 400. Not run against the API: a `promptfoo eval` run, a
  comparison of two judges, more than one draw, and the rate-limit, server-error and timeout paths.

Each import also prints the served-name statement above, the reasoning line (how many asks got a reply with reasoning,
and the total, median and largest reasoning-token count), and the re-ask line.

**From an earlier version.** Grader records move from v7 to v8, which adds `wire`. This version refuses a v7
grader result at import: grade again, or, before you upgrade, import the file with the checkout whose grader wrote it. A run file
already imported stays valid and unaffected. A run imported before and one imported after differ in `judgeHarnessVersion`, as after any change of the
grading script. `regrade.py` and `regrade.ts` now require `--wire`, and the promptfoo grader config requires `wire`:
add it to commands and configs you saved.

## Reading the result

[JUDGE_CHANGE.md](JUDGE_CHANGE.md) explains each number of the report. In these reports the line
`labels that differ between two sets of one judge` reads `not measured (the plan declares no re-ask set)`. To get it, grade six draws, and
give the helper `--label-rule worst --estimate-draws 0,1,2,3,4,5`. Then set two keys in the plan by hand:
`"labelRule": "majority"` and `"drawSets": { "estimate": [0, 1, 2], "reask": [3, 4, 5] }`.

## Limits

- promptfoo: one `llm-rubric` check per test. Inspect: one scorer, `model_graded_qa`, and JSON logs only at import.
- The skill's result folder: one question and one answer per case. Tool turns and attachments are refused.
- Anthropic's Messages API and OpenAI's own Responses API only. Other servers that speak OpenAI's format are not
  tested. OpenAI's pages, as read on 2026-11-06, do not say which models reject or ignore `temperature` or an effort
  word; the record says what was sent.
- The API address: `https`, or `http` to `127.0.0.1` or `[::1]` (not `localhost`), written in its plain form, as in
  `https://gateway.example/anthropic`. An unusual spelling of a host or a port is refused, and so is a user name, a
  query, `..` or a `%` escape. A reply the server compresses is refused too.
- The two grading scripts are written in two languages and can react differently to a malformed reply from a server:
  one may refuse it or ask again where the other records it. Through Inspect, a reply that holds a broken character
  is imported, where the other two paths refuse it.
