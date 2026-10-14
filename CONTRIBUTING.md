# Contributing

Thank you for your interest. Pull requests are welcome.

anchorset's code is licensed under `Apache-2.0` (see `LICENSE`) and its documentation under `CC-BY-4.0`; `REUSE.toml`
maps every path to its licence. A contribution is accepted under the licence of the file it changes, with no separate
agreement to sign: by sending a pull request you state that you wrote the change, or have the right to submit it,
under that licence. You say so with the Developer
Certificate of Origin 1.1 (<https://developercertificate.org/>), by signing off every commit
(`git commit -s`). That adds a `Signed-off-by: Your Name <you@example.com>` line, using the name and
email address set in your git configuration. The `sign-off` check of CI (`node tools/dco-check.ts <base>..<head>`) fails
a pull request with a commit that lacks the line, or whose line carries an address that is neither the commit's
author's nor its committer's. It is not merged until every commit carries it (`git commit -s --amend`, or
`git rebase --signoff` for several).

- **Bug reports, questions and ideas** are welcome as issues.
- **Reproductions and recomputations** of published numbers are especially welcome. Report them
  as issues, with the exact version and inputs used.
- **Pull requests** are accepted. Keep a change small and say what it is for; a change to a statistic
  needs a test that pins it: to a published worked example, to a labelled
  hand-worked fixture, or to a labelled independent recomputation.

For your own checks: `npm test` needs only the source tree; `npm run typecheck` also needs `npm install`.
`npm run check` runs the typecheck, the tests and the pack-install test (`npm run test:pack`).

## Repository map

| Path | What it is |
|---|---|
| `src/` | The library: identity, call shape, rng, scoring, gate, regression, agreement, stats, stability, drift, cut map, flips, judge change, study manifest, ledger, artifact, errors, version, CLI and the package entry (`index.ts`) |
| `test/` | `node:test` suites. Each statistic is pinned in a test, to a published worked example where the test names one, and otherwise to a hand-worked fixture written out in the test or to an independent recomputation written in the test (which shares the author's reading of the definition) |
| `examples/refund-bot/` | Synthetic demo data for the gate, agreement, drift and flips |
| `examples/judge-change/` | Synthetic demo data for the judge-change measurement: five systems, two judges, a reference, the plan and a study manifest |
| `examples/run-format/` | An example script that writes a run file from what your own harness recorded (`write-run.ts`), with an example input for it (`input/recorded.json`) and the bar; and a finished example run file (`run.json`, the one the run-format page quotes) with its generator |
| `examples/importers/` | Example importers for promptfoo, Inspect and skill-evals, with their recording graders, a fake endpoint for zero-spend rehearsals, `make-plan.ts` (writes a judge-change plan) and synthetic fixtures |
| `tools/` | Scripts for the repository's own checks: the build banner, the sign-off check, the pack-install test, the release gate and the study re-check (`study-check.ts`) |
| `docs/` | The command line, the run format, the rating-file format, the judge-change contracts, the importers guide, how the tool relates to others, and the migration notes |
