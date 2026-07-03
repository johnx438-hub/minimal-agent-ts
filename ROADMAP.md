# minimal-agent-ts 后续路线图

> **定位**: 一页纸规划，避免 TUI / 性能 / Rust 三线并行。  
> **前提**: Phase 1–2、4–6 已实现；Phase 3 跨 session 由 **MemFileCli** 外置（见 `SPEC_CONTEXT_MANAGEMENT.md` §Phase 3、`MemFileCli-skill`）。  
> **当前重点**: session **内**上下文压测；**主/子 Agent 均打满并发时 turn 延迟明显变慢**（见轨 B §同步 IO）。  
> **工程审查**: `workspace/CODE_REVIEW_REPORT.md`（2026-07-01）— 下文 **§工程健康度** 为勘误后的优先级，以本表为准。

**推荐顺序**: **B（观测 + 同步 IO 减负）→ 视数据选 A 或 C**，不要 A+C 同时开工。

---

## 总览

| 轨 | 目标 | 触发条件 | 不做 | 优先级 |
|----|------|----------|------|--------|
| **A** | 嫁接 OpenCode / pi 的 TUI 呈现层 | 极简 TUI 不够用，或需要演示级 UI | fork 整仓、重写 agent 内核 | P2 |
| **B** | TS 运行时内存 / **turn 延迟** / 同步 IO | 压测拐点或 spawn 满并发卡顿（已观测） | 无 profiling 就改架构 | **P0（观测）+ P1（IO）** |
| **C** | Rust 内核 fork（CPU 热点） | B 做完仍撞墙，且热点已定位 |  preemptive 全量重写 `runAgent` | P3 |
| **D** | OhMy 式 spawn 预设子 Agent | ✅ **已实现**（基础版） | Meta-Planner 动态 flow、嵌套 spawn | — |

---

## 工程健康度与优先级（勘误版）

> 对照 `workspace/CODE_REVIEW_REPORT.md` §七 勘误；审查快照为 2026-07-01，本仓已演进（TUI picker、H3 transcript、分页 overlay 等）。

### 审查结论（仍成立）

| 方面 | 判断 |
|------|------|
| 模块职责 / 上下文冷热分离 | 核心亮点，维持现状 |
| `ToolRegistry` 上帝对象 (~340 行) | 技术债，非紧急 |
| `context-policy` 三层交织 | 改压缩策略前补回归测试 |
| `spawn/runner.ts` 动态 `import()` 破环 | 正确；禁止改回顶层静态 import |
| `import type` 循环 | 低危，可接受 |

### 勘误：测试现状（报告 §四「无测试」已过时）

| 项 | 2026-07-01 报告 | 当前（2026-07） |
|----|-----------------|-----------------|
| 测试文件 | 0 | **27** |
| 用例数 | — | **118+**（`npm test`） |
| 已覆盖 | — | compression、pointer-compact、tool-scheduler、llm-retry、permission-gate、spawn-abort、web-fetch、session-*、TUI overlay 等 |

**仍缺专门单测**（补洞即可，非从零建仓）：

- `pointerize.ts` — `POINTER_RULES` / `shouldPointerize` 阈值（`pointer-compact` 未覆盖）
- `action-store.ts` — 写入/读取/列表（仅 `session-log` 间接用到）
- `assembleApiMessages` / prune — 2–3 条边界回归

### 优先级表（合并审查 + 实测）

| 优先级 | 事项 | 触发 / 依据 | 工作量 |
|:------:|------|-------------|:------:|
| **P0** | 轨 B **观测**：turn 墙钟、并行 tool 批、`saveAction` 次数 | 主+子 **max_parallel 满负载** 时 turn 明显变慢（**已观测**） | 半天 |
| **P1** | **同步 IO 异步化**（见轨 B §同步 IO 规划） | P0 数据确认 `writeFileSync` 占 turn 尾延迟 | 1–2 天 |
| **P1** | 测试补洞：pointerize 规则 + action-store + prune 边界 | 动 IO/压缩前的安全带 | 0.5–1 天 |
| **P2** | `ToolRegistry` → Provider 拆分 | 新工具类型激增前 | 1–2 天 |
| **P2** | `token_cost` 更准（tiktoken 或 CJK 友好近似） | 仅当要做预算 UI / 报表 | 半天 |
| **P3** | `spawn/runner.ts` 静态 import 防护注释 + lint | 防误改破环 | 10 分钟 |
| **—** | 轨 A TUI 嫁接 | 功能与压测结论稳定后再动皮 | 见轨 A |
| **—** | 轨 C Rust | B + 异步 IO 后仍撞墙 | 见轨 C |

**原则**：审查报告推荐「先观测再优化」— 与上表一致；**异步 IO 可规划、按 P0 数据排期**，不 preemptive 大拆 `context-policy`。

---

## 轨 D：Spawn 预设子 Agent（✅ 基础版已实现）

### 目标

主 Agent 通过 `spawn_agent(preset, task)` 委派子任务；预设由用户 **MD + agent.json** 自定义（无内置人格）。

### 实现

| 项 | 路径 |
|----|------|
| 预设 MD | `agents/*.md`（示例：`web-researcher`、`skeleton-reader`） |
| 配置 | `agent.json` → `spawn_presets` + `builtin_tools` 含 `spawn_agent` |
| 加载 | `src/spawn/load-preset.ts` |
| 执行 | `src/spawn/runner.ts` → isolated `runAgent` |
| 工具 | `src/tools/spawn.ts` |

### 约束（v1）

- 子 Agent **isolated**，不写主 session `current_messages`
- **禁止**子 Agent 再 `spawn_agent`（`spawnDepth` ≤ 2）
- 继承父级 `allowShell` / `allowWeb` / `abortSignal`
- **不做** Meta-Planner 动态改 flow（权限与校验未定型）

### 后续可选（非 P0）

- [ ] slash `/spawns` 列表预设
- [ ] `{{recall(...)}}` workflow 模板
- [ ] 子 Agent action 可选写入主 session recall

---

## 轨 A：TUI 嫁接（pi / OpenCode）

### 目标

保留 `AgentRuntime` + `runAgent` / `runWorkflow` 语义，只替换 **presenter**（输入框、流式展示、tool 卡片、markdown）。

### 已有对接面

| 接口 | 路径 | 说明 |
|------|------|------|
| `AgentRuntime` | `src/runner.ts` | session、shell/web、workflow、abort |
| `RuntimeEvent` | `src/events.ts` | 生命周期 + `AgentStepEvent` |
| NDJSON | `npm start -- --json-events` | 第三方 UI / PoC 无需改内核 |
| TUI 极简版 | `src/tui/` | pi 式滚动 REPL + slash + 终稿 markdown |

### 路线选择

| 来源 | 拿什么 | 工作量 | 备注 |
|------|--------|--------|------|
| **pi** | `@earendil-works/pi-tui` 组件（Markdown、Input、SelectList…） | 中 | **首选**；文档见 [pi TUI](https://pi.dev/docs/latest/tui) |
| **OpenCode** | TUI 层 / 交互思路 | 中–高 | 适合参考，不宜整仓 fork |
| **自研** | 继续增强 `src/tui/log.ts` | 低 | 当前方案；演示感弱但实验诚实 |

### 触发条件（满足任一再启动 A）

- [ ] 极简 TUI 无法满足日常演示 / 给他人用
- [ ] `--json-events` PoC 验证事件字段够用
- [ ] session 内压测结论稳定，愿为 UI 分心

### 验收

1. slash（`/sessions`、`/workflow`、`/stop` 等）仍只调 `AgentRuntime`，**不**穿透 `agent.ts`
2. pointerize / compression 触发条件与 headless 一致
3. `npm start` headless 行为不变

### 明确不做

- workflow 流程图 / 角色分栏（见 `SPEC_TUI.md` 非目标）
- 在线热重载 `agent.json`
- 为 TUI 改 ReAct 语义

---

## 轨 B：TS 性能、turn 延迟与同步 IO

### 目标

在 **不 fork Rust** 的前提下，用 profiling 数据做针对性减负；优先消除 **事件循环上的同步写盘** 对 turn 尾延迟的放大。

### 已观测症状（2026-07）

- 单 Agent ~38+ turn 仍相对稳定（内存 / 压缩未明显拐点）。
- **主 Agent + 子 Agent（`spawn_policy.max_parallel: 2`）均满并发** 时，**单 turn 墙钟明显变长** — 怀疑同步 IO 与并行 tool 批叠加阻塞事件循环（待 P0 量化）。

### 同步 IO 热点（审查 + 代码路径）

| 调用点 | 模块 | 时机 | 放大因子 |
|--------|------|------|----------|
| `saveAction()` | `action-store.ts` | **每个** tool 完成，`writeFileSync` | × 并行 tool 数（`tool-scheduler`） |
| `appendTaskTranscript()` | `session-transcript.ts` | 每个 task 完成，`appendFileSync` | × workflow 多角色 |
| `saveSession()` | `session.ts` | run 结束 / 节流保存 | 整棵 `session.json` 序列化 |
| `indexActionAsync()` | `action-index.ts` | 每 action（已异步） | CPU/RSS，与 IO 争抢 |

**并发叠乘示意**（`max_parallel: 2` 时）：

```text
主 Agent turn：parallel batch N 个 tool → 最多 N 次同步 saveAction
              + 最多 2 个子 Agent 同时跑 → 各自 parallel batch → 2×N 级 writeFileSync
              → 事件循环在 await 工具结果后仍被 sync IO 卡住 → turn 尾延迟上升
```

### 同步 IO 异步化规划（P1，待 P0 数据确认后实施）

**设计原则**：与 `saveSessionThrottled` 对称 — **热路径只入队，后台 flush**；abort 时 `force` 刷盘；不改变 ActionStore 文件格式。

| 步骤 | 内容 | 文件 | 验收 |
|:----:|------|------|------|
| **B-IO-1** | `ActionWriteQueue`：`enqueue(block)` + 定时/批量 `writeFile`（`fs.promises`） | 新 `src/action-write-queue.ts`，`agent.ts` 改调队列 | 同任务复测 turn P95 下降；abort 后 action 文件仍存在 |
| **B-IO-2** | 队列 **按 session 合并 flush**（如 50ms 或 ≤8 条一批） | 同上 | 满并发 spawn 场景 turn 延迟改善 |
| **B-IO-3** | `appendTaskTranscript` 改异步 append + 可选内存队列 | `session-transcript.ts` | task 完成后 1s 内落盘；`max_bytes` 逻辑不变 |
| **B-IO-4** | ✅ 轻量指标：`turn_io` + `action_flush` 事件；`ACTION_IO_METRICS=1` 人类 log | `action-io-metrics.ts`, `events.ts`, `agent.ts` | P0 表可填数 |
| **B-IO-1** | ✅ `ActionWriteQueue` 异步批量写盘；run/spawn 结束 `flush`；abort `flushSync` | `action-write-queue.ts`, `action-store.ts` | 满并发 spawn 复测 turn P95 |
| **B-IO-5**（可选） | spawn 子 Agent action 写入 **独立子目录** 或延迟索引，减轻主 session 队列竞争 | `spawn/runner.ts` | 子 Agent 冷存不拖主 turn |

**明确不做（本阶段）**：

- 把 `saveAction` 改成纯内存、丢冷存（违背 recall 叙事）
- 为 IO 改 `runAgent` 语义或 pointerize 规则
- 未测就先上 Rust（轨 C）

### 优先怀疑点（Node / TS，含非 IO）

| 区域 | 模块 | 典型症状 |
|------|------|----------|
| **同步 action 写盘** | `action-store.ts` | 满并发 spawn + parallel tool → **turn 变慢（已观测）** |
| Session 整树序列化 | `session.ts`、`saveSession` | turn 越多 save 越慢、RSS 阶梯上升 |
| Embedding 推理 | `embedding.ts`、`@xenova/transformers` | 索引时 CPU/RSS 尖峰 |
| 混合检索 | `action-index.ts`、zvec | recall / 索引写入卡顿 |
| 消息树常驻 | `agent.ts`、`current_messages` | 长会话 RSS 与 messages 长度线性相关 |
| 大 tool 结果多份拷贝 | inline + `action-store` | 峰值内存翻倍 |

### 压测记录表（P0 必填后再动 P1 IO）

| 日期 | 任务类型 | turn | 并发场景 | turn P50/P95 (ms) | saveAction 次/turn | RSS (MB) | 备注 |
|------|----------|------|----------|-------------------|---------------------|----------|------|
| 2026-06-30 | 网络漫游 / HTML 小游戏 | ~38+ | 单 Agent | _待填_ | _待填_ | _待填_ | 基线：尚稳定 |
| 2026-07 | 含 spawn 委派 | _待填_ | 主 + **max_parallel=2** | _待填_ | _待填_ | _待填_ | **满并发 turn 变慢（主观已确认）** |
| | | | | | | | |

**建议采集**：

```bash
# RSS 粗看（跑 task 前后各一次）
ps -o rss= -p $(pgrep -f "tsx src/tui")

# 带 json-events 跑一轮；筛 turn_io / action_flush 填 P0 表
ACTION_IO_METRICS=1 npm start -- --json-events --allow-shell -- "task…" 2>/dev/null | tee /tmp/events.ndjson
# jq 示例: grep turn_io → actions_saved, action_save_ms; action_flush → flush_ms

# Node 堆快照（出现拐点时）
node --heapsnapshot-near-heap-limit=3 $(which tsx) src/tui/main.ts
```

### 触发条件

**启动 P0 观测**（已满足一条）：

- [x] 主/子 Agent 满并发时 turn 延迟可感知变差

**启动 P1 异步 IO 实作**（满足任一）：

- [ ] P0 表显示 `saveAction` 次/turn 与 turn P95 强相关
- [ ] 单 turn 内 sync write 累计 > **Y ms**（自定，如 20ms）
- [ ] 异步 IO 方案 B-IO-1 PoC 在 spawn 压测场景 P95 改善 ≥30%

**其他 B 项**（非 IO）：

- [ ] turn > **N**（如 50）时 RSS > **X MB** 或明显 GC 卡顿
- [ ] embedding 索引阻塞主循环可感知

### 候选优化（按性价比，IO 优先）

1. **B-IO-1～3** 同步写盘队列化（见上表）
2. `saveSession` 增量 / 节流（已有 `saveSessionThrottled`；评估是否够）
3. embedding 懒加载、批量 `indexActionAsync` 限流
4. 压缩后释放大 `content` 引用（仅留 action_id）
5. `assembleApiMessages` 结果缓存失效策略收紧
6. 系统提示词 MD 解析替换 — **维护者自行实验**，不进本轨 P0

### 验收

- 同任务复测（尤其 **spawn max_parallel=2** 场景）：turn P95 或 RSS 明显改善（记入上表）
- headless / TUI 行为与 spec 一致；abort 后冷存完整
- `npm test` 无回归

---

## 轨 C：Rust 内核 fork

### 目标

仅将 **已证实的 CPU 密集路径** 迁到 Rust；TS 保留编排、MCP、Skills、workflow、TUI。

### 适合 Rust 化的边界

| 候选 | 现 TS 模块 | 不适合迁 Rust 的 |
|------|------------|------------------|
| Embedding 推理 | `embedding.ts` | `runAgent` 主循环、LLM 流式 |
| 向量 + FTS 检索 | `action-index.ts` | workflow 模板、slash |
| 大文本 hash / diff | `file-hash.ts`、`edit_file` 锚定 | MCP stdio、Skills 加载 |
| Action 冷存批量 IO | `action-store.ts`（或轨 B 队列后再评估） | session 业务逻辑 |

### 架构草图

```
minimal-agent-ts/          # 壳：runner、TUI、workflow、plugins
minimal-agent-rs/          # 库或 CLI：embed、index、store（napi-rs 或子进程）
minimal-agent-ts-ds-cache/   # 已有：前缀缓存叙事 fork（独立）
```

集成方式（实现时再定）: **napi-rs** 同进程，或 **`minimal-agent-rs index/recall` 子进程** + JSON stdin/stdout。

### 触发条件（全部满足再启动 C）

- [ ] 轨 B 已做，热点仍占 CPU / 内存主导
- [ ] 热点函数在 profiling 中可点名（非「感觉慢」）
- [ ] 愿维护双语言构建与发布

### 验收

1. TS 壳 `npm start` / `npm run tui` 接口不变
2. 同任务压测：指标优于轨 B 最优值
3. Rust 边界文档化（哪些 API 稳定）

### 明确不做

- 为用 Rust 而用 Rust（38+ turn 仍稳时 **保持 TS**）
- 第一个版本就迁 `runAgent` 全循环
- 与 ds-cache fork 混为一谈（缓存策略仍独立 repo）

---

## 与其他 repo 的关系

| Repo | 职责 |
|------|------|
| **minimal-agent-ts**（本仓） | session 内上下文实验 + 极简 TUI + harness |
| **minimal-agent-ts-ds-cache** | DeepSeek 前缀缓存友好变体 |
| **MemFileCli** | 跨 session / 跨 Agent 记忆（Phase 3 外置） |
| **minimal-agent-rs**（规划） | 可选 CPU 内核，轨 C 触发后再建 |

---

## 版本

| 日期 | 说明 |
|------|------|
| 2026-06-30 | 轨 D：OhMy 式 `spawn_agent` 基础版落地 |
| 2026-06-30 | 初版：轨 A/B/C、触发条件、压测表、对接面 |
| 2026-07-03 | 合并 `CODE_REVIEW_REPORT.md` 勘误优先级；轨 B 增同步 IO 规划与 spawn 满并发 turn 延迟观测 |
| 2026-07-03 | B-IO-4 + B-IO-1：`turn_io`/`action_flush` 指标 + `ActionWriteQueue` 异步写盘 |