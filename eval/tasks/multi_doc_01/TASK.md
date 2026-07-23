# multi_doc_01 — multi-document synthesis (mid-context needle)

Workspace contains several documents under `docs/`. Some are long filler; one holds a **single critical fact**.

## Goal

1. List `docs/` and read **every** file there (including long ones — skim is OK for filler, but you must open each file).
2. Find the **Project Codename** stated in the documents (exact string).
3. Find the **Budget Cap USD** integer stated near that codename.
4. Write `answer.json` at the workspace root:

```json
{
  "project_codename": "<exact string>",
  "budget_cap_usd": 0,
  "docs_read": 0
}
```

`docs_read` must equal the number of files under `docs/`.

## Rules

- Do not invent values; they appear only in the prepared docs.
- Success is judged only by `answer.json` on disk.
