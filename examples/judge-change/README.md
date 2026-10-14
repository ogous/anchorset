# Example: the judge changed, the stored answers did not

Made-up data for `judge-change`. Five versions of a refund bot (`bot-v1` to `bot-v5`) each answered 34 customer
messages once, and the answers were stored. An old judge and a new judge then graded every stored answer six times,
from 1 to 5. The data show the shape of the report. They are no finding about any real judge.

Of the 34 messages, 32 are in the class the plan measures, `reply_quality`, and 2 are in `policy_safe`. The plan sets
8 of the 32 aside to fit the cut, so the report scores 24. A plan without that option scores all 32.

| File | What it is |
|---|---|
| `runs/` | for each bot version: the old judge's run file, the new judge's run file and a reference file |
| `plan.json` | the plan: which files, which class, what counts as a pass, and the options that are on |
| `bar.json` | the bar file the runs were written for |
| `manifest.json` | the numbers this example prints, kept so a check can tell when they change |
| `generate.ts` | the script that wrote the data |

From a clone of the repository:

```sh
npm run --silent demo:judge-change
```

How to read the report is in [docs/JUDGE_CHANGE.md](../../docs/JUDGE_CHANGE.md).

To check that the tool still prints the numbers in `manifest.json`:

```sh
node tools/study-check.ts examples/judge-change/manifest.json
```
