# The run file

How to write a run file, check it, and fix it when the tool refuses it. A run file is what `gate`, `flips` and
`judge-change` read. Your eval code runs the cases and writes down what happened, as one JSON file per run.

A **case** is one test input. A **draw** is one repeat of a case. It may produce a new answer, or grade the same
stored answer again. An **answer** is what your system returned. The **judge** is the model that grades the
answers, and a **label** is what it gives an answer. The **packet** is what the judge was shown for one answer.

## The quickest way

An example script writes a run file from a plain record of your run. You need Node 22.21 or later and a clone of
this repository. Run the commands from its root.

```bash
OUT="$(mktemp -d)"
node examples/run-format/write-run.ts --in examples/run-format/input/recorded.json --out "$OUT/run.json"
```

It prints `run written to` with the path, a `run hash:` line, and `identity fields left "UNKNOWN": none`.

The input is [`recorded.json`](../examples/run-format/input/recorded.json): the bar file's content, the cases,
what you know about the model, and for every draw the answer, its label and why the system stopped. The script
works out the hashes of the cases, the bar file, the settings and each answer. You make the other hashes yourself,
and it writes what you leave out as `"UNKNOWN"`. The script is
[`write-run.ts`](../examples/run-format/write-run.ts).

- The script never overwrites `--out`. Use a new name to write again.
- For a run that a judge graded, it writes every packet as `"UNKNOWN"`. `gate` reads such a file and `flips`
  refuses it. To record packets, write the file from your own code.

The keys of the input:

- `graded`: `"by-code"` or `"by-judge"`.
- `bar`, `cases` and `callShapes`: as in the bar file and the run file below. `callShapes` is optional.
- `drawsPerCase`: a whole number.
- `identity`: the fields you know, named as in the `identity` table below, without the four hashes the script
  works out and without `drawsPerCase`, which has its own key. With `"by-code"`, also without the judge fields.
- `draws`: one entry for each case and draw, with `case`, `draw` and `attempts`.

An attempt takes one of three forms:

- An answer with its label: `output`, `label` and `stop`; also `judgeStop` when a judge graded.
- A failure of the system: `failed` (the reason), `detail` and `stop`.
- Nothing measured: `unmeasured` (the reason), `role` and `detail`; for the role `"judge"`, also `output` and `stop`.

## A complete example

This is [`examples/run-format/run.json`](../examples/run-format/run.json). A refund bot answers three customer
messages twice each, and a judge grades each answer from 1 to 5. The data is made up.

```json
{
  "schema": "anchorset.run/v3",
  "identity": {
    "caseSetHash": "834f5ed304b1c175672aecad9f00c41f1eca8658e60f4131b2ea84838ec4e4e6",
    "rubricHash": "77648c7319e3f23c744251c186c247477669aa568ee782c63fbf1ff65c5d0330",
    "barHash": "7427ac45882381d8b1e936285ac864cba6c3d79f8d5b44a191266ff11b143e3b",
    "systemModelRequested": "example-model-a",
    "systemModelServed": "example-model-a-2026-01-15",
    "systemCallShapeHash": "055d098dbf3e569cf91f368664d770a07983be04590e264760f49483e9c903e3",
    "systemPromptHash": "66b1737752278036aa7fe208365c76e49ffd58351787f0ddf90bc1be243c41c7",
    "systemToolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "systemHarnessVersion": "refund-harness 1.4.0",
    "judgeDefinitionHash": "eafa30d635a5fff32e6f2d2a2564c4fb1d34a3cbe7307e08d3739ae3c28e0d5e",
    "judgeModelRequested": "example-judge",
    "judgeModelServed": "example-judge-2026-02-01",
    "judgeCallShapeHash": "3c8f437842433074a7a2a14f0e4592a14e64ab55e6e993d04024270dd84f4a1f",
    "judgeHarnessVersion": "refund-harness 1.4.0",
    "seed": 20260115,
    "drawsPerCase": 2
  },
  "callShapes": {
    "system": {
      "schema": "anchorset.callshape/v1",
      "endpoint": "example-provider:messages",
      "apiVersion": "2026-01-01",
      "betaFlags": [],
      "thinkingMode": "off",
      "thinkingBudgetTokens": "NOT_SENT",
      "effort": "NOT_SENT",
      "toolChoice": "none",
      "toolChoiceName": "NOT_SENT",
      "strictTools": "NOT_SENT",
      "parallelToolUse": "NOT_SENT",
      "temperature": 0,
      "topP": "NOT_SENT",
      "topK": "NOT_SENT",
      "frequencyPenalty": "NOT_SENT",
      "presencePenalty": "NOT_SENT",
      "samplingSeed": "NOT_SENT",
      "maxOutputTokens": 512,
      "stopSequences": "NOT_SENT",
      "responseFormat": {
        "kind": "text"
      },
      "contextPolicy": "none",
      "stream": false,
      "timeoutMs": 30000,
      "extras": {}
    },
    "judge": {
      "schema": "anchorset.callshape/v1",
      "endpoint": "example-provider:messages",
      "apiVersion": "2026-01-01",
      "betaFlags": [],
      "thinkingMode": "off",
      "thinkingBudgetTokens": "NOT_SENT",
      "effort": "NOT_SENT",
      "toolChoice": "named",
      "toolChoiceName": "grade",
      "strictTools": true,
      "parallelToolUse": "NOT_SENT",
      "temperature": 0,
      "topP": "NOT_SENT",
      "topK": "NOT_SENT",
      "frequencyPenalty": "NOT_SENT",
      "presencePenalty": "NOT_SENT",
      "samplingSeed": "NOT_SENT",
      "maxOutputTokens": 256,
      "stopSequences": "NOT_SENT",
      "responseFormat": {
        "kind": "tool",
        "name": "grade"
      },
      "contextPolicy": "none",
      "stream": false,
      "timeoutMs": 30000,
      "extras": {}
    }
  },
  "cases": [
    {
      "id": "q01",
      "klass": "reply_quality",
      "input": {
        "message": "How long do refunds usually take to show up?"
      },
      "expect": "4"
    },
    {
      "id": "q02",
      "klass": "reply_quality",
      "input": {
        "message": "I returned the jacket a month ago and still have not seen the refund."
      },
      "expect": "4"
    },
    {
      "id": "q03",
      "klass": "reply_quality",
      "input": {
        "message": "Can I return an item I bought on sale?"
      },
      "expect": "4"
    }
  ],
  "draws": [
    {
      "caseId": "q01",
      "drawIndex": 0,
      "attempts": [
        {
          "kind": "graded",
          "label": "5",
          "outputHash": "f07dde746055dc746fbf23884beb1db0d1f900ef25aca61a3fcdb1f382a9481e",
          "systemStop": "end",
          "judgeStop": "tool-use",
          "packetHash": "6ff00a754f489d65282ce50b77451c70592576db01d69d5a9e25d3ea706b60a3"
        }
      ]
    },
    {
      "caseId": "q01",
      "drawIndex": 1,
      "attempts": [
        {
          "kind": "unmeasured",
          "role": "system",
          "reason": "timeout",
          "detail": "no response within 30000 ms"
        },
        {
          "kind": "graded",
          "label": "4",
          "outputHash": "55359e43dd1abd07057e1835a88013753734e60f81ff852009e4835afbf7d2f9",
          "systemStop": "end",
          "judgeStop": "tool-use",
          "packetHash": "23c35fd08c64f7288007635d1bfa6f1f5cb12b3d0264af4d943d30299af14f2a"
        }
      ]
    },
    {
      "caseId": "q02",
      "drawIndex": 0,
      "attempts": [
        {
          "kind": "unmeasured",
          "role": "judge",
          "reason": "parse-failure",
          "detail": "the grade tool was called with no grade",
          "outputHash": "0ca15417fbbb59094d427e8dffe28916bbe4431b779293c505a67b6c429771a6",
          "systemStop": "end",
          "packetHash": "5e110850821c38e019fa0337db9dc9019ac91a22ab15a25ecf8b17627b960591"
        },
        {
          "kind": "graded",
          "label": "5",
          "outputHash": "0ca15417fbbb59094d427e8dffe28916bbe4431b779293c505a67b6c429771a6",
          "systemStop": "end",
          "judgeStop": "tool-use",
          "packetHash": "5e110850821c38e019fa0337db9dc9019ac91a22ab15a25ecf8b17627b960591"
        }
      ]
    },
    {
      "caseId": "q02",
      "drawIndex": 1,
      "attempts": [
        {
          "kind": "graded",
          "label": "4",
          "outputHash": "8a4c2b291dd4e8eadba4b8a3565aa12725efd309717582b27031796d7f8c009a",
          "systemStop": "end",
          "judgeStop": "tool-use",
          "packetHash": "a9dcac313c510cec146d1a8c190480de7cd5a9d214b1988119bd0149ddba1c6e"
        }
      ]
    },
    {
      "caseId": "q03",
      "drawIndex": 0,
      "attempts": [
        {
          "kind": "failed",
          "reason": "truncated",
          "detail": "the reply reached maxOutputTokens (512)",
          "outputHash": "b237e23f9808ae33340381bd330fa70519232549c98263c3111b269004ddf05d",
          "systemStop": "max-tokens"
        }
      ]
    },
    {
      "caseId": "q03",
      "drawIndex": 1,
      "attempts": [
        {
          "kind": "graded",
          "label": "4",
          "outputHash": "84ba1e51dbf86b7b88946806bd0679d445fbea3b68eec8c3b6fda860a5ac2961",
          "systemStop": "end",
          "judgeStop": "tool-use",
          "packetHash": "5bf329b54dab026934c88126b7d20b7151440b87678b05a7a3bc1059e4f6d0b7"
        }
      ]
    }
  ],
  "packetBasis": "recorded"
}
```

Three draws show a retry or a failure:

- `q01`, draw 1: the first call to the system timed out, and the second was graded. The last one counts.
- `q02`, draw 0: the judge's first reply could not be read. The second graded the same answer.
- `q03`, draw 0: the answer was cut at the token limit. That is a `failed` attempt, with no label.

The run was written for this bar file, [`examples/run-format/bar.json`](../examples/run-format/bar.json). It
holds the pass bar: the pass rate you require for each class, a group of cases.

```json
{
  "labels": [
    "1",
    "2",
    "3",
    "4",
    "5"
  ],
  "classes": {
    "reply_quality": {
      "direction": "floor",
      "minPassRate": 0.5
    }
  },
  "knownFailures": []
}
```

`labels` lists your labels from lowest to highest. `classes` names each class. With `floor`, a draw
passes when its label is the case's `expect` or higher; with `ceiling`, when it is `expect` or lower. A class
with `"nonCompensable": true` fails the gate on one failing case. A class with no case in the run fails the gate.
`knownFailures` is required; write `[]` for
none. An entry is `{ "caseId": …, "since": "YYYY-MM-DD", "note": … }`. It is a note: the case still counts as a
failure in every rate and in the verdict. While it fails, the report adds the line
`known failures (still counted): <case ids>` under its class. Adding or removing an entry changes the bar's hash, so run
files written for the old bar are refused until they are written again for the new one.

To check a run file, gate it against itself:

```bash
node src/cli.ts gate --baseline examples/run-format/run.json --candidate examples/run-format/run.json --bar examples/run-format/bar.json
```

```text
class           direction       baseline      candidate             bar     result
reply_quality   floor           2/3 0.667     2/3 0.667, 0 new      0.500   ok

BROKE (0)
FIXED (0)

verdict: OK (exit 0)
```

A case passes only if every draw passes. `q03` has a failed draw, so two of three cases pass. That meets this
pass bar of 0.5. Exit 0, 1 or 2 means the run file is in the format.

## The fields

Every field is required; `packetSource`, only with `declared`. A field the tables do not list is refused. A hash is a full
sha256: 64 characters, digits and the letters a to f in lowercase.

### Top level

| Field | What it means | If you do not know it |
|---|---|---|
| `schema` | Always `"anchorset.run/v3"` | Always known |
| `identity` | What produced the run: the cases, the models, the prompts, the settings | See the next table |
| `callShapes` | The settings of each model call, under `system` and `judge` | `judge` is `"NO_JUDGE"` when code grades |
| `cases` | Every case of the run | Always known |
| `draws` | One record for each case and draw | A draw you leave out makes its case incomplete |
| `packetBasis`, `packetSource` | Where the packet hashes come from | See "The packet" below |

### `identity`

| Field | What it means | If you do not know it |
|---|---|---|
| `caseSetHash` | A hash of `cases`. The tool works it out again and compares | Always known: the cases are in the file |
| `rubricHash` | A sha256 of the rubric the labels were given under | `"UNKNOWN"` |
| `barHash` | A hash of the bar file. `gate` and `judge-change` compare it with the bar file you pass | `"UNKNOWN"` |
| `systemModelRequested` | The model name your code asked for | `"UNKNOWN"` |
| `systemModelServed` | The model name the provider's reply gave | `"UNKNOWN"` |
| `systemCallShapeHash` | A hash of `callShapes.system`. The tool works it out again and compares | `"UNKNOWN"` when any setting in it is `"UNKNOWN"`, and only then |
| `systemPromptHash` | A sha256 of the system prompt and of any other fixed text your code adds to it | `"UNKNOWN"` |
| `systemToolsHash` | A sha256 of the tools and output formats the system can use. With no tools, the sha256 of `[]` | `"UNKNOWN"` |
| `systemHarnessVersion` | The name and version of the code that called the system | `"UNKNOWN"` |
| `judgeDefinitionHash` | A sha256 of the judge's prompt, tools and output format, without the rubric | `"UNKNOWN"`. `"NO_JUDGE"` when code grades |
| `judgeModelRequested`, `judgeModelServed` | The two model names, for the judge | `"UNKNOWN"`. `"NO_JUDGE"` when code grades |
| `judgeCallShapeHash` | A hash of `callShapes.judge`, checked like the system's | As for the system. `"NO_JUDGE"` when code grades |
| `judgeHarnessVersion` | The name and version of the code that called the judge | `"UNKNOWN"`. `"NO_JUDGE"` when code grades |
| `seed` | The seed of the random choices your code made, such as the order of the cases: a whole number from 0 to 4294967295 | `"NO_SEED"` when your code made no random choice. `"UNKNOWN"` when you cannot say |
| `drawsPerCase` | How many draws every case has: a whole number from 1 to 10,000 | `"UNKNOWN"` |

The five judge fields are all `"NO_JUDGE"`, or none of them is. The example script works out `caseSetHash`,
`barHash` and the two hashes of the settings. For the other hashes, hash the same thing the same way in every run.

If your code is not JavaScript, work out those hashes yourself. Write the value as JSON with the keys of every
object sorted, no spaces or line breaks, and strings and numbers as JavaScript's `JSON.stringify` writes them. Then
take the sha256 of that text as UTF-8. For `caseSetHash` the value is the `cases` list sorted by `id`. For `barHash`
it is the whole bar file. For a hash of the settings it is that block of settings, and the hash is `"UNKNOWN"` if
any setting in it is. When you gate the file against itself, a wrong one of these is rejected, and the message
prints the right one.

### The settings of a model call: `callShapes.system` and `callShapes.judge`

Each key except `schema`, `endpoint` and `extras` takes the value your code sent, or `"NOT_SENT"` when it sent
nothing for that setting, or `"UNKNOWN"` when you cannot say. `endpoint` takes text or `"UNKNOWN"`, and `extras` an
object (`{}` for none) or `"UNKNOWN"`.

| Field | The value, when sent |
|---|---|
| `schema` | Always `"anchorset.callshape/v1"` |
| `endpoint` | The API and the route, as text. It cannot be `"NOT_SENT"` |
| `apiVersion` | The API version, as text |
| `betaFlags` | A list of beta flags in lowercase, sorted, none twice |
| `thinkingMode` | `off`, `adaptive`, `budgeted` or `between-tools` |
| `thinkingBudgetTokens` | A whole number above 0. Required with `budgeted`; `"NOT_SENT"` otherwise |
| `effort` | `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `toolChoice` | `none`, `auto`, `any` or `named` |
| `toolChoiceName` | The tool's name. Required with `named`; `"NOT_SENT"` otherwise |
| `strictTools`, `parallelToolUse`, `stream` | `true` or `false` |
| `temperature` | A number from 0 to 2 |
| `topP` | A number from 0 to 1 |
| `topK` | A whole number above 0 |
| `frequencyPenalty`, `presencePenalty` | A number |
| `samplingSeed` | The provider's sampling seed, a whole number. It is not the run's `seed` |
| `maxOutputTokens` | The most tokens the model may write, a whole number above 0 |
| `stopSequences` | A list of texts, sorted, none twice |
| `responseFormat` | `{ "kind": "text" }`, `{ "kind": "tool", "name": … }` or `{ "kind": "json-schema", "name": … }` |
| `contextPolicy` | How a long input is cut before the call: `none`, `truncate-head`, `truncate-tail` or `compact` |
| `timeoutMs` | Your code's time limit for one call, in milliseconds: a whole number above 0 |
| `extras` | Any other provider setting, as an object with keys like `provider.setting`. `{}` for none |

### `cases`

| Field | What it means |
|---|---|
| `id` | Your name for the case. No two cases share one |
| `klass` | The case's class: one of the `classes` of your bar file |
| `input` | What the system was given. Any JSON value except `null` |
| `expect` | The label the case is scored against: one of the `labels` of your bar file |

Nothing in a case can be unknown.

### `draws` and their attempts

A draw has `caseId`, `drawIndex` (counted from 0) and `attempts`. Each case and draw has one record. `attempts`
lists the calls in order, and the last attempt is the draw's result.

An attempt has a `kind`:

- `graded`: the system answered, and the answer got a label.
- `failed`: the system failed on its own. The draw fails.
- `unmeasured`: nothing was measured. Its `role` is `"system"` when the provider sent nothing back, and `"judge"`
  when the judge could not grade an answer.

| Field | On which attempts | What it means | If you do not know it |
|---|---|---|---|
| `label` | graded | The label: one of the `labels` of your bar file | Always known |
| `reason` | failed | `truncated` (the answer hit the token limit), `client-error` (the provider rejected the request) or `system-error` (your system returned an error of its own) | Always known |
| `reason` | unmeasured, system | `timeout`, `transport`, `server-error` or `rate-limited` | Always known |
| `reason` | unmeasured, judge | One of those four, or `truncated`, `content-filter`, `client-error` or `parse-failure` (the judge's reply could not be read) | Always known |
| `detail` | failed, unmeasured | A note for the reader, as text | An empty text |
| `outputHash` | graded, failed, unmeasured by the judge | The sha256 of the answer's text. For a failed attempt with no answer, a sha256 of the failure note | Always known |
| `systemStop` | graded, unmeasured by the judge | Why the system stopped: `end`, `stop-sequence`, `tool-use`, `content-filter` or `refusal` | `"UNKNOWN"`; `gate` and `flips` then refuse the run |
| `systemStop` | failed | `max-tokens` with `truncated`; `"NOT_SENT"` with the other two reasons | Always known |
| `judgeStop` | graded | Why the judge stopped: `end` or `tool-use` | Always known. `"NO_JUDGE"` when code grades |
| `packetHash` | graded, unmeasured by the judge | The sha256 of what the judge was shown for this answer | `"UNKNOWN"`. `"NO_JUDGE"` when code grades |

Three rules:

- Only an `unmeasured` attempt can be followed by another. A `graded` or `failed` attempt is always the last.
- After the judge could not grade, the next attempt grades the same answer: same `outputHash`, `systemStop` and
  `packetHash`.
- A graded attempt cannot carry the stop `max-tokens`, and no attempt can carry the stop `other`. For a stop that is
  none of the five in the table, write `"UNKNOWN"`. A filtered answer or a refusal is still an answer: grade it.

### The packet

| Field | What it means | If you do not know it |
|---|---|---|
| `packetHash` | On each attempt a judge saw: the sha256 of what the judge was shown | `"UNKNOWN"` |
| `packetBasis` | `recorded`: your code hashed each packet as it showed it. `declared`: the hashes were worked out later from a description | `"UNKNOWN"`, and then every `packetHash` is `"UNKNOWN"` too. `"NO_JUDGE"` when code grades |
| `packetSource` | With `declared` only: the name of that description, as text | Required with `declared`; otherwise leave it out |

A packet holds the answer as the judge saw it, and any other text shown with it, such as the question. The
judge's own instructions belong in `judgeDefinitionHash`.

The tool only compares packet hashes. Any sha256 works if you make it the same way in every run. `gate` reads no
packet for its verdict. `flips` needs `recorded`. `judge-change` takes `recorded` or `declared`.

## What you do not know

A value you did not record is written as `"UNKNOWN"`. Do not guess it, and do not write `null`, "n/a" or "none":
the tool refuses those. A file with unknowns is valid, but an unknown blocks every comparison that depends on it:

- `gate` needs all sixteen `identity` fields known in both runs, even one you allow to differ, and every
  `systemStop`.
- `flips` needs `drawsPerCase`, at least two draws per case and every `systemStop`. For a run a judge graded, it also needs recorded packets.
- `judge-change` has its own list, in [JUDGE_CHANGE.md](JUDGE_CHANGE.md).

`"NOT_SENT"`, `"NO_JUDGE"` and `"NO_SEED"` count as known.

## If the tool refuses your file

A file that breaks the format gives `anchorset: invalid input`, every problem with its place, and exit code 65.
A comparison the tool will not make gives `REFUSED`, a code, and exit code 2.

- `unknown field` → a key is misspelled or not in the tables above. A provider's own name, such as `max_tokens`,
  is not accepted.
- `missing`, `null is not allowed` or `reads as a gap` → write the field with its value. If you do not know it,
  write `"UNKNOWN"`, except for a field the tables mark "Always known".
- `caseSetHash: declared` or `systemCallShapeHash: declared` → the cases or the settings changed after the hash
  was made. The message gives the hash the file should carry.
- `a truncated answer is recorded as failed` → a graded attempt has the stop `max-tokens`. Make it `failed`,
  with `truncated`.
- `IDENTITY_GAP` → the fields named are `"UNKNOWN"`. Record them in your eval code and write the file again.
- `IDENTITY_MISMATCH` → the two runs differ in the fields named. If you changed the system on purpose, add
  `--allow-differ` with the field names; [CLI.md](CLI.md) says which fields can never be listed.
- `HASH_MISMATCH`, naming `barHash` → the bar file is not the one the run was written for.
- `INCOMPLETE_RUN` → the baseline (for `flips`, the run) has a draw with no record, or one that ends `unmeasured`.
  Run it again.
- `MEASUREMENT_NOT_RUNNABLE` → a judge attempt has the reason `client-error`. Fix the judge call and grade again.
- `PACKET_MISMATCH`, from `flips` → the packets are `declared`, or differ between draws of one answer. With
  `packetBasis` `"UNKNOWN"` the code is `IDENTITY_GAP`.

## Limits

- The settings and hashes are what your code declared. The tool cannot check what ran.
- For `judge-change`, every draw of a case must grade one stored answer. The example above does not.
- At most 1,000,000 draws per run and 1,000 labels.
- The tool reads `anchorset.run/v3` only. [MIGRATIONS.md](MIGRATIONS.md) lists the format versions.
