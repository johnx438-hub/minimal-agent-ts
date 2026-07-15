---
name: workflow-design
description: >
  Design and write multi-role Workflow / DAG JSON under workflows/. Guide the
  user from intent → roles → flow or DAG → valid file. Use when the user wants
  a workflow, DAG, review loop, parallel workers, orchestration JSON, multi-agent
  pipeline, or runs /workflow-design. Prefer this over inventing ad-hoc spawn
  chains for repeatable multi-role pipelines.
---

# workflow-design

Help humans **name intent, choose topology, pick roles**, then write a loadable
`workflows/<name>.json` for this repo’s `runWorkflow` (W1–W3).

**Spec / code:** `SPEC_WORKFLOW.md`（含 **§11 W4 hands-off 设计**）· `src/workflow/*` ·
examples: `workflows/review-loop.json` (flow) · `workflows/dag-review.json` (DAG).

**Product north stars (W4):**

1. **Isolation** — role envelopes attach only to that role’s `runAgent`
   (`systemPrompt` / step user prompt). Never rewrite the main session’s
   system prompt; parent only gets prior history + digest after the run.
2. **Hands-off pipeline** — arm a preset, user types a normal task, multi-role
   division with **independent perspectives** and **finite** loops/handback.
   Not a single-agent “[goal] keep trying” loop when the goal is fuzzy.

**Do not** invent a second orchestrator. Output is always a workflow JSON
(plus optional role md / preset note). Nested `spawn_*` inside roles is stripped.
Default `share_session: false`. Prefer dedicated planner/reviewer profiles over
generic spawn personas that “just do the task”.

---

## When to invoke

`invoke_skill("workflow-design")` when the user:

- Wants a **multi-role** pipeline (plan → do → review, fan-out, branch)
- Mentions **workflow / DAG / flow / orchestration / review-loop**
- Asks to **build or edit** `workflows/*.json`
- Needs help **choosing flow vs DAG** or **parallel / switch / loop**

**Skip** for one-shot single agent work, or pure `spawn_background` fan-out
with no reusable JSON (see `background-spawn` skill).

---

## Operating loop (do this every time)

### Phase A — Discover (talk first, file second)

Ask **short** clarifying questions until you can fill this card. Prefer 2–4
questions per turn, not a form dump.

| Field | Ask | Default if vague |
|-------|-----|------------------|
| **Goal** | One sentence: what “done” looks like | User’s first message |
| **Inputs** | What is `user_task`? files? URLs? | Free-form task string |
| **Roles** | Who acts? (planner / worker / reviewer / research…) | 2–3 roles max |
| **Order** | Sequential? Parallel fan-out? Loop on feedback? Branch? | Sequential |
| **Stop** | When to stop / hand back to human | Review approved or max rounds |
| **Tools** | Full coding vs read-only review vs web | Match existing presets |
| **Mode** | Blocking agent steps vs long `job` | `agent` (default) |

If the user is fuzzy, offer **2–3 named patterns** (see below) and let them pick.

### Phase B — Choose topology

| Choose **flow** when… | Choose **DAG** when… |
|----------------------|----------------------|
| Linear steps + optional **loop** / **switch** / **parallel** | Graph joins, multiple parents, conditional **back-edges** |
| Easy to read top-to-bottom | Same role reused on different node ids with cycles |
| Review-loop style is enough | Explicit `entry` + edge readiness matters |

**Rule:** `flow` **XOR** (`nodes` + `edges` + `entry`). Never both.

Heuristic:

1. Only A→B→C → **flow**
2. A→B, A→C, then join D → **DAG** (or flow `parallel` then step)
3. Review feedback back to implement with edge `when` → **DAG** or flow **loop**
4. Unsure → start **flow**; upgrade to DAG if joins/cycles get messy

### Phase C — Map roles → profiles

Prefer **preset** over copying long prompts.

| Need | Prefer preset (see `agent.json` `spawn_presets`) |
|------|--------------------------------------------------|
| Implement / edit / shell | `dev-worker` |
| Repo map / read-first | `skeleton-reader` |
| Web research | `web-researcher` |
| Bug / security / quality review | `code-review-bug` / `-security` / `-quality` |

Role JSON fields (snake_case): `preset`, `prompt_file`, `prompt`, `tools`,
`max_turns`, `model`, `api_profile`, `shell`, `description`.

- Role `tools` **replaces** preset tools (use to **narrow** reviewers).
- Nested spawn tools are always stripped.
- New persona: `agents/<name>.md` + optional `spawn_presets` entry, **or**
  `prompt_file` under cwd (e.g. `roles/reviewer.md`). Paths must stay **under cwd**.

### Phase D — Sketch then write

1. Show a **text graph** (boxes/arrows or numbered list) for confirmation.
2. Write `workflows/<kebab-name>.json`.
3. Validate mentally with the checklist below; optionally load via dry logic.
4. Tell user how to run:

```bash
npm start -- --workflow workflows/<name>.json --confirm-workflow "具体任务…"
# or registered name if agent.json workflows map exists:
npm start -- --workflow <name> --confirm-workflow "…"
```

Optional: add `"workflows": { "<name>": "workflows/<name>.json" }` in `agent.json`.

---

## Context & templates

Runtime context:

```text
ctx.user_task
ctx.roles[<slot>].output
ctx.roles[<slot>].verdict   # if model ends with JSON containing verdict
```

Templates: `{{user_task}}`, `{{planner.output}}`, `{{reviewer.verdict}}`.

| Mode | Slot keys |
|------|-----------|
| **flow** | `as` if set, else role name; parallel without `as` → auto `role#0`, `role#1`, … |
| **DAG** | always **node id** + optional `as` alias |

**Always set explicit `as`** when the same role runs more than once in parallel
or you want stable template names (`worker_api`, `reviewer`).

Conditions (`when` / switch):

```json
{ "path": "reviewer.verdict", "eq": "needs_revision" }
```

Legacy string form still works: `"{{reviewer.verdict}} == 'needs_revision'"`.
Prefer the object form.

Ask reviewers to **end with** machine-readable verdict, e.g.:

```text
End with JSON: {"verdict":"approved"|"needs_revision","notes":"..."}
```

`share_session` (default false): each role only sees its **templated input**.
Set `true` only when you intentionally share full message history (rare).

**Parent session (slash / active chat):** like **spawn** — pre-workflow
`current_messages` are **preserved**. On success/handback the runtime appends
a short **user task + assistant digest** (role slots + final output), not the
full multi-role transcript. Cancel/abort restores prior history without digest.

**Handoff (W4):** each role gets a `[workflow_envelope]` (role system only) with
workflow-specific **negative feedback**: only a clear handoff advances the pipeline;
tooling without a deliverable burns turns and fails the step; parent history is
kept. Optional `workflow_handoff` (preferred) **or** a final message as the body.
Reviewer verdicts: `approved` | `needs_revision` | `needs_human`.

---

## Pattern library (pick → adapt)

### 1) Sequential plan → work → review (flow)

Canonical: `workflows/review-loop.json`.

```json
{
  "name": "review-loop",
  "share_session": false,
  "roles": {
    "planner": { "preset": "skeleton-reader", "tools": ["read_file", "grep_search", "list_files"], "max_turns": 50 },
    "worker": { "preset": "dev-worker" },
    "reviewer": {
      "prompt_file": "roles/reviewer.md",
      "tools": ["read_file", "grep_search", "diff_file"],
      "max_turns": 50
    }
  },
  "flow": [
    { "role": "planner", "input": "{{user_task}}" },
    {
      "role": "worker",
      "input": "## Plan\n{{planner.output}}\n\n## Task\n{{user_task}}\n\nImplement. Summarize files changed."
    },
    {
      "role": "reviewer",
      "input": "## Work\n{{worker.output}}\n\nReview. End with JSON: {\"verdict\":\"approved\"|\"needs_revision\",\"notes\":\"...\"}"
    },
    {
      "loop": {
        "when": { "path": "reviewer.verdict", "eq": "needs_revision" },
        "max_rounds": 2,
        "steps": [
          {
            "role": "worker",
            "input": "## Feedback\n{{reviewer.output}}\n\n## Task\n{{user_task}}\n\nFix and summarize."
          },
          {
            "role": "reviewer",
            "input": "## Revised\n{{worker.output}}\n\nRe-review. End with JSON: {\"verdict\":\"approved\"|\"needs_revision\",\"notes\":\"...\"}"
          }
        ]
      }
    }
  ]
}
```

### 2) Same loop as DAG (back-edge)

Canonical: `workflows/dag-review.json`.

```json
{
  "name": "dag-review",
  "share_session": false,
  "roles": {
    "planner": { "preset": "skeleton-reader", "max_turns": 50 },
    "worker": { "preset": "dev-worker" },
    "reviewer": {
      "prompt_file": "roles/reviewer.md",
      "tools": ["read_file", "grep_search", "diff_file"],
      "max_turns": 50
    }
  },
  "entry": "plan",
  "nodes": {
    "plan": { "role": "planner", "input": "{{user_task}}" },
    "impl": {
      "role": "worker",
      "as": "worker",
      "input": "## Plan\n{{plan.output}}\n\n## Task\n{{user_task}}\n\nImplement.",
      "max_visits": 3
    },
    "review": {
      "role": "reviewer",
      "as": "reviewer",
      "input": "## Work\n{{worker.output}}\n\nReview. End with JSON: {\"verdict\":\"approved\"|\"needs_revision\",\"notes\":\"...\"}",
      "max_visits": 3
    }
  },
  "edges": [
    { "from": "plan", "to": "impl" },
    { "from": "impl", "to": "review" },
    {
      "from": "review",
      "to": "impl",
      "when": { "path": "reviewer.verdict", "eq": "needs_revision" },
      "max_visits": 2
    }
  ]
}
```

**DAG readiness:** edges **without** `when` are **required** for the successor.
Conditional edges fire/waive after source completes and **do not** block first
activation that already has required edges satisfied. Cap cycles with
`max_visits` on nodes and/or edges. Exhaustion → handback `dag_exhausted`
(not silent success).

### 3) Parallel fan-out then merge (flow)

```json
{
  "name": "parallel-reviews",
  "roles": {
    "bug": { "preset": "code-review-bug", "max_turns": 50 },
    "sec": { "preset": "code-review-security", "max_turns": 50 },
    "merge": { "preset": "skeleton-reader", "tools": ["read_file"], "max_turns": 50 }
  },
  "flow": [
    {
      "parallel": {
        "join": "all",
        "steps": [
          { "role": "bug", "as": "bug", "input": "Review for bugs:\n{{user_task}}" },
          { "role": "sec", "as": "sec", "input": "Review for security:\n{{user_task}}" }
        ]
      }
    },
    {
      "role": "merge",
      "input": "## Bug pass\n{{bug.output}}\n\n## Security\n{{sec.output}}\n\nMerge into one prioritized list."
    }
  ]
}
```

Same role twice in parallel → different `as` (or rely on auto `role#index`).

### 4) Branch on verdict (switch)

```json
{
  "switch": {
    "on": "reviewer.verdict",
    "cases": {
      "needs_revision": [
        { "role": "worker", "input": "Fix per:\n{{reviewer.output}}" }
      ],
      "approved": []
    },
    "default": [
      { "role": "worker", "input": "Verdict unclear; re-check:\n{{reviewer.output}}" }
    ]
  }
}
```

### 5) Heavy step as job

Long / isolatable work: `"mode": "job"` on a step or node → `spawn_background`
+ await; text still lands in `ctx`. Prefer when the step should use job disk
isolation; default remains `"mode": "agent"`.

```json
{ "role": "worker", "mode": "job", "input": "{{user_task}}" }
```

### 6) Research → write (flow)

```json
{
  "name": "research-write",
  "roles": {
    "researcher": { "preset": "web-researcher", "max_turns": 10 },
    "writer": { "preset": "dev-worker", "tools": ["read_file", "write_file", "edit_file", "list_files"], "max_turns": 12 }
  },
  "flow": [
    { "role": "researcher", "input": "Research with sources:\n{{user_task}}" },
    {
      "role": "writer",
      "input": "## Sources\n{{researcher.output}}\n\n## Task\n{{user_task}}\n\nWrite the deliverable under the project cwd."
    }
  ]
}
```

---

## Interview scripts (agent tone)

**Opening (user vague):**

> 你想用 workflow 固化哪条流水线？可以说：目标产出、要不要审查循环、有没有可并行的独立分支。我也可以按「计划→实现→审查」模板开写。

**Pick topology:**

> 听起来是线性 + 审查打回，用 **flow + loop** 就够；如果后面要「多路实现再汇合」或复杂回边，我们再升成 **DAG**。

**Before writing file:**

> 草稿拓扑：`plan → impl ⇄ review (needs_revision)`，三角色用 skeleton-reader / dev-worker / reviewer。确认名字和 `max_rounds`/`max_visits` 后我写入 `workflows/….json`。

**After write:**

> 已写好 `workflows/<name>.json`。跑：  
> `npm start -- --workflow workflows/<name>.json --confirm-workflow "…"`  
> 若 handback（`loop_guard` / `dag_exhausted` / `max_rounds_exhausted`），把 detail 贴回来我们调条件或上限。

---

## Validation checklist (before handoff)

- [ ] `name` set; file under `workflows/` (or registered path)
- [ ] Exactly one of: `flow` **or** (`entry` + `nodes` + `edges`)
- [ ] Every `role` in steps/nodes exists in `roles`
- [ ] Templates only reference slots that **already ran** (or `user_task`)
- [ ] Parallel / multi-use roles have distinct `as` (or accept `role#i`)
- [ ] Loops/cycles have finite `max_rounds` or `max_visits`
- [ ] `when` paths match slot names (`as` or node id), field `verdict`/`output`
- [ ] Reviewer prompts produce parseable `verdict` if you branch on it
- [ ] `prompt_file` paths under project cwd (no `../../etc`)
- [ ] No reliance on nested spawn inside roles

Loader rejects invalid JSON / mutual exclusion; prefer fixing structure over
“hoping runner sorts it out”.

---

## Handback & failure UX

Workflow may return control early with `handback.reason`:

| reason | Meaning | Typical fix |
|--------|---------|-------------|
| `loop_guard` / `max_rounds_exhausted` | Flow loop hit cap | Raise `max_rounds` or tighten `when` |
| `dag_exhausted` | Stuck unfinished nodes or schedule cap | Fix edges/`when`, raise `max_visits`, avoid impossible joins |
| `turn_ceiling` / `agent_stopped` | Role run stopped | Raise `max_turns` or simplify role task |

Tell the user these are **expected safety exits**, not silent success.

---

## Anti-patterns

1. **One mega role** that “does everything” — use workflow only if ≥2 distinct personas or real structure.
2. **flow + nodes** in one file — illegal.
3. **Same slot overwrite** in parallel without `as`.
4. **Uncapped** review loops (`max_rounds` / `max_visits` missing).
5. **Switch on free prose** without forcing `verdict` JSON.
6. **Copying** giant system prompts into every JSON — use `preset` / `agents/*.md`.
7. **Path escape** in `prompt_file`.
8. Replacing workflow with ad-hoc main-agent spawn when the user asked for a **reusable** pipeline file.

---

## Deliverable format

When done, leave the user with:

1. **Intent summary** (1–3 bullets)
2. **Topology** (flow or DAG sketch)
3. **File path** `workflows/<name>.json` (and any new `roles/` / `agents/` files)
4. **Run command**
5. **Knobs** they may tune later (`max_rounds`, tools lists, `share_session`)

If they only wanted design: stop after the sketch and wait for “写文件”.
If they said “直接搭”：write the file after one confirmation of topology (or
immediately if they already specified the full graph).
