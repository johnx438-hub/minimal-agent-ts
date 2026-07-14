---
name: office-layout
description: >
  Docx/pptx structured layout for office_write — blocks, markdown inline, tables,
  append_blocks, slide masters/charts. Use before rich reports or decks; light
  paragraphs/slides need no skill. Templates live under this skill for extension.
---

# office-layout

How to use **`office_read` / `office_write`** for real documents without stuffing
the full schema into every turn.

## When to invoke

Call `invoke_skill("office-layout")` (optional focus query, e.g. `weekly report`
or `pptx chart + master`) when you need:

- Headings, lists, tables, images, pagebreak, header/footer
- Markdown-like inline (`**bold**`, `*italic*`, `` `code` ``, `~~strike~~`)
- Draft → `append_blocks` multi-step writing
- PPTX layouts, freeform `objects`, charts, custom `masters`

**Skip this skill** for plain `paragraphs` / `text` or simple
`slides: [{ title, bullets }]`.

## Mental model

| Layer | Where | Cost |
|-------|--------|------|
| Tools | `office_read` / `office_write` always available (if in `builtin_tools`) | Schema every turn |
| This skill | Full recipes + templates | Only when invoked |
| Sidecar | `<path>.docx.office.json` after structured write | Enables append |

Generate-oriented: **create/overwrite** (and docx **append via sidecar**), not
surgical edit of arbitrary third-party OOXML.

---

## Docx — light

```json
{
  "path": "notes/hello.docx",
  "paragraphs": ["Para one", "Para two with 中文"]
}
```

Or `text` (blank-line split). Markdown in strings is OK: `"**Lead** then body"`.

## Docx — blocks (preferred for structure)

```json
{
  "path": "report.docx",
  "doc_title": "Weekly",
  "header": "Confidential",
  "footer": true,
  "page": { "orientation": "portrait", "margins_in": { "top": 0.8 } },
  "blocks": [
    { "type": "heading", "level": 1, "text": "周报", "align": "center" },
    { "type": "paragraph", "text": "本周完成 **API** 与 *TUI*。" },
    { "type": "bullet", "items": ["Item A", "Item **B**"] },
    { "type": "number", "items": ["First", "Second"] },
    {
      "type": "table",
      "headers": ["项", "状态"],
      "rows": ["API | ok", "TUI | ok"]
    },
    { "type": "pagebreak" },
    { "type": "heading", "level": 2, "text": "附录" },
    {
      "type": "image",
      "path": "assets/logo.png",
      "width_in": 1.5,
      "height_in": 1.5,
      "alt": "logo"
    }
  ]
}
```

### Table row shorthand

| `rows` shape | Meaning |
|--------------|---------|
| `["row1", "row2"]` | One cell per row (single column) |
| `["A \| B", "C \| D"]` | Columns split on ` \| ` (spaces around pipe) |
| `[["A","B"],["C","D"]]` | Full matrix |
| Cell with `\n` | Multi-paragraph cell |

Set `"markdown": false` on a block to disable inline parse.

### Draft → append (multi-step)

1. Write with `blocks` / `paragraphs` / `text` → creates `report.docx` **and**
   `report.docx.office.json`.
2. Later:

```json
{
  "path": "report.docx",
  "append_blocks": [
    { "type": "heading", "level": 2, "text": "风险" },
    { "type": "paragraph", "text": "延迟 **可控**。" }
  ]
}
```

Do **not** pass `blocks` and `append_blocks` together. No sidecar → error
(must structure-write first).

---

## Pptx — light

```json
{
  "path": "decks/demo.pptx",
  "title": "Demo",
  "slides": [
    { "title": "Agenda", "bullets": ["A", "B"] },
    { "title": "Next", "body": "Ship it." }
  ]
}
```

## Pptx — layouts, chart, master

```json
{
  "path": "decks/qbr.pptx",
  "layout": "LAYOUT_16x9",
  "masters": [{
    "name": "CORP",
    "background": "FFFFFF",
    "slide_number": { "x": 9.0, "y": 5.15, "color": "888888" },
    "objects": [
      { "kind": "rect", "x": 0, "y": 0, "w": "100%", "h": 0.45, "fill": "1E3A5F" },
      { "kind": "text", "text": "Acme", "x": 0.3, "y": 0.05, "w": 4, "h": 0.35, "color": "FFFFFF", "fontSize": 12, "bold": true }
    ]
  }],
  "slides": [
    {
      "master": "CORP",
      "layout": "title",
      "title": "Q3 Review",
      "subtitle": "Metrics",
      "notes": "Open with revenue."
    },
    {
      "master": "CORP",
      "layout": "blank",
      "objects": [{
        "kind": "chart",
        "chart_type": "bar",
        "x": 0.5, "y": 1.0, "w": 9, "h": 4,
        "title": "Revenue",
        "show_legend": true,
        "labels": ["Q1", "Q2", "Q3", "Q4"],
        "values": [12, 18, 15, 22],
        "series_name": "2026"
      }]
    }
  ]
}
```

Slide `layout`: `title` | `title_bullets` | `title_body` | `section` | `two_column` | `blank`.  
Object `kind`: `text` | `shape` | `table` | `image` | `chart`.  
Chart types: `bar` | `line` | `pie` | `doughnut` | `area` | `radar` | …  
Multi-series: `series: [{ name, labels, values }, …]`.

---

## Xlsx (light only)

```json
{
  "path": "data/t.xlsx",
  "sheet": "Main",
  "headers": ["name", "qty"],
  "append_rows": [["a", 1]],
  "set_cells": [{ "cell": "B2", "value": 99 }],
  "replace_sheet": false
}
```

---

## Templates (extend here)

Add new recipes under this skill without growing `office_write` schema:

| Name | Focus query | Use |
|------|-------------|-----|
| weekly-report | `weekly report` | Docx heading + bullets + status table + append section |
| meeting-notes | `meeting notes` | Docx attendees table + action bullets |
| status-deck | `status deck` | Pptx CORP master + title + chart slide |
| one-pager | `one pager` | Docx short: title, 3 bullets, one table |

### Template: weekly-report

```json
{
  "path": "reports/weekly.docx",
  "doc_title": "Weekly Report",
  "footer": true,
  "blocks": [
    { "type": "heading", "level": 1, "text": "Weekly Report", "align": "center" },
    { "type": "paragraph", "text": "Period: **YYYY-MM-DD** → **YYYY-MM-DD**" },
    { "type": "heading", "level": 2, "text": "Highlights" },
    { "type": "bullet", "items": ["…", "…"] },
    { "type": "heading", "level": 2, "text": "Status" },
    {
      "type": "table",
      "headers": ["Workstream", "Status", "Notes"],
      "rows": [
        "Platform | green | …",
        "Client | yellow | …"
      ]
    },
    { "type": "heading", "level": 2, "text": "Risks" },
    { "type": "bullet", "items": ["…"] },
    { "type": "heading", "level": 2, "text": "Next week" },
    { "type": "number", "items": ["…", "…"] }
  ]
}
```

Later same path: `append_blocks` for a dated “Update” section.

### Template: meeting-notes

```json
{
  "path": "notes/meeting.docx",
  "blocks": [
    { "type": "heading", "level": 1, "text": "Meeting: <title>" },
    { "type": "paragraph", "text": "Date: … · Owner: …" },
    {
      "type": "table",
      "headers": ["Attendee", "Role"],
      "rows": ["Alice | Eng", "Bob | PM"]
    },
    { "type": "heading", "level": 2, "text": "Decisions" },
    { "type": "bullet", "items": ["…"] },
    { "type": "heading", "level": 2, "text": "Actions" },
    { "type": "number", "items": ["**@name**: task — due …"] }
  ]
}
```

### Adding a template later

1. Append a `### Template: <name>` section **or** add
   `skills/office-layout/templates/<name>.json` and link it from this file.
2. Keep tool schemas **light**; put long examples only here.
3. Optional: mention the template name in the skill `description` frontmatter
   so discovery stays searchable.

---

## Read path

```json
{ "path": "report.docx", "format": "markdown" }
```

Docx → structured markdown when possible; pptx → per-slide outline; xlsx → sampled rows.
Large output may spill under `.cache/office/`.

## Gotchas

1. **Paths** stay under project cwd; images for docx/pptx must already exist.
2. **append_blocks** needs sidecar; deleting `.office.json` breaks append.
3. **Do not** invent OOXML fields not listed here; stick to documented keys.
4. Prefer **one write** with complete `blocks` when the full outline is known;
   use append only for iterative drafting.
5. After write, `office_read` to verify Chinese / structure before handoff.
