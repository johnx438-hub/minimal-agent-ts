# minimal-agent-ts

用 TypeScript 写的 **ReAct Agent 学习项目**——从最小循环起步，逐步叠加上下文管理、工具生态、子 Agent 委派与多角色编排（不依赖 pi / rig / scream / zerostack）。

**仓库**: https://github.com/johnx438-hub/minimal-agent-ts

详细设计见 [`SPEC_CONTEXT_MANAGEMENT.md`](SPEC_CONTEXT_MANAGEMENT.md)，TUI 见 [`SPEC_TUI.md`](SPEC_TUI.md)，上手命令见 [`QUICKSTART.md`](QUICKSTART.md)。

> **变体**：DeepSeek 前缀缓存友好 fork `minimal-agent-ts-ds-cache`（冻结指针卡片、尾部 append 压缩）为本地 sibling 项目；本仓库保留 OpenCode 式上下文实验默认行为。

## 特性概览

| 能力 | 说明 |
|------|------|
| ReAct 主循环 | 手写 `agent.ts`，流式 LLM + 并行 tool 调度 |
| 上下文管理 | 指针化、冷存储、`recall_query`、prune / 压缩事件 |
| Loop guard | 重复工具检测 → nudge → 强制总结；terminate 后 session 回滚 |
| 子 Agent | `spawn_agent` 同步委派；`spawn_background` 非阻塞后台 job |
| 代码审查 | `code_review` 并发 bug/security/quality 子 Agent，支持 `background: true` |
| Workflow | JSON 驱动多角色（Planner → Worker → Reviewer） |
| TUI | `npm run tui` — pi-tui 终端界面，slash 命令、会话浏览 |
| 插件 | MCP stdio、`invoke_skill`、可配置 `agent.json` |

## 项目结构

```
src/
  agent.ts              # ReAct 主循环（核心）
  runner.ts             # 会话生命周期、task/workflow 入口
  llm.ts / llm-retry.ts # OpenAI 兼容 chat + 重试
  main.ts               # CLI 入口
  spawn-cli.ts          # 后台 job CLI（list/status/kill/tail）
  loop-guard.ts         # 循环检测、强制总结、注入消息清理
  session.ts            # 会话持久化（.sessions/）
  action-store.ts       # 冷存储（tool 结果全文，运行时落在 .sessions/actions/）
  action-write-queue.ts # 异步批量写盘
  action-preview.ts     # 指针卡片 smart 摘要
  pointerize.ts         # 大结果指针化
  recall.ts             # recall_query 解引用
  context-budget.ts     # Token 预算与压缩触发
  context-policy.ts     # OpenCode 式 prune / 压缩
  tool-scheduler.ts     # 工具并行调度（读写冲突降级串行）
  spawn/
    job-registry.ts     # 后台 job 注册与磁盘状态
    job-runner.ts       # 子进程 / 内嵌 spawn 执行
    job-cancel.ts       # cancel.requested 跨进程取消
    load-preset.ts      # agents/*.md 预设加载
  tools/
    registry.ts         # 工具注册 + MCP 合并
    spawn.ts            # spawn_agent
    spawn-background.ts # spawn_background
    code-review.ts      # code_review（同步 / 后台）
    read-write.ts, edit-file.ts, explore.ts, shell.ts, web-fetch.ts, ...
  workflow/             # 多角色 workflow 执行器
  tui/                  # 终端 UI（pi-tui）

agents/                 # spawn 预设（code-review-bug/security/quality 等）
workflows/              # review-loop.json 等
roles/                  # workflow 角色 MD
skills/context-design/  # 仓库内置 skill；其余 skill 本地自备
agent.json              # 工具、spawn 预设、指针化、MCP 配置
```

### ReAct 循环（`agent.ts`）

```
turn 1..N:
  1. assembleApiMessages → LLM（Reason + 可能 Act）
  2. 若有 tool_calls → tool-scheduler 并行/串行执行 → 冷存 + 热写（Observe）
  3. turn 结束 → pointerize / prune / 压缩事件
  4. 若无 tool_calls 且有文本 → 返回最终答案
  5. loop_guard：重复无进展 → soft_nudge → forced_summary（tools=[]）→ 或 terminate
```

对应 scream 的 `runTurn` / zerostack 的 `spawn_agent` + rig，这里**全部手写**，方便对照阅读。

## 快速开始

```bash
git clone https://github.com/johnx438-hub/minimal-agent-ts.git
cd minimal-agent-ts
npm install
cp .env.example .env   # 填入 OPENAI_API_KEY

# 只读任务（默认关闭 run_shell / web_fetch）
npm start -- "列出当前目录文件，读 README，用一句话总结"

# 终端 UI
npm run tui

# 允许 shell / 联网
npm start -- --allow-shell "运行 npm run typecheck 并汇报结果"
npm start -- --allow-web "抓取 https://example.com 并总结"

# 续接会话
npm start -- --resume session_20260627203000 "继续上次的工作"

# 同步子 Agent
npm start -- "用 spawn_agent 预设 skeleton-reader 画一份仓库骨架"

# 后台代码审查（非阻塞，返回 job_id）
npm start -- --allow-shell "code_review scope=HEAD~3 background=true，完成后读 workspace 报告"

# 查看后台 job
npm run spawn:list
npm run spawn:status -- <job_id>

# 多角色 workflow
npm start -- --workflow workflows/review-loop.json "实现一个小功能"

# 加载 Skill（仓库内置 context-design）
npm start -- --load-skills context-design "设计上下文策略"
```

## 内置工具

| 工具 | 说明 |
|------|------|
| `read_file` | 读文件，返回 `[file_meta hash=…]` 供锚点编辑 |
| `write_file` | 写文件（新文件或全文重写） |
| `edit_file` | 局部编辑，需 `expected_hash` 防并发覆盖 |
| `grep_search` | 项目内搜索（rg / grep） |
| `list_files` | 目录列举 |
| `diff_file` | 与冷存储快照或指定文本对比 |
| `recall_query` | 按 `action_id` 或冷存关键词捞回历史 tool 结果 |
| `invoke_skill` | 加载 `skills/` 下的 SKILL.md 指引 |
| `run_shell` | 执行 shell（需 `--allow-shell`） |
| `web_fetch` | 抓取 URL → Markdown（L1 HTTP；可选本地 cloak-fetch L2） |
| `spawn_agent` | 同步委派子 Agent（`agents/*.md` 预设） |
| `spawn_background` | 启动后台 job，立即返回 `job_id` |
| `code_review` | 并发 bug/security/quality 审查；`background: true` 非阻塞 |
| `mcp_<server>_<tool>` | MCP 插件工具（`agent.json` 配置） |

工具开关在 `agent.json` 的 `builtin_tools`；`run_shell` 需 `--allow-shell`，`web_fetch` 需 `--allow-web`。

### 后台 job 状态机

后台任务写入 `workspace/jobs/<job_id>/`（本地，不进 git）：

```
meta.json → events.jsonl → result.json / report.md
```

CLI：`npm run spawn:{list,status,kill,tail}`。

## Skills 与本地数据

| 路径 | 说明 | git |
|------|------|-----|
| `skills/context-design/` | 仓库内置示例 skill | ✅ |
| `skills/*`（其他） | 如 `cloak-fetch`、自定义 skill | ❌ 本地自备 |
| `.sessions/` | 会话、action 冷存、向量索引 | ❌ |
| `.env` | API Key | ❌ |
| `workspace/` | 审查报告、`jobs/` 输出 | ❌ |

公开版 `agent.json` 默认 `cloak_fetch_enabled: false`。本地安装 `skills/cloak-fetch/` 后可手动开启。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | — | API Key（Gemini/OpenAI 兼容） |
| `OPENAI_BASE_URL` | Gemini OpenAI 兼容端点 | 可换 OpenRouter 等 |
| `MODEL` | 见 `.env.example` | 模型名 |
| `MAX_TURNS` | `0` | `0` = 不限轮次；正整数为硬上限 |
| `LOOP_HARD_CEILING` | `200` | `MAX_TURNS=0` 时的安全顶 |
| `LOOP_GUARD` | `inject` | `inject` / `terminate` / `off` |
| `LOOP_GUARD_REGRESSION` | — | 设为 `1` 放宽 review 回归任务的重复检测 |
| `ALLOW_SHELL` / `ALLOW_WEB` | `0` | 启用对应工具 |
| `STREAM` | `1` | 设为 `0` 关闭流式输出 |
| `ACTION_IO_METRICS` | — | headless：`turn_io` / `action_flush` 行级指标 |
| `MAX_CONTEXT_TOKENS` | — | 手动覆盖模型上下文上限 |

## 路线图状态

**功能 Phase（1–6）** 见下表；**统一规划**（产品轨、底座模块化、压测、Hooks）见 **[docs/ROADMAP.md](./docs/ROADMAP.md)**；轨 A–G 缩写见 **[ROADMAP.md](./ROADMAP.md)**。

| Phase | 主题 | 状态 |
|-------|------|------|
| 1 | 会话续接 + TaskSummary + 滑动窗口 | ✅ |
| 2 | 冷存储 + 指针化 + recall + context-policy | ✅ |
| 3 | 跨 session 记忆 | 🔗 外部 MemFileCli（不内置） |
| 4 | 工具扩展 + 并行执行 + SSE 流式 | ✅ |
| 5 | MCP / Skills 插件层 | ✅ |
| 6 | 多角色 workflow（config 驱动） | ✅ |
| 1a–1d | 后台 spawn：`JobRegistry` + `spawn_background` + `code_review` 后台模式 | ✅ |

当前测试：**382** 用例（`npm test`）。

## 建议学习顺序

1. `src/agent.ts` — ReAct 主循环与压缩 / pointerize 钩子
2. `src/loop-guard.ts` — 循环检测、强制总结、session 污染防护
3. `src/tools/registry.ts` — 工具注册与 MCP 合并
4. `src/pointerize.ts` + `src/action-preview.ts` — 大结果瘦身与 smart 摘要
5. `src/spawn/job-registry.ts` + `src/tools/code-review.ts` — 后台子 Agent
6. `src/workflow/runner.ts` — 多角色编排

## 下一步

见 **[docs/ROADMAP.md](./docs/ROADMAP.md)**：

- [x] **M-Prod-1** TUI `/jobs` + job-query 层
- [x] **M-Prod-2** `web_search` 工具（ddgr + cache + budget）
- [ ] **压测 harness** stress preset + 并行 `spawn_background` dev-worker
- [ ] **MessageBridge** hook（IM 预留，见 docs/ROADMAP §6）
- [ ] 底座 L1–L3（ToolProvider、context pipeline、hooks）