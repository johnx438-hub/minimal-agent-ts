# minimal-agent-ts 工具能力拓展 Spec（草案）

> **定位**: 与 ReAct 主线、上下文策略、TUI **正交** 的能力拓展规划；细节打磨期单开维护，避免撑大 `ROADMAP.md`。  
> **原则**: 轻量内置 + 可选外部 CLI 后端；大结果仍走 pointerize + 冷存；权限沿用现有 gate（`allowShell` / `allowWeb` / path JIT）。  
> **状态**: Draft v0.1（2026-07-06）；产品轨 Wave 2 见 **[docs/ROADMAP.md](./docs/ROADMAP.md)** §3

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

## 3. `web_search` — ddgr 式轻量搜索

### 目标

返回 **标题 + snippet + URL** 列表，不拉全文；供 agent 筛选后再 `web_fetch`。

### 后端

| 候选 | 优点 | 缺点 |
|------|------|------|
| **ddgr** | JSON 输出、无 API key、体量小 | 需本机安装 |
| googler | 功能类似 | 同上 |
| 自建 HTTP API | 可控 | 违背 minimal，不优先 |

### 工具形状（草案）

```typescript
web_search({ query: string, max_results?: number, region?: string })
// → markdown 列表或 JSON 摘要；超长 pointerize
```

### 实现要点

- 子进程调用 `ddgr --json …`，解析 stdout；失败时清晰 `error: ddgr not found`
- 权限：**`allowWeb`**（与 `web_fetch` 同级）；可选 `agent.json` `web_search.allowed: false` 硬关
- 不替代 `web_fetch`；system hint：`web_search` 发现 → `web_fetch` 深读
- 测试：mock 子进程 stdout；不依赖网络

### 验收

- [ ] 无 ddgr 时返回可读错误，不 crash loop
- [ ] 结果 ≤ N 条时可 inline；超出 pointerize
- [ ] `ENABLE_WEB=0` 时工具不可用

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

- [ ] 对 fixture `.ts` 文件 `definition` 命中正确符号
- [ ] server 未安装时错误可读
- [ ] abort 时子进程被清理

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

## 7. 横切 concern

| 项 | 约定 |
|----|------|
| 注册 | `src/tools/*.ts` + `ToolRegistry`；MCP 同名工具不自动合并 |
| pointerize | 新工具大结果走现有 `shouldPointerize` 规则或注册 per-tool 阈值 |
| 并行 | 只读工具可进 parallel batch；LSP / convert 视子进程锁策略 |
| 测试 | 每工具 ≥1 单元测试 + 可选 fixture 集成测试（无网络） |
| 文档 | 工具 description 写清与 `run_shell` 手工调 CLI 的分工 |

---

## 8. 版本

| 日期 | 说明 |
|------|------|
| 2026-07-06 | v0.1 初稿：web_search、lsp_query、convert_document、office_* 范围与验收 |

---

*维护：与 [ROADMAP.md](./ROADMAP.md) 轨 F（个性化）解耦；能力项就绪后按 §2 顺序单独 PR。*