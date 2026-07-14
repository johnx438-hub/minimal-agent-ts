# minimal-agent-ts

TypeScript 生态下的 **Agent harness**：从**上下文事件结构**实验演进而来——先解决长会话里「发生了什么、还能不能找回来、窗会不会爆」，再叠上工具、子 Agent、TUI 与可观测性。

手写 **ReAct** 主循环（Reason → Act → Observe），热路径瘦身、冷路径保全，不绑特定商业 Agent 产品或闭源运行时。

**仓库**: https://github.com/johnx438-hub/minimal-agent-ts  

| 文档 | 用途 |
|------|------|
| [QUICKSTART.md](./QUICKSTART.md) | 安装与常用命令 |
| [docs/DEPS.md](./docs/DEPS.md) | 必装 / 可选依赖 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 规划与方向 |
| [SPEC_CONTEXT_MANAGEMENT.md](./SPEC_CONTEXT_MANAGEMENT.md) | 上下文与指针化设计 |
| [SPEC_TOOLS.md](./SPEC_TOOLS.md) · [SPEC_TUI.md](./SPEC_TUI.md) · [SPEC_LLM_ROUTER.md](./SPEC_LLM_ROUTER.md) | 工具 / TUI / 多模型路由 |

验证：`npm test` · `npm run typecheck`（约 600 tests）

---

## 从哪来

早期问题不是「再包一层 chat UI」，而是：

1. 多轮 tool 之后 **context 膨胀**，长任务不可持续  
2. 结果一旦截断，**事件顺序与细节丢失**  
3. 希望在 **Node / TypeScript 栈内** 可测、可演进、可分享  

本仓库的主干答案是：

- **冷热分离**：大 tool 结果进 `.sessions/actions/`，对话里留 `[action:…]` 指针卡  
- **按需召回**：`recall_query` 再捞全文  
- **轮末管线**：pointerize → prune → pointer-compact →（阈值到了再）heavy 摘要  
- 在此之上再接工具、spawn、workflow、TUI  

因此它更像 **harness + 上下文运行时**，而不是「又一个完整 IDE 替代品」。

---

## 特性（现状）

| 区域 | 内容 |
|------|------|
| **主循环** | 流式 LLM、并行 tool、loop guard、会话 resume |
| **上下文** | 指针卡、冷存写队列、task summary、预算与 prune |
| **可观测** | 底栏 `Σm` / `Σs` / `ctx` / 前缀 `c:hit%`；可选 `--json-events` |
| **工具** | 文件编辑 · apply_patch · git_* · lsp_query · office_read/write · shell/test · web · skills/MCP |
| **委派** | `spawn_agent` / `spawn_background` / `code_review`；job 落盘 `workspace/jobs/` |
| **编排** | JSON workflow（如 Planner → Worker → Reviewer） |
| **TUI** | 终端 UI：会话列表（备注/删除）、`/lang` 中英、`MINIMAL` banner、权限确认 |
| **LLM** | `agent.json` 多 profile、fallback、reasoning_map；DeepSeek 等隐式缓存可观测 |

长会话实践中：事件结构可恢复；前缀缓存在稳态任务上可到很高 hit（取决于厂商与是否频繁改写 history）。

---

## 快速开始

```bash
git clone https://github.com/johnx438-hub/minimal-agent-ts.git
cd minimal-agent-ts
npm install

# ── 密钥只写在 .env（不要写进 agent.json）────────────────
cp .env.example .env
# 编辑 .env，至少填写：
#   DEEPSEEK_API_KEY=sk-...     ← 默认 profile deepseek-main 用这个
# 可选：
#   OPENROUTER_API_KEY=...      ← fallback profile 用这个
#
# agent.json 里是 api_key_env: "DEEPSEEK_API_KEY"（变量名），不是 key 本身。

npm run tui                   # 交互 TUI（推荐）
# 或
npm start -- "读 README，用三句话说明这个项目做什么"
```

| 场景 | 命令 |
|------|------|
| 允许 shell | `npm run tui` 内 `/shell on`，或 `npm start -- --allow-shell "…"` |
| 允许联网 | `/web on`，或 `--allow-web`（搜索另需 `ddgr`） |
| 续接会话 | `--resume <session_id>` 或 TUI `/sessions` |
| 工具与宿主依赖 | TUI `/tools` · `npm start -- --list-tools` |
| 界面语言 | TUI `/lang zh` · `/lang en` |

会话与冷存默认在项目下 `.sessions/`（本地、不进 git）。  
**唯一硬性依赖**：Node.js ≥ 22。git / ddgr / shell 为可选，见 [docs/DEPS.md](./docs/DEPS.md)。

---

## 配置 LLM / API Key

| 想改什么 | 改哪里 |
|----------|--------|
| key 的**值** | **`.env`**：`XXX=sk-...` |
| key 的**变量名** | `agent.json` → `api_profiles.*.api_key_env: "XXX"`（任意名字） |
| 默认用哪个厂商 | `default_api_profile` |
| 模型列表 / 默认模型 | `api_profiles.*.models` / `default_model` |
| base URL | `api_profiles.*.base_url` |
| 失败换备用 | `fallback_profiles: ["其它 profile 名"]` |

**有名 profile 不硬编码环境变量名**：代码读的是 `process.env[api_key_env]`。当前仓库默认写成 `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY`，只是约定，可改。

**自定义常用 API**（需 OpenAI 兼容 `chat/completions`）：

1. 在 `agent.json` 增加 profile，例如 `my-gateway`：`base_url`、`api_key_env`（如 `MY_GATEWAY_KEY`）、`default_model`、`models`，并设 `default_api_profile`。  
2. 在 `.env` 写：`MY_GATEWAY_KEY=sk-xxxx`。  
3. `npm run tui`，或会话内 `/profile my-gateway` · `/model …`。

模板：`agent.llm.2key.example.json`、`agent.llm.example.json`。  
仅当没有可用 named profile 时，才会退回虚拟 `__env__`（`OPENAI_API_KEY` / `OPENROUTER_API_KEY` + `OPENAI_BASE_URL` + `MODEL`）。

---

## 内置工具（摘要）

| 类别 | 工具 |
|------|------|
| 文件 | `read_file` · `write_file` · `edit_file` · `apply_patch` · `grep_search` · `list_files` · `diff_file` |
| 上下文 | `recall_query` |
| Office | `office_read` · `office_write`（docx/pptx 结构化排版生成；xlsx 读+轻改；纯 Node） |
| 代码 | `git_status` · `git_diff` · `git_log` · `lsp_query` · `test_run` |
| 执行 / 网 | `run_shell` · `web_fetch` · `web_search` |
| 委派 | `spawn_agent` · `spawn_background` · `code_review` |
| 插件 | `invoke_skill` · `mcp_<server>_<tool>` |

开关：`agent.json` → `builtin_tools`；子 Agent 预设见 `agents/`。

---

## 代码地图

```
src/
  agent.ts              # ReAct 主循环
  runner.ts             # 会话 / task / workflow 入口
  context/              # 预算、prune、assemble、heavy compression
  pointerize.ts         # 指针卡片
  action-store.ts       # 冷存 + 写队列
  tools/                # 内置工具与 providers
  spawn/                # 预设、并行、后台 job
  workflow/             # 多角色 workflow
  tui/                  # 终端 UI
agents/  workflows/  roles/  skills/
```

**单 turn 热路径**（简化）：

```text
assembleApiMessages → LLM → tool-scheduler → 冷存
    → turn 末：pointerize → prune → pointer-compact → (heavy)
```

建议阅读：`agent.ts` → `context/pipeline.ts` → `pointerize.ts` → `tools/providers/` → `spawn/`。

---

## 非目标（首发分享）

- 替代完整 IDE / 云托管 Agent 产品  
- 默认捆绑浏览器反爬或本机 Office 安装  
- 为极致前缀缓存去冻结全量 transcript（缓存是稳态 history 的副产品，见可观测 `c:%`）

---

## 下一步

面向分享与打包的收口（bin / `npm pack` / 版本号）仍在进行；规划见 [docs/ROADMAP.md](./docs/ROADMAP.md)。
