#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_ID="${1:?usage: score-task.sh <task_id>}"
SCORE="$ROOT/eval/tasks/$TASK_ID/score.sh"
if [[ ! -f "$SCORE" ]]; then
  echo "error: no score.sh for task $TASK_ID" >&2
  exit 1
fi
exec bash "$SCORE"
