#!/usr/bin/env bash
# Regenerates the fixtures of the third importer (seven good re-grade files and three a re-grade wrote in a bad state) from
# scratch, at zero spend: the real re-grade script and the real recording grader run against the local fake endpoint,
# and no provider is reached. It then imports the two judges' fixtures and writes the example plan (plan.json) from the
# importer's printed fragments. It is not part of `npm test`; a test compares what it wrote with the files in the tree,
# so after an edit to a file listed in FIXTURES.sha256 the tests fail until this script has been run again.
#
#   bash examples/importers/skill-evals/fixtures.sh
#
# Optional: FIXTURES_OUT_ROOT (default: this folder) takes the fixtures, plan.json and FIXTURES.sha256 somewhere else;
#           FIXTURES_SCRATCH_BASE (default: $TMPDIR or /tmp) is where the scratch folder is made; it must be outside every
#           git tree. KEEP_SCRATCH=1 keeps the scratch folder.
#
# What it guarantees:
#   * it refuses to run when one of the provider variables it lists is set;
#   * the judge is examples/importers/fake-endpoint.ts on its one fixed default port, on 127.0.0.1; the re-grade runs under
#     `env -i` with a dummy key and every proxy variable pointed at a dead local port, so a request to another host fails;
#   * every re-grade is made from a scratch folder outside every git tree, on copies of the inputs, with RELATIVE paths
#     for the flow, the texts and the output, so no file names a home or a scratch folder; the results are copied;
#   * the re-grade script, the files it imports and the grader are the repository's own, run where they are (the
#     re-grade file records the sha256 of each);
#   * at the end it records the sha256 of the inputs and of each fixture in FIXTURES.sha256.
#
# The inputs: the example flow (example-flow/), as it is. Its two reps of a case hold different stored answers, as the
# reps of a flow do, so one source rep is chosen (--rep) and each of its stored answers is graded three times (--draws 3):
# `judge-change` reads repeated grades of one stored output. So that the two fake judges differ, rep 0 of the case
# `clearance-organiser` wrongly grants a refund and carries the marker [[strict:fail]], which only the fake endpoint
# reads (a judge whose model name holds "strict" fails a prompt that holds it). The judge is shown the `reply` field of
# each stored answer (--select /reply) under the example template, criterion and system text. Every re-grade states the
# reading rule its replies are read under (--reading, written into the header), and the imports below state the same
# rule. Every re-grade states a bound of re-asks per slot too (--max-reasks), 0 for the fixtures above.
#
# The re-ask fixtures use a criterion text of their own (fixture-inputs/), so the example flow and its hashes do not
# change. It carries the marker [[times:<n>:<mode>]], which only the fake endpoint reads: the first n requests with a
# given body are cut at the output cap, and every later one is answered whole. The draws of a case share one body, so
# the first draw of each of the three cases is asked again.
#
# Two fixtures are graded on the OpenAI Responses wire (`--wire openai-responses/v1`, the key in OPENAI_API_KEY, the base URL
# with /v1): the two judges' files on the stored outputs of rep 0. The others are graded on the Anthropic wire.
#
# Exit codes: 0 all ten fixtures and the plan made; 2 refused or a step failed; any other code is a step that failed under `set -e`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_ROOT="${FIXTURES_OUT_ROOT:-$HERE}"
PORT=18765   # the endpoint's default port (DEFAULT_PORT in fake-endpoint.ts); it is in every call shape, so it is fixed
REPS=2
DRAWS=3
die() { echo "fixtures.sh: $*" >&2; exit 2; }

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
S="$(mktemp -d "${FIXTURES_SCRATCH_BASE:-${TMPDIR:-/tmp}}/anchorset-skill-fixtures.XXXXXX")"
S="$(cd "$S" && pwd -P)"
EP_PID=""
cleanup() {
  if [ -n "$EP_PID" ]; then kill "$EP_PID" 2>/dev/null || true; wait "$EP_PID" 2>/dev/null || true; fi
  if [ "${KEEP_SCRATCH:-0}" != 1 ] && [ -n "${S:-}" ]; then rm -rf "${S:?}"; fi
}
trap cleanup EXIT
if git -C "$S" rev-parse --is-inside-work-tree >/dev/null 2>&1; then die "the scratch folder is inside a git tree; set FIXTURES_SCRATCH_BASE"; fi
echo "scratch: $S"
mkdir -p "$S/home" "$S/tmp" "$S/work/out" "$S/logs"

# ---- copies of the inputs, so that every path the re-grade is given is relative to the scratch folder
cp -R "$HERE/example-flow" "$S/work/flow"
for f in cases.json bar.json template.txt criterion.txt system.txt; do cp "$HERE/$f" "$S/work/$f"; cmp -s "$HERE/$f" "$S/work/$f" || die "copy of $f differs"; done
for f in criterion-reask.txt criterion-reask-exhausted.txt; do cp "$HERE/fixture-inputs/$f" "$S/work/$f"; cmp -s "$HERE/fixture-inputs/$f" "$S/work/$f" || die "copy of $f differs"; done

# ---- the environment of every re-grade: nothing inherited, a dummy key, every proxy variable at a dead port
RUN_ENV=(PATH="$NODE_BIN:/usr/bin:/bin" HOME="$S/home" TMPDIR="$S/tmp" LANG=en_US.UTF-8
  NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9
  ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
  ANTHROPIC_API_KEY=dummy-key-for-local-fake-endpoint OPENAI_API_KEY=dummy-key-for-local-fake-endpoint)

# ---- the fake endpoint: started and stopped for each fixture, so every fixture sees response ids from 0001
start_ep() { # <name> [endpoint flags]
  local name=$1; shift
  node "$HERE/../fake-endpoint.ts" --port "$PORT" --log "$S/logs/$name.requests.jsonl" "$@" 2>"$S/logs/$name.endpoint.err" &
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

CRITERION=criterion.txt   # the criterion text of the next re-grades
MAX_REASKS=0              # the bound of re-asks per slot of the next re-grades, stated for every one (no default)
READING=one-json-object-boolean-pass/v1   # the reading rule of every re-grade and of every import below (no default)
WIRE=anthropic-messages/v1   # the wire of the next re-grades (--wire, no default): anthropic-messages/v1 or openai-responses/v1
GO_ON=()                  # --go-on-and-count for the next re-grades: without it a re-grade stops at the first slot the importer will refuse
regrade() { # <fixture name> <judge model> <source rep> <expected exit code> <expected requests> [endpoint flags]
  local name=$1 model=$2 rep=$3 want=$4 n=$5; shift 5
  start_ep "$name" "$@"
  # The flags that differ by wire: the Anthropic wire states --thinking and takes the base URL as it is; the OpenAI wire states --verbosity and its base URL ends in /v1.
  local wire_flags base_url
  if [ "$WIRE" = openai-responses/v1 ]; then wire_flags=(--wire "$WIRE" --verbosity NOT_SENT); base_url="http://127.0.0.1:$PORT/v1"
  else wire_flags=(--wire "$WIRE" --thinking NOT_SENT); base_url="http://127.0.0.1:$PORT"; fi
  local rc=0
  (cd "$S/work" && env -i "${RUN_ENV[@]}" node "$HERE/regrade.ts" --flow flow --variant baseline --cases cases.json --reps "$REPS" --rep "$rep" --draws "$DRAWS" \
    --template template.txt --criterion "$CRITERION" --system system.txt --select /reply \
    --model "$model" --max-tokens 256 --temperature 0 "${wire_flags[@]}" --effort NOT_SENT --max-reasks "$MAX_REASKS" \
    --base-url "$base_url" --reading "$READING" ${GO_ON[@]+"${GO_ON[@]}"} --out "out/$name.regrade.jsonl" > "$S/logs/$name.stdout" 2> "$S/logs/$name.stderr") || rc=$?
  stop_ep
  if [ "$rc" != "$want" ]; then cat "$S/logs/$name.stdout" "$S/logs/$name.stderr" >&2; die "re-grade $name exited $rc, expected $want"; fi
  local got; got="$(wc -l < "$S/logs/$name.requests.jsonl" | tr -d ' ')"
  [ "$got" = "$n" ] || die "$name: the endpoint saw $got requests, expected $n"
  [ -f "$S/work/out/$name.regrade.jsonl" ] || die "$name: no re-grade file was written"
}

# Two judges on the same stored outputs, those of source rep 0: three cases x three draws = nine calls each.
regrade old-judge fake-judge-old 0 0 9
regrade new-judge fake-judge-strict-new 0 0 9
# The same two judges on the OpenAI Responses wire, on the same stored outputs.
WIRE=openai-responses/v1
regrade openai-old-judge fake-judge-old 0 0 9
regrade openai-new-judge fake-judge-strict-new 0 0 9
WIRE=anthropic-messages/v1
# The new judge on the OTHER source rep: another measurement. Nothing in the importer keeps it apart from a run made
# from rep 0; the end-to-end test hands the two to `judge-change` to show that it refuses them, since their stored
# outputs differ.
regrade new-judge-rep1 fake-judge-strict-new 1 0 9
# Files a re-grade wrote in a bad state. `failed-slot`: the endpoint answers status 500, so the first call fails; the
# script writes that slot's row with no record, ends with exit 2 and keeps the file. `unreadable-reply`: every reply is
# finished and holds no verdict under the reading rule. Without --go-on-and-count the re-grade would stop at the first
# slot (1 request, exit 2); with it the re-grade calls every slot, counts all nine, and the importer refuses the file.
regrade failed-slot fake-judge-old 0 2 1 --mode http-500
GO_ON=(--go-on-and-count); regrade unreadable-reply fake-judge-old 0 0 9 --mode no-verdict; GO_ON=()
# The bounded, recorded re-ask. `reask`: a bound of 2; the first reply of each case is cut and asked again, 12 requests
# for 9 slots. `reask-new-judge`: the second judge on the same stored outputs and the same criterion, under ANOTHER
# bound, 1: the two runs differ in judgeHarnessVersion, and a plan must name that field as moved.
CRITERION=criterion-reask.txt
MAX_REASKS=2; regrade reask fake-judge-old 0 0 12
MAX_REASKS=1; regrade reask-new-judge fake-judge-strict-new 0 0 12
# `reask-exhausted`: a bound of 1 and two cut replies for the first draw of each case, so three slots use up the bound
# (12 requests). Without --go-on-and-count the re-grade would stop at the first of them (2 requests, exit 2); with it the
# re-grade succeeds and writes each record, and the importer refuses the file.
CRITERION=criterion-reask-exhausted.txt
GO_ON=(--go-on-and-count); MAX_REASKS=1; regrade reask-exhausted fake-judge-old 0 0 12; GO_ON=()
CRITERION=criterion.txt; MAX_REASKS=0

# ---- no generated file may name this machine: the scratch folder, a home folder or a temp folder
for f in "$S"/work/out/*.regrade.jsonl; do
  if grep -q -e "$S" -e "$HOME" -e '/Use''rs/' -e '/home/' -e '/tmp/' -e '/var''/folders/' "$f"; then die "$(basename "$f") holds a path of this machine"; fi
  if grep -q 'dummy-key-for-local-fake-endpoint' "$f"; then die "$(basename "$f") holds the key's text"; fi
done

# ---- place the fixtures, then record the hashes
mkdir -p "${OUT_ROOT:?}/fixtures" "${OUT_ROOT:?}/bad-fixtures"
FIXTURES=(fixtures/old-judge.regrade.jsonl fixtures/new-judge.regrade.jsonl fixtures/new-judge-rep1.regrade.jsonl fixtures/reask.regrade.jsonl fixtures/reask-new-judge.regrade.jsonl
  fixtures/openai-old-judge.regrade.jsonl fixtures/openai-new-judge.regrade.jsonl
  bad-fixtures/failed-slot.regrade.jsonl bad-fixtures/unreadable-reply.regrade.jsonl bad-fixtures/reask-exhausted.regrade.jsonl)
for f in "${FIXTURES[@]}"; do
  rm -f "${OUT_ROOT:?}/${f:?}"
  cp "$S/work/out/${f##*/}" "$OUT_ROOT/$f"
done

# ---- the example plan: the two judges' fixtures of source rep 0, imported by the real importer with the flow read again;
#      the plan is what the importer's two printed fragments give. The end-to-end test derives the same plan from its
#      own imports and compares it with the committed file; it never writes the file. This script is what writes it.
mkdir -p "$S/work/runs"
import_run() { # <fixture name> <run name>
  (cd "$S/work" && env -i "${RUN_ENV[@]}" node "$HERE/import.ts" --in "out/$1.regrade.jsonl" --cases cases.json --bar bar.json --out "runs/$2.json" \
    --reading "$READING" --flow flow > "$S/logs/$1.import.stdout" 2> "$S/logs/$1.import.stderr") \
    || { cat "$S/logs/$1.import.stdout" "$S/logs/$1.import.stderr" >&2; die "the import of $1 failed"; }
}
import_run old-judge old
import_run new-judge new
node -e '
const fs = require("node:fs");
// The plan fragment is the first JSON object on stdout: it ends at the first line that is a lone closing brace.
const fragment = (path) => { const t = fs.readFileSync(path, "utf8"); return JSON.parse(t.slice(0, t.indexOf("\n}\n") + 2)); };
const [o, n] = [fragment(process.argv[1]), fragment(process.argv[2])];
for (const k of ["barHash", "caseSetHash", "drawsPerCase"]) if (o[k] !== n[k]) { console.error(`fixtures.sh: the two imports differ in ${k}`); process.exit(2); }
const run = (f) => f.systems["<system name>"]["<old or new>"];
const plan = {
  schema: "anchorset.judge-change-plan/v1",
  barHash: o.barHash,
  caseSetHash: o.caseSetHash,
  drawsPerCase: o.drawsPerCase,
  judges: { old: o.judge, new: n.judge },
  judgeMoves: Object.keys(o.judge).filter((k) => o.judge[k] !== n.judge[k]),
  systems: { "refund-bot": { old: run(o), new: run(n) } },
  storedOutputs: "system-side-not-compared",
  measuredClass: "refund_policy",
  cut: "pass",
  drawSets: { estimate: [0, 1, 2] },
  labelRule: "majority",
  pooling: "items-equal",
};
fs.writeFileSync(process.argv[3], JSON.stringify(plan, null, 2) + "\n");
' "$S/logs/old-judge.import.stdout" "$S/logs/new-judge.import.stdout" "$OUT_ROOT/plan.json" || die "the plan could not be written"

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
{
  # the scripts and the inputs the re-grades ran with: paths relative to examples/importers
  (cd "$HERE/.." && sha promptfoo/grader-provider.cjs skill-evals/regrade.ts skill-evals/flow.ts skill-evals/render.ts skill-evals/selector.ts skill-evals/strict.ts shared.ts fake-endpoint.ts \
    skill-evals/cases.json skill-evals/bar.json skill-evals/template.txt skill-evals/criterion.txt skill-evals/system.txt \
    skill-evals/fixture-inputs/criterion-reask.txt skill-evals/fixture-inputs/criterion-reask-exhausted.txt \
    skill-evals/example-flow/_state.json skill-evals/example-flow/baseline/results.jsonl skill-evals/example-flow/baseline/errors.jsonl skill-evals/example-flow/baseline/traces/*.json)
  # the fixtures: made relative to the same base, examples/importers, so `cd examples/importers && shasum -a 256 -c skill-evals/FIXTURES.sha256` reads every line
  (cd "$OUT_ROOT" && sha "${FIXTURES[@]}") | sed 's|^\([0-9a-f]\{64\}\)  |\1  skill-evals/|'
} > "$OUT_ROOT/FIXTURES.sha256"
echo "made ${#FIXTURES[@]} fixtures and plan.json; hashes in $OUT_ROOT/FIXTURES.sha256"
