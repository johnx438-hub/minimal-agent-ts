# minimal-agent-ts 后续路线图

> **定位**: 一页纸规划，避免 TUI / 性能 / Rust 三线并行。  
> **前提**: Phase 1–2、4–6 已实现；Phase 3 跨 session 由 **MemFileCli** 外置（见 `SPEC_CONTEXT_MANAGEMENT.md` §Phase 3、`MemFileCli-skill`）。  
> **当前重点**: session **内**上下文压测（长轮次网络漫游、HTML 小游戏等；已观测 ~38+ turn 稳定）。

**推荐顺序**: **B（观测）→ 视数据选 A 或 C**，不要 A+C 同时开工。

---

## 总览

| 轨 | 目标 | 触发条件 | 不做 | 优先级 |
|----|------|----------|------|--------|
| **A** | 嫁接 OpenCode / pi 的 TUI 呈现层 | 极简 TUI 不够用，或需要演示级 UI | fork 整仓、重写 agent 内核 | P2 |
| **B** | TS 运行时内存 / 延迟优化 | 压测出现拐点（见下表） | 无 profiling 数据就改架构 | P1（观测先行） |
| **C** | Rust 内核 fork（CPU 热点） | B 做完仍撞墙，且热点已定位 |  preemptive 全量重写 `runAgent` | P3 |
| **D** | OhMy 式 spawn 预设子 Agent | ✅ **已实现**（基础版） | Meta-Planner 动态 flow、嵌套 spawn | — |

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

## 轨 B：TS 性能与内存抖动

### 目标

在 **不 fork Rust** 的前提下，用 profiling 数据做针对性减负。

### 优先怀疑点（Node / TS）

| 区域 | 模块 | 典型症状 |
|------|------|----------|
| Session 整树序列化 | `session.ts`、`saveSession` | turn 越多 save 越慢、RSS 阶梯上升 |
| Embedding 推理 | `embedding.ts`、`@xenova/transformers` | 索引时 CPU/RSS 尖峰 |
| 混合检索 | `action-index.ts`、zvec | recall / 索引写入卡顿 |
| 消息树常驻 | `agent.ts`、`current_messages` | 长会话 RSS 与 messages 长度线性相关 |
| 大 tool 结果多份拷贝 | inline + `action-store` | 峰值内存翻倍 |

### 压测记录表（填数据后再优化）

| 日期 | 任务类型 | turn | RSS (MB) | saveSession (ms) | 备注 |
|------|----------|------|----------|------------------|------|
| 2026-06-30 | 网络漫游 / HTML 小游戏 | ~38+ | _待填_ | _待填_ | 基线：尚稳定 |
| | | | | | |
| | | | | | |

**建议采集**（任选）:

```bash
# RSS 粗看（跑 task 前后各一次）
ps -o rss= -p $(pgrep -f "tsx src/tui")

# Node 堆快照（出现拐点时）
node --heapsnapshot-near-heap-limit=3 $(which tsx) src/tui/main.ts
```

### 触发条件（满足任一启动 B 实作）

- [ ] turn > **N**（自定，如 50）时 RSS > **X MB** 或明显 GC 卡顿
- [ ] `saveSession` 单次 > **Y ms**
- [ ] embedding 索引阻塞主循环可感知

### 候选优化（按性价比）

1. `saveSession` 增量 / 节流（不必每 tool 都写盘）
2. embedding 懒加载、批量 `indexActionAsync` 限流
3. 压缩后释放大 `content` 引用（仅留 action_id）
4. `assembleApiMessages` 结果缓存失效策略收紧
5. 系统提示词 MD 解析替换 — **维护者自行实验**，不进本轨 P0

### 验收

- 同任务复测：turn 上限或 RSS 明显改善（记录进上表）
- headless / TUI 行为与 spec 一致，无回归

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
| Action 冷存批量 IO | `action-store.ts` | session 业务逻辑 |

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