#!/usr/bin/env bash
set -euo pipefail

TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${EVAL_WORKDIR:-$TASK_ROOT/workspace}"
EXPECTED="$TASK_ROOT/expected.json"
ANSWER="$WORKDIR/answer.json"

if [[ ! -f "$EXPECTED" ]]; then
  echo '{"ok":false,"error":"missing expected.json"}'
  exit 1
fi
if [[ ! -f "$ANSWER" ]]; then
  echo '{"ok":false,"error":"missing answer.json","path":"'"$ANSWER"'"}'
  exit 1
fi

node --input-type=module -e '
import { readFileSync } from "node:fs";

const expected = JSON.parse(readFileSync(process.argv[1], "utf8"));
const answer = JSON.parse(readFileSync(process.argv[2], "utf8"));
const keys = ["project_codename", "budget_cap_usd", "docs_read"];
const mismatches = [];
for (const k of keys) {
  if (answer[k] !== expected[k]) {
    mismatches.push({ key: k, expected: expected[k], actual: answer[k] });
  }
}
const ok = mismatches.length === 0;
console.log(JSON.stringify({ ok, mismatches, answer_path: process.argv[2] }));
process.exit(ok ? 0 : 1);
' "$EXPECTED" "$ANSWER"
