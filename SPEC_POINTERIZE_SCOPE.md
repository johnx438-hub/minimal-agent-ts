# SPEC: Pointerize scope（对照型任务 vs 线性工具结果）

> **状态**: Phase 1 ✅ · Phase 2 ✅（2026-07-18）  
> **相关**: 上下文管线 `pointerize → prune → pointer-compact → heavy` · 审查/DAG 死亡螺旋  
> **代码**: `src/pointerize.ts` · `context_focus` · spawn/workflow `pointerize_mode`

---

## 1. 问题

Pointerize 默认假设：**工具结果用过即冷**（`keep_inline_turns=2` 后变 `[action:…]`，靠 `recall_query` 取回）。

| 任务形态 | 是否匹配 |
|----------|----------|
| 线性 coding（写完忘） | 匹配 |
| 对照型审查（多条款反复看同一大材料） | **冲突** → 死亡螺旋 |

User/system 免疫；workflow 模板注入为 user。螺旋真源是 **tool / recall 结果** 被滑窗没收。

---

## 2. 目标

**P1**（已做）  
1. `recall_query` 默认 never pointerize  
2. `tool_overrides`  
3. preset/role `keep_inline_turns`

**P2**（本阶段）— **主/子分流**  

| 角色 | 接口 |
|------|------|
| **子 agent / workflow 节点** | 配置 `pointerize_mode: "hold" \| "window"`（节点内 hold） |
| **主 agent** | 显式 tool **`context_focus`**：临时提高 keep 窗口 |

两者均受 **预算压力阀** 约束：上下文过高时强制走 window pointerize。

**P3**（规划）模板 artifact / `{{file:…}}` 注入 user。

非目标：仅靠正则猜「在审查」；主 agent 全局永久 hold。

---

## 3. Phase 1 配置（摘要）

### 3.1 `pointerize_policy`

```jsonc
{
  "keep_inline_turns": 2,
  "tool_overrides": {
    "recall_query": { "mode": "never" },
    "read_file": { "keep_inline_turns": 6 }
  },
  "soft_force_ratio": 0.75
}
```

| 字段 | 含义 |
|------|------|
| `keep_inline_turns` | 全局滑窗（默认 2） |
| `tool_overrides[tool].mode` | `default` \| `never` |
| `tool_overrides[tool].keep_inline_turns` | 该 tool 覆盖全局 keep |
| `soft_force_ratio` | **P2**：`estimateTokens > ratio × usable` 时强制 pointerize（即使 hold / focus）。默认 `0.75` |

### 3.2 Spawn / workflow

```jsonc
"keep_inline_turns": 10,
"pointerize_mode": "hold"   // P2: hold | window（默认 window）
```

---

## 4. Phase 2 接口

### 4.1 子 agent / 节点：`pointerize_mode`

| 值 | 行为 |
|----|------|
| `window`（默认） | 现有滑窗 + tool_overrides |
| `hold` | **节点/子 agent 内不 pointerize**，直到压力阀触发 |

算法：

```
if mode == hold && !force_by_budget → return 0（本 stage 不卡片化）
else → Phase 1 window 算法
```

`force_by_budget`：

```
estimateTokens(messages) > soft_force_ratio * usableContextTokens(budget)
```

配置落点：

- `spawn_presets[].pointerize_mode`
- `workflows.roles.<name>.pointerize_mode`
- 解析进 `AgentConfig.pointerizeMode` / `ResolvedSpawnPreset` / `ResolvedWorkflowRole`

推荐：reviewer 类 role → `"hold"`（或保持高 `keep_inline_turns`）。

### 4.2 主 agent：`context_focus` tool

**用途**：声明「接下来若干 turn 要对照大材料」，临时抬高 keep（可选限定 tools）。

```jsonc
// tool parameters
{
  "keep_inline_turns": 12,   // default 12, hard cap 20
  "ttl_turns": 8,            // default 8, hard cap 30
  "tools": ["read_file", "grep_search", "diff_file"],  // optional; omit = all tools use raised keep
  "reason": "multi-clause review",
  "clear": false             // true → 取消当前 focus
}
```

**Runtime 状态**（挂在 `AgentConfig`，随 run 可变）：

```ts
pointerizeFocus?: {
  keepInlineTurns: number;
  remainingTurns: number;
  tools?: string[];
  reason?: string;
}
```

**生效**（window 模式下）：

```
keep(tool) = max(
  tool_override_keep ?? global_keep,
  focus.active && tool_allowed ? focus.keepInlineTurns : 0
)
focus.remainingTurns -= 1 after each turn-end pointerize stage
remainingTurns <= 0 → clear focus
```

**压力阀**：`force_by_budget` 时 **忽略 focus**（仍 pointerize），并可缩短 remaining。

**权限**：仅主 agent（`spawnDepth === 0`）；子 agent 调用返回 error。

**System**：不堆长文；tool description 写清用途即可。

---

## 5. 算法总览

```
runPointerizeStage(ctx):
  force = tokens > soft_force_ratio * usable(budget)
  if pointerizeMode == hold && !force:
    return 0
  // window (+ optional context_focus keep boost)
  for each tool msg:
    if mode(tool)==never: skip
    keep = resolveKeep(tool, global, overrides, focus)
    if turn too recent: skip
    if shouldPointerize: card
  if focus: focus.remainingTurns--
```

Heavy / prune 不变。

---

## 6. 分期状态

| Phase | 内容 | 状态 |
|-------|------|------|
| **P1** | tool_overrides + recall never + keep_inline_turns | ✅ |
| **P2a** | `pointerize_mode` hold/window + soft_force_ratio | ✅ |
| **P2b** | `context_focus` tool | ✅ |
| **P3** | 模板 artifact / file 注入 | 规划 |

---

## 7. 验收

### P1（已过）

- [x] recall 不卡片化  
- [x] read_file keep override  
- [x] reviewer keep=10  

### P2

- [x] hold 模式跳过 pointerize（除非 force）  
- [x] soft_force_ratio 预算阀  
- [x] `context_focus` 提高 keep + ttl  
- [x] 子 agent 调 `context_focus` → error  
- [x] 默认 window 行为保持  


---

## 8. 风险

| 风险 | 缓解 |
|------|------|
| hold/focus 堆上下文 | soft_force_ratio + MAX_CONTEXT_TOKENS + heavy |
| 模型滥用 context_focus | cap keep≤20、ttl≤30；仅主 agent |
| 配置爆炸 | reviewer 用 hold；主用 tool 按需 |
