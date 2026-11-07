#!/usr/bin/env bash
# Repeatable agent benchmark. Usage (from repo root, Git Bash):
#   bench/run.sh <stage: mini|taskb> <model[,fallback...]> [profile full|lean] [compactAt]
# Resets the target repo, runs the real TrueForge pipeline headless (simulated accept-all
# review, approval-gated commands), then records TrueForge usage metrics, test results and
# the diff, and restores the target repo. Results: bench/results/<stamp>-<stage>-<model>.*
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE=$1; MODELS=$2; PROFILE=${3:-lean}; COMPACT=${4:-0}
STAMP=$(date +%m%d-%H%M%S); TAG="$STAMP-$STAGE-$(echo "${MODELS%%,*}" | tr '/:' '__')-$PROFILE"
OUT="$ROOT/bench/results/$TAG"
if [ "$STAGE" = mini ]; then
  WS="${TMPDIR:-/tmp}/forge-bench-shop"; rm -rf "$WS"; cp -r "$ROOT/bench/fixtures/shop" "$WS"
  (cd "$WS" && git init -q && git add -A && git -c user.email=b@b -c user.name=b commit -qm base)
  TASK="$ROOT/bench/task-mini.txt"; PY=python; TESTS="tests"
else
  WS="$ROOT/flask"; [ -z "$(git -C "$WS" status --short)" ] || { echo "flask not clean"; exit 2; }
  TASK="$ROOT/demo/tasks/task-b.txt"; PY="$WS/.venv/Scripts/python"; TESTS="tests/test_cli.py"
fi
cd "$ROOT/extension"
FORGE_PROFILE=$PROFILE FORGE_COMPACT_AT=$COMPACT FORGE_CONTEXT_MAX=${FORGE_CONTEXT_MAX:-0} timeout 2400 node out/e2e-edit.js "$WS" "$MODELS" "$TASK" > "$OUT.log" 2>&1
echo "exit=$?" >> "$OUT.log"
node "$ROOT/scripts/session-metrics.mjs" "$OUT.log" > "$OUT.metrics" 2>&1
(cd "$WS" && git diff > "$OUT.diff"; "$PY" -m pytest $TESTS -q -p no:cacheprovider > "$OUT.tests" 2>&1)
# deletion check: any removed def/class/top-level assignment line in the diff
grep -E '^-(def |class |async def |[A-Za-z_][A-Za-z0-9_]* = )' "$OUT.diff" > "$OUT.deleted" || true
(cd "$WS" && git checkout -q -- . && git clean -qfd -e .venv -e .pytest_cache)
echo "== $TAG"; grep RESULT "$OUT.log"; tail -1 "$OUT.metrics"; tail -1 "$OUT.tests"
echo "files: $(grep -c '^diff --git' "$OUT.diff")  deleted-defs: $(wc -l < "$OUT.deleted")"
