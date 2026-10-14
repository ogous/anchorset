# Importers: promptfoo, Inspect and the eval-building skill

Your eval results are in promptfoo, in Inspect (`inspect_ai`), or in the result folder of Claude's eval-building
skill, and you want to know what a change of judge does to your labels. You grade your stored answers again with
the old judge and with the new one, turn both results into run files, and run `judge-change` on them.

The **grading script** is the example script that sends each stored answer, with your rubric and (Inspect, the
skill) the question, to the judge and records the call. A **draw** is one more grading of the same stored answer.
A **run file** holds one judge's labels ([RUN_FORMAT.md](RUN_FORMAT.md)). A **plan** names the two run files and
says what to measure.

## Before you start

You need:

- Node 22.21 or later.
- A clone of this repository. The importers are examples under `examples/importers/`. Run every command on this
  page from the repository root.
- For promptfoo: version 0.123.1 exactly (`npm install -g promptfoo@0.123.1`). Any other version is refused.
- For Inspect: `inspect_ai` 0.3.275 exactly (`pip install inspect_ai==0.3.275`), on Python 3.10 or later. Any other
  version is refused.
- For the skill's result folder: no tool.
- An Anthropic API key, for the paid step only.

Before you pay for a call:

- The grading scripts speak the Anthropic Messages API only. A judge from another provider cannot be used through
  them.
- The importers never read labels you already have. Both judges grade again, and you pay for those calls with your
  own key: at least one call per draw, for each judge.
- The old judge is whatever its model name serves today. It may not be the judge that gave your earlier labels.
- One draw without a finished, readable reply refuses the whole file, and the calls made up to then are paid for.
- A draw whose call fails leaves no record of its calls. They may be billed, and the error message is the only trace
  of them. promptfoo also keeps no record of a draw whose last reply was cut at the cap.
- Imported run files work with `judge-change` only. `gate` and `flips` refuse them.
- The scripts as shipped were run against Anthropic's API on 2026-10-13, on the small example of each source. Six of
  seven imports succeeded; one promptfoo import was refused because five of its nine replies were not a single JSON
  object. Not tried there: a re-ask, a rate limit, a
  server error, a timeout, a model that rejects a thinking or effort setting, or `judge-change` on real imported
  files.

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

Every grading script takes the same settings: the judge's model name, the API address, `max_tokens` (the cap on
the judge's reply), `temperature`, `thinking` and `effort` (`NOT_SENT` sends no such setting), and the number of
re-asks, 0 to 3. A re-ask is one more try after a call got no reply or a reply cut at the cap. The scripts call one
case and draw a slot. Between the two judges, change only what you mean to measure. Usually that is the model name.

If `ANTHROPIC_BASE_URL` is set in your shell and differs from the address you give, no grading script makes a
call, and promptfoo reports every row as an error. Unset it.

An importer never overwrites its `--out`. Use a new name to import again.

Grade both judges on the same Node or Python version and with the same number of re-asks. Otherwise the two run
files differ in one more judge field, `judgeHarnessVersion`, and `judge-change` refuses them unless you list it in
`--judge-moves`.

For a real judge, the address is `https://api.anthropic.com`. Export `ANTHROPIC_API_KEY` once in your shell, from
your secret store, and drop the inline `ANTHROPIC_API_KEY=dummy` from the commands below. Do not type a key into a
command: it would stay in your shell history.

### promptfoo

You start from your stored answers, one per case. You write `stored.json` by hand; no script fills it from an
earlier promptfoo result.

1. Copy the example folder. The `export` line keeps promptfoo's data in the scratch folder and turns off its
   telemetry, update check and sharing.

```bash
cp -R examples/importers/promptfoo "$OUT/pf"
export PROMPTFOO_CONFIG_DIR="$OUT/pfcfg" PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 PROMPTFOO_DISABLE_SHARING=1 PROMPTFOO_DISABLE_REMOTE_GENERATION=true
```

With your own data, now replace the example's values in four files of the copy, `"$OUT/pf"`:

- `stored.json`: one JSON object from case id to answer text, `{ "c1": "the answer", … }`.
- `promptfooconfig.yaml`: your tests, each with a `case_id`; your rubric, as the `value` of the one `llm-rubric`
  check; the old judge's settings on the `config:` line (`model`, `baseUrl`, `max_tokens`, `temperature`,
  `thinking`, `effort`, `maxReasks`). With no `baseUrl`, the grading script sends your key to
  `https://api.anthropic.com`.
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
- `IMPORT_TOOL_VERSION` → the file comes from another promptfoo. Install 0.123.1 and grade again.
- `IMPORT_NO_RECORD` → the file was not graded through the example grading script. Name `grader-provider.cjs` in
  the config, as the example does, and grade again.
- `IMPORT_CACHE` → the run lacked `--no-cache`. Grade again with it.
- `IMPORT_UNGRADED` → the listed draws have no finished reply that the rule can read, and nothing is imported. If
  replies were cut, raise `max_tokens`. If the message names the other reading rule, use it for both judges.

### Inspect

You start from an Inspect log of your system's run, with one answer per case. The example script `regrade.py`
grades it with Inspect's `model_graded_qa` scorer. The judge replies with a letter, so the labels in your bar file
are letters: see [`cases.json`](../examples/importers/inspect/cases.json) and
[`bar.json`](../examples/importers/inspect/bar.json). `python` below is the Python that has `inspect_ai`.

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
ANTHROPIC_API_KEY=dummy python examples/importers/inspect/regrade.py --log examples/importers/inspect/fixtures/source.json --epochs 3 --judge-model fake-judge-old --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --out-dir "$OUT/in-old"
ANTHROPIC_API_KEY=dummy python examples/importers/inspect/regrade.py --log examples/importers/inspect/fixtures/source.json --epochs 3 --judge-model fake-judge-strict-new --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --out-dir "$OUT/in-new"
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
`--judge-model`, `--base-url`, `--max-tokens`, `--temperature`, `--thinking`, `--effort` and `--max-reasks`. For
your own grading prompt, add `--template-file` and `--instructions-file`.

**If it stops:**

- `usage error: inspect_ai <version> is installed` → install 0.3.275. A log from another version gives
  `IMPORT_TOOL_VERSION` at import.
- `refused: the source log cannot be replayed` → the message lists each sample and the reason. Every sample needs
  one question, one target and one answer, each as plain text.
- `REFUSED the re-grade stopped at the first slot the importer will refuse` → usually a reply was cut or did not
  end in a grade line. No later call was made. Raise `--max-tokens` or fix the instructions, and grade again with
  a new `--out-dir`.
- `IMPORT_NO_RECORD`, or `IMPORT_SHAPE` naming `/eval/scorers` → the log was not graded through the example
  grading script. Grade again with `regrade.py`.
- `IMPORT_SHAPE`, "this is the packed log format" → import the JSON log that `regrade.py` wrote.

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
ANTHROPIC_API_KEY=dummy node examples/importers/skill-evals/regrade.ts --flow examples/importers/skill-evals/example-flow --variant baseline --cases examples/importers/skill-evals/cases.json --reps 2 --rep 0 --draws 3 --template examples/importers/skill-evals/template.txt --criterion examples/importers/skill-evals/criterion.txt --system examples/importers/skill-evals/system.txt --select /reply --model fake-judge-old --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --reading one-json-object-boolean-pass/v1 --out "$OUT/sk-old.regrade.jsonl"
ANTHROPIC_API_KEY=dummy node examples/importers/skill-evals/regrade.ts --flow examples/importers/skill-evals/example-flow --variant baseline --cases examples/importers/skill-evals/cases.json --reps 2 --rep 0 --draws 3 --template examples/importers/skill-evals/template.txt --criterion examples/importers/skill-evals/criterion.txt --system examples/importers/skill-evals/system.txt --select /reply --model fake-judge-strict-new --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --reading one-json-object-boolean-pass/v1 --out "$OUT/sk-new.regrade.jsonl"
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
your own template, criterion, `cases.json` and bar. Set `--model`, `--base-url`, `--max-tokens`, `--temperature`,
`--thinking`, `--effort` and `--max-reasks`. In the example each stored answer is a JSON object, and
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

## Reading the result

[JUDGE_CHANGE.md](JUDGE_CHANGE.md) explains each number of the report. In these reports the line
`labels that differ between two sets of one judge` reads `not declared`. To get it, grade six draws, and
give the helper `--label-rule worst --estimate-draws 0,1,2,3,4,5`. Then set two keys in the plan by hand:
`"labelRule": "majority"` and `"drawSets": { "estimate": [0, 1, 2], "reask": [3, 4, 5] }`.

## Limits

- promptfoo: one `llm-rubric` check per test. Inspect: one scorer, `model_graded_qa`, and JSON logs only at import.
- The skill's result folder: one question and one answer per case. Tool turns and attachments are refused.
- The API address: `https`, or `http` to `127.0.0.1` (not `localhost`), written in its plain form, as in
  `https://gateway.example/anthropic`. An unusual spelling of a host or a port is refused, and so is a user name, a
  query, `..` or a `%` escape. A reply the server compresses is refused too.
- The two grading scripts are written in two languages and can react differently to a malformed reply from a server:
  one may refuse it or ask again where the other records it. Through Inspect, a reply that holds a broken character
  is imported, where the other two paths refuse it.
