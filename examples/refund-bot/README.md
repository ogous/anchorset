# Example: a refund bot

Made-up data for four of the commands. The bot answers customer messages about refunds, and each answer gets one
of three labels, from lowest to highest: `none`, `review`, `handoff` (hand the chat to a person).

| File | What it is | Used by |
|---|---|---|
| `baseline.json`, `candidate.json` | two runs of the bot, 20 cases with 3 draws each | `gate` |
| `bar.json` | the pass bar for each class of cases | `gate` |
| `ratings.json` | three graders' labels on 20 items | `agree` |
| `anchor_old.json`, `anchor_new.json` | one judge's labels on 24 items, at two times | `drift` |
| `judged.json` | one run with three gradings of each case | `flips` |
| `generate.ts` | the script that wrote the data | |

From a clone of the repository:

```sh
npm run --silent demo
npm run --silent demo:agree
npm run --silent demo:drift
npm run --silent demo:flips
```

The first one exits 1: the example is built so that the candidate breaks one case. How to read each output is in
the [README](../../README.md).
