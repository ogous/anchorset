#!/usr/bin/env bash
# Regenerates the fixtures of the importers (seventeen good ones and, for each tool, three files the tool wrote in a bad state) from scratch, at zero spend: both tools run against the local fake
# endpoint, and no provider is reached. It runs the whole set under the tool versions installed, each of which must be in
# tested-versions.json. Run it once per version: the versions a matrix walks are the ones that file lists.
#
#   ANCHORSET_PROMPTFOO_DIR=<folder holding node_modules/.bin/promptfoo, of a listed version>
#   ANCHORSET_INSPECT_VENV=<a Python virtual environment with inspect_ai of a listed version>
#   bash examples/importers/fixtures.sh
#
# Where the files go: the first version a tool lists is its reference version, and the whole set is kept for it
# (<tool>/fixtures, <tool>/bad-fixtures). For any other listed version only the witnesses are kept: the two judges' files, the
# three bad-state files and, for Inspect, the source log, in the folders its entry names. A whole set is still made and checked for it.
# The Inspect reference set stands as it was written, before regrade.py wrote a system-log marker: the tests pin it as the file
# with no marker. So a run under the Inspect reference version must name FIXTURES_OUT_ROOT, and is refused otherwise.
#
# One fixture needs the tool's own Anthropic provider: ANCHORSET_INSPECT_PLAIN_VENV names an environment with the same inspect_ai and
# the anthropic package (inspect_ai 0.3.275 runs on anthropic<2 and fails on 2.3.0; 0.3.286 runs on 2.3.0).
#
# Optional: FIXTURES_TOOLS (default: "promptfoo inspect") names the tools to run; "none" only records the hashes again;
#           FIXTURES_OUT_ROOT (default: this folder) takes the fixtures and FIXTURES.sha256 somewhere else;
#           FIXTURES_SCRATCH_BASE (default: $TMPDIR or /tmp) is where the scratch folder is made; it must be outside every
#           git tree. KEEP_SCRATCH=1 keeps the scratch folder.
#
# What it guarantees:
#   * it refuses to run when one of the provider variables it lists is set;
#   * the judge is examples/importers/fake-endpoint.ts on its one fixed default port, on 127.0.0.1; every tool runs under
#     `env -i` with a dummy key (where a provider demands one), telemetry, update checks and sharing off, the response
#     cache off, and every proxy variable pointed at a dead local port, so a request to another host through a client that honours the proxy variables fails;
#   * every run is made in a scratch folder outside every git tree with RELATIVE output paths, and the results are copied;
#   * no result holds a path of this machine: promptfoo's config is named through the fixed link /tmp/anchorset-fixtures-pf, and a file that holds one anyway stops the run;
#   * the grader files are used byte for byte (copies are compared with cmp);
#   * at the end it records the sha256 of each grader file and of each fixture in FIXTURES.sha256.
# Exit codes: 0 every fixture of the tools run was made; 2 refused or a step failed; 3 a fixture could not be generated with the installed tools; any other code is a step that failed under `set -e`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_ROOT="${FIXTURES_OUT_ROOT:-$HERE}"
PORT=18765   # the endpoint's default port (DEFAULT_PORT in fake-endpoint.ts); it is in every call shape, so it is fixed
TOOLS="${FIXTURES_TOOLS:-promptfoo inspect}"
die() { echo "fixtures.sh: $*" >&2; exit 2; }
case " $TOOLS " in *" promptfoo "*) DO_PF=1 ;; *) DO_PF=0 ;; esac
case " $TOOLS " in *" inspect "*) DO_IN=1 ;; *) DO_IN=0 ;; esac
for t in $TOOLS; do case "$t" in promptfoo|inspect|none) ;; *) die "FIXTURES_TOOLS names $t; it takes promptfoo, inspect or none" ;; esac; done

PF_BIN=""
PY=""
if [ "$DO_PF" = 1 ]; then
  : "${ANCHORSET_PROMPTFOO_DIR:?set ANCHORSET_PROMPTFOO_DIR to the folder that holds node_modules/.bin/promptfoo}"
  PF_BIN="$ANCHORSET_PROMPTFOO_DIR/node_modules/.bin/promptfoo"
  [ -x "$PF_BIN" ] || die "no promptfoo at \$ANCHORSET_PROMPTFOO_DIR/node_modules/.bin/promptfoo"
fi
if [ "$DO_IN" = 1 ]; then
  : "${ANCHORSET_INSPECT_VENV:?set ANCHORSET_INSPECT_VENV to a Python virtual environment with a listed inspect_ai}"
  PY="$ANCHORSET_INSPECT_VENV/bin/python"
  [ -x "$PY" ] || die "no python at \$ANCHORSET_INSPECT_VENV/bin/python"
fi

# One field of a listed version's entry, read through the importers' own reader: <tool> <version> <field>. It fails on a version that is not listed.
entry_field() {
  node --input-type=module -e '
    const { loadTestedVersions } = await import(process.argv[1]);
    const e = loadTestedVersions(process.argv[2]).entries.find((x) => x.version === process.argv[3]);
    if (e === undefined) process.exit(3);
    console.log(e[process.argv[4]]);
  ' "$HERE/shared.ts" "$1" "$2" "$3"
}
reference_version() {
  node --input-type=module -e '
    const { loadTestedVersions } = await import(process.argv[1]);
    console.log(loadTestedVersions(process.argv[2]).versions[0]);
  ' "$HERE/shared.ts" "$1"
}

# ---- refuse when a provider key (or a provider's credential variable) is set
keys="$(compgen -e | grep -E '^(ANTHROPIC_[A-Z_]*|OPENAI_[A-Z_]*|AZURE_[A-Z_]*|VERTEX_[A-Z_]*|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_API_KEY|GEMINI_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|MISTRAL_API_KEY|COHERE_API_KEY|GROQ_API_KEY|XAI_API_KEY|DEEPSEEK_API_KEY|TOGETHER_API_KEY|OPENROUTER_API_KEY|PERPLEXITY_API_KEY|FIREWORKS_API_KEY|REPLICATE_API_TOKEN|HF_TOKEN|HUGGINGFACE_API_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_BEARER_TOKEN_BEDROCK)$' || true)"
if [ -n "$keys" ]; then
  echo "fixtures.sh: refusing to run: these provider variables are set (names only): $(echo "$keys" | tr '\n' ' ')" >&2
  echo "fixtures.sh: unset them; the fixtures are made with no key but a dummy value" >&2
  exit 2
fi

NODE_BIN="$(dirname "$(command -v node)")"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 21) ? 0 : 1)' || die "Node 22.21 or later is required"

# ---- the scratch folder: outside every git tree
S="$(mktemp -d "${FIXTURES_SCRATCH_BASE:-${TMPDIR:-/tmp}}/anchorset-fixtures.XXXXXX")"
S="$(cd "$S" && pwd -P)"
EP_PID=""
PF_LINK_MADE=0
cleanup() {
  if [ -n "$EP_PID" ]; then kill "$EP_PID" 2>/dev/null || true; wait "$EP_PID" 2>/dev/null || true; fi
  if [ "$PF_LINK_MADE" = 1 ]; then rm -f "$PF_ADDRESS"; fi
  if [ "${KEEP_SCRATCH:-0}" != 1 ] && [ -n "${S:-}" ]; then rm -rf "${S:?}"; fi
}
trap cleanup EXIT
if git -C "$S" rev-parse --is-inside-work-tree >/dev/null 2>&1; then die "the scratch folder is inside a git tree; set FIXTURES_SCRATCH_BASE"; fi
echo "scratch: $S"
mkdir -p "$S/home" "$S/tmp" "$S/pf/out" "$S/in" "$S/stage" "$S/logs"

# ---- the same environment for every tool run
TOOL_ENV=(HOME="$S/home" TMPDIR="$S/tmp" LANG=en_US.UTF-8
  HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9
  ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
  DO_NOT_TRACK=1 NO_UPDATE_NOTIFIER=1)
PF_ENV=(PATH="$NODE_BIN:/usr/bin:/bin" NODE_USE_ENV_PROXY=1 PROMPTFOO_CONFIG_DIR="$S/pfcfg"
  PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 PROMPTFOO_DISABLE_SHARING=1 PROMPTFOO_DISABLE_REMOTE_GENERATION=true)
PY_ENV=(PATH="${ANCHORSET_INSPECT_VENV:-}/bin:/usr/bin:/bin" PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0)
DUMMY_KEY=dummy-key-for-local-fake-endpoint

# ---- the fake endpoint: started and stopped for each fixture, so every fixture sees response ids from 0001
EP_EXTRA=()   # endpoint flags for the next start_ep calls (the bad-state runs set --mode)
start_ep() { # <name> [endpoint flags]
  local name=$1; shift
  node "$HERE/fake-endpoint.ts" --port "$PORT" --log "$S/logs/$name.requests.jsonl" ${EP_EXTRA[@]+"${EP_EXTRA[@]}"} "$@" 2>"$S/logs/$name.endpoint.err" &
  EP_PID=$!
  for _ in $(seq 1 100); do
    grep -q listening "$S/logs/$name.endpoint.err" 2>/dev/null && return 0
    kill -0 "$EP_PID" 2>/dev/null || break
    sleep 0.1
  done
  cat "$S/logs/$name.endpoint.err" >&2
  die "the fake endpoint did not start on 127.0.0.1:$PORT (is the port in use?)"
}
stop_ep() { kill "$EP_PID" 2>/dev/null || true; wait "$EP_PID" 2>/dev/null || true; EP_PID=""; }
expect_requests() { # <name> <n>
  local got; got="$(wc -l < "$S/logs/$1.requests.jsonl" | tr -d ' ')"
  [ "$got" = "$2" ] || die "$1: the endpoint saw $got requests, expected $2"
}

NOT_MADE=()
# ---- promptfoo
P="$HERE/promptfoo"
if [ "$DO_PF" = 1 ]; then
# A promptfoo version may write the folder of its config into the result file (config.basePath). The config is named through one
# fixed link, so that the bytes hold no path of the machine that made them and do not depend on the scratch folder.
PF_ADDRESS=/tmp/anchorset-fixtures-pf
ln -sn "$S/pf" "$PF_ADDRESS" 2>/dev/null || die "$PF_ADDRESS exists: another run is making fixtures, or an old one left it; remove it if none is"
PF_LINK_MADE=1
# The grader reads the list of tested versions one folder above itself.
cp "$HERE/tested-versions.json" "$S/tested-versions.json"; cmp -s "$HERE/tested-versions.json" "$S/tested-versions.json" || die "copy of tested-versions.json differs"
for f in grader-provider.cjs stored-outputs-provider.cjs; do cp "$P/$f" "$S/pf/$f"; cmp -s "$P/$f" "$S/pf/$f" || die "copy of $f differs"; done
printf '{ "name": "fixtures-work", "private": true, "type": "module" }\n' > "$S/pf/package.json"
cp "$P/stored.json" "$P/promptfooconfig.yaml" "$S/pf/"
cp "$P/fixture-inputs/"* "$S/pf/"

PF_VERSION="$(env -i "${PF_ENV[@]}" "${TOOL_ENV[@]}" "$PF_BIN" --version 2>/dev/null | tail -1)"
PF_FIXTURES="$(entry_field promptfoo "$PF_VERSION" fixtures)" || die "promptfoo $PF_VERSION is not listed in tested-versions.json"
PF_BAD="$(entry_field promptfoo "$PF_VERSION" badFixtures)"

PF_REQUESTS=9   # the requests the next promptfoo run must make: 9 slots, and the re-asks a fixture rehearses
pf_run() { # <fixture name> <config> [extra env]
  local name=$1 cfg=$2; shift 2
  start_ep "pf-$name"
  local rc=0
  (cd "$S/pf" && env -i "${PF_ENV[@]}" "${TOOL_ENV[@]}" ANTHROPIC_API_KEY="$DUMMY_KEY" "$@" \
    "$PF_BIN" eval -c "$PF_ADDRESS/$cfg" --repeat 3 --no-cache -j 1 -o "out/$name.json" > "$S/logs/pf-$name.stdout" 2>&1) || rc=$?
  stop_ep
  # 0 = every row passed, 100 = a completed run in which some row failed
  if [ "$rc" != 0 ] && [ "$rc" != 100 ]; then cat "$S/logs/pf-$name.stdout" >&2; die "promptfoo run $name exited $rc"; fi
  expect_requests "pf-$name" "$PF_REQUESTS"
  mkdir -p "$S/stage/promptfoo"
  cp "$S/pf/out/$name.json" "$S/stage/promptfoo/$name.json"
}
pf_run old-judge promptfooconfig.yaml
pf_run new-judge new-judge.yaml
pf_run plain plain.yaml ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT"
pf_run short-outputs short-outputs.yaml
# Some replies carry a thinking block (the grader states an adaptive thinking setting and an effort), and some replies are
# wrapped in a json code fence (read at import under the second rule; the grader neither reads nor records a rule).
pf_run thinking thinking.yaml
pf_run fenced fenced.yaml
# Files the tool wrote when the judge's reply was bad: `truncated` (the reply cut at max_tokens; the tool keeps
# an error and no record) and `no-verdict` (a finished reply with no verdict; the tool keeps the record). Real tool output.
EP_EXTRA=(--mode truncated); pf_run bad-truncated promptfooconfig.yaml
EP_EXTRA=(--mode no-verdict); pf_run bad-no-verdict promptfooconfig.yaml
EP_EXTRA=()
# The bounded, recorded re-ask. The endpoint cuts, or answers 529 to, the first request with a given body (the marker
# [[times:<n>:<mode>]] in a stored output) and answers every later one whole; the draws of a case share one body, so
# one slot of each marked case is asked twice. `reask`: a bound of 2, one cut reply and one 529, 11 requests for 9
# slots. `reask-new-judge`: the second judge on the same stored outputs under a bound of 1. `reask-exhausted`: a bound
# of 1 and two cut replies, so one slot uses up the bound (10 requests); the tool keeps an error and no record for it.
PF_REQUESTS=11; pf_run reask reask.yaml
PF_REQUESTS=11; pf_run reask-new-judge reask-new-judge.yaml
PF_REQUESTS=10; pf_run bad-reask-exhausted reask-exhausted.yaml
PF_REQUESTS=9
fi

# ---- inspect_ai
I="$HERE/inspect"
if [ "$DO_IN" = 1 ]; then
IN_VERSION="$(env -i "${PY_ENV[@]}" "${TOOL_ENV[@]}" "$PY" -c 'import importlib.metadata as m; print(m.version("inspect_ai"))')"
IN_FIXTURES="$(entry_field inspect_ai "$IN_VERSION" fixtures)" || die "inspect_ai $IN_VERSION is not listed in tested-versions.json"
IN_BAD="$(entry_field inspect_ai "$IN_VERSION" badFixtures)"
if [ "$IN_VERSION" = "$(reference_version inspect_ai)" ] && [ "$OUT_ROOT" = "$HERE" ]; then
  die "inspect_ai $IN_VERSION is the reference version, whose committed set stands as the file with no system-log marker; name FIXTURES_OUT_ROOT to run it"
fi
py() { (cd "$S/in" && env -i "${PY_ENV[@]}" "${TOOL_ENV[@]}" ANTHROPIC_API_KEY="$DUMMY_KEY" "$@"); }
one_log() { # <dir> : the one log file in it
  local n; n="$(ls "$1"/*.json 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" = 1 ] || die "$1 holds $n log files, expected 1"
  ls "$1"/*.json
}
mkdir -p "$S/stage/inspect"
py "$PY" "$I/fixture_inputs.py" source src >/dev/null
cp "$(one_log "$S/in/src")" "$S/stage/inspect/source.json"
cp "$S/stage/inspect/source.json" "$S/in/source.json"
py "$PY" "$I/fixture_inputs.py" source-short src-short >/dev/null
cp "$(one_log "$S/in/src-short")" "$S/in/source-short.json"
py "$PY" "$I/fixture_inputs.py" source-thinking src-thinking >/dev/null
cp "$(one_log "$S/in/src-thinking")" "$S/in/source-thinking.json"
py "$PY" "$I/fixture_inputs.py" source-reask src-reask >/dev/null
cp "$(one_log "$S/in/src-reask")" "$S/in/source-reask.json"
py "$PY" "$I/fixture_inputs.py" source-reask-exhausted src-reask-exhausted >/dev/null
cp "$(one_log "$S/in/src-reask-exhausted")" "$S/in/source-reask-exhausted.json"

RG_THINKING=NOT_SENT   # the two settings of regrade.py, stated for every run (it has no default); a fixture may set them before its call
RG_EFFORT=NOT_SENT
RG_REASKS=0            # the bound of re-asks per slot, stated for every run too (no default); 0 asks every slot once
RG_GO_ON=()            # --go-on-and-count: without it regrade.py stops at the first slot the importer will refuse; a bad-state fixture needs the file whole
regrade() { # <fixture name> <source log> <judge model> <epochs> <requests> [endpoint flags]
  local name=$1 src=$2 model=$3 epochs=$4 n=$5; shift 5
  start_ep "in-$name" --reply-format grade "$@"
  py "$PY" "$I/regrade.py" --log "$src" --epochs "$epochs" --judge-model "$model" --max-tokens 256 --temperature 0 \
     --thinking "$RG_THINKING" --effort "$RG_EFFORT" --max-reasks "$RG_REASKS" --base-url "http://127.0.0.1:$PORT" ${RG_GO_ON[@]+"${RG_GO_ON[@]}"} --out-dir "run-$name" > "$S/logs/in-$name.stdout" 2>&1 \
     || { stop_ep; cat "$S/logs/in-$name.stdout" >&2; die "regrade $name failed"; }
  stop_ep
  expect_requests "in-$name" "$n"
  cp "$(one_log "$S/in/run-$name")" "$S/stage/inspect/$name.json"
}
regrade old-judge source.json fake-judge-old 3 9
regrade new-judge source.json fake-judge-strict-new 3 9
regrade long-reply source.json fake-judge-old 1 3 --long-reply 20000
regrade short-targets source-short.json fake-judge-old 3 9
# Some replies carry a thinking block: the grader states an adaptive thinking setting and a high effort.
RG_THINKING='{"type":"adaptive"}'; RG_EFFORT=high
regrade thinking source-thinking.json fake-judge-old 3 9
RG_THINKING=NOT_SENT; RG_EFFORT=NOT_SENT
# Files the tool wrote when the judge's reply was bad: Inspect writes a bare NaN for both of these grades.
RG_GO_ON=(--go-on-and-count)
regrade bad-truncated source.json fake-judge-old 3 9 --mode truncated
regrade bad-no-verdict source.json fake-judge-old 3 9 --mode no-verdict
RG_GO_ON=()
# The bounded, recorded re-ask, as for promptfoo above: the markers are in the stored outputs of the source log.
RG_REASKS=2; regrade reask source-reask.json fake-judge-old 3 11
RG_REASKS=1; regrade reask-new-judge source-reask.json fake-judge-strict-new 3 11
# One slot uses up a bound of 1 on two cut replies: Inspect writes a bare NaN for that grade.
RG_GO_ON=(--go-on-and-count); RG_REASKS=1; regrade bad-reask-exhausted source-reask-exhausted.json fake-judge-old 3 10; RG_GO_ON=()
RG_REASKS=0

# the plain log needs Inspect's own Anthropic provider, which needs the `anthropic` package. It comes from a second,
# separate environment named by ANCHORSET_INSPECT_PLAIN_VENV, used for this one fixture only.
PLAIN_PY="${ANCHORSET_INSPECT_PLAIN_VENV:-}/bin/python"
if [ -n "${ANCHORSET_INSPECT_PLAIN_VENV:-}" ] && [ -x "$PLAIN_PY" ]; then
  PLAIN_ENV=(PATH="$ANCHORSET_INSPECT_PLAIN_VENV/bin:/usr/bin:/bin" PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0)
  [ "$(env -i "${PLAIN_ENV[@]}" "${TOOL_ENV[@]}" "$PLAIN_PY" -c 'import importlib.metadata as m; print(m.version("inspect_ai"))')" = "$IN_VERSION" ] || die "inspect_ai in the plain environment is not $IN_VERSION"
  start_ep "in-plain" --reply-format grade
  (cd "$S/in" && env -i "${PLAIN_ENV[@]}" "${TOOL_ENV[@]}" ANTHROPIC_API_KEY="$DUMMY_KEY" ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
    "$PLAIN_PY" "$I/fixture_inputs.py" plain source.json run-plain 3) > "$S/logs/in-plain.stdout" 2>&1 \
    || { stop_ep; cat "$S/logs/in-plain.stdout" >&2; die "the plain run failed"; }
  stop_ep
  expect_requests "in-plain" 9
  cp "$(one_log "$S/in/run-plain")" "$S/stage/inspect/plain.json"
else
  echo "fixtures.sh: inspect/fixtures/plain.json NOT MADE: set ANCHORSET_INSPECT_PLAIN_VENV to an environment with inspect_ai $IN_VERSION and the anthropic package" >&2
  NOT_MADE+=(inspect/fixtures/plain.json)
fi
fi

# ---- no file made here may hold a path of this machine
if [ -d "$S/stage" ]; then
  while IFS= read -r f; do
    if grep -q -F -e "$S" -e "$HOME/" -e '/private''/tmp' -e '/Use''rs/' "$f"; then die "$(basename "$f") holds a path of this machine"; fi
  done < <(find "$S/stage" -type f)
fi

# ---- place the fixtures, then record the hashes
# The whole set is staged under <tool>/<name>, a bad-state file as <tool>/bad-<name>. Each staged file is placed under the folder
# the version's entry names: for a version other than the reference, only the witnesses are kept.
WHOLE_GOOD_PF=(old-judge new-judge plain short-outputs thinking fenced reask reask-new-judge)
WHOLE_GOOD_IN=(old-judge new-judge plain long-reply source short-targets thinking reask reask-new-judge)
BAD=(truncated no-verdict reask-exhausted)
place_tool() { # <tool folder> <fixtures folder> <bad folder> <good names...>
  local tool=$1 good=$2 bad=$3; shift 3
  local names=("$@")
  # Beyond the reference version: the two judges' files and, for Inspect, the system log they were graded from.
  case "$good" in */by-version/*) names=(old-judge new-judge); if [ "$tool" = inspect ]; then names+=(source); fi ;; esac
  mkdir -p "${OUT_ROOT:?}/$good" "${OUT_ROOT:?}/$bad"
  local n
  for n in "${names[@]}"; do
    rm -f "${OUT_ROOT:?}/${good:?}/$n.json"
    if [ -f "$S/stage/$tool/$n.json" ]; then cp "$S/stage/$tool/$n.json" "$OUT_ROOT/$good/$n.json"; made=$((made + 1)); fi
  done
  for n in "${BAD[@]}"; do
    rm -f "${OUT_ROOT:?}/${bad:?}/$n.json"
    if [ -f "$S/stage/$tool/bad-$n.json" ]; then cp "$S/stage/$tool/bad-$n.json" "$OUT_ROOT/$bad/$n.json"; made=$((made + 1)); fi
  done
}
made=0
if [ "$DO_PF" = 1 ]; then place_tool promptfoo "$PF_FIXTURES" "$PF_BAD" "${WHOLE_GOOD_PF[@]}"; fi
if [ "$DO_IN" = 1 ]; then place_tool inspect "$IN_FIXTURES" "$IN_BAD" "${WHOLE_GOOD_IN[@]}"; fi
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
{
  # the grader files and the inputs: paths relative to examples/importers. The Inspect reference set was written by an earlier
  # regrade.py (examples/importers/README.md); these are the files as they are now.
  (cd "$HERE" && sha promptfoo/grader-provider.cjs inspect/recording_grader.py promptfoo/stored-outputs-provider.cjs inspect/regrade.py \
    inspect/fixture_inputs.py inspect/template.txt inspect/instructions.txt fake-endpoint.ts tested-versions.json)
  # every fixture under the output root: paths relative to it, sorted by byte
  (cd "$OUT_ROOT" && for t in promptfoo inspect; do if [ -d "$t" ]; then find "$t" -type f -name '*.json' \( -path '*/fixtures/*' -o -path '*/bad-fixtures/*' -o -path '*/by-version/*' \); fi; done | LC_ALL=C sort | while IFS= read -r f; do sha "$f"; done)
} > "$OUT_ROOT/FIXTURES.sha256"
echo "made $made fixtures; hashes in $OUT_ROOT/FIXTURES.sha256"
if [ "${#NOT_MADE[@]}" -gt 0 ]; then echo "NOT MADE: ${NOT_MADE[*]}" >&2; exit 3; fi
