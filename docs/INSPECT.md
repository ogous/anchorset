# Inspect: what a judge change does to your grades

You grade with Inspect's `model_graded_qa`, and the model behind it is about to change: the provider retires its
snapshot, a model name starts to serve a newer model, you move to a cheaper judge, or you edit the grading prompt.
After the change your accuracy moves, and one new number does not tell you how much of the move is the judge and how
much is your system.

anchorset holds your system's answers fixed: both judges grade the answers stored in one Inspect log of your system,
so what the report shows comes from the judges (each judge's own draw-to-draw variation included), not from your
system. `judge-change` reports:

- the pass rate of the class you measure under each judge, and the change;
- how many labels differ between the two judges, in each direction (pass to fail, fail to pass), never netted;
- each case of a class you mark as non-compensable that either judge fails on at least one draw, with the draws each
  judge failed;
- in how many cases of the measured class each judge's own draws split between pass and fail.

It does not say which judge is right. It has no verdict and never exits 1; it exits 2 when it refuses to compare, 64
or 65 on a usage or input error, and 70 on an internal error.

## What you need

- A clone of this repository and Node 22.21 or later. The scripts are examples under `examples/importers/`; the npm
  package does not include them. Run the commands below from the repository root.
- Python 3.10 or later, and a separate environment for the grading with `inspect_ai` **0.3.286** or 0.3.275, exactly.
  Your own eval can stay on the version it uses: the grading reads your log for its stored answers only. A newer
  `inspect_ai`, such as 0.3.288, is refused for the grading itself; a small log written by 0.3.288 was checked and
  graded under 0.3.286 against the stand-in.
- A judge on Anthropic's Messages API or on OpenAI's Responses API, with your key for it in `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY`. The grading script speaks those two APIs and nothing else; a judge from another provider cannot be
  used through it. If the old judge's snapshot is being retired, grade with it before it is: after that it cannot be
  called.
- One Inspect log of your system's run (`.eval` or `.json`), run with one epoch, so that it holds one answer per case.

Both judges grade every answer again, with your key: for each judge, one call per draw, and up to one more for each
re-ask you allow. 200 cases, 3 draws and two judges are at least 1,200 calls. The script makes one call at a time, and
waits 2, 4 and 8 seconds before re-asking a call that got no reply, so a run with a slow reasoning judge can take hours.

Try the whole flow first on the example data, at no cost, against a stand-in for the API on your own machine:
[Try it first, at no cost](IMPORTERS.md#try-it-first-at-no-cost) and [the Inspect steps](IMPORTERS.md#inspect).

## What your log must hold

The grading script checks the log before any call and lists every sample it refuses, with the reason. It takes a log
in which:

- the run finished (`status` is `success`), and the log states how many answers it holds;
- each sample has an id, a string or an integer, and no error;
- each sample's input is one plain string, not a list of chat messages, and its target is one plain string, not a list
  of targets (the target is the criterion the judge grades against);
- each sample has exactly one answer, stored as one non-empty string, and no answer choices: an answer stored as a list
  of parts (for example a reasoning model's reasoning and text) is refused, and so is one whose message differs from
  `output.completion`;
- each id occurs once: a run with `--epochs 2` or more holds two answers for one case, and is refused; so is a log
  with both `1` and `"1"` as ids;
- the number of answers the log states equals the number it holds;
- no question, answer or target holds `[BEGIN DATA]` or `[END DATA]`, in any mix of upper and lower case.

A refused log exits 2 and nothing is sent.

## With your own eval

Stop the stand-in if it runs, and start it in a second terminal (`node examples/importers/fake-endpoint.ts
--reply-format grade`) for a free rehearsal of these steps, or name the real API in step 3 when you are ready to pay. On
the stand-in, both judges pass every answer that does not hold the example's marker `[[strict:fail]]`, so a rehearsal on
your own answers shows no change: it tests the steps, not your judges. If `ANTHROPIC_BASE_URL` (for an OpenAI judge, any
of `OPENAI_BASE_URL`, `OPENAI_API_BASE_URL`, `OPENAI_API_HOST` and `OPENAI_HOST`) is set in your shell and is not the
`--base-url` you give, the grading script makes no call: unset it. Then, in your terminal:

```bash
python3 --version
python3 -m venv .anchorset-grade && .anchorset-grade/bin/pip install inspect_ai==0.3.286
PY=.anchorset-grade/bin/python
OUT="$(mktemp -d)"
cp -R examples/importers/inspect "$OUT/in"
LOG=examples/importers/inspect/fixtures/source.json
```

`python3 --version` must print 3.10 or later: on an older Python, `pip` finds no matching `inspect_ai`, so name a newer
one in its place (macOS's own `python3` is 3.9). For results you want to keep, use a folder of your own in place of
`mktemp`. `LOG` names the example's log; set it to your own log's path.

**1. Check your log.** This makes no call.

```bash
$PY examples/importers/inspect/regrade.py --log "$LOG" --epochs 3 --check
```

It prints `system log: sha256 <hash>, stated version inspect_ai <version> (recorded, not required)` and
`check passed: <n> sample(s), one stored output each; 3 epoch(s) would be run. No request was made.` The run files
record that hash and version.

**2. Your cases and your bar.** In the copy, `"$OUT/in"`, replace the example's values:

- `cases.json`: each sample id of your log, its class and the grade letter you expect (`"C"` for a correct answer).
- `bar.json`: the labels, your classes, the pass bar of each, and which are non-compensable. The labels are the
  letters the judge may reply with, worst first, as in the example's `["I", "C"]`. Inspect reads only `C`, `P` and
  `I`. If your instructions allow partial credit, list `["I", "P", "C"]`: with `--cut C`, a `P` then counts as a fail.
  A reply with another letter, or with a letter your bar does not list, refuses the whole log at import, after the
  grading is paid for.

`cases.json` must list exactly the ids of your log, no more and no fewer; that too is checked only at import. A free
rehearsal of steps 3 to 5 on your own log, against the stand-in, catches both mistakes at no cost.

**3. Grade with both judges.** `--epochs 3` asks for three draws of each judge. Give every run a new `--out-dir`.
With a real judge, import the old judge's log (step 4) before you pay for the new one.

```bash
ANTHROPIC_API_KEY=dummy $PY examples/importers/inspect/regrade.py --wire anthropic-messages/v1 --log "$LOG" --epochs 3 --judge-model fake-judge-old --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --out-dir "$OUT/in-old"
ANTHROPIC_API_KEY=dummy $PY examples/importers/inspect/regrade.py --wire anthropic-messages/v1 --log "$LOG" --epochs 3 --judge-model fake-judge-strict-new --max-tokens 256 --temperature 0 --thinking NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url http://127.0.0.1:18765 --out-dir "$OUT/in-new"
```

Each run prints `status: success` and `slots the importer will refuse: 0`, and writes one log into its `--out-dir`. With
your own judges, put their two model names in `--judge-model`, and give `--base-url https://api.anthropic.com`. Between
the two judges, change only what you mean to measure; keep `--max-reasks` the same, since the re-ask bound is part of
the judge's definition. Grade both judges from the same clone and the same environment (the same `inspect_ai`, the same
Python): otherwise `judgeHarnessVersion` moves, and `judgeDefinitionHash` too for another `inspect_ai`, and
`judge-change` refuses unless you list them. With a real judge, export `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from your
secret store and drop the inline `=dummy`.

The grading prompt is the template and the instructions of `model_graded_qa`. Without a file flag the script passes
the two texts beside it, `template.txt` and `instructions.txt`, which are Inspect 0.3.286's defaults. If your eval
gives the scorer its own template or instructions, pass them with `--template-file` and `--instructions-file`. A
template may hold no brace but `{question}`, `{answer}`, `{criterion}` and `{instructions}`: a metadata variable or a
literal JSON brace is refused. Inspect 0.3.288 changed its default template, and the script cannot use the new one, so
if your eval graded with 0.3.288's default, your earlier grades came from another prompt than the one both judges get
here.

The settings are not the same on the two APIs. A setting of the other API is refused before any call.

| Setting | `anthropic-messages/v1` | `openai-responses/v1` |
|---|---|---|
| `--judge-model` | required | required |
| `--max-tokens` | required, sent as `max_tokens` | required, 16 or more, sent as `max_output_tokens` |
| `--temperature` | optional, 0 to 1 | optional, 0 to 2 |
| `--thinking` | required: `NOT_SENT` or one of four thinking objects | not accepted |
| `--effort` | required: `NOT_SENT`, or `low`, `medium`, `high`, `xhigh`, `max` | required: `NOT_SENT`, or `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--verbosity` | not accepted | required: `NOT_SENT`, `low`, `medium` or `high` |
| `--max-reasks` | required, 0 to 3 | required, 0 to 3 |
| `--timeout-ms` | optional, default 60000 (one minute), at most 3600000 | the same |
| `--base-url` | required; Anthropic's is `https://api.anthropic.com` | required; OpenAI's is `https://api.openai.com/v1` |

`NOT_SENT` sends no such setting. [IMPORTERS.md](IMPORTERS.md#two-apis-and-a-switch-between-them) lists the rest
(`--api-version`, `--api-key-env`) and the forms an API address may take: `https`, or `http` to `127.0.0.1` or `[::1]`
only (not `localhost`), written in its plain form (lower case, no default port). Nothing checks a setting against the
model: a model that refuses one (an `effort` word, a `temperature`, a thinking object) rejects the first call, and the
re-grade stops with exit 2. An OpenAI judge looks like this, the cap included:

```bash
$PY examples/importers/inspect/regrade.py --wire openai-responses/v1 --log "$LOG" --epochs 3 --judge-model your-model-name --max-tokens 25000 --verbosity NOT_SENT --effort NOT_SENT --max-reasks 0 --base-url https://api.openai.com/v1 --out-dir "$OUT/in-gpt"
```

The cap is 25000 and not the Anthropic example's 256 because on OpenAI's API the cap counts the model's reasoning tokens
as well as the reply, and OpenAI's reasoning guide, as read on 2026-11-06, advises reserving at least 25,000 tokens for
reasoning and output. That is OpenAI's advice, not a figure measured on your judge. With a large cap on a reasoning
model, raise `--timeout-ms`, for both judges: a call with no reply within it ends the re-grade unless a re-ask remains.
On the stand-in, the address is `http://127.0.0.1:18765/v1` and the key `OPENAI_API_KEY=dummy`.

The re-grade stops, with exit 2, at the first reply that cannot be graded: one still cut at the cap after the
re-asks you allow, a refusal, or one whose last non-empty line is not exactly `GRADE: ` and one capital letter. A call
that fails (a timeout, a rate limit or a server error once the re-asks are used up, or a rejected request) stops it the
same way. No later call is made, the calls before it are paid for, and its log cannot be imported. A grade letter that
is not in your bar, or one Inspect does not read as `C`, `P` or `I`, is found only at import, after every call is paid
for. Raise `--max-tokens` or fix the
instructions, and grade again with a new `--out-dir`.

**4. Import both logs.**

```bash
mkdir "$OUT/in-runs"
node examples/importers/inspect/import.ts --in "$(ls "$OUT"/in-old/*.json)" --cases "$OUT/in/cases.json" --bar "$OUT/in/bar.json" --out "$OUT/in-runs/old.json"
node examples/importers/inspect/import.ts --in "$(ls "$OUT"/in-new/*.json)" --cases "$OUT/in/cases.json" --bar "$OUT/in/bar.json" --out "$OUT/in-runs/new.json"
```

Each import prints a `run file sha256:` line and exits 0.

**5. Measure.** Name your system, the class to measure, the label that counts as a pass (`--cut C`) and what you
changed about the judge, then run `judge-change`. For a new model on the same API the moves are
`judgeModelRequested,judgeModelServed`; for edited instructions, `rubricHash`; for an edited template,
`judgeDefinitionHash`; and whatever else you changed. When the same model name starts to serve a newer model, the move
is `judgeModelServed` alone, and only if the provider's served name changed. If it did not, no field moves and the
two runs cannot be compared: the run files cannot show the switch. Grade the old judge before the switch: after it,
the name may no longer serve the old model.
[JUDGE_CHANGE.md](JUDGE_CHANGE.md) describes each flag.

```bash
node examples/importers/make-plan.ts --old "$OUT/in-runs/old.json" --new "$OUT/in-runs/new.json" --bar "$OUT/in/bar.json" --out "$OUT/in-plan.json" --system refund-bot --stored-outputs system-side-not-compared --measured-class refund_policy --cut C --label-rule majority --pooling items-equal --estimate-draws 0,1,2 --judge-moves judgeModelRequested,judgeModelServed
node src/cli.ts judge-change --plan "$OUT/in-plan.json" --bar "$OUT/in/bar.json" --inputs "$OUT/in-runs"
```

To switch from a Claude judge to a GPT judge, the moves are
`--judge-moves judgeModelRequested,judgeModelServed,judgeCallShapeHash,judgeHarnessVersion`: the request goes to
another endpoint with another set of settings, and the grading script calls a different API.
[IMPORTERS.md](IMPORTERS.md#two-apis-and-a-switch-between-them) has the whole switch.

On the example's log and the stand-in's two judges, the report lists, after its header, the judge fields that moved,
for example `judgeModelRequested   fake-judge-old -> fake-judge-strict-new`. Its inputs line carries the system log's
hash and the version it states. For the measured class (3 cases) it shows a pass rate of 1.000 under the old judge and
0.667 under the new one, per draw and by label, and one case that moved, `refund-bot/c3  pass -> fail`. This plan
computes points only, with no spread; the resampling block in [JUDGE_CHANGE.md](JUDGE_CHANGE.md), set by hand in the
plan, adds one when there are enough cases, and that page explains each line.

When a step stops, its message names the reason; [the importers guide](IMPORTERS.md#inspect) lists the common ones
and what to do.

## Limits

- One scorer, `model_graded_qa`, with one question, one target and one answer per case. Chat-message inputs,
  multiple-choice samples and answers stored as a list of parts (as many reasoning models store them) are refused. For
  an agent, only its final answer is graded; the judges never see its tool calls.
- The grading runs on `inspect_ai` 0.3.286 or 0.3.275 only, and the grading prompt cannot be 0.3.288's default
  template.
- OpenAI's own API only; other servers that speak its format are not tested. OpenAI's pages, as read on 2026-11-06, do
  not say which models reject or ignore `temperature` or an effort word; the record says what was sent.
- The old judge is what its model name serves today. It may not be the judge that gave your earlier grades.
- The system log is not pinned: the run records its sha256 and the version it states, which nothing checks. A log the
  tested tool cannot read is refused; one it misreads may not be detected.
- Of the commands that compare runs, only `judge-change` takes the imported run files. `gate` refuses them because they
  do not record your system's side, including how it ended each answer. `flips` refuses them because the prompt each
  judge call was shown is rebuilt at import, not recorded when it was sent. `validate` reads them and says why.
- An earlier copy of the grading script ran against Anthropic's API on 2026-10-13, on the small example with
  `inspect_ai` 0.3.275. Through OpenAI's API, one case was graded and imported on 2026-11-06 with `inspect_ai` 0.3.286.
  The script as it is now, on Anthropic's wire, and a log written by 0.3.288 have run against the stand-in only.
  [The importers guide](IMPORTERS.md#before-you-start) lists what has and has not been tried.
