---
name: memory
description: Cross-session memory management — when and how to update profile, requirements, and archives across tasks.
---

# memory

Manage cross-session memory under `.agent/memory/`. Three files, three purposes — kept short and scannable.

## File overview

| File | Purpose | Injected into prompt? | Update style |
|------|---------|----------------------|-------------|
| `profile.md` | Who the user is, stack, style | ✅ Every turn | Overwrite (manual) |
| `requirements.md` | Hard rules the agent must follow | ✅ Every turn | Overwrite (manual) |
| `archives.md` | Task index — one line per major task | ❌ (search via `grep_search`) | Append |

## When to update

### profile.md — 手动触发

User says things like "记住我偏好 X" or "以后都用 Y 风格"。Agent should acknowledge and ask if the user wants it persisted. **Never auto-update profile without asking.**

Good triggers:
- "以后都用中文回复"
- "我喜欢简洁的回答，不要啰嗦"
- "我主要做前端，不太懂后端"

### requirements.md — 手动触发

User states a hard rule the agent must follow. **Never auto-update.** Ask first.

Good triggers:
- "以后新功能必须先写 spec"
- "绝对不要直接 force push"
- "代码里不能出现 console.log"

### archives.md — 任务完成时

After completing a major task or phase, **ask the user if they want it archived**, then append one line:

```
YYYY-MM-DD | path or topic | one-line summary
```

Format rules:
- Date must be ISO (YYYY-MM-DD)
- Topic is file/path or feature name
- Summary is one sentence, no more than 80 chars
- Use `edit_file` with `old_string` anchoring to avoid race conditions

## Cross-session awareness

At the start of each session, the agent automatically receives:

```
## Cross-session memory
### User profile
Source: .agent/memory/profile.md
...

### User requirements
Source: .agent/memory/requirements.md
...
```

The agent should **reference this memory** when making decisions — e.g., "Based on your profile, I'll keep this concise" or "Per requirements.md, I'll write a spec first."

## Slash commands (TUI)

| Command | Action |
|---------|--------|
| `/memory init` | Create `.agent/memory/` with template files |
| `/memory show` | Print all memory files |
| `/memory show profile` | Show profile.md |
| `/memory show requirements` | Show requirements.md |
| `/memory show archives` | Show archives.md |
| `/memory status` | Summary of what's populated |
| `/memory paths` | Print absolute paths to all files |

## Tips

1. **Keep it short.** Memory injected into the prompt has a ~4KB budget. Be concise.
2. **Archives are index-only.** They're not injected — use `grep_search` on `.agent/memory/` to find past tasks.
3. **One line, one task.** Don't write paragraphs in archives.md. If you need detail, reference a spec or commit.
4. **Never touch memory files without user consent** (except archives.md, where you ask before appending).
