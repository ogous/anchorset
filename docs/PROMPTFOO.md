# promptfoo: what a judge change does to your grades

You grade with promptfoo's `llm-rubric`, and the model behind it is about to change: the provider retires its
snapshot, a model name starts to serve a newer model, you move to a cheaper judge, or you edit the rubric. After the
change your pass rate moves, and one new pass rate does not tell you how much of the move is the judge and how much
is your system.

anchorset holds your system's answers fixed: both judges grade the same stored answers, so what the report shows
comes from the judges (each judge's own draw-to-draw variation included), not from your system. `judge-change`
reports:

- the pass rate of the class you measure under each judge, and the change;
- how many labels differ between the two judges, in each direction (pass to fail, fail to pass), never netted;
- each case of a class you mark as non-compensable that either judge fails on at least one draw, with the draws each
  judge failed;
- in how many cases of the measured class each judge's own draws split between pass and fail.

It does not say which judge is right. It has no verdict and never exits 1; it exits 2 when it refuses to compare, and
64 or 65 on a usage or input error.

## What you need

- A clone of this repository and Node 22.21 or later. The scripts are examples under `examples/importers/`; the npm
  package does not include them. Run the commands below from the repository root.
- promptfoo **0.125.1** (its current release on 2026-11-06) or 0.123.1, exactly: `npm install -g promptfoo@0.125.1`. A
  file from any other version is refused.
- A judge on Anthropic's Messages API or on OpenAI's Responses API, with your key for it in `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY`. The grading script speaks those two APIs and nothing else; a judge from another provider cannot be
  used through it. If the old judge's snapshot is being retired, grade with it before it is: after that it cannot be
  called.
- The answers of your system, one per case, each test with a `case_id` variable.

Both judges grade every answer again, with your key: for each judge, one call per draw, and up to one more for each
re-ask you allow. 200 cases, 3 draws and two judges are at least 1,200 calls.

Try the whole flow first on the example data, at no cost, against a stand-in for the API on your own machine:
[Try it first, at no cost](IMPORTERS.md#try-it-first-at-no-cost) and [Your own results](IMPORTERS.md#your-own-results).

## With your own suite

Start the stand-in in a second terminal (`node examples/importers/fake-endpoint.ts`) for a free rehearsal of these
steps, or name the real API in step 2 when you are ready to pay. On the stand-in, both judges pass every answer that
does not hold the example's marker `[[strict:fail]]`, so a rehearsal on your own answers shows no change: it tests the
steps, not your judges. If `ANTHROPIC_BASE_URL` (for an OpenAI judge, any of `OPENAI_BASE_URL`, `OPENAI_API_BASE_URL`,
`OPENAI_API_HOST` and `OPENAI_HOST`) is set in your shell and is not the `baseUrl` written in your config (with no
`baseUrl`, any value), the grading script makes no call and every row holds an error: unset it. Then, in your
terminal:

```bash
OUT="$(mktemp -d)"
cp -R examples/importers/promptfoo "$OUT/pf"
cp examples/importers/tested-versions.json "$OUT/"
export PROMPTFOO_CONFIG_DIR="$OUT/pfcfg" PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 PROMPTFOO_DISABLE_SHARING=1 PROMPTFOO_DISABLE_REMOTE_GENERATION=true
```

For results you want to keep, use a folder of your own in place of `mktemp`.

**1. Your answers.** If you have a result file of a run of your system (`promptfoo eval -o result.json`, from a tested
promptfoo version, one prompt and one provider, no test with a provider or `providerOutput` of its own, each test with
a `case_id` variable), turn it into the stored answers:

```bash
rm "$OUT/pf/stored.json"
node examples/importers/promptfoo/stored-from-result.ts --in result.json --out "$OUT/pf/stored.json"
```

It prints `stored answers: <cases> cases from <rows> rows of a promptfoo <version> result file, written to <path>` and
`stored file sha256: <hash>`. Keep that hash: the run files do not record which result file the answers came from. It
copies none of the grades the file may hold. It refuses a file with two different answers for one case, as `--repeat` gives for a system that does
not answer the same way twice, since the judges must grade one fixed answer per case: run your system once for the
answers you want to keep. Without such a file, or for a file it refuses, write `stored.json` yourself:
`{ "c1": "the answer", … }`.

**2. Your cases and your judges.** In the copy, `"$OUT/pf"`, replace the example's values:

- `promptfooconfig.yaml`: your tests, each with its `case_id`; your rubric, as the `value` of the one `llm-rubric`
  check; the old judge's model and settings on the `config:` line, which names the API in `wire` (no default). With no
  `baseUrl`, the grading script sends your key to `https://api.anthropic.com` (Anthropic's wire) or
  `https://api.openai.com/v1` (OpenAI's).
- `cases.json`: each case id, its class and the label you expect.
- `bar.json`: the labels (`fail`, `pass`), your classes, the pass bar of each, and which are non-compensable.

The settings are not the same on the two APIs. A setting of the other API is refused before any call.

| Setting | `anthropic-messages/v1` | `openai-responses/v1` |
|---|---|---|
| `model` | required | required |
| output cap | `max_tokens`, required | `max_output_tokens`, required, 16 or more |
| `temperature` | optional, 0 to 1 | optional, 0 to 2 |
| `thinking` | required: `NOT_SENT` or a thinking object | not accepted |
| `effort` | required: `NOT_SENT`, or `low`, `medium`, `high`, `xhigh`, `max` | required: `NOT_SENT`, or `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `verbosity` | not accepted | required: `NOT_SENT`, `low`, `medium` or `high` |
| `maxReasks` | required, 0 to 3 | required, 0 to 3 |

`NOT_SENT` sends no such setting. A model may refuse an `effort` word it does not take; the first call is then rejected
and that draw ends with no record. The config line of an OpenAI judge looks like this, the cap included
([IMPORTERS.md](IMPORTERS.md#your-own-results) lists the other keys):

```yaml
config: { wire: openai-responses/v1, model: your-model-name, max_output_tokens: 25000, effort: NOT_SENT, verbosity: NOT_SENT, maxReasks: 0 }
```

The cap is 25000 and not the Anthropic example's 256 because on OpenAI's API the cap counts the model's reasoning
tokens as well as the reply, and OpenAI's reasoning guide, as read on 2026-11-06, advises reserving at least 25,000
tokens for reasoning and output. That is OpenAI's advice, not a figure measured on your judge. The importer prints the
reasoning tokens it saw; lower the cap only after reading them. `max_output_tokens` below 16 is refused. Keep `maxReasks` the same as the old judge's: the re-ask bound is part of the
judge's definition, and a different one moves `judgeDefinitionHash` too.

Then make the new judge's config: the same file with the new model name. The line below swaps the stand-in's two
names; with your own judges, put their two model names in it.

```bash
sed 's/fake-judge-old/fake-judge-strict-new/' "$OUT/pf/promptfooconfig.yaml" > "$OUT/pf/new-judge.yaml"
```

**3. Grade with both judges.** Three draws each. With a real judge, import the old judge's file (step 4) before you
pay for the new one.

```bash
(cd "$OUT" && ANTHROPIC_API_KEY=dummy promptfoo eval -c "$OUT/pf/promptfooconfig.yaml" --repeat 3 --no-cache -o old-judge.json)
(cd "$OUT" && ANTHROPIC_API_KEY=dummy promptfoo eval -c "$OUT/pf/new-judge.yaml" --repeat 3 --no-cache -o new-judge.json)
```

On the stand-in, an OpenAI judge's config line adds `baseUrl: 'http://127.0.0.1:18765/v1'` and takes
`OPENAI_API_KEY=dummy` in place of `ANTHROPIC_API_KEY=dummy`. A Claude-to-GPT switch needs both keys, one for each
judge. With a real judge, export `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from your secret store and drop the inline `=dummy`.
promptfoo (0.123.1 and 0.125.1) exits 100 when any row does not pass, a failed or an errored row; the file is still written.
Step 4 refuses a file in which any row holds no reply it can read. promptfoo's own pass and fail counts in its result
file are not what anchorset reads: the importer in step 4 decides which replies can be read, and a row it cannot read
refuses the whole file.

**4. Import both files.**

```bash
mkdir "$OUT/pf-runs"
node examples/importers/promptfoo/import.ts --in "$OUT/old-judge.json" --cases "$OUT/pf/cases.json" --bar "$OUT/pf/bar.json" --out "$OUT/pf-runs/old.json" --reading one-json-object-boolean-pass/v1
node examples/importers/promptfoo/import.ts --in "$OUT/new-judge.json" --cases "$OUT/pf/cases.json" --bar "$OUT/pf/bar.json" --out "$OUT/pf-runs/new.json" --reading one-json-object-boolean-pass/v1
```

**5. Measure.** Name the class to measure and what you changed about the judge, then run `judge-change`. For a new
model on the same API the moves are `judgeModelRequested,judgeModelServed`; for an edited rubric, `rubricHash` and
whatever else you changed. [JUDGE_CHANGE.md](JUDGE_CHANGE.md) describes each flag.

```bash
node examples/importers/make-plan.ts --old "$OUT/pf-runs/old.json" --new "$OUT/pf-runs/new.json" --bar "$OUT/pf/bar.json" --out "$OUT/pf-plan.json" --system refund-bot --stored-outputs system-side-not-compared --measured-class refund_policy --cut pass --label-rule majority --pooling items-equal --estimate-draws 0,1,2 --judge-moves judgeModelRequested,judgeModelServed
node src/cli.ts judge-change --plan "$OUT/pf-plan.json" --bar "$OUT/pf/bar.json" --inputs "$OUT/pf-runs"
```

To switch from a Claude judge to a GPT judge, graded through the two configs above, the moves are
`--judge-moves judgeModelRequested,judgeModelServed,judgeCallShapeHash,judgeHarnessVersion`. Each field moves for its
own reason:

- `judgeModelRequested` and `judgeModelServed` hold the two model names.
- `judgeCallShapeHash` moves because the request goes to another endpoint, with another set of settings.
- `judgeHarnessVersion` moves because the grading script called a different API; `judgeDefinitionHash` does not move,
  because the template, the reading rule and the re-ask bound are the same text and the tool and its version are the
  same (both are part of that hash). The same text is not the same presentation: in promptfoo and in skill-evals the
  system text goes to Anthropic as `system` and to OpenAI as `instructions`. The Inspect grader sends no system text on
  either wire.

The example switch changes more than the model name: the output cap (`maxOutputTokens 256 -> 25000`) and `temperature`
(`0 -> "NOT_SENT"`, because the OpenAI example line sends none) move with it, and the call-shape line of the report shows
both. Between the two judges, change only what you mean to measure; here the whole change of grading path is what the
report measures.

`make-plan` then prints a note on standard error that the report measures the change of the whole grading path, not of
the model alone ([IMPORTERS.md](IMPORTERS.md#two-apis-and-a-switch-between-them) has it whole).

On the example's answers and the stand-in's two judges, the report lists, after its header, the judge fields that
moved, for example `judgeModelRequested   fake-judge-old -> fake-judge-strict-new`. It shows a pass rate of 1.000 under
both judges for the measured class (2 cases), `labels that differ between the judges (majority)              0.000`, and
the one non-compensable case the new judge fails:
`refund_safety/refund-bot/c3  old judge fails draws [] · new judge fails draws [0, 1, 2] · worst-of-N differs between the judges`.
This plan computes points only, with no spread; the resampling block in [JUDGE_CHANGE.md](JUDGE_CHANGE.md), set by hand
in the plan, adds one when there are enough cases, and that page explains each line.

When a step stops, its message names the reason; [the importers guide](IMPORTERS.md#promptfoo) lists the common ones
and what to do.

## Limits

- One `llm-rubric` check per test, and one prompt and one provider in the result file of your system.
- The judge replies pass or fail, so the labels are `fail` and `pass`.
- OpenAI's own API only; other servers that speak its format are not tested. OpenAI's pages, as read on 2026-11-06, do
  not say which models reject or ignore `temperature` or an effort word; the record says what was sent.
- The old judge is what its model name serves today. It may not be the judge that gave your earlier grades.
- Of the commands that compare runs, only `judge-change` takes the imported run files. `gate` refuses them because they
  do not record your system's side, including how it ended each answer. `flips` refuses them because the prompt each
  judge call was shown is rebuilt at import, not recorded when it was sent. `validate` reads them and says why.
- An earlier copy of the grading script, which builds the same Anthropic requests but predates the tested-versions file
  and OpenAI's wire, was run against Anthropic's API on 2026-10-13, on the small example with promptfoo 0.123.1: one promptfoo import was
  refused because five of nine replies were not a single JSON object. 0.125.1, `stored-from-result.ts` and
  `judge-change` on imported files have run against the stand-in only, and `stored-from-result.ts` has never read a
  result file from a model provider.
  The OpenAI path ran against OpenAI's API on 2026-11-06 in two short checks, not through a `promptfoo eval` run.
  [The importers guide](IMPORTERS.md#before-you-start) lists what has and has not been tried.
