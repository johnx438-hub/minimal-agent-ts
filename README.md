# minimal-agent-ts

TypeScript **ReAct Agent 学习底座**：手写主循环 + 上下文冷热分离 + 子 Agent / workflow / TUI，不依赖 pi / rig / scream / zerostack 内核。

**仓库**: https://github.com/johnx438-hub/minimal-agent-ts  
**上手**: [QUICKSTART.md](./QUICKSTART.md) · **规划**: [docs/ROADMAP.md](./docs/ROADMAP.md)

> DeepSeek 前缀缓存实验在 sibling 项目 `minimal-agent-ts-ds-cache`；本仓默认 OpenCode 式上下文（pointerize / prune / resume 预算裁剪）。

---

## 现状（2026-07）

| 区域 | 状态 |
|------|:----:|
| Phase 1–2、4–6（session / 指针化 / 并行 tool / MCP·Skills / workflow） | ✅ |
| Spawn 同步 + 后台 job / `code_review` | ✅ |
| TUI（pi-tui）：`/jobs`、`/spawns`、`/profile`·`/model`·`/reasoning`、`/brief` | ✅ |
| LLM 路由（api_profiles、fallback、reasoning） | ✅ 主体；G5 待做 |
| `web_search`（ddgr + cache） | ✅ |
| 底座 L1 ToolProvider · L2 context pipeline | ✅ |
| 压测 harness · MessageBridge (L3) | 待做 |

验证：`npm test`（440+）· `npm run typecheck`

---

## 能做什么

| 能力 | 要点 |
|------|------|
| ReAct 循环 | 流式 LLM、并行 tool、loop guard |
| 上下文 | 冷存 + `[action:…]` 指针卡片、`recall_query`、prune / heavy、resume 层摘要 + 历史预算裁剪 |
| 子 Agent | `spawn_agent` / `spawn_background` / `code_review` |
| 编排 | JSON workflow（Planner → Worker → Reviewer） |
| 扩展 | MCP（stdio / streamable-http / sse）、Skills、`Agent.md`、`/memory` |
| 界面 | `npm run tui` 或 headless `npm start` · `--json-events` |

---

## 快速开始

```bash
npm install
cp .env.example .env   # OPENAI_API_KEY 等

npm start -- "列出当前目录，读 README，一句话总结"
npm run tui

npm start -- --allow-shell "运行 npm run typecheck 并汇报"
npm start -- --allow-web "web_search 查 …，必要时 web_fetch 深读"
npm start -- --resume <session_id> "继续"
npm run spawn:list
```

更多命令与权限说明见 [QUICKSTART.md](./QUICKSTART.md)。Key / 模型 / `MAX_CONTEXT_TOKENS` 等见 `.env.example`。

---

## 内置工具（摘要）

| 类别 | 工具 |
|------|------|
| 文件 | `read_file` · `write_file` · `edit_file` · `grep_search` · `list_files` · `diff_file` |
| 上下文 | `recall_query` |
| 执行 / 网 | `run_shell`（`--allow-shell`）· `web_fetch` / `web_search`（`--allow-web`） |
| 委派 | `spawn_agent` · `spawn_background` · `code_review` |
| 插件 | `invoke_skill` · `mcp_<server>_<tool>` |

开关：`agent.json` → `builtin_tools`。后台 job 落盘 `workspace/jobs/<id>/`（本地不进 git）。

---

## 代码地图

```
src/
  agent.ts              # ReAct 主循环
  runner.ts             # 会话 / task / workflow 入口
  context/              # L2 pipeline：budget · prune · assemble · heavy · …
  pointerize.ts         # 指针卡片
  action-store.ts       # 冷存 + 异步写队列
  tools/providers/      # L1：builtin / cli / spawn / skills / mcp
  spawn/                # 预设加载、job 注册与取消
  workflow/             # 多角色执行器
  tui/                  # pi-tui
agents/  workflows/  roles/  skills/   # 预设与配置
```

**一圈 turn**：`assembleApiMessages` → LLM → tool-scheduler → 冷存 → turn 末 `pointerize → prune → pointer-compact → heavy`。

建议阅读顺序：`agent.ts` → `context/pipeline.ts` → `pointerize.ts` → `tools/providers/` → `spawn/` → `workflow/runner.ts`。

---

## 文档

| 文档 | 用途 |
|------|------|
| [QUICKSTART.md](./QUICKSTART.md) | 5 分钟上手 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | **单一规划源**（产品 / 底座 / 压测） |
| [ROADMAP.md](./ROADMAP.md) | 轨 A–G 缩写与变更日志 |
| [SPEC_CONTEXT_MANAGEMENT.md](./SPEC_CONTEXT_MANAGEMENT.md) | 上下文设计 |
| [SPEC_LLM_ROUTER.md](./SPEC_LLM_ROUTER.md) | 多 profile / fallback |
| [SPEC_TOOLS.md](./SPEC_TOOLS.md) | 工具拓展（web_search 等） |
| [SPEC_TUI.md](./SPEC_TUI.md) | TUI 规范 |

---

## 下一步

见 [docs/ROADMAP.md](./docs/ROADMAP.md)：

- [ ] 压测 harness（stress preset + 并行 dev-worker）
- [ ] L3 MessageBridge hooks（IM 预留）
- [ ] G5 Anthropic 显式缓存（按需）
- [ ] workflow if/else、SPEC_TOOLS 后续能力（按需）
