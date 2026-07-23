# state_chain_01 — state-dependent tool chain

You are in a prepared workspace. Complete **every** step. Success is judged only by the final file `answer.json` on disk (not by chat claims).

## Steps (in order)

1. Read `data/brief.md` and follow it.
2. Read `data/step1.txt` and extract the secret **token** (string after `token=`).
3. Write that token alone (no newline padding issues: trim whitespace) into `data/claimed_token.txt`.
4. List `noise/` and **read at least the first 200 characters** of each file under `noise/` (there are several large files — this is intentional load).
5. Compute:
   - `token_len` = character length of the token
   - `token_fingerprint` = `token_len * 7 +` Unicode code point of the first character of the token
6. Write `answer.json` in the workspace **root** with exactly this JSON shape (integers as numbers, not strings):

```json
{
  "token": "<the token>",
  "token_len": 0,
  "token_fingerprint": 0,
  "noise_files_read": 0
}
```

`noise_files_read` must equal the number of files you read under `noise/` (should match how many files exist there).

## Rules

- Do not invent a token; it only exists in `data/step1.txt`.
- Do not skip the noise reads.
- When finished, ensure `answer.json` is valid JSON on disk.
