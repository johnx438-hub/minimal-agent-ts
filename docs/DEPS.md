# 依赖地图（Dependency map）

> 目标：分享 / 打包前说清 **必装 / 推荐 / 可选**，以及「缺了会怎样」。  
> 实现探针：`src/deps-probe.ts`（`/tools` 与 `--list-tools` 会附带 host 探针摘要）。  
> 日期：2026-07-14 · 慢梳理，可随 Office / 打包迭代。

---

## 1. 分层总览

```text
┌─────────────────────────────────────────────────────────┐
│  REQUIRED — Node.js ≥ 22 + npm install（本仓 dependencies） │
│  无外挂也可：读文件、edit、office、lsp、spawn、session…     │
└─────────────────────────────────────────────────────────┘
              │
    ┌─────────┴──────────┐
    ▼                    ▼
 RECOMMENDED          OPTIONAL
 shell · git          ddgr · python/cloak · MCP 服务器 · 本地 skills 二进制
 run_shell/test_run   web_search / L2 fetch / 用户自配
```

| 层 | 不装的结果 |
|----|------------|
| **Required** | 无法启动 |
| **Recommended** | 主路径可用；shell/git 类工具报错或隐藏 |
| **Optional** | 对应工具失败或默认关闭；核心 ReAct 不受影响 |

---

## 2. npm 包（`package.json`）

### 2.1 运行时 dependencies

| 包 | 用途 | 备注 |
|----|------|------|
| `@earendil-works/pi-tui` | TUI | 无图形依赖，终端即可 |
| `@modelcontextprotocol/sdk` | MCP | 无 servers 时几乎空转 |
| `@mozilla/readability` · `linkedom` · `turndown` | `web_fetch` HTML→MD | 纯 JS |
| `chalk` | TUI 颜色 | |
| `dotenv` | 读 `.env` | |
| `mammoth` · `docx` | Office docx 读/写 | |
| `exceljs` | Office xlsx 读/轻写 | |
| `pptxgenjs` · `jszip` | Office pptx 写/读大纲 | pptxgenjs 经 CJS require 加载 |
| （间接） | exceljs/mammoth 等传递依赖 | 体积主要在此 |

### 2.2 devDependencies

| 包 | 用途 |
|----|------|
| `typescript` · `tsx` · `@types/*` | 开发、测试、**`lsp_query` 进程内 TS LanguageService**（运行时也会 resolve 到已安装的 `typescript`） |

**说明**：生产分享若用 `npm i --omit=dev`，需确认 `lsp_query` 是否仍能 `import('typescript')`。首包建议 **完整 `npm i`**，或把 `typescript` 挪到 dependencies（打包阶段再定）。

### 2.3 明确不进主依赖

| 项 | 原因 |
|----|------|
| Python 包 / markitdown | Office 已 Node 化；convert 路线可选且未默认 |
| office_cli / pandoc | 同上 |
| Rust `skills/cli-web-search` | 实验 skill，不进 npm tarball |
| `skills/*/target` | 构建产物，`.npmignore` 候选 |

---

## 3. 宿主二进制 / 运行时

| ID | 层级 | 工具 | 缺失时行为 | 安装提示（示例） |
|----|------|------|------------|------------------|
| **node** | required | 全部 | 无法运行 | nodejs.org / nvm ≥22 |
| **shell** | recommended | `run_shell` · `test_run` | 工具错误或需 `--allow-shell` 仍可能找不到 shell | bash / cmd；`MINIMAL_SHELL` |
| **git** | recommended | `git_*` · `code_review` | `error: git not found` | `apt/brew/choco install git` |
| **ddgr** | optional | `web_search` | 明确 error + 安装提示 | `apt/brew install ddgr` |
| **python3** | optional | cloak L2 only | 默认不启用 cloak | 系统 Python |
| **cloak_fetch 脚本** | optional | `web_fetch` 反爬 L2 | 默认 `cloak_fetch_enabled: false` | Agents365 cloakFetch |

探测命令：`npm start -- --list-tools` 或 TUI `/tools`（含 host 摘要）。

---

## 4. 按工具能力矩阵

| 工具 | npm | 宿主 | 权限门 |
|------|-----|------|--------|
| read/write/edit/apply_patch/list/grep/diff | — | — | 路径 |
| recall_query · invoke_skill | — | — | — |
| office_read / office_write | mammoth/docx/exceljs/pptxgenjs/jszip | — | 路径 |
| lsp_query | typescript | — | 路径只读 |
| run_shell · test_run | — | shell | **shell** |
| git_status/diff/log | — | **git** | **shell** |
| code_review | — | **git** | 路径/spawn |
| web_fetch | readability 栈 | 网络；cloak 可选 | **web** |
| web_search | — | **ddgr** + 网络 | **web** |
| spawn_* · jobs | — | — | 继承 shell/web |
| mcp_* | mcp sdk | 用户配置的 server 进程 | 策略 allow/deny |

---

## 5. 仓库内「非产品」路径（分享时忽略）

| 路径 | 建议 |
|------|------|
| `.sessions/` · `workspace/jobs/` | 本地状态，gitignore |
| `skills/cli-web-search/target/` | 不发布 |
| `reports/` · `web-articles/` · 根目录杂 md | 文档/笔记，可 npmignore |
| `node_modules/` | 由安装方生成 |

打包阶段（P5）用 `.npmignore` / `files` 白名单收紧。

---

## 6. 最小安装 vs 完整体验

### 最小（能聊 + 改代码 + Office）

```bash
# Node 22+
npm install
cp agent.llm.2key.example.json  # 或编辑 agent.json + .env
npm run tui
```

不必装 git/ddgr/python。

### 完整（搜索 + shell + review）

```bash
# + git + ddgr
# + 可选 cloak（反爬）
npm run tui -- --allow-shell   # 或 TUI 内 /shell on
# web: /web on
```

---

## 7. 后续决策（慢迭代 backlog）

| 项 | 状态 | 备注 |
|----|------|------|
| `typescript` → dependencies | 待定 | 保证 omit=dev 时 lsp 可用 |
| dynamic import office 包 | 待定 | 减冷启动，非必须 |
| web_search 纯 Node 后端 | 待定 | 去掉 ddgr；工作量大 |
| convert_document (pandoc/markitdown) | 不做默认 | Office 已覆盖主场景 |
| SEA / pkg 单文件 | 二期 | native/体积风险 |

---

## 8. 相关代码

| 文件 | 作用 |
|------|------|
| `src/deps-probe.ts` | host 探针 + 文案 |
| `package.json` | npm 依赖真源 |
| `agent.json` → `web_search` / `web_fetch_policy` | ddgr 路径、cloak 开关 |
| `src/tools/shell-resolve.ts` | shell 解析 |
| `SPEC_TOOLS.md` §6 | Office 已落地说明 |
