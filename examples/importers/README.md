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
| `tested-versions.json` | the tool versions the importers were tested on, and for each what was run and read |
| `*/fixtures/`, `*/bad-fixtures/`, `*/by-version/` | result files the tools wrote, good and refused, used by the tests; `by-version/` holds a smaller set for each version after the first |
| `fixtures.sh`, `FIXTURES.sha256` | the script that regenerates the fixtures, and the hashes it records |
| `watch-candidate.sh` | tries a new tool release in a scratch copy of the tree; a run made that way carries no claim from this repository |
| `shared.ts` | what the three importers share |

The Inspect set in `inspect/fixtures/` was written before `regrade.py` recorded the system log, so its files hold no record of
one. It stays that way on purpose: it is the example of such a file.

The grading texts under `inspect/` are copied from inspect_ai 0.3.275 and are under that tool's MIT license; see
`NOTICE`.
