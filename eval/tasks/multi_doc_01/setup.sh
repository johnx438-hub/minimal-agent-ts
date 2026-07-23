#!/usr/bin/env bash
# multi_doc_01: mid-stack needle among filler documents (deterministic).
set -euo pipefail

TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${EVAL_WORKDIR:-$TASK_ROOT/workspace}"

if [[ -e "$WORKDIR" ]]; then
  rm -rf "$WORKDIR"
fi
mkdir -p "$WORKDIR/docs"

CODENAME="ORBIT-7"
BUDGET=42000
DOC_COUNT=5

# Doc A — intro (no needle)
cat >"$WORKDIR/docs/01_overview.md" <<'EOF'
# Program Overview

This packet describes a fictional internal program for eval purposes.
Stakeholders care about delivery cadence and risk reviews.
Ignore any numbers that are not labeled as Project Codename or Budget Cap.
EOF

# Doc B — needle in the middle of filler paragraphs
{
  echo "# Operations Notes"
  echo ""
  node --input-type=module -e "
const pad = (n) => Array.from({length:n}, (_,i)=>'Filler paragraph '+i+': ' + 'lorem '.repeat(40)).join('\\n\\n');
process.stdout.write(pad(12));
"
  echo ""
  echo "## Critical registry"
  echo ""
  echo "Project Codename: ${CODENAME}"
  echo "Budget Cap USD: ${BUDGET}"
  echo ""
  node --input-type=module -e "
const pad = (n) => Array.from({length:n}, (_,i)=>'Trailing notes '+i+': ' + 'ipsum '.repeat(40)).join('\\n\\n');
process.stdout.write(pad(12));
"
} >"$WORKDIR/docs/02_operations.md"

# Docs C–E — large distractors
for i in 3 4 5; do
  node --input-type=module -e "
const i = ${i};
const lines = [];
lines.push('# Distractor volume ' + i);
lines.push('');
lines.push('No project codename here. No budget cap here.');
for (let k = 0; k < 100; k++) {
  lines.push('row-' + i + '-' + k + ' ' + 'noiseDATA'.repeat(30));
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
