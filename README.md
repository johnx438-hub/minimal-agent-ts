# minimal-agent-ts

> **别的 Agent 跑 10 轮开始忘事，跑 30 轮开始烧钱。这个跑 90 轮还在写日记。**

TypeScript 写的 Agent 框架，目标针对长程任务三大顽疾：**越跑越蠢**（上下文膨胀稀释注意力）、**越跑越贵**（每轮重编码全量历史）、**越跑越慢**（前缀不稳 cache 命中归零）。

核心方案：热路径做轻（对话里只留指针卡片）、冷数据存盘（完整结果落地 `.sessions/actions/`），纯手写 ReAct 主循环，不绑定任何商业 Agent 产品或闭源运行时。

> 🎯 **长程甜点区**：稳态任务下前缀缓存命中率可达 **95%+**，边际成本递减——多数框架是越跑越贵，此框架是越跑越便宜。

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

## 五层意外特性金字塔

目标痛点催生了五层架构，从地基到塔尖，每一层都踩在别人容易踩偏的点上：

```
           ┌──────────────────────┐
           │ ⑤ 源码总量控制        │  ~100 TS 文件干完别人 300+ 的事
           ├──────────────────────┤
           │ ④ 后台多Agent异步      │  无消息总线，文件系统即通信
           ├──────────────────────┤
           │ ③ 前缀缓存友好         │  冻结指针卡片 → 稳态长任务 95%+ cache hit
           ├──────────────────────┤
           │ ② 上下文结构化排布      │  事件时间线 vs 传统扁平信息流
           ├──────────────────────┤
           │ ① 长程任务稳定性        │  90 轮不崩、不蠢、不贵
           └──────────────────────┘
```

- **① 长程稳定性**：「90 轮之后 Agent 还在写日记回忆任务事件顺序」。
- **② 结构化上下文**：对话历史并非一长串纯文本，是「事件卡片」（类型 + hash + 摘要 + 指针）。Agent 看到的是时间线，不是信息粥。
- **③ 前缀缓存**：卡片 = hash 引用 = 稳定前缀 = KV-cache 命中。架构本身就对缓存友好，不需要额外 hack。
- **④ 后台多 Agent**：`spawn_background` + 文件系统 job log。没有 Redis、Kafka、gRPC——纯 Node 进程内搞定。
- **⑤ 源码极简**：核心引擎 + TUI + MCP + 多模型路由 + 审批 + 工作流，全在 ~100 个文件里。不是更少，是密度更高。

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

定位是从上下文结构实验出发，同时对前缀缓存友好做平衡，以及在小身板内实现主流harness功能的底座，并非替代对标任何其他Agent。

> ⚠️ **防御声明**（诚实版）  
> 现阶段**没有** `npx skills add` 之类的一键安装命令。  
> 想要新 Skill？两个办法：  
> 1. 直接把 `SKILL.md` + 脚本**复制粘贴**进 `skills/<name>/`  
> 2. 告诉 Agent："帮我把 xxx 的 skill 关联到 skills 文件夹"，它会自己搞定  
> ——— 反正 Agent 就是干这个的，何必再写一个安装器 😄

### 推荐社区 Skill

除核心自带外，`skills/` 里还附带了一些好用的社区 skill（需自行决定是否纳入 `.gitignore` 白名单）：

| Skill | 用途 | 上游 / 致谢 |
|-------|------|------------|
| `opencli-usage` | OpenCLI 通用适配层 — 让 Agent 统一驱动网站、桌面应用、外部 CLI | [OpenCLI](https://github.com/johnx438-hub/opencli) |
| `cli-web-search` | 跨平台 CLI 搜索引擎（Google/Bing/Brave/DuckDuckGo 等 7 种后端）+ MCP 支持 | [scottgl9/cli-web-search](https://github.com/scottgl9/cli-web-search)（Apache-2.0） |

> 🙏 感谢 Scott Glover 及上述开源项目维护者。

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
| **多模型支持** | `agent.json`多Profile配置、自动降级、推理力度映射；前缀缓存友好架构，稳态会话缓存命中率达 **95%+** |

### 同步 vs 后台子 Agent

| 模式 | 工具名 | 行为 | 适用场景 |
|------|--------|------|---------|
| **同步** | `spawn_agent` | 阻塞等待子 Agent 完成后返回结果 | API 有并发限制时（如免费 tier 只允许 1 个并发请求） |
| **后台** | `spawn_background` | 立即返回 `job_id`，子 Agent 在后台异步跑，进度写文件 | 多个独立任务并行处理（但需手动验收） |

> ⚠️ **API 并发限制**：如果用的是 DeepSeek / OpenRouter 等有限流 API（比如同一 API Key 只允许 1 个并发请求），后台模式下的并行子 Agent 会触发 429 错误。此时应在 Prompt 里明确指定 `spawn_agent`（同步模式），子 Agent 会排队串行执行。  
> 当前框架**不会自动降级**——同步还是后台由 Agent 根据你的 Prompt 自行选择，所以想串行就说「用 spawn_agent 一个个做」。  
> **后台通信机制**：后台子 Agent 不使用消息总线，而是通过文件事件流（`workspace/jobs/<id>/events.jsonl`）写入进度，结果落盘到 `report.md` / `result.json`。主 Agent 不会主动「监听」——想查看后台任务进度，请在本轮 Prompt 中要求 Agent 调用 `npm run spawn:status` 检查 `/jobs` 面板，或在下一轮对话中提醒它验收（读 report）或终止（`npm run spawn:kill`）已完成/跑偏的作业。

---

## 自定义 Agent 行为

### Agent.md — 项目级系统提示词

在项目根目录放一个 `Agent.md`（或 `AGENTS.md`），框架启动时会自动读取并拼接到系统提示词中。这是我的（也就是本仓库根目录的 `Agent.md`）：

```markdown
# Workspace agent instructions
1. **规划对齐**：讨论需求、目标，最短代码实现方式……
2. **创建目标**：讨论完成后在任务项目文件夹中创建spec文档和测试脚本
3. **阶段分支**：任务启动前预判代码长度，按功能块分批完成……
```

- **优先级**：`Agent.md` → `AGENTS.md`（二选一，先找到的生效）
- **预算上限**：默认 8000 字符，超过按行截断
- **加载时机**：每轮 turn 构建系统提示词时，顺序为：`base → Agent.md → memory → loaded_skills → summary extension`
- **源码**：`src/workspace-agent-md.ts`

### 自定义子 Agent 预设

子 Agent（`spawn_agent` / `spawn_background`）的行为由两类文件定义：

| 文件 | 位置 | 内容 |
|------|------|------|
| **Agent 角色** | `agents/*.md` | 系统提示词 + 工具白名单 + 轮次上限 |
| **Skill 技能** | `skills/*/SKILL.md` | 工具使用指南，运行时通过 `invoke_skill` 注入 |

**内置预设**：

| 预设名 | 文件 | 用途 |
|--------|------|------|
| `dev-worker` | `agents/dev-worker.md` | 完整工具集的编码 Agent |
| `code-review-bug` | `agents/code-review-bug.md` | 逻辑/异步/错误处理审查 |
| `code-review-security` | `agents/code-review-security.md` | 安全漏洞/密钥/注入审查 |
| `code-review-quality` | `agents/code-review-quality.md` | 可读性/一致性/最佳实践审查 |
| `web-researcher` | `agents/web-researcher.md` | 网页搜索与摘要 |
| `skeleton-reader` | `agents/skeleton-reader.md` | 项目骨架分析 |
| `hackernews-digest` | `agents/hackernews-digest.md` | HN 帖子抓取摘要 |

**三步新增自定义子 Agent**：

1. 在 `agents/` 下新建 `my-agent.md`（参考已有文件格式）
2. 在 `agent.json` 的 `spawn_presets` 中注册名称和工具策略
3. 主 Agent 即可通过 `spawn_agent(preset="my-agent")` 调用

Skill 同理——在 `skills/<name>/SKILL.md` 写一份 Markdown，Agent 通过 `invoke_skill(name="my-skill")` 即可加载对应指南。

### 多角色工作流（Workflow）

工作流以 JSON 文件定义在 `workflows/` 目录，编排多个角色的协作。内置示例 `workflows/review-loop.json`：

```json
{
  "name": "review-loop",
  "roles": {
    "planner": { "prompt_file": "roles/planner.md", "tools": ["read_file","grep_search","list_files","recall_query"], "max_turns": 8 },
    "worker":   { "prompt_file": "roles/worker.md",   "max_turns": 20 },
    "reviewer": { "prompt_file": "roles/reviewer.md", "max_turns": 6 }
  },
  "flow": [
    { "role": "planner",   "handoff": "worker" },
    { "role": "worker",    "handoff": "reviewer" },
    { "role": "reviewer",  "handoff": "worker", "on_approve": "done" }
  ],
  "max_cycles": 3
}
```

角色文件（`roles/*.md`）定义每个角色的系统提示词。执行时框架自动按 `flow` 顺序切换角色上下文，通过 `handoff` 传递中间结果，最多循环 `max_cycles` 次。加载逻辑在 `src/workflow/runner.ts`，自定义工作流只需放一个 JSON 到 `workflows/` 目录即可。

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

- **依赖**：Python 3 + [`cloak_fetch.py`](https://github.com/Agents365-ai/cloakFetch) 脚本（或同目录的 `cloak_fetch.sh`）
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

> 🙏 感谢 [Agents365-ai/cloakFetch](https://github.com/Agents365-ai/cloakFetch)（MIT）提供的 CloakBrowser 抓取方案，本项目的 `skills/cloak-fetch/` 及 L2 抓取通道基于此构建。

---

## FAQ

### 为什么几乎 100% TypeScript？Go / Rust 不更快吗？

Agent 框架的性能瓶颈不在 CPU，在 LLM API 延迟。主循环快 10 倍也没意义——还是在等 HTTP 响应。TypeScript 的 async/await 处理 I/O 并发天然顺手，JSON 操作零解析成本，npm 生态里 LLM SDK、MCP Server 最先支持，ts迭代改进调试更快。

### 现在都有 1M 上下文窗口了，指针卡片还有必要吗？

1M 上下文解决的是 **「能不能装下」**，指针卡片解决的是 **「装下之后还能不能有效思考」**。两者不是替代关系：

- **经济账**：用 1M 上下文跑 100 轮，每轮重编码全量历史，token 开销线性增长。指针化让上下文体量保持稳定。
- **质量账**：LLM 在长上下文中的注意力不是均匀分布的（参见「Lost in the Middle」），历史越长越容易忽略关键信息。指针卡片保证当前上下文只有「此刻相关的东西」。
- **前缀缓存账**：指针卡片是 hash 引用的，稳定前缀带来高 KV-cache 命中率。稳态会话实测 **95%+** 命中——越跑越快，越跑越便宜。而全量上下文每轮前缀都在变，cache 命中为零。

**1M 是更大的仓库，指针卡片是仓库里的索引系统，让大模型注意力能放在当前任务，且随时清楚已发生的事件结构顺序**
