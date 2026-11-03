#!/usr/bin/env bash
# Tries a tool release that the list of tested versions does not hold, at zero spend, and changes nothing in this tree.
#
#   bash examples/importers/watch-candidate.sh <inspect_ai | promptfoo> <version> <environment>
#
# <environment> is the installed candidate: for inspect_ai a Python virtual environment, for promptfoo the folder that holds
# node_modules/.bin/promptfoo. The script makes a scratch copy of the tree, adds the candidate to that copy's
# tested-versions.json, runs the fixture script there against the local fake endpoint and walks the list with
# test/importers.versions.test.ts. A run made this way carries no claim from this repository: an entry is a claim only with
# its written read of the tool's grading path, which no script can make. There is no flag or variable that widens the list.
#
# Exit codes: 0 the candidate passes the fixture run and the walk; 2 usage; any other code is the step that failed.
set -euo pipefail

[ "$#" = 3 ] || { echo "usage: watch-candidate.sh <inspect_ai | promptfoo> <version> <environment>" >&2; exit 2; }
TOOL=$1; VERSION=$2; ENVIRONMENT=$3
case "$TOOL" in
  inspect_ai) FOLDER=inspect; TOOLS=inspect ;;
  promptfoo) FOLDER=promptfoo; TOOLS=promptfoo ;;
  *) echo "watch-candidate.sh: the tool is inspect_ai or promptfoo" >&2; exit 2 ;;
esac
case "$VERSION" in *[!0-9A-Za-z.+-]*|'') echo "watch-candidate.sh: not a version" >&2; exit 2 ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$HERE/../.." && pwd)"
SCRATCH="$(mktemp -d "${FIXTURES_SCRATCH_BASE:-${TMPDIR:-/tmp}}/anchorset-watch.XXXXXX")"
trap 'rm -rf "${SCRATCH:?}"' EXIT
if git -C "$SCRATCH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "watch-candidate.sh: the scratch folder is inside a git tree" >&2; exit 2; fi

# The scratch copy: the files git tracks, or in a tree without git the tree without its dependencies and history.
# The candidate is added to this copy only.
if git -C "$TREE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$TREE" ls-files -z | tar -C "$TREE" --null -T - -cf - | tar -C "$SCRATCH" -xf -
else
  tar -C "$TREE" --exclude=./node_modules --exclude=./.git --exclude=./dist -cf - . | tar -C "$SCRATCH" -xf -
fi
COPY="$SCRATCH/examples/importers"
node - "$COPY/tested-versions.json" "$TOOL" "$VERSION" "$FOLDER" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, tool, version, folder] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, 'utf8'));
const t = d.tools[tool];
if (t.versions.some((e) => e.version === version)) { console.error(`${tool} ${version} is in the list already`); process.exit(2); }
t.versions.push({
  version,
  testedOn: new Date().toISOString().slice(0, 10),
  fixtures: `${folder}/by-version/${version}`,
  badFixtures: `${folder}/by-version/${version}/bad`,
  runtimes: 'the watch',
  gradingPathRead: 'A candidate in a scratch copy of the tree: nobody has read the changes to its grading path, so this entry is no claim.',
});
writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
NODE

case "$TOOL" in
  inspect_ai) FIXTURES_TOOLS="$TOOLS" ANCHORSET_INSPECT_VENV="$ENVIRONMENT" ANCHORSET_INSPECT_PLAIN_VENV="${ANCHORSET_INSPECT_PLAIN_VENV:-}" bash "$COPY/fixtures.sh" ;;
  promptfoo) FIXTURES_TOOLS="$TOOLS" ANCHORSET_PROMPTFOO_DIR="$ENVIRONMENT" bash "$COPY/fixtures.sh" ;;
esac

cd "$SCRATCH"
if [ "$TOOL" = inspect_ai ]; then export ANCHORSET_INSPECT_VENV="$ENVIRONMENT"; fi
node --test test/importers.versions.test.ts
