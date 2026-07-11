# minimal-agent-ts TUI Spec（v0.1 草案）

> **范围**: 原版 `minimal-agent-ts` 的终端 UI 层；**不修改** ReAct 内核语义（`agent.ts` 主循环、pointerize、compression 策略保持不变）。  
> **目标**: 比纯 CLI 更易用；slash 覆盖日常操作；事件驱动、可后接 GUI。

---

## 1. 非目标（v0.1 不做）

- GUI / Electron / Web
- 在线编辑 `agent.json` / workflow 可视化
- 前缀缓存专项优化（见 `minimal-agent-ts-ds-cache` fork）
- 多进程 daemon + 远程 attach
- 花里胡哨 onboarding / 营销文案

---

## 2. 架构

```
┌──────────────────────────────────────┐
│  src/tui/          Ink 或 blessed    │
│  - App.tsx / loop                  │
│  - slash parser                    │
│  - presenter（订阅事件 → 渲染）       │
└──────────────┬───────────────────────┘
               │ 同进程调用
┌──────────────▼───────────────────────┐
│  src/runner.ts（新建，从 main 抽出）  │
│  - AgentRuntime：config/session 可变 │
│  - runTask(prompt) → AsyncGenerator   │
│  - abortSignal                        │
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐
│  runAgent / runWorkflow（现有）       │
└──────────────────────────────────────┘
```

### 入口

| 命令 | 说明 |
|------|------|
| `npm start -- "task"` | 现有 headless CLI（保持） |
| `npm run tui` | 新 TUI（`tsx src/tui/main.tsx`） |
| `npm start -- --json-events -- "task"` | NDJSON 事件流（调试 / 第三方 UI） |

`main.ts` 逻辑逐步迁到 `src/runner.ts`；`main.ts` 与 `tui` 共用 runner。

---

## 3. 运行态（UI 状态机）

| 状态 | 含义 | 输入框 |
|------|------|--------|
| `idle` | 无 agent 在跑 | 接受普通 task 文本 |
| `running` | `runAgent` 进行中 | 仅 slash（`/stop` 等）；普通文本进 **队列**（v0.2，v0.1 可禁用并提示） |
| `stopping` | 已 `/stop`，等当前 fetch/tool 收尾 | 禁用 |

TUI 根据 `AgentStepEvent` 推导状态：`turn_start` → running；`final` / stopped → idle。

### 3.1 TUI 工具默认（与 headless CLI 分离）

headless `npm start` **保持** opt-in（`--allow-shell` / `--allow-web`，默认 off）——验收 §9.6 不变。

TUI 是日常交互入口，阶段性保守默认（全 off）已不适用：18–20 turn 的网络漫游 + shell 任务实测稳定，workflow worker 也普遍需要 `run_shell`。因此 **仅 TUI / `AgentRuntime` 初始化** 采用更宽松的默认：

| 开关 | TUI 默认值 | headless 默认 |
|------|------------|---------------|
| `allowShell` | **on** | off |
| `allowWeb` | off | off |

**首次进入确认**（非花里胡哨 onboarding，一行搞定）：

- 若无 prefs 文件（`{project}/.tui-prefs.json` 或 `~/.config/minimal-agent-ts/tui-prefs.json`，实现时二选一），进入 `idle` 前 Stage 显示：
  ```
  Tools: shell [on]  web [off]  —  Enter 确认，s/w 切换，之后可用 /shell /web 改
  ```
- 用户确认后写入 prefs；**之后启动不再询问**，直接读 prefs（缺字段则用上表默认）。
- 已有 prefs 时跳过；`/shell` `/web` 变更 **不** 自动写 prefs（v0.1 仅首次确认持久化；热切换当次 session 有效即可）。

`npm run tui -- --no-shell` / `--no-web` / `--allow-web` 可覆盖默认（与 CLI flag 同名，仅 TUI 入口解析）。

---

## 4. 布局（三轨，固定比例可配置）

```
┌─ Timeline ─────────┬─ Stage ─────────────────┬─ Status ─────┐
│ turn 3 • 2 tools   │ 流式 assistant 文本      │ session_id   │
│ turn 2 ○ compress  │ 或选中 tool preview     │ cwd          │
│ turn 1 ✓           │                         │ shell/web    │
├────────────────────┴─────────────────────────┴──────────────┤
│ › 输入（idle）或 › :slash（running）                           │
└──────────────────────────────────────────────────────────────┘
```

**渲染纪律**

- `tool_result` **默认 preview**（≤400 字符或 `action-preview` 一行 summary）；Enter 展开 / `/recall`
- `token` 事件 16ms 批量刷新 Stage，避免每字符重绘 Timeline
- Timeline 只显示结构（turn、tool 名、ok/error），不塞全文
- 同一 turn 内纵向顺序（pi chat log）：`turn_start` → `tool_plan`（若有）→ `tool_call` / `tool_result` → 流式 assistant（`token` / `final`）；meta 行始终在 LLM 流式块**上方**（见 §5.4）

---

## 5. 事件协议

### 5.1 现有 `AgentStepEvent`（不变）

见 `src/agent.ts`：`turn_start` | `token` | `llm_done` | `tool_plan` | `tool_batch` | `tool_*` | `compression` | `loop_guard` | `final`。

### 5.2 v0.1 扩展（内核小改，仅附加字段/事件）

```typescript
// tool_result 增加可选 preview（UI 优先显示，output 仍可用于 recall）
{ type: 'tool_result'; turn; name; output; preview?: string }

// 新增
{ type: 'run_start'; session_id: string; cwd: string }
{ type: 'run_end'; reason: 'completed' | 'aborted' | 'error'; message?: string }
{ type: 'session_saved'; session_id: string; task_count: number }
{ type: 'runtime'; shell: boolean; web: boolean }  // allow 开关变化时

// v0.2 — 工具调度可观测性（§5.4）；与 tool_batch 并存
{
  type: 'tool_plan';
  turn: number;
  total: number;
  parallel_count: number;
  serial_count: number;
  entries: Array<{
    id: string;              // ToolCall.id
    name: string;
    args_preview: string;    // 截断后的 args JSON，与 tool_call.args 同规则
    disposition: 'parallel' | 'serial';
    reason: ToolPlanReason;
    detail?: string;         // 可选：path、冲突对象等
  }>;
}

type ToolPlanReason =
  | 'parallel_safe'
  | 'serial_only_tool'
  | 'not_parallel_safe'
  | 'conflicts_pending_write'
  | 'conflicts_shell_on_path';
```

### 5.3 `--json-events` 行格式

每行一个 JSON 对象，stdout 专用；人类 log 走 stderr 或不输出。

```json
{"ts":1719660000123,"event":{"type":"tool_call","turn":2,"name":"read_file","args":"{\"path\":\"README.md\"}"}}
```

### 5.4 `tool_plan`（工具调度可观测性）

> **动机**：LLM 一次返回多个 `tool_calls` 时，用户需要知道**哪些会并行、哪些必须串行、以及为什么**——便于调试 agent 行为，而不必读 `tool-scheduler.ts` 或猜 harness 策略。  
> **原则**：`reason` 必须来自 `scheduleToolCalls()` 的**确定性规则**，不得由 LLM 文案或启发式猜测填充。

#### 5.4.1 发射时机与顺序

在 `src/agent.ts` 中，当 `message.tool_calls.length > 0`：

1. `commitAssistantToolCalls` 之后、`executeTool` 之前，调用扩展后的 `scheduleToolCalls()` 得到 `plan` + `entries`
2. 发射 **`tool_plan`**（每个 entry 一条调度结论）
3. 发射 **`tool_batch`**（兼容现有消费者；仅 `total` + `parallel` 计数摘要）
4. 执行：`Promise.all(plan.parallel)` → 按 `plan.serial` 顺序 `await` 逐个执行
5. 执行过程中照常发射 `tool_call` / `tool_result`

同一 turn 内事件顺序：

```
turn_start → llm_done → tool_plan → tool_batch? → tool_call* → tool_result* → (下一 turn 或 final)
```

`tool_batch` 在 `parallel_count <= 1` 时 presenter **可不渲染**（与今日行为一致）；`tool_plan` 在 `total >= 2` 时仍应渲染一行摘要。

#### 5.4.2 调度原因（与 `src/tool-scheduler.ts` 一一对应）

| `reason` | `disposition` | 判定条件（当前实现） |
|----------|---------------|----------------------|
| `serial_only_tool` | `serial` | 工具名 ∈ `{ write_file, edit_file, run_shell }` |
| `not_parallel_safe` | `serial` | 既不在 `PARALLEL_SAFE`，也不是 `mcp_*` 前缀 |
| `conflicts_pending_write` | `serial` | 只读候选的 `path` 与同批已登记的 `writePaths` 冲突 |
| `conflicts_shell_on_path` | `serial` | 只读候选的 `path` 与同批 `run_shell` 的 `command` 字符串冲突 |
| `parallel_safe` | `parallel` | 通过上述检查，进入 `plan.parallel` |

**`detail` 字段（可选，建议）**

| `reason` | `detail` 示例 |
|----------|----------------|
| `serial_only_tool` | `write_file` / `run_shell` |
| `conflicts_pending_write` | `path=src/foo.ts` |
| `conflicts_shell_on_path` | `path=package.json shell=cat package.json` |
| `parallel_safe` | 省略，或 `path=README.md`（有 path 时） |

**非目标（本切片不改）**

- 不修改调度策略本身（仍保守：仅明确独立的只读类可并行）
- 不从 `llm.ts` / reasoning 字段推断「模型为何选并行」
- 不新增 workflow `when` / 分支决策事件（属 M6）
- `entries` 顺序：与 LLM 原始 `tool_calls` 顺序一致（便于对照）；**执行顺序**仍由 scheduler 的 `parallel` + `serial` 数组决定

#### 5.4.3 与 `tool_batch` 的关系

| 事件 | 职责 |
|------|------|
| `tool_plan` | 结构化、逐工具、带 `reason`；供 TUI / `--json-events` / 调试 |
| `tool_batch` | 向后兼容的计数摘要；`parallel > 1` 时一行 `⚡ parallel batch: N/M` |

新代码应优先消费 `tool_plan`；`tool_batch` 保留至 v0.3 再评估废弃。

#### 5.4.4 TUI 展示（pi presenter）

**默认（v0.2）**：单行摘要，走 `appendRunMeta`（dim），位于该 turn 的 `tool_call` 行**之上**：

```
[turn 3] LLM
plan: 4 tools — parallel 2, serial 2
→ read_file({"path":"a.ts"})
→ grep_search({"pattern":"foo"})
...
```

**展开（v0.2 可选 / v0.3）**：第二行起缩进列出 disposition + reason，例如：

```
  ∥ read_file        parallel_safe
  ∥ grep_search      parallel_safe
  → write_file       serial_only_tool
  → run_shell        serial_only_tool
```

符号约定：`∥` = parallel，`→` = serial（与 `tool_call` 前缀一致）。

**headless `printStepEvent`**：与 pi 同文案；`--json-events` 输出完整 `entries` 数组。

#### 5.4.5 实现清单（内核小改）

| 文件 | 改动 |
|------|------|
| `src/tool-scheduler.ts` | `scheduleToolCalls()` 返回 `{ parallel, serial, entries }` |
| `src/events.ts` | 增加 `tool_plan` 联合成员 + `ToolPlanReason` |
| `src/agent.ts` | `tool_plan` 在 `tool_batch` 之前 `onStep` |
| `src/tui/pi/event-presenter.ts` | `appendRunMeta` 渲染 plan 摘要（+ 可选展开） |
| `src/tui/log.ts` | `isAgentStep` 纳入 `tool_plan` |
| `src/runner.ts` | `printStepEvent` 分支 |
| `tests/tool-scheduler.test.ts`（新建） | reason 映射单元测试 |

**验收**

1. 单工具 turn：无 `tool_plan` 行（或 `total === 1` 时省略摘要，实现二选一并在测试中固定）
2. `read_file` ×2 + `write_file`：plan 显示 2 parallel + 1 serial，`write_file` 的 reason 为 `serial_only_tool`
3. 同批 `write_file` + `read_file` 同 path：后者 reason 为 `conflicts_pending_write`
4. pi TUI：plan 行在 `→ tool_call` 之上、流式回复之下
5. `--json-events` 可解析 `tool_plan.entries`

---

## 6. Slash 命令（v0.1 必须）

以 `/` 开头；running 与 idle 均可用（另有说明的除外）。解析后 **不** 发给 LLM。

### 6.1 会话

| 命令 | 行为 | 对应今日 CLI |
|------|------|--------------|
| `/sessions` | 列出 `.sessions/*.json`（id、时间、task 数） | 无（用 `listSessions()`） |
| `/resume <id>` | 加载 session；**idle 时**下一道 task 续接 | `--resume <id>` |
| `/new` | 新建 session（不自动清屏，Timeline 标分界） | 新 `createSession()` |
| `/quit` | 退出 TUI；若 session 有变更则 `saveSession`；`process.exit(0)` | 无 |

**约束**: `/resume`、`/workflow` 在 `running` 时拒绝并提示先 `/stop`。

### 6.2 运行时开关（内存态，写入下一 task 的 `AgentConfig`）

| 命令 | 行为 | 对应今日 CLI |
|------|------|--------------|
| `/shell on` | `allowShell = true`；刷新 tool 列表 | `--allow-shell` |
| `/shell off` | `allowShell = false` | headless 默认 off；**TUI 默认 on**（§3.1） |
| `/web on` | `allowWeb = true` | `--allow-web` |
| `/web off` | `allowWeb = false` | TUI / headless 默认 off |

切换后发 `runtime` 事件；Status 栏显示 `shell:on web:off`（TUI 冷启动多为 `shell:on`）。**已在跑的 turn 不 retroactive**（与 CLI 一致）。

### 6.3 Skills

| 命令 | 行为 | 对应今日 CLI |
|------|------|--------------|
| `/skills` | 列出 `toolRegistry.listSkillNames()` + 简短 description | 无 |
| `/skills load <name>` | 追加到 `pluginConfig.loaded_skills`；下轮 task 生效 | `--load-skills` |

v0.1 **不** 做 `/skills unload`（可 v0.2）。

### 6.4 Workflow 启动（无专门 UI）

不做流程图/角色面板；Timeline 仅像 CLI 一样打印 `workflow ▶ role / loop` 行。

| 命令 | 行为 | 对应今日 CLI |
|------|------|--------------|
| `/workflow` | 列出 `workflows/*.json`（basename） | 无 |
| `/workflow <name\|path>` | **武装**下一道 task：Status 显示 `workflow: …`；紧随其后的普通输入走 `runWorkflow` | `--workflow <path>`（task 另输） |
| `/workflow <name\|path> <task…>` | 立即启动 workflow，`<task…>` 为 user task | `--workflow <path> -- "task"` |

**路径解析**

- `<name>` 无 `/` 且不以 `.json` 结尾 → `workflows/<name>.json`
- 否则 → 相对 `cwd` 的路径（与 CLI 一致）
- 文件不存在 → slash 报错，保持 idle

**与 `/shell` 关系**: TUI 默认 shell on（§3.1），`review-loop` 一般无需再开；若用户 `/shell off` 或 `--no-shell` 启动，worker 缺 shell 时 `runWorkflow` 抛错，Stage 提示 `/shell on`。

**展示**: 复用现有 `onWorkflowStep` + `AgentStepEvent`；**不**新增 workflow 专用组件。

### 6.5 工具与上下文

| 命令 | 行为 |
|------|------|
| `/tools` | 列出当前 `getToolDefinitions()`（含 MCP） |
| `/stop` | `AbortSignal.abort()`；见 §7 |
| `/cwd <path>` | 更新 runtime `cwd`（idle 或下轮生效） |

### 6.6 v0.1 可选（时间够再做）

| 命令 | 行为 |
|------|------|
| `/recall <action_id>` | 本地调 `recallQuery`，结果弹 Stage（不经过 LLM） |
| `/context` | 展示 `assembleApiMessages` 条数 + 近几条角色/长度 |

### 6.7 明确不做进 v0.1 slash

- workflow 流程图 / 角色分栏 / 修订轮可视化
- `/config` 热重载
- `/inject` 运行中插话
- 自然语言 alias

### 6.8 Slash 迁移（2026-07 rename）

减少与 Codex `/handoff`（git/worktree 迁移）及通用词歧义：

| 新命令 | 旧命令（deprecated，仍解析） | 说明 |
|--------|------------------------------|------|
| `/actions [id]` | `/log` | 任务与工具调用审计 |
| `/transcript [id]` | `/history` | user/assistant 对话时间线 |
| `/brief` | `/handoff` | 写 session 摘要 markdown（**非** git 迁移） |
| `/brief load [id]` | `/handoff load` | 排队注入下条 task |
| `/new brief` | `/new handoff` | 写摘要并新建 session |

**已删除别名**：`/session`（用 `/sessions`）、`/provider`（用 `/profile`）。

内部仍写 `.sessions/handoff_<id>.md`；CLI `--handoff` 不变。

---

## 7. `/stop`（Abort）语义

### 7.1 机制

- `AgentRuntime` 持有 `AbortController`
- `src/llm.ts` 的 `fetch` 传入 `signal`；abort 时抛 `AbortError`
- `runAgent` 顶层 catch：`run_end { reason: 'aborted' }`；**保留** 已写入的 `messages` 并 `saveSession`

### 7.2 边界

| 场景 | 行为 |
|------|------|
| LLM 流式中 | 尽快断流，返回 idle |
| 子进程 `run_shell` 中 | v0.1：发 SIGTERM 给 child（`shell.ts` 需接 abort）；未完成则 Stage 提示 `shell still running` |
| 并行 tool 一批中 | 已完成的保留；未开始的跳过 |
| workflow 多角色 | 走 `/workflow` 启动；**无**专用 UI；`/stop` 中断整次 `runWorkflow` |

### 7.3 UI

- `/stop` 后 Timeline 标记 `⊗ aborted turn N`
- session **不丢**；可 `/resume` 同 id 再发 task

---

## 8. `AgentRuntime` 职责（`src/runner.ts`）

```typescript
interface TuiRuntimeDefaults {
  allowShell: true;   // TUI only; headless stays false
  allowWeb: false;
}

interface AgentRuntime {
  config: AgentConfig;           // 含 allowShell/allowWeb，可突变；TUI 按 §3.1 初始化
  session: SessionFile;
  pluginConfig: AgentPluginConfig;

  listSessions(): SessionMeta[];
  resumeSession(id: string): boolean;
  newSession(): void;
  setAllowShell(on: boolean): void;
  setAllowWeb(on: boolean): void;
  loadSkill(name: string): void;
  setCwd(path: string): void;

  /** 普通单 Agent 任务 */
  runTask(prompt: string): Promise<AgentResult>;
  /** workflow；path 已由 /workflow 武装或参数传入 */
  runWorkflow(prompt: string, workflowPath: string): Promise<AgentResult>;
  /** 仅设置下一 task 的 workflow 路径；空则清除 */
  armWorkflow(path: string | null): void;
  listWorkflows(): string[];

  abort(): void;
}
```

TUI 只调 Runtime；不直接 `runAgent`。

---

## 9. 实现顺序

| 步骤 | 内容 | 触动内核 |
|------|------|----------|
| **P0** | `runner.ts` 抽出；`llm` AbortSignal；`tool_result.preview` | 小 |
| **P1** | `--json-events` | 小 |
| **P2** | TUI 骨架：Timeline + Stage + Status + 输入 | 新 `src/tui/` |
| **P3** | slash：§6.1–6.5 全部（含 `/quit`、`/workflow`） | Runtime |
| **P4** | `/recall` `/context` | 可选 |
| **P5** | `shell.ts` abort 传播 | 小 |
| **P6** | `tool_plan` 事件 + presenter（§5.4） | 小 |

**验收（v0.1）**

1. `npm run tui` 启动，发 task，见流式输出与 tool 折叠  
2. 冷启动（默认 shell on）`/tools` 已含 `run_shell`；`/shell off` 后消失
3. `/sessions` + `/resume` 续接同 session  
4. `/stop` 中断长跑，session 可再 resume  
5. `/skills` 列出；`/skills load` 后下轮 task 生效  
6. headless `npm start` 行为与改前一致  
7. `/workflow review-loop 某任务` 能跑通（Timeline 仅有文本阶段行，无流程图）  
8. `/quit` 正常退出且 session 已保存

---

## 10. 依赖建议

- **TUI 框架**: [OpenTUI](https://github.com/anomalyco/opentui) 或 Ink（二选一，P2 定）
- **无** 新后端依赖

`package.json` 增加：

```json
"scripts": { "tui": "tsx src/tui/main.tsx" }
```

---

## 11. 与上下文实验的关系

- TUI **展示** compression / loop_guard / pointer 折叠，**不改变**触发条件  
- `/context`（若做）只读 `assembleApiMessages`，方便观察「事件前后」差异  
- Spec 纪律（DIY）不在 v0.1 做交互编辑；Status 栏只 **显示** `keep_inline_turns`（读 `agent.json`）

---

## 12. 版本

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-06-29 | v0.1 | 初稿：架构、slash 最小集、abort、事件扩展 |
| 2026-06-29 | v0.1.1 | 增加 `/quit`；`/workflow` 启动（无专门展示） |
| 2026-06-30 | v0.1.2 | TUI：`allowShell` 默认 on；首次进入一行确认 shell/web；headless 仍 opt-in |
| 2026-07-02 | v0.2.0 | §5.4 `tool_plan`：调度可观测性（reason 来自 `tool-scheduler`；与 `tool_batch` 并存） |