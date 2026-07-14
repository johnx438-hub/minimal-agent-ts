# minimal-agent-ts

TypeScript 写的轻量 Agent Harness，从长会话上下文管理实验演进而来。核心先解决长对话里的三个痛点：事件顺序不丢、历史内容可找回、上下文窗口不爆炸，再在此基础上叠加工具调用、子Agent、TUI和可观测能力。

纯手写ReAct主循环（Reason → Act → Observe），热路径做轻、冷数据存盘，不绑定任何商业Agent产品或闭源运行时。

**仓库地址**: https://github.com/johnx438-hub/minimal-agent-ts

| 文档 | 用途 |
|------|------|
| [QUICKSTART.md](./QUICKSTART.md) | 安装与常用命令 |
| [docs/DEPS.md](./docs/DEPS.md) | 必装/可选依赖说明 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 项目规划与方向 |
| [SPEC_CONTEXT_MANAGEMENT.md](./SPEC_CONTEXT_MANAGEMENT.md) | 上下文与指针化设计细节 |
| [SPEC_TOOLS.md](./SPEC_TOOLS.md) · [SPEC_TUI.md](./SPEC_TUI.md) · [SPEC_LLM_ROUTER.md](./SPEC_LLM_ROUTER.md) | 工具/TUI/多模型路由规范 |

验证命令：`npm test` · `npm run typecheck`（约600个测试用例）

---

## 设计思路

做这个项目最初的出发点很简单，就是解决多轮工具调用后的三个实际问题：

1. 上下文越聊越肿，长任务跑着跑着就爆窗口
2. 长结果被截断后，事件顺序和细节容易丢，Agent经常搞混哪个结果是哪次调用的
3. 希望整个东西跑在Node/TypeScript栈里，可测试、可改、方便分享

核心方案：

- **冷热分离**：长工具结果落地存在 `.sessions/actions/`，对话里只留固定格式的`[action:…]`指针卡片
- **按需召回**：需要看历史结果时用`recall_query`拉全文，不用的时候不占上下文
- **轮末管线**：每轮结束自动跑：指针化→剪枝→指针压缩→阈值触发时做重量级摘要，全程不碰最前面的系统提示
- 工具、子Agent、工作流、TUI都在这个基础上扩展

定位是小而稳的底座，不追求做全功能IDE替代品。

---

## 当前特性

| 模块 | 能力 |
|------|------|
| **主循环** | 流式LLM输出、并行工具调用、循环防死锁、会话断点续跑 |
| **上下文管理** | 指针卡片、异步写队列、任务摘要、token预算自动剪枝 |
| **可观测性** | TUI底栏实时显示token/会话数/上下文占比/前缀缓存命中率；支持`--json-events`输出结构化事件 |
| **内置工具** | 文件编辑、patch应用、git全套、LSP查询、Office文档读写（docx/pptx/xlsx纯Node实现）、shell/测试、网页抓取搜索、Skill/MCP扩展 |
| **子Agent** | `spawn_agent`/后台spawn/三角色代码审查，任务日志落地在`workspace/jobs/` |
| **工作流** | JSON格式工作流，支持Planner→Worker→Reviewer这类多角色编排 |
| **TUI** | 终端交互界面：会话列表管理、中英双语切换、启动LOGO、高危操作权限确认 |
| **多模型支持** | `agent.json`多Profile配置、自动降级、推理力度映射；天然适配大模型前缀缓存，稳态任务缓存命中率极高 |

---

## 快速开始

```bash
git clone https://github.com/johnx438-hub/minimal-agent-ts.git
cd minimal-agent-ts
npm install

# 1. 配置环境变量：密钥只写在.env里，绝对不要提交到git
cp .env.example .env
# 编辑.env，至少填一个可用的API Key，默认配置用DeepSeek：
# DEEPSEEK_API_KEY=sk-xxx
# 可选其他Key：OPENROUTER_API_KEY=xxx / ZAI_API_KEY=xxx / XAI_API_KEY=xxx

# 2. 启动
npm run tui                   # 推荐：启动交互式TUI
# 或者直接命令行跑单次任务：
npm start -- "读一下README，用三句话总结这个项目是做什么的"
```

---

## 自定义 API Key 与 Profile

密钥**只写在 `.env`**，不在 `agent.json` 里硬编码。`agent.json` 通过 `api_key_env` 字段声明"从哪个环境变量取密钥"。

### 内置 Profile 约定

| Profile | 环境变量 |
|---------|----------|
| `deepseek-main`（默认） | `DEEPSEEK_API_KEY` |
| `openrouter-test`（fallback） | `OPENROUTER_API_KEY` |

### 三步新增自定义 API

假设你要接入一个 OpenAI 兼容网关 `https://my-gw.example/v1`：

**1. `agent.json` 新增 profile**（可参考 `agent.llm.example.json`）：

```json
{
  "api_profiles": {
    "my-gw": {
      "base_url": "https://my-gw.example/v1",
      "api_key_env": "MY_GW_KEY",
      "default_model": "my-model",
      "models": ["my-model"]
    }
  },
  "default_api_profile": "my-gw"
}
```

**2. `.env` 配置密钥**：

```bash
MY_GW_KEY=sk-xxxxxxxx
```

**3. 生效**：重启 TUI 或单次任务，`api_key_env` 指向的变量自动从 `.env` 读取。

> 多个 API 做 fallback 时，利用 `fallback_profiles` 数组和 `FALLBACK=1` 环境变量自动切换。参考模板文件 `agent.llm.2key.example.json`。

---

## Web Fetch / Search 可选依赖

`web_fetch` 和 `web_search` 依赖宿主机的外部工具，框架会**自动探测**，找不到时优雅降级。

### CloakFetch（网页抓取）

- **依赖**：Python 3 + [`cloak_fetch.py`](https://github.com/nickclyde/cloakFetch) 脚本（或同目录的 `cloak_fetch.sh`）
- **作用**：带 JS 渲染的网页抓取（`web_fetch` 的 L2 通道），没有时自动退回纯 HTTP fetch
- **自动探测**：按优先级搜索 → 环境变量 `CLOAK_FETCH_SCRIPT` → `skills/cloak-fetch/` → `~/.claude/skills/` → `~/github/cloakFetch/` → Windows 常见路径
- **探测逻辑**：`src/tools/cloak-resolve.ts`（全平台兼容 Linux / macOS / Windows / Git Bash）

### ddgr（网页搜索）

- **依赖**：[`ddgr`](https://github.com/jarun/ddgr)（DuckDuckGo 命令行搜索）
- **作用**：`web_search` 的后端，没有时搜索功能不可用（本地缓存仍可命中）
- **安装**：`pip install ddgr` 或 `brew install ddgr`，Windows 需确保在 PATH 中
- **自动探测**：`ddgr` → `ddgr.exe` → `ddgr.cmd` → `ddgr.bat`（Windows），也可在 `agent.json` 中配置 `web_search.ddgr_path`

### 跨平台说明

不同平台（Linux / macOS / Windows / Git Bash）的安装路径和可执行文件后缀不同，探测代码已经覆盖了常见情况。如果自动探测失败：

1. **设置环境变量**：`CLOAK_FETCH_SCRIPT=/your/path/cloak_fetch.py`、`DDGR_PATH=/your/path/ddgr`
2. **或在 `agent.json` 中指定路径**：`web_search.ddgr_path`、`cloak_fetch.script_path`
3. **让 Agent 自己修**：探测源码都在 `src/tools/cloak-resolve.ts`，告诉 Agent "帮我把 ddgr 路径配好"，它会读代码、找到对应配置项、帮你改
