# multi_doc_01 — multi-document synthesis (mid-context needle, **segmented reads**)

Workspace contains several documents under `docs/`. Some are long filler; one holds a **single critical fact**.

## Goal

1. List `docs/` (once is fine).
2. Read **every** file under `docs/` (including long filler).
3. Find the **Project Codename** (exact string) and **Budget Cap USD** (integer) in the documents.
4. Write `answer.json` at the workspace root:

```json
{
  "project_codename": "<exact string>",
  "budget_cap_usd": 0,
  "docs_read": 0
}
```

`docs_read` must equal the number of files under `docs/`.

## Hard rules (eval harness)

- **Segmented reading (mandatory):** In any single turn, you may open **at most 2 files** under `docs/` via `read_file` (or equivalent full-content read).
  - Allowed: list directory, then over multiple turns read 1–2 docs at a time.
  - **Forbidden:** reading 3+ `docs/*` files in the same turn (including parallel tool batches).
- Do not invent values; they appear only in the prepared docs.
- Success is judged only by `answer.json` on disk (not chat claims).

## Why this constraint

Long-context evals need multi-turn tool history so pointerize/keep windows can act. Batch-reading every file in one turn hides that signal.
