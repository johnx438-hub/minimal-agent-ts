# Workflow 编排 Spec（精简）

> **定位**: 多角色 `runWorkflow` 与 spawn 预设如何共用「人设 + 工具」真源；编排 JSON 风格对齐 `agent.json`；DAG 变体分阶段演进。  
> **原则**: profile 共用、编排分离；兼容现有 `flow[]` + `loop`；先 W1 再并行/分支。  
> **状态**: Draft v0.3（2026-07-15）· **W1–W3 ✅**  
> **代码锚点**: `src/workflow/*` · `src/spawn/load-preset.ts` · `agent.json` `spawn_presets` · `agents/` · `roles/` · `workflows/`  
> **相关**: [SPEC_CONTEXT](./SPEC_CONTEXT_MANAGEMENT.md)（role 仍走 `runAgent` + 指针化）· [docs/ROADMAP.md](./docs/ROADMAP.md)

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

---

## 10. 版本

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-15 | v0.3 | **W3**：DAG 执行、job 节点、workflows 注册解析 |
| 2026-07-15 | v0.2 | **W2**：parallel/switch/as、结构化 when |
| 2026-07-15 | v0.1 | 初稿：W1 契约 + W2/W3 轮廓 |

---

*实现以本 spec §5 验收为准；冲突时以代码 + `npm test` 为准。*
