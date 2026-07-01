# minimal-agent-ts

用 TypeScript 写的 **ReAct Agent 学习项目**——从最小循环起步，逐步叠加上下文管理、工具生态与多角色编排（不依赖 pi / rig / scream / zerostack）。

详细设计见 [`SPEC_CONTEXT_MANAGEMENT.md`](SPEC_CONTEXT_MANAGEMENT.md)，上手命令见 [`QUICKSTART.md`](QUICKSTART.md)。

> **变体**：DeepSeek 前缀缓存友好 fork → [`../minimal-agent-ts-ds-cache`](../minimal-agent-ts-ds-cache)（冻结指针卡片、尾部 append 压缩）。本仓库保留 OpenCode 式上下文实验默认行为。

## 项目结构

```
src/
  agent.ts              # ReAct 主循环（核心）
  llm.ts                # OpenAI 兼容 chat/completions
  main.ts               # CLI 入口
  types.ts              # Message / ToolCall / Session 类型
  session.ts            # 会话持久化（.sessions/）
  action-store.ts       # 冷存储（tool 结果全文）
  action-preview.ts     # 指针卡片 smart 摘要
  pointerize.ts         # 大结果指针化
  recall.ts             # recall_query 解引用
  context-budget.ts     # Token 预算与压缩触发
  context-policy.ts     # OpenCode 式 prune
  loop-guard.ts         # 循环检测与收口总结
  tool-scheduler.ts     # 工具并行调度
  embedding.ts          # 本地 embedding（Zvec 检索）
  action-index.ts       # Zvec 混合索引
  tools.ts              # 兼容 re-export → tools/registry.ts
  tools/
    registry.ts         # 工具注册 + MCP 合并
    read-write.ts       # read_file / write_file
    edit-file.ts        # edit_file（hash 锚定局部编辑）
    file-hash.ts        # 文件 hash 元数据
    explore.ts          # grep_search / list_files / diff_file
    shell.ts            # run_shell
    recall.ts           # recall_query 工具
    skills-tool.ts      # invoke_skill
  plugins/
    config-loader.ts    # agent.json 加载
    mcp-manager.ts      # stdio MCP
    skills.ts           # Skills 发现
  workflow/
    runner.ts           # 多角色 workflow 执行器
    load-workflow.ts    # JSON workflow 解析
    load-role.ts        # Markdown role + frontmatter
    template.ts         # {{role.output}} 模板
    verdict.ts          # reviewer 裁决解析

workflows/review-loop.json   # 内置：Planner → Worker → Reviewer
roles/                       # planner.md / worker.md / reviewer.md
skills/                      # 本地 Skills（SKILL.md）
agent.json                   # 工具开关、指针化、MCP、Skills 配置
```

### ReAct 循环（`agent.ts`）

```
turn 1..N:
  1. assembleApiMessages → LLM（Reason + 可能 Act）
  2. 若有 tool_calls → tool-scheduler 执行 → 冷存 + 热写（Observe）
  3. turn 结束 → pointerize / prune / 压缩事件
  4. 若无 tool_calls 且有文本 → 返回最终答案
  5. loop_guard 检测重复工具调用 → nudge 或强制收口总结
```

对应 scream 的 `runTurn` / zerostack 的 `spawn_agent` + rig，这里**全部手写**，方便对照阅读。

## 快速开始

```bash
cd minimal-agent-ts
npm install
cp .env.example .env   # 填入 OPENAI_API_KEY

# 只读任务（默认关闭 run_shell）
npm start -- "列出当前目录文件，读 README，用一句话总结"

# 允许执行 shell
npm start -- --allow-shell "运行 npm run typecheck 并汇报结果"

# 指定工作目录
npm start -- --cwd /path/to/project "用一句话说明这个项目"

# 续接会话
npm start -- --resume session_20260627203000 "继续上次的工作"

# 多角色 workflow
npm start -- --workflow workflows/review-loop.json "实现一个小功能"

# 加载 Skill
npm start -- --load-skills context-design "设计上下文策略"

# 查看可用工具
npm start -- --list-tools
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
| `recall_query` | 按 `action_id` 或语义搜索捞回历史 tool 结果 |
| `invoke_skill` | 加载 `skills/` 下的 SKILL.md 指引 |
| `run_shell` | 执行 shell（需 `--allow-shell`） |
| `web_fetch` | 抓取 URL → Markdown（L1 HTTP + 可选 L2 cloakFetch） |
| `mcp_<server>_<tool>` | MCP 插件工具（`agent.json` 配置） |

工具开关在 `agent.json` 的 `builtin_tools`；`run_shell` 需 `--allow-shell`，`web_fetch` 需 `--allow-web`。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | — | API Key（Gemini/OpenAI 兼容） |
| `OPENAI_BASE_URL` | Gemini OpenAI 兼容端点 | 可换 OpenRouter 等 |
| `MODEL` | `gemini-2.0-flash` | 模型名 |
| `MAX_TURNS` | `0` | `0` = 不限轮次；正整数为硬上限 |
| `LOOP_HARD_CEILING` | `200` | `MAX_TURNS=0` 时的安全顶 |
| `LOOP_GUARD` | `inject` | 循环检测：`inject` / `terminate` / `off` |
| `ALLOW_SHELL` | `0` | 设为 `1` 启用 `run_shell` |
| `STREAM` | `1` | 设为 `0` 关闭流式输出 |
| `MAX_CONTEXT_TOKENS` | — | 手动覆盖模型上下文上限 |

## 路线图状态

**功能 Phase（1–6）** 见下表；**后续轨 A/B/C**（TUI 嫁接、TS 性能、Rust 内核）见 **[ROADMAP.md](./ROADMAP.md)**。

| Phase | 主题 | 状态 |
|-------|------|------|
| 1 | 会话续接 + TaskSummary + 滑动窗口 | ✅ |
| 2 | 冷存储 + 指针化 + recall + context-policy | ✅ |
| 3 | 跨 session 记忆 | 🔗 外部 MemFileCli（`memfilecli` + skill，不内置） |
| 4 | 工具扩展 + 并行执行 + SSE 流式 | ✅ |
| 5 | MCP / Skills 插件层 | ✅ |
| 6 | 多角色 workflow（config 驱动） | ✅ |

## 建议学习顺序

1. `src/agent.ts` — ReAct 主循环与压缩/pointerize 钩子
2. `src/tools/registry.ts` — 工具注册与 MCP 合并
3. `src/pointerize.ts` + `src/action-preview.ts` — 大结果瘦身与 smart 摘要
4. `src/recall.ts` + `src/action-store.ts` — 冷存储与按需捞回
5. `src/workflow/runner.ts` — 多角色编排
6. 对照 `../SCREAM_VS_ZEROSTACK.md` 里 scream 的 `run-turn.ts`

## 下一步（可选练习）

- [x] Phase 3：跨 session 记忆 → **MemFileCli**（`memfilecli` + skill，见 `SPEC_CONTEXT_MANAGEMENT.md` §Phase 3）
- [x] `web_fetch` 工具（L1 HTTP + 可选 cloakFetch L2）
- [ ] 写文件前 `readline` 确认（permission 层）
- [ ] Rust 内核 fork（仅 CPU 热点，触发条件见 [ROADMAP.md](./ROADMAP.md) 轨 C）