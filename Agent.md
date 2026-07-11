# Workspace agent instructions

1. **规划对齐**： 讨论需求,目标，最短代码实现方式,可能存在的健壮代码方案，整体流程，阶段性验收标准，以及任务边界或原代码保护部分。
2. **创建目标**： 讨论完成后在任务项目文件夹中创建spec文档和测试脚本
3. **阶段分支**： 任务启动前预判代码长度,如果可能过大按照功能块区分阶段，分批完成; 阶段性任务完成后询问是否需要调用子agent 进行 cold review 以及进一步改进; 确定阶段性完成时询问是否归档进经验文件
## Paradigm

- **Plan-with-files**: multi-file or >10-turn work → write `.agent/plan.md` (goal / steps / risks) before editing source.
- **Spec-first**: new features → `specs/<feature>.md` with acceptance criteria; align implementation to spec.
- **Grill mode**: vague or large tasks → ask 3–5 clarifying questions **before** destructive tools; continue after user replies.
- **Large HTML/JSON**: `write_file` **content_b64** or `edit_file` **old_string_b64** / **new_string_b64** — avoids broken JSON tool args from unescaped quotes.
## Triggers

| Condition | Action |
|-----------|--------|
| Touches >3 files or unclear scope | Ask clarifying questions; optional `.agent/plan.md` |
| New feature / API change | `specs/<name>.md` then implement |
| Small fix (1–2 files) | Proceed directly |
| User says "grill me" | Questions only this turn; no write/edit/shell until answered |

## Artifacts

```
.agent/plan.md       # current task plan (agent-maintained)
specs/               # feature specs (optional)
```

## Skills (on demand)

Use `invoke_skill` for full playbooks instead of duplicating them here:

- `invoke_skill` with skill name + optional query when a trigger matches and you need the full checklist.

## Cross-session memory

User-level notes live in `.agent/memory/` (see `/memory` in TUI):

- `profile.md` / `requirements.md` — injected every run
- `archives.md` — task index only (use `grep_search` / `read_file`)

## Project notes

<!-- Add stack, conventions, test commands, paths to avoid, etc. -->