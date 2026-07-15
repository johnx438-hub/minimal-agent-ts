# 提示词中文化计划（演示可观测性）

> **目的**：周一对外演示时，主 Agent / spawn 子 Agent / workflow 角色的**系统与角色提示**以中文呈现，便于旁观理解「谁在干什么」。  
> **原则**：同词义翻译，**不改协议**；工程量大但机械，**分步合并、每步可演示**。  
> **状态**：规划中（2026-07-16）· 未开工实现。

---

## 1. 范围地图（先分清「译 / 不译」）

| 层 | 位置（示例） | 演示是否必看 | 是否中文化 |
|----|--------------|--------------|------------|
| **主 Agent system** | `src/agent-prompt.ts` `buildSystemPrompt` | ✅ 核心 | ✅ |
| **Workflow 信封** | `src/workflow/envelope.ts` | ✅ 多角色步骤 | ✅ |
| **Workflow 角色人设** | `roles/planner.md` 等 | ✅ | ✅ |
| **Workflow 步骤 input** | `workflows/*.json` 的 `input` 字符串 | ✅ | ✅ |
| **Spawn 预设人设** | `agents/*.md` + `agent.json` `description` | ✅ 子 Agent | ✅ |
| **Fallback 短句** | `src/agent-profile.ts` 默认 “You are…” | 中 | ✅ |
| **Handback / digest 文案** | `src/workflow/handback.ts` | 中（失败路径） | ✅ 建议 |
| **TUI 中文** | `src/tui/i18n.ts` 等 | 已部分中文 | 本计划外（已可用） |
| **工具 schema description** | `src/tools/**` 英文说明 | 模型可见，旁观较少 | ⏳ 后期可选 |
| **Skill 正文** | `skills/**/SKILL.md` | 按需 invoke | ⏳ 演示用到再译 |
| **SPEC / README 工程文档** | `SPEC_*.md` | 给人看的 | ⏳ 非演示阻塞 |
| **协议字段** | `verdict` 枚举、`workflow_handoff` 参数名、工具名 | 机器契约 | ❌ **保持英文** |
| **代码标识符** | 变量 / JSON key | — | ❌ 不译 |

**硬约束（防回归）**

1. 工具名：`read_file` / `workflow_handoff` 等 **永远英文**。  
2. 分支字段：`approved` | `needs_revision` | `needs_human` **永远英文**（可在中文说明里写「取值必须是 …」）。  
3. 模板变量：`{{user_task}}` / `{{plan.output}}` **不译**。  
4. 主 system 与 role system **路径不变**（envelope 仍只进 role，不污染主 system）。

---

## 2. 策略选择（建议）

| 方案 | 做法 | 适合 |
|------|------|------|
| **A. 就地中文（推荐演示周）** | md / 字符串直接改成中文，git 历史可回滚 | 受众明确中文、少分叉 |
| B. 双文件 `agents/zh/` + locale | `prompt_locale: zh\|en` 解析 | 长期双语，工程多一截 |
| C. 仅演示分支 `demo/zh-prompts` | 不进 master | 临时演示，合并成本后置 |

**建议：演示周用 A**；若会后要长期 EN 上游协作，再开 B（locale 开关）。  
一步一步推进时，**不要**一上来做 B。

翻译语气：简体、短句、条目化；保留 Markdown 结构（`##`、列表）；专有名可中英并列一次（如「开发工人 dev-worker」）。

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

### S1 — 运行时「骨架句」（高可见、文件少）

| 文件 | 动作 |
|------|------|
| `src/agent-prompt.ts` | `buildSystemPrompt` 主文案 → 中文；工具名保留 |
| `src/workflow/envelope.ts` | 信封 duty / 负反馈 / 交接说明 → 中文 |
| `src/workflow/handoff-tool.ts` | tool `description` + 成功 ok 文案 → 中文（参数名英文） |
| `src/agent-profile.ts` | 默认 fallback “You are…” → 中文 |

**验收**：新会话主 Agent 首条可见中文 system 行为；workflow 一步里日志/行为符合中文信封；`npm test` 中断言英文短语的用例改为中文或语义匹配。

### S2 — Workflow 演示路径（周一最该稳）

| 文件 | 动作 |
|------|------|
| `roles/planner.md` / `worker.md` / `reviewer.md` | 全文同义中文 |
| `workflows/dag-review.json` | 各节点 `input` 中文合同（保留 `{{…}}` 与 verdict 英文） |
| `workflows/review-loop.json` | 同上 |

**验收**：arm `dag-review`，一句中文任务能跑完；digest 里角色产出可读；旁观能听懂 planner≠worker≠reviewer。

### S3 — Spawn 演示路径

| 优先 | 文件 |
|------|------|
| P0 | `agents/dev-worker.md` |
| P1 | `agents/skeleton-reader.md`（若演示仍 spawn 它） |
| P2 | `code-review-*.md`（若演示 code_review / 并行审查） |
| P3 | `web-researcher.md` / `hackernews-digest.md` |

同步：`agent.json` 里对应 `spawn_presets[].description` 中文（列表/UI 展示）。

**验收**：`spawn_agent(preset=dev-worker)` 子任务行为与英文版同质；TUI/列表描述为中文。

### S4 — 扫尾 spawn 与默认句

- 剩余 `agents/*`  
- `handback.ts` / `formatWorkflowReturnSummary` 用户可见块  
- 任何 “Complete the delegated task…” 残留 `rg "You are"` 清零（提示词语境）

### S5 — 测试与门禁

- 更新 `tests/workflow-envelope.test.ts` 等对英文片段的 `assert.match`  
- 可选：加一条「主 system 含中文关键词 / 不含 You are a minimal」的冒烟  
- **不要**要求模型输出必须是中文（用户任务语言决定即可）

### S6 — 可选增强（演示后）

- 工具 definition 中文（体积大、与 MCP 混杂）  
- `prompt_locale` 双语文档方案 B  
- Skill 按演示脚本点名翻译  

---

## 5. 翻译规范（给执行的人）

1. **先结构后措辞**：标题层级与列表与原文对齐，再润色。  
2. **中英锚点**：首次出现角色名可写「规划员（planner）」，后文可只用中文。  
3. **命令式**：用「请…」「不要…」「必须…」，避免文学腔。  
4. **负反馈**（envelope）：保持「无交接则本步失败、父会话保留」语义，不写「作废删除」。  
5. **禁止**把 `needs_revision` 译成中文当作 JSON 值。  
6. 每步 PR/commit 信息：`docs(i18n): …` 或 `i18n(prompts): S2 workflow roles`。

### 对照示例（风格）

| EN | ZH |
|----|-----|
| You are the **planner** role in a multi-agent **workflow**. | 你是多角色 **workflow** 中的 **规划员（planner）**。 |
| Do NOT implement. | 不要实现代码或改文件。 |
| Prefer workflow_handoff(kind=plan). | 优先调用 `workflow_handoff`（`kind=plan`），再结束本步。 |
| End with verdict: approved \| needs_revision \| needs_human | 结束时给出裁决，`verdict` 必须是：`approved` \| `needs_revision` \| `needs_human` |

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
