# minimal-agent-ts 工具能力拓展 Spec（草案）

> **定位**: 与 ReAct 主线、上下文策略、TUI **正交** 的能力拓展规划；细节打磨期单开维护，避免撑大 `ROADMAP.md`。  
> **原则**: 轻量内置 + 可选外部 CLI 后端；大结果仍走 pointerize + 冷存；权限沿用现有 gate（`allowShell` / `allowWeb` / path JIT）。  
> **状态**: Draft v0.2（2026-07-12）；产品轨 Wave 2（M-Prod-2）见 **[docs/ROADMAP.md](./docs/ROADMAP.md)** §3

---

## 1. 非目标

- 为每个能力引入独立微服务或常驻 daemon
- 在 agent 内核内嵌完整浏览器 / IDE
- 用新工具替代现有 `read_file` / `grep_search` / `web_fetch` 语义
- 本 spec 不覆盖：跨 session 记忆、`Agent.md`、ZVEC 剥离（见 [ROADMAP.md](./ROADMAP.md) 轨 F）

---

## 2. 与主线的关系

```
runAgent 主循环（不变）
    │
    ├── 已有 builtin：read/write/edit/grep/shell/web_fetch/recall/spawn/…
    │
    └── 本 spec（按需叠加，各自独立 PR）
            ├── web_search      ← 发现层，配合 web_fetch 深读
            ├── lsp_query       ← 结构化代码语义
            ├── convert_document← 多格式 → Markdown 落盘
            └── office_*        ← 结构化 Office 读写
```

**合并顺序建议**（均有真实任务需求再动）：

1. `web_search`（零 TS 重依赖，子进程 CLI）
2. `convert_document`（与 `web_fetch` spill 同模式）
3. `lsp_query`（子进程 JSON-RPC，生命周期需单测）
4. `office_read` / `office_write`（依赖选定 CLI，权限最重）

---

## 3. `web_search` — 发现层（免 API key，分阶段）

### 3.1 目标与分工

| 阶段 | 工具 | 职责 |
|------|------|------|
| 发现 | **`web_search`** | 标题 + snippet + URL 列表 |
| 深读 | **`web_fetch`**（已有） | 全文 / readability / spill 落盘 |

**叙事**：`web_search` 发现 → `web_fetch` 深读。不替代 `grep_search` / `recall_query` / 跨 session 记忆。

免 key 方案的共性风险（实现与运维时需正视）：

| 风险 | 说明 |
|------|------|
| 脆弱性 | 上游 HTML / 非官方接口变更 → 子进程爬虫挂 |
| 风控 | CAPTCHA、IP 限流；spawn 并行搜索更易触发 |
| 质量 | snippet 薄、中文/垂直领域噪声大 |
| 合规 | 爬虫 ToS 灰色；默认个人/实验场景 |

本 spec **默认走「轻量 + 可降级」**，不把付费 Search API 写进主线；需要稳定 SLA 时由用户自配 SearXNG 或 MCP 外置搜索服务。

### 3.2 实施分期（M-Prod-2）

```text
v1    ddgr 子进程（默认后端）
  ↓
v1.5  本地 cache 先查 + 搜索次数软提示
  ↓
v2    agent.json 可选 backend: ddgr | searxng
```

**不进 builtin 主线**（正交能力，按需并行）：

- **频道路由**（知乎 / HN / GitHub 等）→ 外部 skill（如 smart-search / agent-reach）或 MCP
- **浏览器已登录态搜索** → opencli 等 JIT 方案，非默认 `web_search`
- **付费 Search API**（Brave / Tavily 等）→ 用户自配 MCP 或 fork 变体

### 3.3 免 key 后端选型（参考）

| 后端 | 优点 | 缺点 | 本仓定位 |
|------|------|------|----------|
| **ddgr** | JSON、无 key、体量小、易 mock | 需安装；DuckDuckGo 非官方接口 | **v1 默认** |
| googler | 结果有时更全 | Google 风控更狠；维护波动 | 不内置；用户可自行 `run_shell` |
| **SearXNG**（自托管 HTTP） | 对 agent 是稳定 JSON 契约；可聚合多引擎 | 需部署 sidecar | **v2 可选**；可改 MCP HTTP 外置 |
| Python `duckduckgo-search` | 参数多 | 多 Python 依赖；同样脆 | 不优先 |
| 浏览器自动化 | 可用登录态 | 重、难测、权限大 | 明确不做默认 |

### 3.4 工具形状

```typescript
web_search({
  query: string,
  max_results?: number,   // 默认 5，上限 10
  region?: string,        // 透传 ddgr -r；v2 searxng 映射
  skip_cache?: boolean,   // v1.5：跳过本地 cache 层，强制外搜
})
// → markdown 列表；超长 pointerize
```

工具 description 须写明：**先本地 cache（v1.5）→ 再外网**；外搜失败时提示安装 ddgr 或配置 searxng。

### 3.5 搜索降级链（v1.5）

每次 `web_search` 按序尝试，命中即返回（标注 `source:`）：

```text
1. spill cache     grep/read .cache/web-fetch/  frontmatter 与标题（url、title 模糊匹配 query）
2. archives        .agent/memory/archives.md 一行摘要匹配（可选，token 友好）
3. external        v1/v2 配置的后端（ddgr / searxng）
```

设计意图：

- 减少重复外搜 → 降风控、省 turn
- 与 pointerize / 冷存叙事一致
- cache 命中 **不计入** 外搜次数预算（见 §3.7）

实现接缝：`src/tools/web-search.ts` 内 `searchLocalCache(query)`；不新增独立 tool。

### 3.6 `agent.json` 配置（v1 起草案，v2 生效 backend）

```json
{
  "web_search": {
    "allowed": true,
    "backend": "ddgr",
    "max_results_default": 5,
    "max_results_cap": 10,
    "ddgr_path": "ddgr",
    "searxng": {
      "base_url": "http://127.0.0.1:8888",
      "categories": "general"
    },
    "cache": {
      "enabled": true,
      "search_spill_dir": ".cache/web-fetch"
    },
    "budget": {
      "max_external_per_task": 5,
      "warn_after": 3
    },
    "domain_hints": []
  }
}
```

| 字段 | 说明 |
|------|------|
| `allowed` | `false` 时工具不可见（硬关，优先于 `ALLOW_WEB`） |
| `backend` | v1 仅 `ddgr`；v2 加 `searxng` |
| `searxng` | `GET {base_url}/search?format=json&q=…`；与 MCP streamable-http **二选一**接入即可 |
| `cache.enabled` | v1.5 本地先查；默认 `true` |
| `budget` | 单 task 外搜次数；超限返回 `error: web_search budget exhausted` + 建议 `web_fetch` 已知 URL |
| `domain_hints` | 可选；外搜时自动加 `site:` 或后过滤（提高免 key 精度） |

环境变量：`ALLOW_WEB=0` / TUI `/web off` 时与 `web_fetch` 同级禁用。

### 3.7 搜索预算与后台 Researcher（软约束）

| 机制 | 行为 |
|------|------|
| `budget.warn_after` | 第 N 次外搜起，结果前缀 `[web_search: N/${max} this task]` |
| `budget.max_external_per_task` | 超限拒绝外搜；cache 命中不计数 |
| 重活委派 | 文档建议：>5 次发现类任务用 `spawn_background(web-researcher)`，报告落 `workspace/jobs/` |

与压测 harness（`docs/ROADMAP.md` §5）同叙事：主 Agent 少搜，子 job 多 turn。

### 3.8 v1 实现要点（ddgr）

- 子进程：`ddgr --json -n ${max_results} ${query}`（region 用 `-r`）
- 解析 stdout → `{ title, url, snippet }[]`；stderr 非空附在 `error:` 诊断
- 失败分类：
  - `ddgr not found` → 安装提示 + `apt/brew` 一行指引
  - 非零 exit / 空结果 → `error: web_search failed (…)`，**不** crash loop
- 权限：`isCapabilityEnabled(config, 'web')` + `PermissionGate`（同 `web-fetch.ts`）
- 注册：`src/tools/web-search.ts` + `ToolRegistry`；只读 → 可进 parallel batch
- 测试：mock 子进程 stdout（`tests/web-search.test.ts`）；不依赖网络

### 3.9 v1.5 实现要点（cache + budget）

- `searchLocalCache`：对 `.cache/web-fetch/**/*.md` 读 frontmatter `source_url` / `title`，简单 token 匹配 query
- 返回格式：`[cache hit] url · title · excerpt`（最多 3 条）
- task 级计数器挂在 `AgentConfig` 或 run 局部状态（随 task 重置）
- `turn_io` / tool_result 可带 `web_search_source: cache|ddgr|searxng`（`--json-events` 可选）

### 3.10 v2 实现要点（searxng）

- HTTP `fetch` 至 SearXNG JSON API；timeout + 清晰 `error: searxng unreachable`
- **不**把 SearXNG 打进 `node_modules`；用户 Docker / 本机二选一
- 替代路径：SearXNG 以 **MCP HTTP** 暴露，builtin `web_search` 保持 ddgr-only，避免双份逻辑——实现时二选一并在本文档注明

### 3.11 明确不做（本 spec）

- 默认内置浏览器自动化搜索
- Python `duckduckgo-search` 作为硬依赖
- 付费 API 默认配置（Brave / Tavily / Serper）
- 用 `web_search` 替代 `web_fetch` 拉全文
- 频道爬虫（知乎 / 微博等）塞进 builtin——走 skill / MCP

### 3.12 验收

**v1（M-Prod-2 首 PR）** ✅

- [x] `ddgr` 可用时返回 ≥1 条结构化结果
- [x] 无 `ddgr` 时 `error:` 可读，ReAct 继续
- [x] `web_search.allowed: false` 或 `ALLOW_WEB=0` 时工具不可用
- [x] 结果超阈值时 inline 截断；pointerize 规则已注册
- [x] `npm test` mock 路径全绿

**v1.5** ✅

- [x] spill cache 命中时不再调 ddgr
- [x] 外搜次数超 `warn_after` 有前缀提示；超 `max_external_per_task` 拒绝
- [x] cache 命中不计入 budget

**v2**

- [ ] `backend: searxng` 可切换；`ddgr` 仍可用
- [ ] searxng 不可达时错误明确，可回退 ddgr（若配置 `fallback: ddgr` 可选）

---

## 4. `lsp_query` — TypeScript / 多语言 LSP 桥接

### 目标

给 agent **goto definition / references / hover / document symbols**，避免纯文本 grep 误伤。

### 后端

| 语言 | 推荐 server | 集成方式 |
|------|-------------|----------|
| TypeScript | `typescript-language-server` 或 `vtsls` | stdio JSON-RPC 子进程 |
| 其他 | 按 `agent.json` 映射 | 同上 |

### 工具形状（草案）

```typescript
lsp_query({
  path: string,           // 工作区内文件
  line: number,           // 1-based
  character?: number,
  operation: 'hover' | 'definition' | 'references' | 'symbols',
})
```

### 实现要点

- **v1 范围**：单 workspace root = `cwd`；`textDocument/didOpen` 用磁盘内容；不做 unsaved buffer 同步
- 进程池：按 root 复用一个 LSP 子进程；run 结束或 idle TTL 后 kill
- 权限：只读路径校验（同 `read_file`）；**不需** `allowShell`（agent 托管子进程，用户不直接下命令）
- 输出：结构化 markdown（路径:行:列 + 摘要）；大结果 pointerize
- 失败：`error: LSP timeout` / `error: no server for .py`

### 明确不做（v1）

- 全 workspace `didChangeWatchedFiles` 同步
- Code action / rename / refactor 写操作
- 多根 workspace

### 验收

- [x] 对 fixture `.ts` 文件 `definition` 命中正确符号（TypeScript LanguageService）
- [x] 非 TS/JS 扩展错误可读
- [x] 无外部 language server 依赖（v1 用 `typescript` 包 in-process；abort 无常驻子进程）

### v1 落地说明（2026-07-13）

| 项 | 实现 |
|----|------|
| 后端 | in-process `typescript` LanguageService（`src/tools/lsp-typescript.ts`） |
| 操作 | `hover` · `definition` · `references` · `symbols` |
| 权限 | 只读 `resolveReadablePath`；**不需** `allowShell` |
| 注册 | `lsp_query` → BuiltinToolProvider + `dev-worker` |
| 后续 | 可选 stdio `typescript-language-server` / 多语言映射 |

---

## 5. `convert_document` — 多格式解析为 Markdown

### 目标

将 pdf / docx / pptx / xlsx 等转为 **Markdown 落盘**，agent 用 `read_file` 阅读（对齐 `web_fetch` spill）。

### 后端（可选，用户环境安装）

| 后端 | 适用 | 备注 |
|------|------|------|
| **MarkItDown** | Office、PDF、图片 OCR 等 | Python 包，`markitdown path -o out.md` |
| **pandoc** | 格式最全 | 依赖重，适合已有 pandoc 的环境 |

`agent.json` 配置首选后端与 fallback。

### 工具形状（草案）

```typescript
convert_document({
  path: string,
  backend?: 'markitdown' | 'pandoc',
})
// → ok: wrote .cache/convert/<hash>.md + 前 2KB 预览
```

### 实现要点

- 输出目录：`.cache/convert/`（gitignore）；路径 escape 走现有 JIT
- 权限：`read_file` 读源 + 隐式写 cache（或显式 `write_file` 等价 gate）
- 大文件：只返回摘要 + `read_file` 指引；全文不进 context
- 与 `web_fetch` spill 共用「转换结果上盘」叙事

### 验收

- [ ] docx fixture → markdown 可读
- [ ] 后端缺失时 `error:` 明确
- [ ] 输出路径不逃逸 cwd 策略

---

## 6. `office_read` / `office_write` — Office CLI 封装

### 目标

参考开源 **office_cli** 类实践：用专用 CLI 做结构化读写，避免 LLM 直接改 xlsx/xml。

### 模式

```
Agent → office_read / office_write (builtin tool)
           → 子进程 office_cli（或同类）JSON stdin/stdout
           → 摘要进 context；完整结构落 .cache/office/ 或用户指定路径
```

### 工具形状（草案）

```typescript
office_read({ path: string, format?: 'json' | 'csv' | 'markdown_summary' })
office_write({ path: string, payload: object, mode?: 'replace_sheet' | 'append_rows' })
```

### 实现要点

- **先选型**：调研 1 个 MIT/Apache CLI（命名以实际 repo 为准），不急于内置多实现
- 权限：**`allowShell`** 或独立 `allowOffice` capability（实现前在 `permission-gate` 定一种）
- 写操作：JIT 确认（对齐 `write_file` / destructive shell）
- 输出：表格用 markdown 摘要；宽表 pointerize + 冷存

### 明确不做（v1）

- 内置纯 TS xlsx 解析（体积与边界情况多）
- WYSIWYG 或宏执行

### 验收

- [ ] xlsx fixture 读出 sheet 名 + 采样行
- [ ] 写后文件可被外部 Excel 打开
- [ ] 拒绝未授权路径

---

## 7. Coding 友好工具（规划）

> 面向 **主 Agent + `dev-worker` 子 Agent** 的编码体验；与 §3–6 正交。  
> **已落地 preset**：`agents/dev-worker.md` + `agent.json` `spawn_presets.dev-worker`（全量文件/shell/web 工具，禁 spawn 递归）。

### 7.1 现状工具矩阵（编码任务）

| 能力 | 工具 | 编码场景 | 缺口 |
|------|------|----------|------|
| 导航 | `list_files` / `grep_search` / `read_file` | 定位符号与读文件 | 无 AST / 定义跳转 |
| 修改 | `edit_file`（hash 锚点）/ `write_file` | 精准补丁 / 新文件 | 无 multi-file atomic apply |
| 对照 | `diff_file` | 与冷存或期望文本 diff | 无 `git diff` 专用封装（可用 shell） |
| 验证 | `run_shell` | typecheck / test / lint | 无结构化 test 报告解析 |
| 记忆 | `recall_query` | 捞历史 tool 结果 | — |
| 技能 | `invoke_skill` | 加载 SKILL.md 流程 | — |
| 文档 | `web_search` + `web_fetch` | API/库文档 | 免 key 搜索脆 |
| 委派 | `spawn_*` / `code_review` | 并行 worker / 三审 | 子 Agent **禁止**再 spawn（`load-preset` 硬过滤） |

**`dev-worker` 工具白名单**（与 agent.json 同步）：

```text
read_file write_file edit_file grep_search list_files diff_file
recall_query invoke_skill run_shell web_fetch web_search
```

**明确不给子 Agent**：`spawn_agent` · `spawn_background` · `code_review`。

### 7.2 推荐补强顺序（coding 向）

```text
C0  dev-worker preset + max_turns_cap 提高          ✅ 2026-07-13
  ↓
C1  git_status / git_diff / git_log                  ✅ 2026-07-13
  ↓
C2  lsp_query（TS/JS LanguageService）               ✅ 2026-07-13
  ↓
C3  apply_patch 多文件 unified diff（单 tool）       降低 edit 轮次
  ↓
C4  test_run 结构化（解析 junit/tap 摘要）           压测/CI 友好
  ↓
C5  spawn_shell_policy（命令前缀白名单）             安全压测再开
```

| 项 | 形态 | 优先级 | 备注 |
|----|------|:------:|------|
| **C1 git_*** | builtin `git_status` / `git_diff` / `git_log` | ✅ | `src/tools/git.ts`；argv spawn；shell gate |
| **C2 lsp_query** | builtin + TS API | ✅ | `src/tools/lsp.ts`；无 shell；见 §4 |
| **C3 apply_patch** | builtin | P2 | 输入 unified diff；原子写 + hash 校验 |
| **C4 test_run** | builtin 或 shell+parser | P3 | 输出 pass/fail 计数进 context，全文 spill |
| **C5 shell_policy** | spawn 配置 | P2（压测） | `docs/ROADMAP` §5.3 |

#### C1 实现要点（已落地）

- 子进程：`spawn('git', args)`，**不用** shell 字符串拼接。
- 权限：与 `run_shell` 相同 `requiresShell` + JIT。
- `git_diff` / `git_log` 的 `path` 必须在 cwd 内。
- 输出默认 `max_chars` 截断；无 diff 时返回 `ok: no differences`。
- 已加入 `dev-worker` 工具白名单与 `agent.json` `builtin_tools`。

### 7.3 并行编码用法（压测 / 日常）

```bash
# 父级开 shell；建议 sandbox cwd
npm start -- --allow-shell --cwd /path/to/sandbox \
  "spawn_background 3 个 dev-worker：A 实现 util/a.ts+测；B util/b.ts+测；C 导出 index"

# TUI
/spawns   # 应能看到 dev-worker
# 父级 /shell on 后委派；子 Agent 继承 allowShell + JIT
```

**约束回顾**：

- `spawn_policy.max_turns_cap` 默认 **80**（dev-worker `max_turns: 50`）
- `max_parallel: 3` — 注意 API 限流；可绑便宜 `api_profile`
- 安全：sandbox cwd + 父级显式 shell；**不做**无 gate 的子 shell

### 7.4 非目标（coding 工具）

- 内嵌完整 IDE / language server 协议全集  
- 自动 commit / push（保持人审）  
- 子 Agent 嵌套 spawn 农场  

---

## 8. 横切 concern

| 项 | 约定 |
|----|------|
| 注册 | `src/tools/*.ts` + `ToolRegistry`；MCP 同名工具不自动合并 |
| pointerize | 新工具大结果走现有 `shouldPointerize` 规则或注册 per-tool 阈值 |
| 并行 | 只读工具可进 parallel batch；LSP / convert 视子进程锁策略 |
| 测试 | 每工具 ≥1 单元测试 + 可选 fixture 集成测试（无网络） |
| 文档 | 工具 description 写清与 `run_shell` 手工调 CLI 的分工 |

---

## 9. 版本

| 日期 | 说明 |
|------|------|
| 2026-07-06 | v0.1 初稿：web_search、lsp_query、convert_document、office_* 范围与验收 |
| 2026-07-12 | v0.2：`web_search` 分期（v1 ddgr / v1.5 cache+budget / v2 searxng）、降级链、agent.json 草案 |
| 2026-07-13 | v0.3：§7 Coding 友好工具；`dev-worker` preset；C1–C5 路线 |
| 2026-07-13 | v0.3.1：C1 `git_status` / `git_diff` / `git_log` 落地 |
| 2026-07-13 | v0.3.2：C2 `lsp_query`（TS LanguageService）落地 |

---

*维护：与 [ROADMAP.md](./ROADMAP.md) 轨 F（个性化）解耦；能力项就绪后按 §2 / §7 顺序单独 PR。*