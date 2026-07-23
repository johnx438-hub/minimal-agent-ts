# SPEC: Context policy（魔法数字 → `agent.json`）

> **状态**: **C1–C4 ✅**（类型/loader · runtime 接线 · calibrator · 示例文档）  
> **日期**: 2026-07-23  
> **相关**: [SPEC_CONTEXT_MANAGEMENT.md](./SPEC_CONTEXT_MANAGEMENT.md) · [SPEC_POINTERIZE_SCOPE.md](./SPEC_POINTERIZE_SCOPE.md) · token 自校准 `src/context/token-calibrator.ts` · [docs/EVAL_LITM.md](./docs/EVAL_LITM.md)  
> **代码**: `policy-config.ts` · `budget.ts` · pipeline · `agent.ts` · `runner.buildAgentConfig`  
> **模板**: [agent.context.example.json](./agent.context.example.json) · [QUICKSTART.md](./QUICKSTART.md) §6.1

---

## 1. 问题

上下文生命周期（pointerize → prune → pointer-compact → heavy compression → resume）依赖大量**源码常量**。部分已进入 `agent.json`（如 `pointerize_policy`），其余仍散落在 `budget.ts` / `estimate.ts` / `prune.ts` / `token-calibrator.ts` 等。

| 痛点 | 说明 |
|------|------|
| 调参要改代码 | 压测「更早压缩 / 更大保护窗」需 PR，不利于 demo 与 eval 网格 |
| 默认值语义不集中 | 新人难对照「旋钮全表」 |
| 与校准 / eval 脱节 | #1 EWMA 校准与 #3 EVAL 需要**可声明**的 budget 变体，而不是 fork 分支 |

**已完成（不在本 SPEC 实现范围，但为本 SPEC 输入）**：

- Session EWMA 自校准：`TokenCalibrator`（`prompt_tokens / local estimate`，默认 scale=1）
- `pointerize_policy` / `soft_force_ratio` 已可配（见 SPEC_POINTERIZE_SCOPE）

---

## 2. 目标

1. 将**影响上下文预算与生命周期**的阈值，收编为 `agent.json` 可选块 **`context_policy`**。  
2. **缺省字段 = 当前硬编码默认**（omit 时行为 bit-identical）。  
3. Loader **merge + clamp**；非法值回落 default，可选 warn。  
4. 与现有 **`pointerize_policy`** 并列：不吞掉已稳定的 pointer 配置。  
5. 为 EVAL_LITM / 现场调参提供**同一配置面**。

### 2.1 非目标

| 不做 | 原因 |
|------|------|
| TUI / Web UI 节流、滚动阈值 | 非 agent 策略；属 UI |
| 每 turn 动态改 policy（除已有 `context_focus`） | 复杂度；本 SPEC 为**加载时静态** |
| 强制暴露 `CHARS_PER_TOKEN` 为日常旋钮 | 换尺子会破坏测试与阈值语义；仅 advanced 可选 |
| GUI Settings 在线编辑全部 knobs | 可后续；本 SPEC 只定 schema + 运行时接线 |
| 密钥 / 路径类配置 | 已有 `api_key_env` 等模式，勿混入 |
| 持久化 EWMA scale 到 session JSON | 属校准 P1+；本 SPEC 只配 **校准器超参** |

---

## 3. 常量清单（真源对照表）

实现前以本表为 checklist；实现后代码 default 必须与「默认值」列一致。

### 3.1 预算分层 — `src/context/budget.ts`

| 常量 / 语义 | 默认值 | 建议配置路径 | 备注 |
|-------------|--------|--------------|------|
| `DEFAULT_BUDGET.total` | `200_000` | **不**进 policy 覆盖 total | 优先 model map / `MAX_CONTEXT_TOKENS` |
| `system_pct` | `0.05` | `context_policy.budget.system_pct` | |
| `current_pct` | `0.1` | `…budget.current_pct` | |
| `recent_pct` | `0.4` | `…budget.recent_pct` | |
| `mid_pct` | `0.35` | `…budget.mid_pct` | |
| `early_pct` | `0.1` | `…budget.early_pct` | |
| `recent_max_tokens` | `80_000` | `…budget.recent_max_tokens` | `createBudgetConfig` 仍可按 total 抬升 |
| `mid_max_summaries` | `20` | `…budget.mid_max_summaries` | |
| `FIRST_HEAVY_COMPRESSION_RATIO` | `0.8` | `context_policy.heavy_compression.first_ratio` | 相对 **usable** |
| `REPEAT_HEAVY_COMPRESSION_RATIO` | `0.9` | `…heavy_compression.repeat_ratio` | 滞回 |
| `CHARS_PER_TOKEN` | `1.8` | `context_policy.estimate.chars_per_token`（**advanced**） | 默认不写文档示例 |
| `MIN_RESUME_HISTORY_TOKENS` | `4_000` | `context_policy.resume.min_history_tokens` | 可选 P1 |

### 3.2 保护窗 / 估算刻度 — `src/context/estimate.ts`

| 常量 | 默认值 | 建议配置路径 | 备注 |
|------|--------|--------------|------|
| `ESTIMATE_SCALE_VS_LEGACY` | `3.5` | **不配**（文档说明即可） | 历史 whitespace→char 换算；非运行时旋钮 |
| `PROTECT_RECENT_TOKENS` | `round(40_000 * 3.5)` = `140_000` | `context_policy.protect.recent_tokens` | 决策用 **raw** estimate（不乘 calibrator scale） |
| `PROTECT_USER_TURNS` | `2` | `context_policy.protect.user_turns` | |

### 3.3 Prune / pointer-compact

| 常量 | 文件 | 默认值 | 建议配置路径 |
|------|------|--------|--------------|
| `PRUNE_MIN_SAVINGS` | `prune.ts` | `70_000` | `context_policy.prune.min_savings_tokens` |
| `MAX_POINTER_COMPACT_PER_TURN` | `pointer-compact.ts` | `20` | `context_policy.prune.max_pointer_compact_per_turn` |

### 3.4 Token 自校准 — `src/context/token-calibrator.ts`（#1 已实现）

| 常量 | 默认值 | 建议配置路径 |
|------|--------|--------------|
| `DEFAULT_CALIBRATOR_ALPHA` | `0.3` | `context_policy.token_calibrator.alpha` |
| `DEFAULT_SCALE_MIN` | `0.5` | `…scale_min` |
| `DEFAULT_SCALE_MAX` | `2.0` | `…scale_max` |
| `DEFAULT_MIN_RAW` | `256` | `…min_raw` |

运行时：`TokenCalibrator` 仍为 **session 内存**；policy 只影响构造参数。`DEBUG_TOKEN_CAL=1` 保持 env。

### 3.5 已有配置（本 SPEC **不迁移**，只交叉引用）

| 块 | 路径 | SPEC |
|----|------|------|
| Pointerize | `pointerize_policy` | SPEC_POINTERIZE_SCOPE |
| Recall | `recall_policy.auto_full_max_chars` | tools / context |
| Spawn | `spawn_policy` | 工具与 shell |
| Web | `web_fetch_policy` / `web_search` | SPEC_TOOLS 等 |
| Vision | `vision.*` | SPEC_VISION |

`soft_force_ratio` **留在** `pointerize_policy`（已有 loader 与测试）。

### 3.6 明确排除（不进 `context_policy`）

| 项 | 位置 | 原因 |
|----|------|------|
| `DEFAULT_TOKEN_THROTTLE_MS` | bridge / TUI | UI |
| Near-bottom scroll px | minimal-gui | UI |
| Shell fail max lines / preview UI | display | 展示层 |
| Loop `hardCeiling` 默认 200 | `loop-guard` / `LOOP_HARD_CEILING` env | 已有 env；可另开 `loop_policy`（**非本 SPEC 必须**） |
| Model context limit 表 | `MODEL_CONTEXT_LIMITS` | 用 env / 映射表，不是 session 策略旋钮 |

---

## 4. 配置 Schema

### 4.1 顶层

```jsonc
// agent.json（片段）
{
  "pointerize_policy": {
    "keep_inline_turns": 2,
    "soft_force_ratio": 0.75
    // …现有字段不变
  },
  "context_policy": {
    "budget": { /* §4.2 */ },
    "heavy_compression": { /* §4.3 */ },
    "protect": { /* §4.4 */ },
    "prune": { /* §4.5 */ },
    "token_calibrator": { /* §4.6 */ },
    "estimate": { /* §4.7 advanced */ },
    "resume": { /* §4.8 optional */ }
  }
}
```

### 4.2 `context_policy.budget`

| 字段 | 类型 | 默认 | Clamp（建议） |
|------|------|------|----------------|
| `system_pct` | number | `0.05` | `(0, 0.3]` |
| `current_pct` | number | `0.1` | `(0, 0.4]` |
| `recent_pct` | number | `0.4` | `(0, 0.8]` |
| `mid_pct` | number | `0.35` | `(0, 0.8]` |
| `early_pct` | number | `0.1` | `(0, 0.5]` |
| `recent_max_tokens` | number | `80000` | `≥ 1000` |
| `mid_max_summaries` | number | `20` | `[1, 200]` |

**不要求** pct 之和 = 1（与今日 `DEFAULT_BUDGET` 一致：分层独立 cap，非严格分区）。

`createBudgetConfig(model, contextPolicy?)`：

```
total = getMaxContextTokens(model)   // 不变
budget = { ...DEFAULT_BUDGET, ...policy.budget, total }
recent_max_tokens = max(policy.recent_max_tokens ?? default, floor(total * recent_pct))
```

### 4.3 `context_policy.heavy_compression`

| 字段 | 默认 | Clamp |
|------|------|-------|
| `first_ratio` | `0.8` | `[0.5, 0.95]` |
| `repeat_ratio` | `0.9` | `[first_ratio, 0.98]` |

语义不变：相对 `usableContextTokens(budget)`。

### 4.4 `context_policy.protect`

| 字段 | 默认 | Clamp |
|------|------|-------|
| `recent_tokens` | `140000` | `≥ 1000` |
| `user_turns` | `2` | `[0, 20]` |

**注意**：保护窗累加使用 **未校准** `estimateTokens`（与 #1 设计一致：避免 scale 双边抵消/扭曲）。

### 4.5 `context_policy.prune`

| 字段 | 默认 | Clamp |
|------|------|-------|
| `min_savings_tokens` | `70000` | `≥ 0` |
| `max_pointer_compact_per_turn` | `20` | `[1, 200]` |

### 4.6 `context_policy.token_calibrator`

| 字段 | 默认 | Clamp |
|------|------|-------|
| `alpha` | `0.3` | `[0, 1]` |
| `scale_min` | `0.5` | `(0, 1]` |
| `scale_max` | `2.0` | `[1, 4]` 且 `≥ scale_min` |
| `min_raw` | `256` | `≥ 1` |

`runAgent`：

```
new TokenCalibrator(pluginConfig.context_policy?.token_calibrator)
// 或 config.tokenCalibrator 注入优先（测试）
```

### 4.7 `context_policy.estimate`（advanced，可选实现）

| 字段 | 默认 | 说明 |
|------|------|------|
| `chars_per_token` | `1.8` | 改动影响所有 filler 测试与阈值；**文档标 advanced** |

Phase 1 实现可 **跳过** 本段，仅在常量清单保留。

### 4.8 `context_policy.resume`（P1）

| 字段 | 默认 | 说明 |
|------|------|------|
| `min_history_tokens` | `4000` | `resumeHistoryBudget` 下限 |
| `apply_calibrator` | `false` → 未来 `true` | resume `shouldCompress` / history 切片是否 `cal.apply`（#1b） |

---

## 5. 类型与加载（实现约定）

### 5.1 TypeScript

```ts
// plugins/types.ts（示意）
export interface ContextBudgetPolicy { /* §4.2 */ }
export interface ContextHeavyCompressionPolicy { /* §4.3 */ }
export interface ContextProtectPolicy { /* §4.4 */ }
export interface ContextPrunePolicy { /* §4.5 */ }
export interface ContextTokenCalibratorPolicy { /* §4.6 */ }
export interface ContextEstimatePolicy { /* §4.7 */ }
export interface ContextResumePolicy { /* §4.8 */ }

export interface ContextPolicy {
  budget?: ContextBudgetPolicy;
  heavy_compression?: ContextHeavyCompressionPolicy;
  protect?: ContextProtectPolicy;
  prune?: ContextPrunePolicy;
  token_calibrator?: ContextTokenCalibratorPolicy;
  estimate?: ContextEstimatePolicy;
  resume?: ContextResumePolicy;
}

// AgentPluginConfig
context_policy?: ContextPolicy;
```

### 5.2 Loader

- `defaultAgentPluginConfig()`：**可不**填满 `context_policy`（代码常量作 fallback），或填完整 default 便于 introspection。  
- `mergeConfig`：浅合并各子对象（同 `pointerize_policy`）。  
- `normalizeContextPolicy(raw): ResolvedContextPolicy`：clamp + 填默认；单测覆盖。

### 5.3 运行时注入路径

```
loadAgentPluginConfig(cwd)
  → pluginConfig.context_policy
  → runner 构建 AgentConfig / BudgetConfig / TokenCalibrator
  → TurnContext { budget, calibrator, … }
  → heavy / prune / pointer-compact / soft_force（soft_force 仍读 pointerize_policy）
```

**不要**用全局可变单例改 `CHARS_PER_TOKEN` 模块常量（测试并行不安全）。优先：

- `createBudgetConfig(model, resolved)` 返回带阈值的闭包数据；或  
- `ResolvedContextPolicy` 显式传入 `shouldRunHeavyCompression(tokens, budget, isRepeat, ratios)`。

### 5.4 优先级

```
显式 AgentConfig / 测试注入
  > agent.json context_policy（cwd → ~/.minimal-agent/agent.json merge）
  > 源码 DEFAULT_* 常量
```

Env 覆盖（可选，P2）：

| Env | 映射 |
|-----|------|
| `DEBUG_TOKEN_CAL` | 已有日志开关 |
| `MAX_CONTEXT_TOKENS` | 已有 total 上限 |
| （可选）`TOKEN_CAL_ALPHA` | 覆盖 alpha；**弱于** agent.json 或强于？→ 建议 **env 仅 debug，policy 优先** |

---

## 6. 与相邻系统的关系

```
                    agent.json
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
 pointerize_policy  context_policy   spawn / web / …
         │               │
         │    ┌──────────┼──────────┐
         │    ▼          ▼          ▼
         │  budget    protect    token_calibrator
         │  heavy     prune      (EWMA hyperparams)
         │    │          │          │
         └────┴──────────┴──────────┘
                    │
         estimateTokens (raw) ──► × scale ──► 阈值比较
                    │                 ▲
                    │                 │
                    └──── llm_done.prompt_tokens ──┘
```

| 系统 | 关系 |
|------|------|
| **#1 TokenCalibrator** | policy 配超参；scale 仍 runtime 学 |
| **Pointerize soft_force** | 阈值用 calibrator.apply(estimate)；ratio 在 `pointerize_policy` |
| **EVAL_LITM** | fixture 旁挂不同 `context_policy` 扫压缩时机 |
| **AgentRuntime 拆分** | 本 SPEC 只依赖 config-loader + context；不要求 Runtime 拆完 |

---

## 7. 实现阶段

| Phase | 内容 | 验收 |
|-------|------|------|
| **C0** | 本 SPEC + 清单冻结 | 文档合并 ✅ |
| **C1** | `ContextPolicy` 类型 + `normalize` + merge + 单测 clamp | omit ≡ 旧默认 ✅ |
| **C2** | `createBudgetConfig` + heavy ratios + protect/prune 接线 | 改 agent.json 可改变阈值（集成测） ✅ |
| **C3** | `token_calibrator` 子块 → `new TokenCalibrator(opts)` | 改 alpha 可测 EWMA ✅（C2 已接线；example `fast_calibrator`） |
| **C4** | `agent.context.example.json` + QUICKSTART / SPEC_CONTEXT_MANAGEMENT 交叉链接 | 可复制片段 ✅ |
| **C5**（可选） | `resume.apply_calibrator` + `min_history_tokens` | #1b |
| **C6**（可选） | advanced `chars_per_token` | 强文档警告 |

**不阻塞** C1–C3 与 EVAL_LITM 并行。

---

## 8. 验收标准

1. **空 `context_policy` / 省略**：现有 context / compression / pointer 测试全绿，行为与 C0 前一致。  
2. 仅提高 `heavy_compression.first_ratio` 到 `0.95`：同等 messages 下 heavy **更晚**触发。  
3. 仅降低 `first_ratio` 到 `0.5`：heavy **更早**触发。  
4. `token_calibrator.alpha = 1` + 一次 observe：scale 立即贴 sample（在 clamp 内）。  
5. 非法 JSON 字段（如 `first_ratio: 2`）被 clamp，不抛未捕获异常。  
6. `pointerize_policy` 现有字段与测试不受破坏。

---

## 9. 示例片段（文档 / example 文件用）

```jsonc
// agent.context.example.json — 说明用，非仓库默认强制
{
  "context_policy": {
    "heavy_compression": {
      "first_ratio": 0.8,
      "repeat_ratio": 0.9
    },
    "protect": {
      "recent_tokens": 140000,
      "user_turns": 2
    },
    "prune": {
      "min_savings_tokens": 70000,
      "max_pointer_compact_per_turn": 20
    },
    "token_calibrator": {
      "alpha": 0.3,
      "scale_min": 0.5,
      "scale_max": 2.0,
      "min_raw": 256
    }
  },
  "pointerize_policy": {
    "keep_inline_turns": 2,
    "soft_force_ratio": 0.75
  }
}
```

**激进压缩**（eval / 小窗模型试验）：

```jsonc
{
  "context_policy": {
    "heavy_compression": { "first_ratio": 0.55, "repeat_ratio": 0.7 },
    "protect": { "recent_tokens": 40000, "user_turns": 1 },
    "prune": { "min_savings_tokens": 20000 }
  }
}
```

---

## 10. 测试计划（实现时）

| 测例 | 断言 |
|------|------|
| `normalizeContextPolicy(undefined)` | 等于代码 DEFAULT 快照 |
| clamp `first_ratio: 1.5` → `0.95` | |
| `mergeConfig` 部分 patch | 未给字段保留 base/default |
| wire: heavy 阈值随 policy | 同 `token-calibrator-wire` 风格 |
| 回归：无 policy 的 context-pipeline / compression / prune | 全绿 |

---

## 11. 文档交叉链接（实现 C4 时）

- [SPEC_CONTEXT_MANAGEMENT.md](./SPEC_CONTEXT_MANAGEMENT.md)：Phase 配置表增加 `context_policy` 一行  
- [QUICKSTART.md](./QUICKSTART.md)：可选「上下文旋钮」链到本 SPEC  
- [docs/EVAL_LITM.md](./docs/EVAL_LITM.md)：指标跑法可引用 policy 网格  
- [docs/ROADMAP.md](./docs/ROADMAP.md)： backlog 项「Context policy knobs」

---

## 12. 修订记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-23 | v0.1 | 初稿：清单 + schema + 阶段；对齐 #1 TokenCalibrator 与 pointerize_policy |
| 2026-07-23 | v0.2 | C1：types + `policy-config` normalize/merge；loader deep-merge；默认从 hardcode 导入 |
| 2026-07-23 | v0.3 | C2：BudgetConfig heavy/resume 字段；pipeline/agent/runner 消费 ResolvedContextPolicy |
| 2026-07-23 | v0.4 | C3/C4：`agent.context.example.json`、QUICKSTART §6.1、SPEC 交叉链接、example 单测 |
