#!/usr/bin/env bash
# Pack-install-run test: the published package must work from node_modules, where Node refuses to
# strip TypeScript. Builds dist/, packs a tarball, checks that the notices, the licence texts, every
# document of docs/ that package.json ships and every document the README links to are in it,
# installs it into a scratch project with no network, then imports the library, checks that --help
# prints the usage, and runs the CLI demo gate (which must exit 1: the demo contains a regression)
# on the example data that the package itself ships, read from node_modules and not from the checkout.
set -euo pipefail
# The folder above tools/, so that the test also runs in a tree that is not a git repository.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/anchorset-pack.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT"
npm run --silent build
TARBALL=$(npm pack --silent --pack-destination "$WORK" | tail -1)
CONTENTS=$(tar -tzf "$WORK/$TARBALL")
# The notices, the licence texts and every document package.json ships from docs/: the allow-list further down names the same seven.
for f in LICENSE NOTICE CITATION.cff TRADEMARKS.md AUTHORSHIP.md llms.txt \
  CHANGELOG.md CONTRIBUTING.md SECURITY.md REUSE.toml \
  LICENSES/Apache-2.0.txt LICENSES/CC-BY-4.0.txt LICENSES/CC0-1.0.txt \
  docs/CLI.md docs/COMPARISON.md docs/IMPORTERS.md docs/JUDGE_CHANGE.md docs/MIGRATIONS.md docs/RATINGS_FORMAT.md docs/RUN_FORMAT.md; do
  grep -qx "package/$f" <<<"$CONTENTS" || { echo "pack-test: $f is missing from the tarball" >&2; exit 1; }
done
# Every file the packaged README links to must be in the package, or the link is dead for whoever installed it.
# A link under tools/ or examples/ points into the repository, which the package does not carry.
LINKS=$(grep -o '](\([^)#]*\)' README.md | sed 's/^](//' | grep -v '^[a-z][a-z]*:' | grep -v '^tools/' | grep -v '^examples/' | sort -u || true)
for f in $LINKS; do
  grep -qx "package/$f" <<<"$CONTENTS" || { echo "pack-test: README.md links to $f, which is missing from the tarball" >&2; exit 1; }
done
# Only the documents named in package.json ship from docs/: a file added there is not shipped unless package.json names it.
EXTRA=$(grep '^package/docs/' <<<"$CONTENTS" | grep -vx -e package/docs/CLI.md -e package/docs/COMPARISON.md -e package/docs/IMPORTERS.md -e package/docs/JUDGE_CHANGE.md -e package/docs/MIGRATIONS.md -e package/docs/RATINGS_FORMAT.md -e package/docs/RUN_FORMAT.md || true)
[[ -z "$EXTRA" ]] || { echo "pack-test: unexpected files under docs/ in the tarball: $EXTRA" >&2; exit 1; }
# Only the data of the two examples ships (the generators import src/, which the package does not carry).
for f in examples/refund-bot/README.md examples/refund-bot/baseline.json examples/refund-bot/candidate.json examples/refund-bot/bar.json \
  examples/refund-bot/ratings.json examples/refund-bot/anchor_old.json examples/refund-bot/anchor_new.json examples/refund-bot/judged.json \
  examples/run-format/run.json examples/run-format/bar.json; do
  grep -qx "package/$f" <<<"$CONTENTS" || { echo "pack-test: $f is missing from the tarball" >&2; exit 1; }
done
EXTRA=$(grep '^package/examples/' <<<"$CONTENTS" | grep -vE '^package/examples/(refund-bot/(README\.md|[a-z_]+\.json)|run-format/[a-z_]+\.json)$' || true)
[[ -z "$EXTRA" ]] || { echo "pack-test: unexpected files under examples/ in the tarball: $EXTRA" >&2; exit 1; }
# REUSE-IgnoreStart
grep -q 'SPDX-License-Identifier: Apache-2.0' dist/cli.js || { echo "pack-test: dist/cli.js has no licence banner" >&2; exit 1; }
# REUSE-IgnoreEnd
# The LICENSE inside the tarball (not the one in the checkout) must be byte-identical to the canonical Apache-2.0 text kept in LICENSES/.
tar -xzOf "$WORK/$TARBALL" package/LICENSE | cmp -s - LICENSES/Apache-2.0.txt || { echo "pack-test: the packed LICENSE is not the Apache-2.0 text in LICENSES/Apache-2.0.txt" >&2; exit 1; }
tar -xzOf "$WORK/$TARBALL" package/LICENSES/Apache-2.0.txt | cmp -s - LICENSES/Apache-2.0.txt || { echo "pack-test: the packed LICENSES/Apache-2.0.txt differs from the checkout" >&2; exit 1; }
head -1 dist/cli.js | grep -q '^#!' || { echo "pack-test: the banner displaced the shebang" >&2; exit 1; }
cd "$WORK"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund --offline "./$TARBALL" >/dev/null
# The installed package exports exactly the values pinned in test/public-api.json: nothing missing, nothing extra.
node --input-type=module -e "
import * as api from 'anchorset';
import { readFileSync } from 'node:fs';
const pinned = JSON.parse(readFileSync(process.argv[1], 'utf8')).values;
const got = Object.keys(api).sort();
if (JSON.stringify(got) !== JSON.stringify(pinned)) {
  console.error('pack-test: the installed package exports other values than test/public-api.json; missing: ' + pinned.filter((x) => !got.includes(x)).join(', ') + '; extra: ' + got.filter((x) => !pinned.includes(x)).join(', '));
  process.exit(3);
}
" "$ROOT/test/public-api.json"
# The same for the types, read from the declaration file the package ships: every `export type { ... }` and every inline `type` item.
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const pinned = JSON.parse(readFileSync(process.argv[1], 'utf8')).types;
const source = readFileSync('node_modules/anchorset/dist/index.d.ts', 'utf8');
const got = [];
for (const st of source.split(';').map((x) => x.trim()).filter((x) => x !== '')) {
  const m = /^export (type )?\{([^}]*)\} from '[^']+'\$/.exec(st);
  if (m === null) { console.error('pack-test: an export form the type pin does not read in dist/index.d.ts: ' + st.slice(0, 60)); process.exit(3); }
  for (const raw of m[2].split(',').map((x) => x.trim()).filter((x) => x !== '')) {
    const inline = /^type\s+(\S+)\$/.exec(raw);
    if (m[1] !== undefined || inline !== null) got.push(inline === null ? raw : inline[1]);
  }
}
got.sort();
if (JSON.stringify(got) !== JSON.stringify(pinned)) {
  console.error('pack-test: the installed package exports other types than test/public-api.json; missing: ' + pinned.filter((x) => !got.includes(x)).join(', ') + '; extra: ' + got.filter((x) => !pinned.includes(x)).join(', '));
  process.exit(3);
}
" "$ROOT/test/public-api.json"
# The ways round a refusal, each written against the installed package alone, fail at import: no export gives a fold,
# a verdict, a lone coefficient, a pooled flip share or a ledger record without the check of its entry point.
cat >"$WORK/bypass-verdict.mjs" <<'EOF'
import { foldRun, evaluate, diffRuns } from 'anchorset';
EOF
cat >"$WORK/bypass-kappa.mjs" <<'EOF'
import { cohenKappa } from 'anchorset';
EOF
cat >"$WORK/bypass-flips.mjs" <<'EOF'
import { flipRate, groupDraws } from 'anchorset';
EOF
# The check a writer makes before it appends is not exported either: the package exports no function that writes a ledger.
cat >"$WORK/bypass-ledger.mjs" <<'EOF'
import { checkLedgerFile } from 'anchorset';
EOF
for b in bypass-verdict bypass-kappa bypass-flips bypass-ledger; do
  if node "$WORK/$b.mjs" >/dev/null 2>"$WORK/$b.err"; then echo "pack-test: $b imported from the installed package" >&2; exit 1; fi
  grep -q "does not provide an export named" "$WORK/$b.err" || { echo "pack-test: $b failed, but not at import: $(head -3 "$WORK/$b.err")" >&2; exit 1; }
done
# A consumer's own tsc run (strict, declaration files checked: skipLibCheck false) against the installed declarations: a broken
# or missing declaration in the package fails here, not in the first user's build.
cat >"$WORK/consumer.ts" <<'CONSUMER'
import { gateRuns, gateExitCode, parseRunArtifact, repeatFlips, agreementReport, driftReport, judgeChangeRuns } from 'anchorset';
import type { RunArtifact, GateRunResult, RepeatFlipReport } from 'anchorset';
export const exported = [gateRuns, gateExitCode, parseRunArtifact, repeatFlips, agreementReport, driftReport, judgeChangeRuns];
export type Used = [RunArtifact, GateRunResult, RepeatFlipReport];
CONSUMER
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --skipLibCheck false --module nodenext --moduleResolution nodenext --target es2022 \
  --typeRoots "$ROOT/node_modules/@types" --types node "$WORK/consumer.ts" || { echo "pack-test: a consumer's strict tsc run against the installed declarations failed" >&2; exit 1; }
npx --no-install anchorset --help | grep -q '^usage:' || { echo "pack-test: anchorset --help printed no usage" >&2; exit 1; }
EX=$WORK/node_modules/anchorset/examples/refund-bot
[[ -f "$EX/baseline.json" ]] || { echo "pack-test: the installed package has no example data at $EX" >&2; exit 1; }
set +e
npx --no-install anchorset gate --baseline "$EX/baseline.json" --candidate "$EX/candidate.json" \
  --bar "$EX/bar.json" --allow-differ systemModelServed,systemCallShapeHash >/dev/null
CODE=$?
set -e
[[ $CODE -eq 1 ]] || { echo "pack-test: demo gate exited $CODE, expected 1" >&2; exit 1; }
echo "pack-test: ok (notices, licences and the documents the README links to shipped, banner kept, import exposes exactly the pinned values, --help prints usage, the refund-bot demo gate exits 1 on the example data read from node_modules)"
