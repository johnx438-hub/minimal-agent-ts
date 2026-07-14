# 快速上手

> 把 harness 跑起来。项目定位与特性见 [README.md](./README.md)；依赖分层见 [docs/DEPS.md](./docs/DEPS.md)。

## 环境

| 层级 | 内容 |
|------|------|
| **必装** | **Node.js ≥ 22**、`npm install`、API Key（`agent.json` profile / `.env`） |
| **推荐** | `git`（git_* / code_review）、可用 shell（run_shell / test_run） |
| **可选** | `ddgr`（web_search）、cloak 脚本（web_fetch L2，默认关） |

Windows 上常见用 **Git Bash** 跑本项目；`ddgr` / Python 须出现在 **Node 进程的 PATH** 里，或写死 `web_search.ddgr_path`。细节：[docs/DEPS.md](./docs/DEPS.md) §3.1。

## 1. 安装与填 Key

```bash
cd minimal-agent-ts
npm install
cp .env.example .env
```

打开 **`.env`**（不是 `agent.json`），至少填一行：

```bash
DEEPSEEK_API_KEY=sk-你的key
```

| 你要做的 | 文件 | 填什么 |
|----------|------|--------|
| **贴 API key** | **`.env`** | `DEEPSEEK_API_KEY=...`（默认必填） |
| 可选备用 key | **`.env`** | `OPENROUTER_API_KEY=...` |
| 换默认厂商/模型列表 | `agent.json` | `default_api_profile`、`api_profiles.*.models` |
| 看「key 读哪个环境变量」 | `agent.json` | `api_profiles.*.api_key_env`（只是**名字**） |

**规则**：密钥只进 `.env`（已 gitignore）；`agent.json` 只写 `api_key_env: "DEEPSEEK_API_KEY"` 这种引用。

多厂商模板见 `agent.llm.example.json`；两 key 模板见 `agent.llm.2key.example.json`（合并进 agent.json 时同样**不要**把 sk- 写进 JSON）。

**拉代码后若 `package.json` 变了**，再执行一次 `npm install`。

## 2. 第一次运行

```bash
# 终端 UI（推荐）
npm run tui

# 或 headless 单次任务
npm start -- "列出当前目录，读 README，用三句话说明项目做什么"
```

TUI 启动后可见 **MINIMAL** banner；`/help` 看命令；`/lang zh|en` 切换界面语言。

## 3. 常用命令

| 场景 | 命令 |
|------|------|
| 指定项目目录 | `npm start -- --cwd /path/to/project "任务"` |
| 续接会话 | `npm start -- --resume <session_id> "继续"` · TUI `/sessions` |
| 允许 shell | TUI `/shell on` · 或 `--allow-shell` |
| 允许联网 | TUI `/web on` · 或 `--allow-web` |
| 网页搜索 | 需 `ddgr` + web：`web_search` 后 `web_fetch` |
| 工具 + 宿主探针 | TUI `/tools` · `npm start -- --list-tools` |
| 多角色 workflow | `npm start -- --workflow workflows/review-loop.json "任务"` |
| 后台 job | Agent 调 `spawn_background`；TUI `/jobs` · CLI `npm run spawn:list` |
| 关闭流式 | `STREAM=0 npm start -- "…"` |

`session_id` 启动时打印；数据在本地 `.sessions/`（**不进 git**）。会话可备注、删除（TUI `/sessions` → `n` / `d`）。

## 4. Workflow（可选）

多角色编排：阶段结果经模板变量传递。内置示例 `workflows/review-loop.json`：

```text
Planner（只读） → Worker（实现） → Reviewer（审批，可退回修订）
```

```bash
npm start -- --workflow workflows/review-loop.json "你的任务描述"
```

角色定义见 `roles/`。

## 5. 权限与安全

| 能力 | 默认 | 说明 |
|------|------|------|
| 文件读写 | 项目 cwd 内 | 逃逸路径可走 JIT 确认 |
| shell | 关（TUI 首次可开） | `/shell` · `--allow-shell` |
| web | 关 | `/web` · `--allow-web` |
| 始终批准 | 可选 | `/approve` 持久化到 `.tui-prefs.json`（启动会提示） |

子 Agent `run_shell` 受 **spawn_shell_policy** 约束（allowlist / deny）；主 Agent 不受影响。

## 6. 配置入口

| 文件 | 作用 |
|------|------|
| **`.env`** | **唯一放 API key 的地方**（从 `.env.example` 复制） |
| `agent.json` | 模型 profile 名、`api_key_env` 变量名、工具、spawn、web 策略 |
| `.tui-prefs.json` | shell/web 默认、locale、verbose 等 |
| `agents/*.md` | 子 Agent 系统提示与工具白名单 |

## 7. 自检

```bash
npm test
npm run typecheck
npm start -- --list-tools
```

更多设计背景与路线：[README.md](./README.md) · [docs/ROADMAP.md](./docs/ROADMAP.md)。
