#!/usr/bin/env bash
# Score state_chain_01: compare workspace/answer.json to expected.json.
# Exit 0 = pass, 1 = fail. Prints a one-line JSON result to stdout.
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

# Prefer node for robust JSON compare (repo requires Node ≥ 22).
node --input-type=module -e '
import { readFileSync } from "node:fs";

const expected = JSON.parse(readFileSync(process.argv[1], "utf8"));
const answer = JSON.parse(readFileSync(process.argv[2], "utf8"));

const keys = ["token", "token_len", "token_fingerprint", "noise_files_read"];
const mismatches = [];
for (const k of keys) {
  if (answer[k] !== expected[k]) {
    mismatches.push({ key: k, expected: expected[k], actual: answer[k] });
  }
}

// Optional soft check: claimed_token.txt
import { existsSync, readFileSync as read } from "node:fs";
const claimedPath = process.argv[3];
let claimed_ok = null;
if (existsSync(claimedPath)) {
  const claimed = read(claimedPath, "utf8").trim();
  claimed_ok = claimed === expected.token;
  if (!claimed_ok) {
    mismatches.push({ key: "claimed_token.txt", expected: expected.token, actual: claimed });
  }
}

const ok = mismatches.length === 0;
const out = { ok, mismatches, answer_path: process.argv[2] };
console.log(JSON.stringify(out));
process.exit(ok ? 0 : 1);
' "$EXPECTED" "$ANSWER" "$WORKDIR/data/claimed_token.txt"
