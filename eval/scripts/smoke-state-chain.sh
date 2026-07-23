#!/usr/bin/env bash
# E0 smoke: setup → correct answer scores 0 → wrong answer scores 1. No API.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK=state_chain_01
WS="$ROOT/eval/tasks/$TASK/workspace"

bash "$ROOT/eval/scripts/setup-task.sh" "$TASK"

cp "$ROOT/eval/tasks/$TASK/fixtures/answer.correct.json" "$WS/answer.json"
mkdir -p "$WS/data"
printf 'cherry-42\n' >"$WS/data/claimed_token.txt"

if ! bash "$ROOT/eval/scripts/score-task.sh" "$TASK" >/tmp/eval-score-ok.json; then
  echo "error: expected correct answer to pass" >&2
  cat /tmp/eval-score-ok.json >&2 || true
  exit 1
fi
echo "pass: correct answer -> $(cat /tmp/eval-score-ok.json)"

echo '{"token":"wrong","token_len":1,"token_fingerprint":1,"noise_files_read":0}' >"$WS/answer.json"
if bash "$ROOT/eval/scripts/score-task.sh" "$TASK" >/tmp/eval-score-bad.json 2>/dev/null; then
  echo "error: expected wrong answer to fail" >&2
  exit 1
fi
echo "pass: wrong answer rejected -> $(cat /tmp/eval-score-bad.json)"

echo "eval smoke ok (state_chain_01)"
