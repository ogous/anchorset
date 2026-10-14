# anchorset next to promptfoo, DeepEval and Langfuse

If you already use promptfoo, DeepEval or Langfuse, this page says what anchorset adds and what it leaves to them.
Each project's documentation, in its own public repository, was read on 2026-10-14.

- **All three document running evals in CI.** anchorset does not run evals and has no dashboard.
- **Langfuse** documents Cohen's kappa, F1 and overall agreement for categorical scores
  ([score analytics](https://langfuse.com/docs/evaluation/scores/score-analytics)). Its
  [CI guide](https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd) gives example code that stops when
  the dataset version or the evaluator version differs from an approved baseline.
- **promptfoo**'s [judge guide](https://www.promptfoo.dev/docs/guides/llm-as-a-judge/) says to pin the grader model
  version and to re-run a held-out labeled set to watch for drift. Its [CI page](https://www.promptfoo.dev/docs/integrations/ci-cd/)
  describes quality gates. Its [release notes](https://www.promptfoo.dev/docs/releases/) (July 2025) list re-grading
  existing red-team scans after a grading change, under enterprise features.
- **DeepEval** has a [guide to regression testing in CI](https://deepeval.com/guides/guides-regression-testing-in-cicd).
- **anchorset** reports AC1 beside kappa, splits a gate's pass-rate change into the judge's part and the system's,
  and counts the pass/fail decisions between two systems that change with the judge. These were not found in the
  three tools' docs on that date.

anchorset is a separate step on [run files](RUN_FORMAT.md) that your own code writes. For `judge-change`, example
importers ([IMPORTERS.md](IMPORTERS.md)) write them from stored answers: for promptfoo you supply the answers, for
Inspect the importer reads your log, and for the eval-building skill your result folder. If you write a run file
yourself, write `UNKNOWN` for a judge's served model name you do not have; `gate` and `judge-change` then refuse
that file.
