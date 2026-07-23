# minimal-agent-ts

> [English](./README.md) | 中文版

## 上下文分级段落位置编码：从 Token 到事件

LLM 理解语言的基础之一是位置编码——每个 token 的序位编码告诉模型 "这个字在哪个字的后面"。这一点，Transformer 架构从第一天就做到了。

但如果把 Agent 的对话历史也看作一段需要 LLM 理解的"文本"，问题就来了：**对话历史有位置编码吗？**

没有。当前所有 Agent 框架都默认对话历史是一个扁平的消息数组：user 说了什么，assistant 回了什么，tool 返回了什么——新的盖在旧的上面，满了就砍、就总结、就丢给向量数据库。没有人认真处理过这条消息数组**自身的时序结构**。

而长任务中的一个关键现象——Lost in the Middle——恰好与位置结构缺失高度相关：LLM 不是"记不住"上下文，而是在一段没有时序标记的扁平消息堆里，它的注意力不知道该锚定哪一条。

### 从TOKEN级到事件级

minimal-agent-ts 做了一件事：**给上下文事件赋予位置编码。**

具体做法是在对话消息的原生数组之上，用一种可保留时序结构的指针卡片替代全文结果插入。每条指针卡片携带三组信息：

- **时序坐标**：`turn=N`，明确该事件发生在第几轮
- **事件摘要**：`read_file(path=agent-prompt.ts, sha256=xxx)`，不读全文也知内容指纹
- **召回入口**：`action_id`，需要时从冷存储按需加载完整内容

于是对话历史从 "一碗粥" 变成了 "一条时间线"。模型读取时，注意力头自动锚定在带有明确时空坐标的事件卡片上——这套做法是对 LLM 位置编码能力的一次向上借用：令牌的位置编码让词序可理解，事件的位置编码让上下文结构可导航。

### 不依赖外挂

这条路线不需要向量数据库、不需要 RAG、不需要复杂状态机、不需要 Memory 模块。它只做一件事：**回到原生消息数组本身，在结构上做细粒度工程。**

- **指针化冷热分离**：长结果落盘（`.sessions/actions/`），对话中只留卡片引用
- **漏斗式压缩**：像操作系统管理内存一样管理上下文——指针化 → 剪枝 → 紧凑 → 阈值摘要，逐级递进
- **前缀缓存友好**：静态的系统提示 + 稳定的指针卡片格式 → KV-cache 可复用 → 稳态命中率 95%+
- **LLM 自主控制**：模型可通过 `context_focus` 工具主动延长关键事件的保留窗口，框架不替它做所有决定

TypeScript 实现，纯手写 ReAct 主循环，~600 个测试用例，不绑定任何商业 API 或闭源运行时。

**仓库地址**: https://github.com/johnx438-hub/minimal-agent-ts

### 仓库结构：主体 + TUI（推荐）· GUI（WIP）

单仓库 monorepo。**对外默认路径 = 终端 TUI + 主体**；浏览器界面**不是**当前门面。

| 路径 | 内容 | 谁需要 |
|------|------|--------|
| 根目录 `src/` · `bin/` | Agent Runtime、**TUI**、Web **API**（`npm run web`） | **几乎所有人** |
| `public/web-ui/` | `npm run web` 时的**说明页**（非产品 UI） | 打开 API 端口时顺带看到 |
| `public/web-ui-legacy/` | 早期静态壳，**已归档** | 考古 only |
| `minimal-gui/` | Next 浏览器 UI | **维护者 dogfood · WIP · 默认不推荐** |
| `docs/EVAL_LITM.md` 等 | 长程实验与规范 | 评测 / 二次开发 |

**约定：**

| 标签 | 含义 |
|------|------|
| **不带 GUI（推荐）** | 只要终端 Agent；不要 `cd minimal-gui` |
| **GUI · WIP** | 可选；问题多，打磨前不写入「稳定能力」 |

> npm 包 **不含** `minimal-gui`。`git clone` 会带上该目录，**忽略即可**，除非你在维护浏览器 UI。

| 文档 | 用途 |
|------|------|
| [QUICKSTART.md](./QUICKSTART.md) | 安装与常用命令 |
| [docs/DEPS.md](./docs/DEPS.md) | 必装/可选依赖说明 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 项目规划与方向 |
| [docs/EVAL_LITM.md](./docs/EVAL_LITM.md) · [eval/README.md](./eval/README.md) | LITM 实验纲要 + 可复现 harness E0–E3 |
| [SPEC_CONTEXT_POLICY.md](./SPEC_CONTEXT_POLICY.md) · [agent.context.example.json](./agent.context.example.json) | 上下文旋钮 `context_policy` |
| [SPEC_CONTEXT_MANAGEMENT.md](./SPEC_CONTEXT_MANAGEMENT.md) | 上下文与指针化设计细节 |
| [SPEC_TOOLS.md](./SPEC_TOOLS.md) · [SPEC_TUI.md](./SPEC_TUI.md) · [SPEC_LLM_ROUTER.md](./SPEC_LLM_ROUTER.md) | 工具/TUI/多模型路由规范 |

验证命令：`npm test` · `npm run typecheck`（约600个测试用例）

---

## 更新 · 2026-07-23

插在产品叙事（上）与「快速开始」（下）之间。完整实验笔记：[eval/NOTES_live_2026-07-23.md](./eval/NOTES_live_2026-07-23.md) · [eval/README.md](./eval/README.md) · [docs/EVAL_LITM.md](./docs/EVAL_LITM.md) · [SPEC_CONTEXT_POLICY.md](./SPEC_CONTEXT_POLICY.md)。

### 我们优先证明什么

| 优先级 | 主张 | 今日态度 |
|--------|------|----------|
| **P0** | **事件结构清晰**——带 `turn=` 的指针卡片、时间线热路径、冷存 `recall_query` | 产品主叙事（与上文「从 Token 到事件」一致）；尚无单独「结构分」指标 |
| **P1** | **指针化改前文 ≠ 必然更费 token**（相对几乎不压历史） | 干净 multi_doc 对上 eager 热路径 **略低约 1.6–2.3%**（n=1） |
| **P2** | 高压下大幅省 token | **不是**本任务头条（pointerize 触发偏晚） |

常见质疑是「卡片化历史只会多烧 token」。对齐轨迹的 live **不支持这一点**；同时不要被带偏成只谈省 token——**主攻仍是事件结构化上下文**。

### 值得引用的 live 快照（窄口径）

- **题**：`multi_doc_01` 分段版（每 turn ≤2 个 `docs/*`，7 文件，大 distractor）  
- **对比**：`minimal_pointerize_eager`（keep=0 + deny `context_focus`）vs `minimal_no_pointerize`（keep=200）  
- **模型**：`deepseek-v4-pro` · 双过 · 8 turn / 10 tool · `repeat_tool_rate=0`  
- **热路径**：eager mean **15615** vs no_ptr **15870**；prompt Σ **124918** vs **126957**  
- **报告**：[eval/reports/live_multi_doc_segmented.md](./eval/reports/live_multi_doc_segmented.md)（务必 `--run-ids`，勿混旧 run）  
- **笔记**：[eval/NOTES_live_2026-07-23.md](./eval/NOTES_live_2026-07-23.md)

**未声称**：大幅省 token、LITM 正确率胜出、或 n≥3 分布。

### 上下文工程落地

| 方向 | 内容 |
|------|------|
| **Token 自校准** | `prompt_tokens` / 本地估 EWMA（`TokenCalibrator`）；`DEBUG_TOKEN_CAL=1` |
| **`context_policy`（C1–C4）** | budget / heavy / protect / prune / calibrator 可配；[agent.context.example.json](./agent.context.example.json) |

### 评测 harness（E0–E3+）

| 阶段 | 能力 |
|------|------|
| **E0–E2** | 金题、策略、`eval:run` / aggregate / compare、dry-run、报告 |
| **E3+** | 分段 multi_doc、`minimal_pointerize_eager`、path 指纹、`tool_deny`、aggregate `--run-ids` / `--git-sha` |

```bash
npm run eval:list
npm run eval:run -- --task multi_doc_01 --strategy minimal_pointerize_eager --max-turns 50
npm run eval:run -- --task multi_doc_01 --strategy minimal_no_pointerize --max-turns 50
npm run eval:aggregate -- --no-dry-run --run-ids <eager_id>,<nop_id> --out-name clean_pair
```

### 今日相关提交（节选）

`92842c4` 自校准 · context_policy · eval E0–E3 · 指纹 / tool_deny / 分段 multi_doc · `0269a3a` live 笔记

---

## 快速开始

### A. 不带 GUI（推荐网友试玩 / 只要 TUI）

只需 **Node ≥ 22** + API Key。**不会**安装 Next，也**不需要**打开浏览器。

#### 方式 1：npm BETA — **暂未发包**（包装已就绪，即将上架）

> ⚠️ **当前 registry 上还没有 `minimal-agent-ts` 正式/beta 包。**  
> 仓库内已完成 `0.1.0-beta.1` 的 `bin` / `dist` / `files` 打包与 `npm pack` 自测；作者完成 npm 2FA 后会 `npm publish --tag beta`。  
> **现在请用下面的「方式 2：源码」试用。** 下列安装命令先划线保留，上架后去掉划线即可用。

```bash
# ── 上架后可用（仅主体 + TUI，包内无 GUI）──
# npm install -g minimal-agent-ts@beta
# # 在含 agent.json 与 .env 的目录：
# minimal-agent                    # 交互 TUI
# minimal-agent-run "你的任务"      # 无界面单次任务
```

~~`npm install -g minimal-agent-ts@beta`~~ · ~~`minimal-agent`~~ · ~~`minimal-agent-run "…"`~~  
（同上，**暂不可用**，待 npm 发布。）

#### 方式 2：源码（**现在就能用** · 不带 GUI）

```bash
git clone https://github.com/johnx438-hub/minimal-agent-ts.git
cd minimal-agent-ts
npm install                      # 只装根 package.json（不含 GUI 的 Next 依赖）
cp .env.example .env             # 密钥只写 .env，不要提交
# 编辑 .env，至少：DEEPSEEK_API_KEY=sk-xxx（或其它 profile 对应变量）

npm run tui                      # 交互 TUI（不带 GUI）
npm start -- "读 README，三句话总结项目"   # headless（不带 GUI）
```

只要终端：到此即可。**不要**执行 `cd minimal-gui && npm install`。

可选：clone 时排除 GUI 目录（更干净）：

```bash
git clone --filter=blob:none --sparse https://github.com/johnx438-hub/minimal-agent-ts.git
cd minimal-agent-ts
git sparse-checkout set '/*' '!minimal-gui'
npm install && cp .env.example .env && npm run tui
```

### B. GUI · WIP（维护者 dogfood · **默认不推荐**）

浏览器 UI 曾用于内部展示，**尚未打磨到可推荐**。需要时见 [`minimal-gui/README.md`](./minimal-gui/README.md)。

```bash
# 已完成 A 的源码步骤后：
npm run web -- --allow-shell --web-port 7788   # 终端 1：API only
cd minimal-gui && npm install && npm run dev   # 终端 2：Next WIP
```

| 命令 | 产品 GUI？ | 说明 |
|------|------------|------|
| ~~`minimal-agent` / `minimal-agent-run`~~ | 否 | npm CLI · **暂未发包** |
| `npm run tui` / `npm start` | 否 | **现在推荐** · 终端 Agent |
| `npm run web` | 否 | harness **API**；浏览器只有说明页（非聊天 UI） |
| `public/web-ui-legacy/` | 否 | **已归档** 的旧静态壳 |
| `minimal-gui` → `npm run dev` | WIP | 实验性 Next UI，需先 `npm run web` |

TUI 里 `npm run tui -- --web` 只顺带起 API，**不等于**启动 `minimal-gui`。

---

## 五层价值金字塔

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

---

## 当前特性

| 模块 | 能力 |
|------|------|
| **主循环** | 流式LLM输出、并行工具调用、循环防死锁、会话断点续跑 |
| **上下文管理** | 指针卡片、异步写队列、任务摘要、token预算自动剪枝；`invoke_skill` 全文常驻保护（灵感来源：朋友吐槽 Codex 经常在长任务中遗漏 skill 细节） |
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
| **后台** | `spawn_background` | 立即返回 `job_id`，子 Agent 在后台异步跑，进度写文件 | 多个独立任务并行处理（完成后自动回推主 Agent 验收） |

> ⚠️ **API 并发限制**：如果用的是 DeepSeek / OpenRouter 等有限流 API（比如同一 API Key 只允许 1 个并发请求），后台模式下的并行子 Agent 会触发 429 错误。此时应在 Prompt 里明确指定 `spawn_agent`（同步模式），子 Agent 会排队串行执行。  
> 当前框架**不会自动降级**——同步还是后台由 Agent 根据你的 Prompt 自行选择，所以想串行就说「用 spawn_agent 一个个做」。  
> **后台通信机制**：后台子 Agent 不使用消息总线，而是通过文件事件流（`workspace/jobs/<id>/events.jsonl`）写入进度，结果落盘到 `report.md` / `result.json`。所有后台任务落地时，框架会生成 `jobs_all_settled` 系统事件**自动唤醒主 Agent 验收**（合成 prompt 触发新 turn，不打断正在进行的对话）——无需手动提醒。想中途查看进度可调用 `npm run spawn:status` 检查 `/jobs` 面板，或要求终止（`npm run spawn:kill`）跑偏的作业。

---

## FAQ

### 为什么几乎 100% TypeScript？Go / Rust 不更快吗？

Agent 框架的性能瓶颈不在 CPU，在 LLM API 延迟。主循环快 10 倍也没意义——还是在等 HTTP 响应。TypeScript 的 async/await 处理 I/O 并发天然顺手，JSON 操作零解析成本，npm 生态里 LLM SDK、MCP Server 最先支持，TS 迭代改进调试更快。

### 现在都有 1M 上下文窗口了，指针卡片还有必要吗？

1M 上下文解决的是 **「能不能装下」**，指针卡片解决的是 **「装下之后还能不能有效思考」**。两者不是替代关系：

- **经济账**：用 1M 上下文跑 100 轮，每轮重编码全量历史，token 开销线性增长。指针化让上下文体量保持稳定。
- **质量账**：LLM 在长上下文中的注意力不是均匀分布的（参见「Lost in the Middle」），历史越长越容易忽略关键信息。指针卡片保证当前上下文只有「此刻相关的东西」。
- **前缀缓存账**：指针卡片是 hash 引用的，稳定前缀带来高 KV-cache 命中率。稳态会话实测 **95%+** 命中——越跑越快，越跑越便宜。而全量上下文每轮前缀都在变，cache 命中为零。

**1M 是更大的仓库，指针卡片是仓库里的索引系统，让大模型注意力能放在当前任务，且随时清楚已发生的事件结构顺序。**

---

## 自定义 Agent 行为

### Agent.md — 项目级系统提示词

在项目根目录放一个 `Agent.md`（或 `AGENTS.md`），框架会读入并拼进系统提示词。  
**Skills / memory 路径 / plan+specs 约定 / 默认工作风格** 已内置在框架（`buildFrameworkWorkspaceHints`），**不要**再写进 `Agent.md`，把 8000 字符预算留给项目规则。

模板：`Agent.md.example`（仅 Project notes）。本仓库示例：

```markdown
# Workspace agent instructions
1. **规划对齐**：……
2. **创建目标**：……
3. **阶段分支**：……
```

- **优先级**：`Agent.md` → `AGENTS.md`（二选一）
- **预算上限**：默认 8000 字符（可用 `AGENT_MD_MAX_CHARS` 覆盖）
- **拼接顺序**：`base + framework hints → Agent.md → memory → loaded_skills → summary extension`
- **源码**：`src/workspace-agent-md.ts` · `src/agent-prompt.ts`

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

工作流以 JSON 文件定义在 `workflows/` 目录，编排多个角色的协作。角色有两种定义方式：复用子 Agent 预设（`"preset": "dev-worker"`，来自 `agents/*.md`），或自定义角色文件（`"prompt_file": "roles/planner.md"`）。节点输入支持模板插值——`{{user_task}}` 注入用户任务，`{{slot.output}}` 注入上游产出。两种编排格式二选一：

**线性流（flow）**：内置示例 `workflows/review-loop.json`——按顺序执行，嵌套 `loop` 块表达修订循环：

```json
{
  "name": "review-loop",
  "share_session": false,
  "roles": {
    "planner":     { "prompt_file": "roles/planner.md", "tools": ["read_file","grep_search","list_files","recall_query"], "max_turns": 50 },
    "implementer": { "preset": "dev-worker" },
    "reviewer":    { "prompt_file": "roles/reviewer.md", "max_turns": 50 }
  },
  "flow": [
    { "role": "planner", "input": "Plan the work in 3-6 steps. Do NOT implement.\n\nTask:\n{{user_task}}", "slot": "plan" },
    {
      "loop": { "slot": "revision", "max_rounds": 3 },
      "steps": [
        { "role": "implementer", "input": "Implement the plan:\n{{plan.output}}", "slot": "impl" },
        { "role": "reviewer", "input": "Review. Reply verdict: pass OR needs_revision.\n{{impl.output}}", "slot": "review" }
      ]
    }
  ]
}
```

**显式 DAG（nodes + edges + entry）**：内置示例 `workflows/dag-review.json`——条件边驱动动态拓扑，同层无依赖节点自动并行：

```json
{
  "entry": "plan",
  "nodes": {
    "plan":   { "role": "planner", "input": "...", "slot": "plan" },
    "impl":   { "role": "worker",  "input": "...", "slot": "impl", "max_visits": 3 },
    "review": { "role": "reviewer", "input": "...", "slot": "review" },
    "final":  { "role": "summarizer", "input": "...", "slot": "final" }
  },
  "edges": [
    { "from": "plan", "to": "impl" },
    { "from": "impl", "to": "review" },
    { "from": "review", "to": "final" },
    { "from": "review", "to": "impl", "when": { "path": "reviewer.verdict", "eq": "needs_revision" } }
  ]
}
```

条件边（`when`）按上游输出字段匹配决定走向——reviewer 的 `verdict` 关键词即控制流协议（`approved` / `needs_revision` / `needs_human`，`pass`/`lgtm` 等同义词自动归一）。`max_visits` 限制节点最大执行次数：允许修订循环，防止死循环。加载与校验逻辑在 `src/workflow/`，自定义工作流只需放一个 JSON 到 `workflows/` 目录即可。

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

### 上下文压缩旋钮（可选）

长会话 heavy 压缩时机、保护窗、token 自校准等可写在 `agent.json` 的 `context_policy`（**全部可选**，省略 = 代码默认）。  
模板：[`agent.context.example.json`](./agent.context.example.json) · 说明：[SPEC_CONTEXT_POLICY.md](./SPEC_CONTEXT_POLICY.md) · [QUICKSTART.md](./QUICKSTART.md) §6.1。

---

## Web Fetch / Search 可选依赖

`web_fetch` 和 `web_search` 依赖宿主机的外部工具，框架会**自动探测**，找不到时优雅降级。

### CloakFetch（网页抓取）

- **依赖**：Python 3 + [`cloak_fetch.py`](https://github.com/Agents365-ai/cloakFetch) 脚本（或同目录的 `cloak_fetch.py`）
- **作用**：带 JS 渲染的网页抓取（`web_fetch` 的 L2 通道），没有时自动退回纯 HTTP fetch
- **自动探测**：按优先级搜索 → 环境变量 `CLOAK_FETCH_SCRIPT` → `skills/cloak-fetch/` → `~/.claude/skills/` → `~/github/cloakFetch/`
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

---

## 推荐社区 Skill

除核心自带外，`skills/` 里还附带了一些好用的社区 skill（需自行决定是否纳入 `.gitignore` 白名单）：

| Skill | 用途 | 上游 / 致谢 |
|-------|------|------------|
| `opencli-usage` | OpenCLI 通用适配层 — 让 Agent 统一驱动网站、桌面应用、外部 CLI | [OpenCLI](https://github.com/johnx438-hub/opencli) |
| `cli-web-search` | 跨平台 CLI 搜索引擎（Google/Bing/Brave/DuckDuckGo 等 7 种后端）+ MCP 支持 | [scottgl9/cli-web-search](https://github.com/scottgl9/cli-web-search)（Apache-2.0） |

> 🙏 感谢 Scott Glover 及上述开源项目维护者。
>
> 🙏 感谢 [Agents365-ai/cloakFetch](https://github.com/Agents365-ai/cloakFetch)（MIT）提供的 CloakBrowser 抓取方案，本项目的 `skills/cloak-fetch/` 及 L2 抓取通道基于此构建。

---

## 致谢

本项目开发过程中深度使用了以下模型，特此感谢：

| 模型 | 角色 |
|------|------|
| **Grok 4.5 + Composer 2.5** | 主力开发 — 大部分源码由其直接生成 |
| **DeepSeek V4 Pro** | 完整驻扎体验 + 代码审查 + 长期运行验证 |
| **豆包 2.1 Pro** | 文档与 README 文本润色 |
| **Kimi K3** | 框架隐形风险排查（verdict 协议裂缝 / stream-draft 复合 bug）+ 审美担当（星空展示页 / 机制笔记 docx） |

> 一个 Agent 框架，由四个不同的 Agent 协作完成——这本身就是最好的证明。
