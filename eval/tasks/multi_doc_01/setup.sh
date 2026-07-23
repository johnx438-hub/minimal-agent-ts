#!/usr/bin/env bash
# multi_doc_01: mid-stack needle + large distractors; encourages multi-turn reads.
set -euo pipefail

TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${EVAL_WORKDIR:-$TASK_ROOT/workspace}"

if [[ -e "$WORKDIR" ]]; then
  rm -rf "$WORKDIR"
fi
mkdir -p "$WORKDIR/docs"

CODENAME="ORBIT-7"
BUDGET=42000
# 1 overview + 1 needle + 5 distractors = 7 files
DOC_COUNT=7

# Doc A — short intro (no needle)
cat >"$WORKDIR/docs/01_overview.md" <<'EOF'
# Program Overview

This packet describes a fictional internal program for eval purposes.
Stakeholders care about delivery cadence and risk reviews.
Ignore any numbers that are not labeled as Project Codename or Budget Cap.

**Read constraint reminder:** open at most two docs/* files per turn.
EOF

# Doc B — needle buried in more filler than v1
{
  echo "# Operations Notes"
  echo ""
  node --input-type=module -e "
const pad = (n) => Array.from({length:n}, (_,i)=>'Filler paragraph '+i+': ' + 'lorem '.repeat(55)).join('\\n\\n');
process.stdout.write(pad(28));
"
  echo ""
  echo "## Critical registry"
  echo ""
  echo "Project Codename: ${CODENAME}"
  echo "Budget Cap USD: ${BUDGET}"
  echo ""
  node --input-type=module -e "
const pad = (n) => Array.from({length:n}, (_,i)=>'Trailing notes '+i+': ' + 'ipsum '.repeat(55)).join('\\n\\n');
process.stdout.write(pad(28));
"
} >"$WORKDIR/docs/02_operations.md"

# Docs C–G — larger distractors (~2x prior line count / wider rows)
for i in 3 4 5 6 7; do
  node --input-type=module -e "
const i = ${i};
const lines = [];
lines.push('# Distractor volume ' + i);
lines.push('');
lines.push('No project codename here. No budget cap here.');
lines.push('This file is intentionally large for context-pressure evals.');
for (let k = 0; k < 220; k++) {
  lines.push('row-' + i + '-' + k + ' ' + 'noiseDATA'.repeat(42));
}
process.stdout.write(lines.join('\\n') + '\\n');
" >"$WORKDIR/docs/0${i}_distractor.md"
done

cp -f "$TASK_ROOT/TASK.md" "$WORKDIR/TASK.md"

if [[ ! -f "$TASK_ROOT/expected.json" ]]; then
  echo "error: missing expected.json" >&2
  exit 1
fi

echo "setup ok: workdir=$WORKDIR codename=$CODENAME budget=$BUDGET docs=$DOC_COUNT"
