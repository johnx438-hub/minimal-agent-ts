# Live eval notes · 2026-07-23

> **Status**: exploratory n≈1 pairs · **not** a published leaderboard  
> **Harness**: `eval/` E0–E3 · git arc includes token calibrator, `context_policy`, fingerprint fix, `tool_deny`, segmented multi_doc  
> **Model**: `deepseek-v4-pro` unless noted

---

## 1. Why record this at all?

Two product claims get challenged in the wild:

1. **“Pointerize / rewriting earlier turns into cards costs *more* tokens than keeping full tool bodies.”**  
2. **“If token savings are tiny, pointerize is pointless.”**

Today’s cleanest multi-turn pair **rejects (1) for this setup** (eager ≤ no-pointerize on hot tokens).  
On (2): **token economy is only one axis**. The main product bet remains **event-structured context** (turn markers, stable cards, cold recall) — structure that full-transcript baselines do not provide even when token counts are similar.

---

## 2. Runs worth keeping (cite these IDs)

### 2.1 Cleanest structure comparison (primary)

| Role | Strategy | Run ID | Result |
|------|----------|--------|--------|
| Treatment | `minimal_pointerize_eager` (`keep=0`, `tool_deny: [context_focus]`) | `multi_doc_01__minimal_pointerize_eager__2026-07-23T05-17-34-414Z` | success |
| Control | `minimal_no_pointerize` (`keep=200`) | `multi_doc_01__minimal_no_pointerize__2026-07-06-471Z` wait — correct: `…T05-17-06-471Z` | success |

**Task**: `multi_doc_01` **segmented** (≤2 `docs/*` reads per turn, 7 files, large distractors).  
**Aggregate**: `eval/reports/live_multi_doc_segmented.{md,json}` with `--run-ids` only (do not mix older multi_doc runs).

| Metric | Eager | No-pointerize | Δ |
|--------|------:|--------------:|---|
| turns / tools | 8 / 10 | 8 / 10 | same |
| repeat_tool_rate | 0 | 0 | — |
| hot_tokens mean | 15614.8 | 15869.6 | **−1.6%** |
| hot_tokens p95 | 23468 | 24015 | **−2.3%** |
| prompt_tokens Σ | 124918 | 126957 | **−1.6%** (~−2k) |
| compression | pointerized=1 @ T8 | 0 | structure engaged late |

**Trajectory**: both respected ≤2 docs/turn (`0→2→2→2→1` reads then answer).  
**Honest read**: same behavior length; eager **not more expensive**; modest savings; pointerize telemetry only late — **not** a large compression win, **is** a rebuttal to “cards always cost more.”

### 2.2 Harness / regression checks (secondary)

| Pair | Takeaway |
|------|----------|
| `state_chain_01` full vs no_ptr (short, ~5 turns) | Both pass; **no strategy separation** (too short) — good smoke, bad for pointerize claims |
| multi_doc pre-segment, full vs no_ptr (~4 turns, batch-read 5 files) | Both pass; ~2% noise-level gap; **batch-read hides keep-window effects** |
| eager **without** `tool_deny` | Model called `context_focus(keep=15)` → **fought** keep=0 → **more** turns/tokens — document as **anti-pattern**, fixed by `tool_deny` |
| Fingerprint bug (absolute path prefix) | Inflated `repeat_tool_rate` on no_ptr; **fixed** (trailing path segments) — ignore pre-fix repeat means |

### 2.3 Do **not** cite for product claims

- Aggregate rows that mix pre/post fingerprint, pre/post `tool_deny`, pre/post segmented task  
- n=1 percentage points as “proven X% savings”  
- Any claim that multi_doc shows LITM accuracy gap (both strategies scored 100% on script)

---

## 3. Narrative for skeptics (token cost)

**Claim you can support (narrow):**

> On a multi-turn, multi-file read task with aligned tool trajectories, a pointerize-eager policy did **not** increase API `prompt_tokens` relative to a near–full-history ablation; it was **slightly lower** (~1–2% mean/sum, n=1).

**Claim you should not support yet:**

> Pointerize always saves large fractions of tokens / always wins long-horizon accuracy.

**Bridge to product:**

Even when token totals are close, the hot path under pointerize is a **timeline of events** (turn, tool, preview, `action_id`), not an undifferentiated paste of tool dumps — that is the **event position encoding** story in the README, independent of a large compression delta.

---

## 4. Main advantage stack (priority)

| Priority | Advantage | Evidence today |
|----------|-----------|----------------|
| **P0** | **Event structure** — turn-marked cards, stable prefix shape, cold `recall_query` | Design + qualitative trajectory; not a numeric “structure score” yet |
| **P1** | **Not more expensive** than full-inline on aligned multi_doc pair | §2.1 |
| **P2** | **Large token funnel** under heavy pressure | **Not shown** on this task (little early pointerize) |
| **P3** | **Accuracy under Lost-in-the-Middle** | Both strategies passed gold `score.sh` — need harder probes / longer horizon |

---

## 5. Method hygiene (so future notes stay clean)

1. Prefer `--run-ids a,b` for any public table.  
2. After harness changes (fingerprint, deny, task text), **new run IDs only**.  
3. Report model, strategy JSON id, `git_sha` from manifest.  
4. Separately log: structure metrics later (e.g. pointer density, prefix hash stability) if you want numbers for P0.

---

## 6. One-paragraph blurb (Chinese, for deck / issue)

> 2026-07-23 live：在分段 multi_doc（每 turn ≤2 文档、7 文件大 distractor）上，`minimal_pointerize_eager`（keep=0 且 deny `context_focus`）与 `minimal_no_pointerize` 同为 8 turn、10 tool、题面全对。热路径 mean/p95/累计 prompt 上 eager **略低约 1.6–2.3%**，**未**出现「指针化改前文反而更费 token」的证据；但 n=1 且 pointerize 触发偏晚，**不能**写成大幅省 token。产品主叙事仍是 **事件结构化上下文**（时间线卡片 + 冷召回），token 经济是附带、且在本任务上呈小幅正向。

---

## 7. Reproduce

```bash
# Re-run (costs API)
npm run eval:run -- --task multi_doc_01 --strategy minimal_pointerize_eager --max-turns 50
npm run eval:run -- --task multi_doc_01 --strategy minimal_no_pointerize --max-turns 50

# Table only these IDs
npm run eval:aggregate -- --no-dry-run \
  --run-ids multi_doc_01__minimal_pointerize_eager__2026-07-23T05-17-34-414Z,multi_doc_01__minimal_no_pointerize__2026-07-23T05-17-06-471Z \
  --out-name live_multi_doc_segmented
```
