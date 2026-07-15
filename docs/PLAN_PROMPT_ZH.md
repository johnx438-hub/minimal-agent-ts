# 提示词中文化计划（演示可观测性）

> **目的**：周一对外演示时，主 Agent / spawn 子 Agent / workflow 角色的**身份与职责**以中文可读，便于旁观理解「谁在干什么」。  
> **原则（最小化，2026-07-16 约定）**：只译 **「你是谁 / 负责什么 / 行为边界」**；**协议、工具用法、核心约束（含负反馈）保持英文**；行业词如 bug / issue / quality **不硬译**。  
> **状态**：口径已定 · 未大规模开工。

---

## 0. 最小中文化口径（权威）

### 0.1 译什么（中文）

| 类型 | 例子 |
|------|------|
| 身份句 | 「你是 workflow 里的 **planner**，只做计划、不实现。」 |
| 职责 / 边界 | 「不要改代码」「以 plan 为真源」「验收、不重做」 |
| 旁观向行为描述 | 「探索后给出编号计划」「结束时说明 Done / 如何验证」 |
| UI 向短 description | spawn 列表里一句话是干什么的（可选中英混排） |

### 0.2 不译什么（英文保留）

| 类型 | 例子 | 原因 |
|------|------|------|
| 工具名与调用法 | `read_file`、`workflow_handoff(kind=plan)` | API / schema 英文 |
| 协议与枚举 | `verdict`: `approved` \| `needs_revision` \| `needs_human` | 分支解析 |
| 模板与 slot | `{{user_task}}`、`{{plan.output}}` | 运行时 |
| **核心规则 / 负反馈** | envelope 里 handoff success criteria、burn max_turns、parent preserved | 约束要稳、少歧义 |
| 领域常见英文词 | bug、issue、quality、security、diff、LGTM | 中文语境已通用 |
| 工具 schema 长说明 | `src/tools/**` description | 演示非必须，改动面大 |

### 0.3 混排模板（推荐写法）

```text
你是多角色 workflow 中的 **planner**（只规划、不实现）。
- 用只读工具探索；产出编号 plan（paths / steps / verify）。
- Do NOT implement or claim the task is done.
- Handoff: prefer workflow_handoff(kind=plan); final message also counts.
- verdict / tool names stay English as required by the runner.
```

即：**中文讲角色，英文钉契约**。

### 0.4 对 LLM / 子 Agent 的风险（结论：可控）

| 担心 | 实际 |
|------|------|
| 中英混排会不会乱 | 常见且稳；模型对「中文 instruction + 英文 identifier」很熟 |
| 输出会不会全变中文 | **主要由 user_task 语言驱动**；system 中英混不强迫输出语言 |
| 子 Agent / workflow 更特殊？ | 特殊在 **冷启动 + 无父会话**，更依赖本步 system/input；因此 **契约段保持英文** 比「全文中文」更安全 |
| 负反馈改中文会不会变软 | 可能；故 **envelope / 硬停止条件保持英文**（你的选择正确） |
| verdict 被写成中文 | 低～中；中文职责旁保留英文枚举 + 现有 normalize 可兜一点 |
| 工具用法改中文 | 易和 schema 英文描述不一致 → **不改** |

**理论**：LLM 会随用户输入切换叙述语言；workflow/spawn 的「特殊」主要是 **上下文隔离**，不是「必须全中文才能懂」。最小化混排对演示可观测性足够，对执行契约更稳。

---

## 1. 范围地图（按最小口径）

| 层 | 位置 | 演示 | 改动 |
|----|------|------|------|
| **主 Agent system** | `buildSystemPrompt` | ✅ | 身份/行为句中文；工具列表与 guidance **英文可留** |
| **Workflow 信封** | `envelope.ts` | ✅ | **默认保持英文**（核心规则）；仅可给 duty 一行中文身份（可选） |
| **Workflow 角色人设** | `roles/*.md` | ✅ | 身份/职责中文；handoff/verdict/工具 **英文** |
| **Workflow 步骤 input** | `workflows/*.json` | ✅ | Role 合同中文一句 + 英文约束 bullet |
| **Spawn 预设** | `agents/*.md` | ✅ | 同上最小混排 |
| **Fallback** | `agent-profile.ts` | 中 | 短中文身份 + 英文 complete task |
| **Handback 给人看** | `handback.ts` | 中 | 可中文（用户 UI）；reason 枚举英文 |
| **工具 schema** | `src/tools/**` | — | ❌ 本阶段不动 |
| **协议字段** | verdict / tool names | — | ❌ 不译 |

**硬约束**

1. 工具名、verdict 枚举、`{{…}}` 永不改成中文取值。  
2. Envelope 负反馈 / success criteria **优先全文英文**（与「核心规则不译」一致）。  
3. 不碰主 system 注入路径（envelope 仍只进 role）。

---

## 2. 策略

| 方案 | 说明 |
|------|------|
| **A′. 最小混排（推荐）** | 就地改 md/短句：中文职责 + 英文契约；不建 locale 双文件 |
| B. 全量中文 | 不推荐演示周：契约漂移风险↑、工作量↑ |
| C. locale 开关 | 演示后再说 |

不上一上来做 B/C。

---

## 3. 工作量粗估（正文量级）

| 批次 | 内容 | 约量 |
|------|------|------|
| S0 | 清单 + 本文件 + 验收口径 | 0.5h |
| S1 | 主 system + envelope + handoff 工具描述 | ~1–2 屏代码字符串 |
| S2 | `roles/*` + `workflows/*` input | ~3 个 md + 2 个 json |
| S3 | 演示用 spawn：`dev-worker` / `skeleton-reader` /（可选）三个 code-review | ~4–7 个 md |
| S4 | 其余 spawn + agent.json description | 剩余 md + json 描述 |
| S5 | handback/digest 用户可见中文 + 单测字符串断言更新 | 小 |
| S6 | （可选）高频工具 description | 中 |

**演示最小集 = S1 + S2 + S3 的 dev-worker**（能讲清主 / 子 / workflow 三层即可）。

---

## 4. 分步执行（每步可合并、可演示）

### S0 — 冻结口径（开工前 30 分钟）

- [ ] 确认演示脚本：例如「主 Agent 聊两句 → spawn 一次 → `/workflow` dag-review 跑完」。  
- [ ] 确认 **不译** 清单（§1）给所有改提示的人。  
- [ ] 开 checklist issue / 本文件勾选；**禁止**顺手大改逻辑。

### S1 — 主 Agent 身份句（可选、小）

| 文件 | 动作 |
|------|------|
| `src/agent-prompt.ts` | 仅「You are a minimal coding assistant…」类身份/行为 → 中文；**工具 bullet 保持英文** |
| `src/agent-profile.ts` | fallback 身份半句中文即可 |
| `src/workflow/envelope.ts` | **默认不改**（核心规则英文）；若演示要一眼看懂角色，最多给 duty 一行中文前缀 |
| `handoff-tool` description | **默认不改**（工具协议英文） |

**验收**：主对话人设中文可读；工具行为与现网一致。

### S2 — Workflow 演示路径（优先）

| 文件 | 动作 |
|------|------|
| `roles/*.md` | 身份/职责中文；Scope 里工具与 handoff **英文保留** |
| `workflows/*.json` `input` | 中文 Role 一句 + 英文 Do NOT / Prefer / verdict 行 |

**验收**：旁观能听懂三角色分工；`verdict` 与 handoff 仍稳定。

### S3 — Spawn 演示路径

| 优先 | 动作 |
|------|------|
| `dev-worker.md` 等 | 开篇 You are… → 中文身份；Capabilities / Hard limits / Workflow 步骤里工具法 **英文** |
| `agent.json` description | 列表用中文短句（可夹 bug/quality） |

**验收**：spawn 行为不漂；列表可读。

### S4–S5 — 扫尾

- 其余 agents 按需同一混排  
- handback **给人看**的段落可中文  
- 测试：只改「我们主动译掉」的断言；**envelope 英文断言尽量不动**

### S6 — 不做（除非明确要）

- 工具 schema 全文中文  
- skills 全译  
- locale 双文件  

---

## 5. 执行规范

1. **只动身份/职责句**，不动协议段。  
2. 角色名可「规划员 planner」一次，后文 planner 即可。  
3. bug / issue / quality / security / diff **不硬译**。  
4. 禁止中文 verdict 取值。  
5. Commit：`i18n(prompts): minimal role blurbs for demo`。

### 对照（最小混排）

| 部分 | 语言 |
|------|------|
| 你是 **planner**，只出 plan、不实现 | 中文 |
| Do NOT call write tools. Prefer `workflow_handoff(kind=plan)`. | 英文 |
| End with `verdict`: `approved` \| `needs_revision` \| `needs_human` | 英文 |
| 检查 logic bug、error handling | 中英：中文动词 + 英文名词 |

---

## 6. 建议演示周排期（示例）

| 时间 | 步骤 |
|------|------|
| 开工半天 | S0 + S1 |
| 同日或次日 | S2（workflow 全程中文可讲） |
| 再半天 | S3 dev-worker + 一条 spawn 演示 |
| 缓冲 | S4/S5 扫尾与回归 |
| 周一 | 固定脚本彩排；不新开翻译 |

---

## 7. 风险

| 风险 | 缓解 |
|------|------|
| 模型偶发把 verdict 写成中文 | 角色 md + envelope 反复强调枚举英文；解析侧已 normalize 少量变体 |
| 单测脆匹配英文 | 每步改测试，避免整包最后才跑 |
| 译走样导致角色又「各自开干」 | S2 重点人工读 plan/impl input 合同 |
| 范围膨胀到 tools/skills | 演示最小集冻结；S6 以后再说 |

---

## 8. 下一步（你点头后执行）

默认从 **S1** 开始改代码；若周一只够讲 workflow，可 **S2 优先、S1 紧随**（主 Agent 仍会先露脸）。

回复优先序即可，例如：`先 S2 再 S1` 或 `按 S1→S2→S3`。
