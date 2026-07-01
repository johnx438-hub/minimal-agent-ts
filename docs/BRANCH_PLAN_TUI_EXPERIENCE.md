# 分支计划：TUI 体验、权限门与嫁接前能力（记录稿）

> **状态**: 仅记录，**不进** `ROADMAP.md`，**不要求**立即改主仓内核。  
> **前提**: 主仓 = session 内上下文实验 + `AgentRuntime` harness；pi 嫁接见轨 A（`ROADMAP.md`）。  
> **原则**: **先定规则、后换皮肤**——权限与 slash 在 readline 时代落地，pi `Overlay` 只替换呈现层。

---

## 1. 目标

在嫁接 `@earendil-works/pi-tui` 之前，把 **成品包级** 体验与安全门补齐，避免：

- pi 做完后仍要改 `AgentRuntime` 交互语义；
- readline 与 pi 各维护一套确认/选择逻辑。

面向用户：

- **魔改党**：继续用主干源码 + `--json-events`；
- **体验党**：TUI 成品包（coding + 轻办公混合）+ 明确权限与交接策略。

---

## 2. 总顺序（依赖链）

```text
P0  权限 JIT + workflow 强制 checkpoint + /resume last
        ↓
P1  slash /approve 完善 + spawn_policy（并行上限 / 轮次顶）
        ↓
P2  handoff 交接文件 + 压缩疲劳软提示（/clear vs 新窗）
        ↓
P2′ workflow「失控回主 Agent」（loop_guard / max_rounds 耗尽）
        ↓
P3  workflow 通用条件分支（if/else，不止 loop.when）
        ↓
P3  多 API profile（workflow 角色 + spawn 预设）
        ↓
P4  pi TUI 嫁接（Overlay / SelectList / 流式 Markdown 组件）
```

**记忆口诀**: 权限 → handoff → workflow 逃生 → 多 API / 全分支 → pi 皮。

---

## 3. 现状与缺口（2026-07 基线）

| 能力 | 现状 | 缺口 |
|------|------|------|
| shell / web | 首启 confirm、`.tui-prefs.json`、`/shell` `/web` | **JIT 批准**：web off 时 `web_fetch` 直接 error |
| 工作区 | `resolveSafePath` 硬拒越界 | 无读项目外路径的事前确认；`/cwd` 无二次确认 |
| workflow | `/workflow` arm 或带 task 直跑 | 无跑前**强制**权限门；无 loop 失控回主 Agent |
| resume | `/resume <id>` | 无最近 session；无列表点选 |
| spawn | 串行；预设 `max_turns`（默认 15） | 无并行上限；无全局轮次 cap |
| handoff | 无 | 无交接文件与「压缩疲劳」软出口 |
| 多 API | workflow 仅 per-role `model` | 共用同一 `apiKey` / `baseUrl` |
| 永久放行 | 无 | 无分能力 `approve always`（需慎用） |

---

## 4. P0：权限门 + resume + workflow 进门（嫁接前必做）

### 4.1 权限模型（三层 + JIT）

```text
L0  prefs 默认值（.tui-prefs.json）
L1  会话级开关（/shell on、/web on）
L2  JIT 门（工具将越权时暂停 → 用户批/拒）
L3  永久策略（dangerous-always-approve，可选、可撤销）
```

**L2 JIT 场景**

| 场景 | 行为 |
|------|------|
| `web_fetch` 且 `allowWeb=false` | 弹窗：本次 / 本会话 / 拒绝 |
| `run_shell` 且 shell off | 同上 |
| 路径将越 `cwd`（read 类） | 可选：一次放行只读；**write/edit 仍硬拒** |
| `/cwd` 改到项目外 | 必须确认 old→new |
| spawn 预设需 web/shell 但父级未开 | 走同一 gate，避免子 agent 静默失败 |

**建议模块**: `src/permission-gate.ts`  
`requestCapability({ kind, reason, scope }) → 'once' | 'session' | 'deny'`

readline 期：`y/n/a` 文本确认；pi 期：`showOverlay` + `SelectList`。

**L3 `/approve`（P1 细化，workflow 禁用 always）**

```text
/approve session web|shell
/approve always web|shell     # 写入 prefs，启动时警告
/approve revoke always web
/approve status
```

### 4.2 workflow 进门 checkpoint（不可绕过）

跑 workflow **前**固定 `runWorkflowCheckpoint()`：

- 展示将启用的能力（shell / web / 各 role 工具）；
- **无「不再询问」**（always-approve 不适用于 workflow 进门）；
- 用户可取消本次 workflow。

与「spec 完成后一键 workflow」配合：一键只省 **选名字**，不省 **权限门**。

### 4.3 resume 便捷化

| 能力 | 说明 |
|------|------|
| `/resume`（无 id） | `getLatestSession()`，可选同 cwd 优先 |
| `/resume last` | 别名 |
| `npm run tui -- --resume-last` | CLI 入口 |
| pi 后 | `SelectList` 默认高亮最近一条 |

---

## 5. P1：slash 完善 + spawn_policy

### 5.1 Slash 补全（命令表稳定后给 pi `Editor` autocomplete）

| 命令 | 行为 |
|------|------|
| `/web` `/shell`（无参数） | 打印当前状态 |
| `/approve …` | 见 §4.1 L3 |
| `/workflow !<name>` | arm |
| `/workflow run <name> [task]` | 带 checkpoint 执行 |
| 别名 | `/r`→`/resume`，已有 `/wf`、`/session`→`/sessions` |

### 5.2 spawn_policy（`agent.json` 草案）

```json
"spawn_policy": {
  "max_parallel": 2,
  "max_turns_default": 15,
  "max_turns_cap": 30
}
```

- `tool-scheduler`：在 `max_parallel` 内允许多 `spawn_agent` 并行（默认 1–2）；
- `spawn/runner.ts`：并发信号量；
- 预设已有 `max_turns` + MD `max_turns:`；全局 cap 防配错。

---

## 6. P2：Handoff（交接文件 + 压缩疲劳软提示）

### 6.1 定位

对标 Claude Code / OpenCode **摘要式交接**，但 **强制落盘**，与主仓上下文策略同一叙事：

- 不替代 compression / pointerize / recall；
- 极端长程任务「每轮都在压」时，给用户 **主动出口**（非硬截断）。

### 6.2 行为

| 项 | 说明 |
|----|------|
| 命令 | `/handoff` 写文件；`/handoff load` 或新 session `--handoff` 注入 |
| 文件 | 建议 `.sessions/handoff_<session_id>.md` 或项目内 `HANDOFF.md`（可配置） |
| 内容 | 用户意图、待办、`files_touched`、最近 task 指针、`action_id` 索引提示 |
| 疲劳启发式 | 最近 M turn 内多次 `compression` / 累计 prune 超阈 → **软弹窗** |
| 用户选择 | **继续** / **handoff + 新 session** / **`/clear` 式截断**（自选） |

### 6.3 与现有能力

| 已有 | handoff 关系 |
|------|----------------|
| TaskSummary | 可引用或合并进 handoff 一节 |
| pointerize + recall | 细节仍 `recall_query`；handoff 写「句柄」 |
| `/new` | 升级为「新窗 + 可选加载 handoff」 |

### 6.4 实现接缝

- 检测：`AgentStepEvent` `compression` 计数（TUI / runner 侧）；
- 写入：纯文件 IO，不进 `current_messages` 必填路径；
- UI：readline 三选一；pi 后 `SelectList` overlay。

**阶段**: P2（权限 P0 之后；pi 之前可做 readline 版）。

---

## 7. P2′：Workflow 失控回主 Agent（窄版，先于全分支）

### 7.1 问题

- 仅有 `loop.when` + `max_rounds`；
- `runAgent` 若 `loop detected` 返回 `[Agent stopped: …]`，workflow **仍当普通 output 继续**。

### 7.2 窄版目标

触发任一即 **结束 workflow** 并回主会话 idle：

- `max_rounds` 用尽；
- `loop_guard` terminate / 强制总结仍失败；
- 弱模型乱循环、用户 spec 不清。

交付：

- 强制总结段落；
- 主 Agent / TUI 固定话术 **询问用户下一步**（不自动再开 workflow）；
- 事件：`workflow_handback`（可供 `--json-events`）。

改动：`workflow/runner.ts` 解析 stop reason；**不动** `agent.ts` ReAct 语义。

### 7.3 全分支（P3，后移）

- 通用 `if / else if / else` 或 `switch(verdict)`；
- 扩展 `WorkflowDefinition`、`evaluateWorkflowWhen`、示例 JSON；
- **在窄版 handback 跑通后再做**，避免逃生路径与分支语法缠在一起。

---

## 8. P3：多 API profile

### 8.1 现状

- workflow role 有 `model`，共用父级 `apiKey` / `baseUrl`；
- spawn 继承整个 `parentConfig`。

### 8.2 目标配置（草案）

```json
"api_profiles": {
  "main": {
    "base_url": "https://…",
    "model": "…",
    "api_key_env": "OPENAI_API_KEY"
  },
  "cheap": {
    "base_url": "https://…",
    "model": "…",
    "api_key_env": "CHEAP_API_KEY"
  }
}
```

绑定：

- `workflow.roles.<name>.api_profile`
- `spawn_presets[].api_profile`

注意：密钥只走 env / 本地配置，**不进 git**；失败重试策略与主 profile 一致或单独文档化。

**阶段**: P3（spawn_policy 定形后；与 handoff / pi 无硬依赖）。

---

## 9. P4：pi TUI 嫁接

### 9.1 只引 `pi-tui`，不引 `coding-agent` 整包

保留 `AgentRuntime` + `RuntimeEvent` / `AgentStepEvent` 契约。

### 9.2 事件 → 组件（对齐 pi `handleEvent`）

| 事件 | 组件行为 |
|------|----------|
| `token` | 单块 `Markdown` 流式 `setText`（非 stdout 追加） |
| `tool_*` | 简易 Tool 卡片（不必 pi 全量 diff/图） |
| `final` | 定稿 Markdown |
| PermissionGate | `SelectList` overlay |
| handoff 疲劳 | 三选一 overlay |
| `/sessions` | `SelectList` → resume |

### 9.3 分阶段替换

| 阶段 | 内容 |
|------|------|
| P0′ | `Editor` + 流式 `Markdown` |
| P1′ | `Loader` / `CancellableLoader` → `runtime.abort()` |
| P2′ | Session / workflow / 权限 overlay |
| P3′ | Tool 卡片美化 |

参考：`pi/packages/tui/test/chat-simple.ts`、`coding-agent/.../interactive-mode.ts` 的 `message_start/update/end` 三段。

---

## 10. 里程碑切片

| 里程碑 | 内容 | 阶段 |
|--------|------|------|
| **M1** | PermissionGate + `/resume` + workflow checkpoint | P0 |
| **M2** | `/approve` + `spawn_policy` | P1 |
| **M3** | `/handoff` 写读 + 压缩疲劳软提示 | P2 |
| **M4** | workflow handback（loop / max_rounds） | P2′ |
| **M5** | `api_profiles` + workflow/spawn 绑定 | P3 |
| **M6** | workflow `if/else` 分支语法 | P3 |
| **M7** | pi presenter 统一承载弹窗/选择/流式 | P4 |

---

## 11. 与其他文档关系

| 文档 | 关系 |
|------|------|
| `ROADMAP.md` 轨 A | pi 嫁接总览；本计划细化 **嫁接前** 接缝 |
| `SPEC_TUI.md` | v0.1 readline 规范；本计划为 **体验升级** 记录 |
| `SPEC_CONTEXT_MANAGEMENT.md` | handoff 与 compression/pointerize **互补** |
| `docs/BRANCH_PLAN_HOSPITAL_DEVICE_ASSISTANT.md` | 医院设备端 **独立**；JIT 权限模型可复用 |

---

## 12. 明确不做（本计划范围外）

- 在线改 `agent.json` 热重载；
- workflow 可视化编辑器；
- 替代 HIS / EMR；
- 为 pi 嫁接重写 `runAgent` / 压缩触发条件；
- 将 `dangerous-always-approve` 用于 workflow 进门或 handoff 强制截断。

---

## 13. 决策记录

| 日期 | 决定 |
|------|------|
| 2026-07-01 | 采纳顺序：权限 → handoff → workflow 逃生 → 多 API / 全分支 → pi |
| 2026-07-01 | 文档仅备案，**不**并入 `ROADMAP.md` |
| 2026-07-01 | **M1 开工**：PermissionGate、workflow checkpoint、`/resume last`、`--resume-last` |
| 2026-07-01 | **M2 完成**：`/approve` L3、`spawn_policy`、workflow `!`/`run` 别名 |

---

*本文档随实现进展可追加「已完成 / 搁置」小节；不表示已对外的产品承诺。*