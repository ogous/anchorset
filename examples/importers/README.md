# Example importers: promptfoo, Inspect and the eval-building skill

These examples take results from promptfoo, from Inspect (`inspect_ai`) or from the result folder of Claude's
eval-building skill, have both judges grade your stored answers again, and write the run files that `judge-change`
reads. The guide, with every command, is [docs/IMPORTERS.md](../../docs/IMPORTERS.md).

They run from a clone of the repository, with Node 22.21 or later. They are examples: the npm package does not
include them.

## What is here

| Path | What it is |
|---|---|
| `promptfoo/` | the grading script (`grader-provider.cjs`), the importer (`import.ts`), an example config, cases, bar and plan |
| `inspect/` | the grading script (`regrade.py`), the importer (`import.ts`), the grading texts, example cases, bar and plan |
| `skill-evals/` | the check (`check.ts`), the grading script (`regrade.ts`), the importer (`import.ts`), an example result folder and the judge's texts |
| `make-plan.ts` | writes a `judge-change` plan for two imported run files |
| `fake-endpoint.ts` | a stand-in for the API on your own machine, so you can try every step at no cost |
| `*/fixtures/`, `*/bad-fixtures/` | result files the tools wrote, good and refused, used by the tests |
| `fixtures.sh`, `FIXTURES.sha256` | the script that regenerates the fixtures, and the hashes it records |
| `shared.ts` | what the three importers share |

The grading texts under `inspect/` are copied from inspect_ai 0.3.275 and are under that tool's MIT license; see
`NOTICE`.
