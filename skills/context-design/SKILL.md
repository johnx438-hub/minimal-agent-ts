---
name: context-design
description: Guidance for Phase 2 context management (pointerize, recall, prune)
---

When working on context management in minimal-agent-ts:

1. **Hot path** messages should stay lean; large tool results become `[action:…]` cards.
2. Use **recall_query(action_id=...)** to pull cold-storage details; default `head_tail` slicing.
3. **Prune** marks `compacted_at` on old tool/assistant messages; data remains in session JSON.
4. **invoke_skill** is for procedural guidance; **recall_query** is for historical tool output.
5. Prefer frozen summaries (`[Task …]`) over rewriting old messages.