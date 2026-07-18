# SPEC: Pointerize scope（对照型任务 vs 线性工具结果）

> **状态**: Phase 1 已落地（2026-07-18）  
> **相关**: 上下文管线 `pointerize → prune → pointer-compact → heavy` · 审查/DAG 死亡螺旋  
> **代码**: `src/pointerize.ts` · `pointerize_policy` · spawn/workflow `keep_inline_turns`

---

## 1. 问题

Pointerize 默认假设：**工具结果用过即冷**（`keep_inline_turns=2` 后变 `[action:…]`，靠 `recall_query` 取回）。

| 任务形态 | 是否匹配 |
|----------|----------|
| 线性 coding（写完忘） | 匹配 |
| 对照型审查（多条款反复看同一大材料） | **冲突** → recall 也被卡片化 → 死亡螺旋 |

User/system 消息免疫；workflow `{{slot.output}}` 注入的是 user task（免疫），但 **摘要** 不够时 reviewer 仍会 `read_file`/`recall_query`，tool 结果被滑窗没收。

---

## 2. 目标

1. **打断螺旋**：`recall_query` 默认不再 pointerize。  
2. **可配置工具策略**：`tool_overrides`（`never` / 更长 keep）。  
3. **节点/预设可覆盖** 全局 `keep_inline_turns`（reviewer 更保守）。  
4. **Phase 2+**（本文只规划）：task_soft / node_hold + 预算阀；模板 `artifact` 注入。

非目标：靠 prompt 禁 recall；全局 `keep_inline=20`。

---

## 3. 配置

### 3.1 `agent.json` → `pointerize_policy`

```jsonc
{
  "pointerize_policy": {
    "keep_inline_turns": 2,
    "tool_overrides": {
      "recall_query": { "mode": "never" },
      "read_file": { "keep_inline_turns": 6 }
    }
    // preview_* 字段不变
  }
}
```

| 字段 | 含义 |
|------|------|
| `keep_inline_turns` | 全局滑窗（默认 2） |
| `tool_overrides[tool].mode` | `default` \| `never` |
| `tool_overrides[tool].keep_inline_turns` | 该 tool 覆盖全局 keep（mode=default 时） |

### 3.2 Spawn preset / workflow role

```jsonc
// spawn_presets[] 或 workflows.roles.<name>
"keep_inline_turns": 10
```

子 agent / role 的 `AgentConfig.keepInlineTurns` 取该值（缺省继承主配置）。

### 3.3 内置默认

| Tool | 默认 |
|------|------|
| `recall_query` | **never** pointerize（即使 json 未写 override） |
| `write_file` / `edit_file` / `apply_patch` / `invoke_skill` | 已有 never |
| 其它 | 现有 `POINTER_RULES` |

---

## 4. 算法（Phase 1）

对每条候选 tool 消息：

```
if mode(tool) == never → skip
keep = override.keep_inline_turns ?? global.keep_inline_turns
if msg.turn >= currentTurn - keep → keep inline
else if shouldPointerize(tool, body) → card
```

Heavy compression / prune **不改**（压力阀仍在）。

---

## 5. 分期

| Phase | 内容 | 状态 |
|-------|------|------|
| **P1** | `tool_overrides` + recall never + preset/role `keep_inline_turns` | ✅ |
| **P2** | `task_soft` / `node_hold` + 软阈值触发加速 pointerize | 规划 |
| **P3** | 模板 `{{file:…}}` / artifact 注入 user 通道 | 规划 |

---

## 6. 验收

- [x] 大 `recall_query` 结果跨 3+ turn 仍全文在 messages（未变 action 卡）  
- [x] `read_file` 在 override keep=6 时比全局 2 更晚卡片化  
- [x] reviewer role `keep_inline_turns: 10` 生效（dag-review / review-loop）  
- [x] 线性 coding：shell/web 仍可正常 pointerize  
- [x] 现有 pointerize 单测通过  

---

## 7. 风险

| 风险 | 缓解 |
|------|------|
| recall 全文堆积 | heavy/prune；500k cap |
| 配置爆炸 | 仅 need 的 tool 写 override |
