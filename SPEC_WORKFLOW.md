# Workflow 编排 Spec（精简）

> **定位**: 多角色 `runWorkflow` 与 spawn 预设如何共用「人设 + 工具」真源；编排 JSON 风格对齐 `agent.json`；DAG 变体分阶段演进。  
> **原则**: profile 共用、编排分离；兼容现有 `flow[]` + `loop`；先 W1 再并行/分支。  
> **状态**: Draft v0.4（2026-07-16）· **W1–W3 ✅** · **W4 设计（hands-off / 隔离信封）**  
> **代码锚点**: `src/workflow/*` · `src/spawn/load-preset.ts` · `agent.json` `spawn_presets` · `agents/` · `roles/` · `workflows/`  
> **相关**: [SPEC_CONTEXT](./SPEC_CONTEXT_MANAGEMENT.md)（role 仍走 `runAgent` + 指针化）· [docs/ROADMAP.md](./docs/ROADMAP.md) · skill `workflow-design`

---

## 1. 非目标

- 可视化 workflow 编辑器
- 任意图 goto / 图灵完备表达式语言
- 用 workflow **替代** spawn_background（job 节点为后续可选，不是 W1）
- 本 spec 不定义 TUI `/workflow` UI（有需求再开）

---

## 2. 问题与目标

| 痛点 | 目标 |
|------|------|
| `roles/*.md` 与 `agents/*` + `spawn_presets` **双份**人设 | **一个 AgentProfile 真源**，workflow 只引用 |
| workflow JSON 字段 / 路径习惯与 `agent.json` 不一致 | role 对象 ⊆ spawn preset 字段集；路径相对 **cwd** |
| `flow` 仅线性 + 单种 `loop` | 分阶段加 `parallel` / `switch`，必要时再 `nodes+edges` |

**共用的是 profile（system + tools + max_turns + LLM + shell）**；  
**不共用的是运行形态**（spawn 冷启动 / job 磁盘 vs workflow 模板输入 + `ctx.roles` + 可选 `share_session`）。

---

## 3. 现状（基线）

```
spawn:  agent.json spawn_presets[] → resolveSpawnPreset → agents/*.md
workflow: workflows/*.json roles{} → resolveWorkflowRole → roles/*.md（相对 workflow 文件）
编排: flow[] = step | { loop: { when, max_rounds, steps } }
模板: {{user_task}} / {{role.output}} / {{role.verdict}}
条件: "{{reviewer.verdict}} == 'needs_revision'"
```

- 禁止嵌套 spawn：仅 spawn 路径 strip `spawn_agent` / `spawn_background` / `code_review`  
- workflow 不合并 `shell` 策略；role 需 shell 时只走 PermissionGate

---

## 4. 统一 AgentProfile（真源）

### 4.1 字段（与 `SpawnPresetConfig` 对齐）

```typescript
/** 可被 spawn 与 workflow 共用 */
interface AgentProfileRef {
  /** agent.json spawn_presets[].name 或 agents/<name>.md */
  preset?: string;
  prompt_file?: string;   // 相对 cwd（W1 起推荐）；兼容相对 workflow 目录见 §5.2
  prompt?: string;        // 内联 system body
  tools?: string[];
  max_turns?: number;
  api_profile?: string;
  model?: string;
  shell?: SpawnShellPolicy;  // workflow 执行 run_shell 时也应 merge（W1）
  description?: string;
}
```

### 4.2 解析顺序 `resolveAgentProfile(cwd, ref, opts?)`

1. 若 `preset`：在 `spawn_presets` 中按 **name** 查找 → 再按 `agents/<preset>.md` 兜底  
2. 否则 `prompt_file` / `prompt`（与现 load-role / load-preset 相同 frontmatter）  
3. **合并**：JSON 显式字段覆盖 frontmatter / preset  
4. **一律** strip `FORBIDDEN_CHILD_TOOLS`（与 spawn 一致）  
5. `max_turns` 受 `spawn_policy.max_turns_cap` 约束（workflow 也可读同一 cap，避免两套上限）  
6. 输出：`ResolvedAgentProfile`（`systemPrompt`, `tools`, `maxTurns`, `api_profile`, `model`, `shell?`）

spawn 的 `resolveSpawnPreset` 与 workflow 的 `resolveWorkflowRole` **收敛到此函数**（薄包装保留旧 API 名亦可）。

### 4.3 工具列表语义

| 情况 | 行为 |
|------|------|
| role/preset 未写 `tools` | 用 md frontmatter 或空 |
| role 写了 `tools` | **整表替换** preset 的 tools（便于收窄 reviewer） |
| 解析结束 | strip 嵌套委托工具 |

---

## 5. W1 — preset 引用 + 字段 / 路径对齐（**本迭代**）

### 5.1 Workflow role 写法

```jsonc
{
  "name": "review-loop",
  "share_session": false,
  "roles": {
    "planner": {
      "preset": "skeleton-reader",
      "tools": ["read_file", "grep_search", "list_files", "recall_query"],
      "max_turns": 50
    },
    "worker": {
      "preset": "dev-worker"
    },
    "reviewer": {
      "preset": "code-review-quality",
      "tools": ["read_file", "grep_search", "diff_file", "recall_query"],
      "max_turns": 50
    }
  },
  "flow": [ /* 现有 step / loop 不变 */ ]
}
```

兼容：仅 `prompt_file` + `tools` 的旧 role **继续可用**（无 `preset`）。

### 5.2 路径

| 优先级 | 规则 |
|--------|------|
| 1 | `prompt_file` 相对 **cwd**（与 spawn 一致） |
| 2 | 若不存在，再试相对 **workflow 文件目录**（兼容 `../roles/…`） |

文档与新示例只写 cwd 相对路径：`agents/dev-worker.md`。

### 5.3 runner 行为（W1）

- `resolveWorkflowRole` → 调 `resolveAgentProfile`  
- `run_shell`：应用 profile.`shell`（与 spawn 子 Agent 同 policy 合并逻辑）  
- 其余：`share_session`、模板、`verdict`、handback **不变**

### 5.4 示例迁移

| 文件 | 动作 |
|------|------|
| `workflows/review-loop.json` | worker → `preset: "dev-worker"`；planner/reviewer 尽量 `preset` + tools 收窄 |
| `roles/worker.md` | 可标 deprecated 或删（迁移后） |
| `roles/planner.md` / `reviewer.md` | 可暂留，或收成 `agents/` 短 profile |

### 5.5 W1 验收

- [x] `preset: "dev-worker"` 的 workflow step 工具集与 spawn 同 preset 一致（含 strip 规则）  
- [x] 旧 `prompt_file: "../roles/…"` 的 workflow 仍能跑（cwd 优先 + workflow 目录回退）  
- [x] 单测：`tests/workflow-preset.test.ts` + 既有 `load-spawn-preset`  
- [x] `review-loop` 示例：`planner`/`worker` 用 preset；`reviewer` 仍 `roles/reviewer.md`  
- [x] role 运行时 `spawnDepth>=1` + `spawnShellPolicy`（与子 Agent shell 策略一致）

### 5.6 非 W1

- ~~`parallel` / `switch`~~ → **W2 ✅**  
- agent.json `workflows` 注册表  
- job 模式节点 / `nodes+edges`  

---

## 6. JSON 风格约定（W1 起）

| 约定 | 说明 |
|------|------|
| 蛇形字段 | `max_turns`, `api_profile`, `prompt_file`, `share_session` |
| role ≈ preset | 同一套可选字段，禁止 workflow 专用魔法字段（除编排层） |
| 编排层字段 | `flow`：`role`, `input`, `as`, `loop`, `parallel`, `switch`, `when` |
| 条件 | 字符串 `{{path}} == 'value'` **或** `{ "path", "eq" }`（W2） |

可选（W2+）：`agent.json` 增加

```jsonc
"workflows": { "review-loop": "workflows/review-loop.json" }
// 或 "workflow_dirs": ["./workflows"]
```

CLI：`--workflow review-loop` 解析注册名。

---

## 7. 编排演进（W2 / W3 · 契约草案）

### 7.1 现状能力

```text
flow: step → step → … → [while when: steps] → …
```

### 7.2 W2 — 扩 `flow` item（✅ 已实现）

```typescript
type FlowItem =
  | { role: string; input: string; id?: string; as?: string }  // as → ctx.roles[as]
  | { loop: { when: string | WhenClause; max_rounds: number; steps: Step[] } }
  | { parallel: { steps: Step[]; join?: 'all' } }             // Promise.all + session clones
  | { switch: { on: string; cases: Record<string, FlowItem[]>; default?: FlowItem[] } };

type WhenClause = { path: string; eq: string };
```

| 能力 | 行为 |
|------|------|
| **`as`** | 输出写入 `ctx.roles[as]`（默认 `role`） |
| **`parallel`** | `Promise.all`；每步 **独立 session 切片** 避免 `current_messages` 竞态；tasks 合并回主 session |
| **`switch`** | `on` → lookup/template；匹配 `cases[key]` 或 `default`，递归执行子 flow |
| **`when` 对象** | loop 条件支持 `{ path, eq }` |

示例：

```jsonc
{
  "parallel": {
    "steps": [
      { "role": "worker", "as": "worker_api", "input": "…\n{{planner.output}}" },
      { "role": "worker", "as": "worker_ui", "input": "…\n{{planner.output}}" }
    ]
  }
}
// …
{
  "switch": {
    "on": "reviewer.verdict",
    "cases": {
      "needs_revision": [
        { "role": "worker", "input": "{{reviewer.output}}" }
      ]
    },
    "default": []
  }
}
```

### 7.3 W3 — DAG + job 节点 + 注册表（✅）

**互斥**：`flow[]` **或** `nodes` + `edges` + `entry`（不可同时）。

```jsonc
{
  "name": "dag-review",
  "roles": { "planner": { "preset": "skeleton-reader" }, "worker": { "preset": "dev-worker" }, … },
  "entry": "plan",
  "nodes": {
    "plan": { "role": "planner", "input": "{{user_task}}" },
    "impl": { "role": "worker", "as": "worker", "input": "{{plan.output}}", "max_visits": 3 },
    "review": { "role": "reviewer", "input": "{{worker.output}}", "max_visits": 3 }
  },
  "edges": [
    { "from": "plan", "to": "impl" },
    { "from": "impl", "to": "review" },
    { "from": "review", "to": "impl", "when": { "path": "reviewer.verdict", "eq": "needs_revision" }, "max_visits": 2 }
  ]
}
```

| 能力 | 行为 |
|------|------|
| **join** | 无 `when` 的边为 **必选**：source 完成且边 fired 后后继可跑 |
| **条件边** | 有 `when`：source 完成后 fire/waive；**不阻塞**首次仅靠必选边的激活 |
| **max_visits** | 节点/边上限制循环次数 |
| **ctx 键** | 写入 `as`（若有）+ **node id**（模板 `{{plan.output}}`） |
| **mode: "job"** | step/node 走 `spawn_background` 并 **await** 结果（文本进 ctx） |
| **注册表** | `agent.json` `workflows: { "name": "path.json" }` + `workflow_dirs`；`--workflow name` |

示例文件：`workflows/dag-review.json`。

### 7.4 W2 / W3 验收

- [x] W2：`when` 对象、`as`、`parallel`、`switch`  
- [x] W3：DAG 加载与就绪判定单测；`resolveWorkflowRef` 注册名  
- [x] `flow` 与 `nodes` 互斥校验  
- [x] job mode 接线（registry.start + await）

---

## 8. 与 spawn / 主 Agent 的边界

| | 主 Agent | spawn / job | workflow role |
|--|----------|-------------|---------------|
| Profile | agent.json 主配置 | preset | preset 或内联 |
| 输入 | 用户 / 压缩 replay | task 字符串 | 模板渲染后的 prompt |
| 输出 | 会话 messages | job meta/report | `ctx.roles[name].{output,verdict}` |
| 嵌套委托 | 可 spawn | **禁止** | **禁止**（W1 起统一 strip） |

---

## 9. 实施顺序

| 阶段 | 内容 | 状态 |
|------|------|------|
| **W1** | `resolveAgentProfile`；workflow `preset`；路径 cwd+兼容；shell 策略；示例迁移 | ✅ `src/agent-profile.ts` |
| **W2** | `when` 对象；`parallel` + `as`；`switch` | ✅ |
| **W3** | nodes/edges/entry；`mode: job`；workflows 注册表 | ✅ `dag.ts` + `resolveWorkflowRef` |
| **W4** | Hands-off 预设流水线 + role 信封（§11）；不污染主 session system | 设计 ✅ · 实现 ⏳ |

---

## 10. 版本

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-16 | v0.4 | **W4 设计**：隔离信封 + hands-off 预设 vs 循环式 goal |
| 2026-07-15 | v0.3 | **W3**：DAG 执行、job 节点、workflows 注册解析 |
| 2026-07-15 | v0.2 | **W2**：parallel/switch/as、结构化 when |
| 2026-07-15 | v0.1 | 初稿：W1 契约 + W2/W3 轮廓 |

---

## 11. W4 — Hands-off 预设流水线（设计）

> **产品目标（仅两条）**  
> 1. **隔离**：workflow 给角色的提示 **不得** 干扰常规模式 session 的主 Agent **系统提示**。  
> 2. **放手**：用户 arm 预设 workflow 后 **只输入自然语言任务** 即可多角色分工跑完；视角独立、预算有限——**不是** Codex 式 `[goal]` 的同一 Agent 反复试错循环。

### 11.1 目标 1：信封隔离（不污染主 system）

**现状（应保持为硬不变量）**

| 路径 | system 来源 | 是否写主 session system |
|------|-------------|-------------------------|
| 常规 `runSingleTask` | `buildSystemPrompt(config)` | 否（每轮现算）；history = `current_messages` |
| workflow role | **`role.systemPrompt` only** + `isolated: true` | 否 |
| workflow 结束 | prior `current_messages` + user/assistant **digest** | 否；**不**改主 system |

角色步已经 **覆盖** system，不走主 Agent 的 coding-assistant 拼装。父 session 写回的是 **消息层 digest**（§ runner `mergeWorkflowResultIntoSessionMessages`），与 system 无关。

**W4 仍须遵守的规则**

| 规则 | 说明 |
|------|------|
| **R1** | Role 信封 **只** 拼进该次 `runAgent` 的 `systemPrompt` 或 **该步 user `prompt` 前缀**；禁止写入 `session` 的「伪 system」持久字段。 |
| **R2** | 禁止修改 `AgentConfig` 上供主 Agent 复用的全局 system 缓存（若未来有缓存，workflow 路径不得复用同一 mutable 串）。 |
| **R3** | `share_session: true` **不得** 作为 hands-off 预设默认；默认 false，避免角色工具史灌进父 transcript。 |
| **R4** | 结束后父 history = **进场快照 + 任务 user + digest assistant**；角色多轮 tool 轨迹 **不** 并入父 session。 |
| **R5** | 下一轮常规对话：主 Agent 仍用 `buildSystemPrompt`；digest 只是普通 user/assistant，**不是** 新的 system。 |

**信封内容（仅 role 可见）——示意**

```text
[workflow_envelope]
workflow: dag-review
step: plan | role: planner | slot: plan
upstream: (none)
downstream: impl consumes this final text as plan.output
duty: produce a handoff plan only; do not implement
budget: finite (max_turns / max_visits owned by runner)
[/workflow_envelope]
```

实现时：`buildWorkflowRoleSystemPrompt(base, envelopeMeta)` 或 `prefixWorkflowUserPrompt(renderedInput, meta)`；**单元测试断言** `buildSystemPrompt` 字符串不包含 `workflow_envelope`。

### 11.2 目标 2：Hands-off ≠ 循环 goal

| | **本产品预设 workflow** | **Codex 式 [goal]（对照）** |
|--|-------------------------|---------------------------|
| 结构 | 固定 **flow/DAG** 多角色 | 同一 Agent 目标循环 |
| 视角 | planner / worker / reviewer **人设与工具分离** | 同一 system，反复尝试 |
| 停止 | `max_rounds` / `max_visits` / handback / 条件边 | 直到「觉得完成」或外部打断 |
| 目标不清 | **有限步**内做可辩护假设 → 交付或 **handback 问人** | 易空转重试 |
| 用户操作 | arm 一次 + **一句任务** | 开 goal 模式后反复推进 |

**Hands-off 用户旅程**

```text
/workflow → 选 dag-review（或已 arm）
用户：修登录页 token 过期闪退
→ plan（只读规划）→ impl（按 plan 改）→ review（裁决）
→ [可选] 有限次 needs_revision 回边
→ 父 session：原对话 + digest；用户可继续聊或再 arm
```

用户 **不必** 写「你是 planner…」；契约在 **预设 JSON + 角色 profile + 运行时信封**。

### 11.3 角色分工（视角独立）

| 角色 | 视角 | 工具倾向 | 产出契约（交接物） |
|------|------|----------|-------------------|
| **planner** | 范围、步骤、风险；**不实现** | 只读 | 可执行 plan（路径/步骤/验证）；含「假设 / 未决问题」小节 |
| **worker** | **只执行 plan**；task 作上下文 | 读写+shell | Done / 路径 / 如何验证；禁止从零重规划 |
| **reviewer** | 验收与回归；**不重做** | 只读+diff | `verdict` + notes；不清则 `needs_revision` 或逼近 cap 后 handback |

**预设禁止** 把 planner 绑成通用 `skeleton-reader` / 把 worker 绑成「无视 plan 的独立 task Agent」而不改 input 合同——那是当前失败模式的根因（人设错位，不是 session 共享不足）。

推荐绑定：

- planner → `roles/planner.md` 或专用 `agents/workflow-planner.md`（可进 `spawn_presets` 仅供 workflow 引用）
- worker → `dev-worker` + **强 input**（Plan 优先）
- reviewer → `roles/reviewer.md` 或 quality preset + 收窄 tools

### 11.4 交接模型（非全量上下文）

```text
ctx.user_task          ← 用户原话（只读上下文）
ctx.roles[slot].output ← 该步最终文本（主交接）
ctx.roles[slot].verdict← 可选机器字段（分支）
```

| 做 | 不做 |
|----|------|
| 模板显式拼接上游 slot | 默认 `share_session` 灌全历史 |
| 运行时信封声明 upstream/downstream | 改主 Agent system |
| 有限 `max_visits` / `max_rounds` | 无界 replan 环 |
| 目标模糊 → plan 写假设；cap 尽 → **handback** | 同一角色死循环试到过 |

**目标不清时的策略（反 goal-loop）**

1. Planner：列出 **Assumptions** + **Open questions**；仍给 **最小可执行 plan**（或明确「信息不足，建议 handback」）。  
2. Worker：只落实 plan 中无歧义部分；不自行扩大范围。  
3. Reviewer：事实不足 → `needs_revision` **有限次**；仍不清 → 工作流耗尽后 **handback 给人**，由主 session 澄清——**不**再自动开新 goal 环。

### 11.5 预设 workflow 验收（产品）

以 `dag-review` / `review-loop` 为标杆：

- [ ] 用户仅输入自然语言任务即可跑通（arm 后无二次编排）  
- [ ] Planner 最终文本是 **计划**，不是实现总结；无写盘（工具集约束）  
- [ ] Worker 引用 plan 步骤；不出现与 plan 无关的「第二遍从零实现」为主路径  
- [ ] Review 有 `verdict`；回边次数有 cap  
- [ ] 父 session system **前后一致**（仅多 digest 消息）  
- [ ] 单测：信封只出现在 role 调用参数，不出现在 `buildSystemPrompt` 结果  

### 11.6 实现切片（建议顺序，未开工）

| 切片 | 内容 |
|------|------|
| **W4a** | 示例 JSON：正确 profile + 步骤 input 合同；`roles/*` 强化交接口吻 |
| **W4b** | `buildWorkflowRoleEnvelope` + 拼入 role `systemPrompt`；隔离单测 |
| **W4c** | 可选：output 小节轻量提示（plan/worker/reviewer）；不做重型 schema 引擎 |
| **W4d** | 文档 / skill：hands-off 用法；明确 vs 循环 goal |

**非目标（W4）**：可视化编辑器、任意表达式语言、默认全量 session 共享、无 cap 的自动重试 goal。

---

*实现以本 spec 验收条目 + `npm test` 为准；W1–W3 已落地，W4 以 §11 为设计源。*
