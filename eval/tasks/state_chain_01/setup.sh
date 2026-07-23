#!/usr/bin/env bash
# Prepare a fresh workspace for state_chain_01 (deterministic; no network).
set -euo pipefail

TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${EVAL_WORKDIR:-$TASK_ROOT/workspace}"

# Idempotent clean (per-run workdir or shared task workspace)
if [[ -e "$WORKDIR" ]]; then
  rm -rf "$WORKDIR"
fi
mkdir -p "$WORKDIR/data" "$WORKDIR/noise"

TOKEN="cherry-42"
# token_len=9; first char 'c' = 99; fingerprint = 9*7+99 = 162
NOISE_COUNT=3

cat >"$WORKDIR/data/brief.md" <<'EOF'
# Brief

This workspace is part of an automated eval.

1. Recover the secret token from `data/step1.txt`.
2. Persist it to `data/claimed_token.txt`.
3. Skim every file in `noise/` (first 200+ chars each).
4. Write `answer.json` at the workspace root as specified in the task prompt.

Do not look for gold answers outside this workspace.
EOF

printf 'token=%s\n' "$TOKEN" >"$WORKDIR/data/step1.txt"

# Deterministic large-ish noise (mixed lines; not pure 'x' so tools do real I/O).
# Use node (repo requires Node ≥ 22) rather than python3.
for i in $(seq 1 "$NOISE_COUNT"); do
  node --input-type=module -e "
const i = ${i};
const header = '=== noise blob ' + i + ' / ${NOISE_COUNT} ===\\n';
const line = 'noise-' + i + '-line-' + 'ABCDEFGHIJ'.repeat(20) + '\\n';
process.stdout.write(header + line.repeat(80));
" >"$WORKDIR/noise/blob_${i}.txt"
done

# Copy human task text into workspace for agents that only see cwd.
cp -f "$TASK_ROOT/TASK.md" "$WORKDIR/TASK.md"

# Record expected for score.sh (outside agent-facing data/ if possible — still under task root).
# expected.json is task-static; do not put it inside workdir.
if [[ ! -f "$TASK_ROOT/expected.json" ]]; then
  echo "error: missing $TASK_ROOT/expected.json" >&2
  exit 1
fi

echo "setup ok: workdir=$WORKDIR token=$TOKEN noise_files=$NOISE_COUNT"
