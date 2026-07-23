#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_ID="${1:?usage: setup-task.sh <task_id>}"
SETUP="$ROOT/eval/tasks/$TASK_ID/setup.sh"
if [[ ! -f "$SETUP" ]]; then
  echo "error: no setup.sh for task $TASK_ID" >&2
  exit 1
fi
exec bash "$SETUP"
