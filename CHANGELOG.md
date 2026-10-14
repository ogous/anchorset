# Changelog

All notable changes to this project are recorded here. Each file format carries its own schema string;
`docs/MIGRATIONS.md` lists them, and from 0.1.0 on it says how a file moves when one changes.

## 0.1.0 (2026-10-16)

The first public version. Nothing was published before it, so this entry is an inventory of what ships, not a list
of changes.

### Commands

- **`anchorset gate`**: did the new version get worse? A pass or fail verdict on a pass bar, case by case.
- **`anchorset agree`**: do the graders agree with each other?
- **`anchorset drift`**: how do two readings of a fixed set of items by one judge differ?
- **`anchorset flips`**: in how many cases do repeat gradings not all get the same label?
- **`anchorset judge-change`**: what does replacing the judge do to the labels, on the same stored answers?

`gate` is the only one with a verdict. The other four are measurements. `docs/CLI.md` has the options and the exit
codes.

### File formats

- The run file, `anchorset.run/v3` (`docs/RUN_FORMAT.md`), read by `gate`, `flips` and `judge-change`.
- The rating files, `anchorset.ratings/v1` and `anchorset.anchor/v1` (`docs/RATINGS_FORMAT.md`), read by `agree` and
  `drift`.
- The judge-change plan and the reference file (`docs/JUDGE_CHANGE.md`).
- `docs/MIGRATIONS.md` lists every version string.

### The package

- Node 22.21 or later. No runtime dependencies. The package ships compiled JavaScript with type declarations.

### In the repository, mostly not in the npm package

- **Examples** on made-up data: a refund bot (`examples/refund-bot/`), a judge change (`examples/judge-change/`)
  and a script that writes a run file (`examples/run-format/`). The package ships only the `.json` files and README
  of the refund bot, and the `.json` files directly in `examples/run-format/` (`run.json` and `bar.json`). The
  scripts, the judge-change example and `examples/run-format/input/` need a clone.
- **Example importers** (`examples/importers/`, guide in `docs/IMPORTERS.md`): for promptfoo 0.123.1, for
  inspect_ai 0.3.275 and for the result folder of Claude's eval-building skill. They work with Anthropic models
  only.

### Licence

Apache-2.0 for the code; CC-BY-4.0 for the documentation (the READMEs under `examples/` follow the code licence). Two
files copied from inspect_ai 0.3.275 (its grading texts) are under that tool's MIT licence; the logs that record the
grading prompts of that tool and of promptfoo 0.123.1 carry the MIT licence of those tools beside Apache-2.0 for the rest
of each file (`Apache-2.0 AND MIT`), with their copyright lines (`NOTICE`, `LICENSES/MIT.txt`). `REUSE.toml` maps every path to its licence.
