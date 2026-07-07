# minimal-agent-ts 后续路线图

> **定位**: 一页纸规划，避免 TUI / 性能 / Rust 三线并行。  
> **前提**: Phase 1–2、4–6 已实现。  
> **当前重点**: 轨 B **P0 填表复测**；轨 A TUI 细节打磨；轨 F 个性化与 ZVEC 减负（见下）。  
> **能力拓展**（web search / LSP / 文档转换 / Office）：单见 **[SPEC_TOOLS.md](./SPEC_TOOLS.md)**，不进本表主线。  
> **工程审查**: `workspace/CODE_REVIEW_REPORT.md`（2026-07-01）为历史快照；以本文件 + `npm test` 为准。

**推荐顺序**: **B（P0 填表）→ F（轻量记忆 + Agent.md + 去 ZVEC）→ 视数据选 C**；轨 A / 轨 E 增强与 **SPEC_TOOLS** 按需并行，不要 B+C 同时开工。

---

## 总览

| 轨 | 目标 | 触发条件 | 不做 | 优先级 |
|----|------|----------|------|--------|
| **A** | 嫁接 pi-tui 呈现层 | ✅ **基础版已实现**（`npm run tui`）；演示级 polish 按需 | fork 整仓、重写 agent 内核 | P2（增强） |
| **B** | TS 运行时内存 / **turn 延迟** / IO | 异步 IO 已落地；**P0 表待填** | 无 profiling 就改架构 | **P0（观测）** |
| **C** | Rust 内核 fork（CPU 热点） | B 填表后仍撞墙，且热点已定位 | preemptive 全量重写 `runAgent` | P3 |
| **D** | `spawn_agent` 同步预设子 Agent | ✅ **已实现**（基础版） | Meta-Planner 动态 flow、嵌套 spawn | — |
| **E** | `spawn_background` + `code_review` 后台 job | ✅ **已实现**（Phase 1a–1d） | TUI jobs 面板、跨机调度 | P2（增强） |
| **F** | 个性化 + 依赖减负 | P0 填表后、细节打磨期 | 内置 RAG、重造 MemFileCli | P1 |
| **—** | 工具能力拓展 | 有真实任务需求 | 见 [SPEC_TOOLS.md](./SPEC_TOOLS.md) | 按需 |

---

## 工程健康度与优先级（勘误版）

> 对照 `workspace/CODE_REVIEW_REPORT.md` §七 勘误；审查快照为 2026-07-01，本仓已演进（TUI picker、H3 transcript、分页 overlay 等）。

### 审查结论（仍成立）

| 方面 | 判断 |
|------|------|
| 模块职责 / 上下文冷热分离 | 核心亮点，维持现状 |
| `ToolRegistry` 上帝对象 (~340 行) | 技术债，非紧急 |
| `context-policy` 三层交织 | Tier 1 prune/pointer 回归已补；改压缩策略前可再扩边界用例 |
| `spawn/runner.ts` 动态 `import()` 破环 | 正确；禁止改回顶层静态 import |
| `import type` 循环 | 低危，可接受 |

### 勘误：测试现状（报告 §四「无测试」已过时）

| 项 | 2026-07-01 报告 | 当前（2026-07-05） |
|----|-----------------|---------------------|
| 测试文件 | 0 | **42** |
| 用例数 | — | **232**（`npm test`） |
| 已覆盖 | — | compression、**context-prune**、pointer-compact、**pointerize**、**action-store**、tool-scheduler、llm-retry、permission-gate、**path-utils**、spawn-*、**spawn-background**、**spawn-job-cancel**、**code-review-background**、**loop-guard**、**action-write/index queue**、**p0-telemetry**、web-fetch、session-*、TUI overlay 等 |

**Tier 1 补洞（✅ 2026-07-05）**：`tests/pointerize.test.ts`（`shouldPointerize` / `materializePriorTurnTools`）、`tests/action-store.test.ts`（冷存读写与列表）、`tests/context-prune.test.ts`（20k/40k 门槛、`assembleApiMessages`）。

### 优先级表（合并审查 + 实测）

| 优先级 | 事项 | 触发 / 依据 | 工作量 |
|:------:|------|-------------|:------:|
| **P0** | 轨 B **观测填表**：turn P50/P95、`turn_io`、`spawn_background` 场景 | 异步 IO 已落地；**待复测** `max_parallel=3` + 后台 `code_review` | 半天 |
| **P1** | ✅ **同步 IO 异步化**（B-IO-1～3、Index 队列） | `ActionWriteQueue`、`TranscriptWriteQueue`、`ActionIndexQueue` 已合入 | — |
| **P1** | ✅ 测试补洞：pointerize 规则 + action-store + prune 边界 | `pointerize` / `action-store` / `context-prune` 单测已合入 | — |
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
| 预设 MD | `agents/*.md`（含 `code-review-bug/security/quality` 等） |
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
- [x] 子 Agent action 独立冷存路径（`actions/spawn/<parent>/`，见 `spawn-cold-storage` 测试）

---

## 轨 E：后台 Spawn 与 `code_review`（✅ Phase 1a–1d 已实现）

### 目标

主 Agent 启动长时间子任务后**立即返回** `job_id`，不阻塞 ReAct 循环；`code_review` 支持 `background: true` 并发三审查预设。

### 实现

| Phase | 内容 | 路径 |
|-------|------|------|
| 1a | Job 磁盘状态机 | `src/spawn/job-registry.ts`, `job-store.ts`, `job-paths.ts` |
| 1b | `spawn_background` 工具 + CLI | `src/tools/spawn-background.ts`, `src/spawn-cli.ts` |
| 1c | `cancel.requested` 跨进程取消 | `src/spawn/job-cancel.ts` |
| 1d | `code_review({ background: true })` | `src/tools/code-review.ts` |

运行时输出：`workspace/jobs/<job_id>/`（`meta.json`、`events.jsonl`、`report.md`）— 本地，不进 git。

### 后续可选（非 P0）

- [ ] TUI jobs 面板（`/jobs` 或 spawn 状态条）
- [ ] P0 遥测按 `job_id` 分桶（`P0_TELEMETRY=1` 骨架已有）
- [ ] `code_review` diff 截断策略调优（当前 40K chars）

### 已合入但未单列的事项

- [x] `code_review` 同步路径（`Promise.all` 三 preset）
- [x] loop guard：review/spawn 豁免、强制总结 session 回滚（`loop-guard.ts` + `runner.ts`）

---

## 轨 A：TUI 嫁接（pi / OpenCode）（✅ 基础版已实现）

### 目标

保留 `AgentRuntime` + `runAgent` / `runWorkflow` 语义，只替换 **presenter**（输入框、流式展示、tool 卡片、markdown）。

### 已有对接面

| 接口 | 路径 | 说明 |
|------|------|------|
| `AgentRuntime` | `src/runner.ts` | session、shell/web、workflow、abort |
| `RuntimeEvent` | `src/events.ts` | 生命周期 + `AgentStepEvent` |
| NDJSON | `npm start -- --json-events` | 第三方 UI / PoC 无需改内核 |
| TUI（pi-tui） | `src/tui/`、`npm run tui` | pi 式 REPL + slash + overlay + tool presenter |

### 路线选择

| 来源 | 拿什么 | 工作量 | 备注 |
|------|--------|--------|------|
| **pi** | `@earendil-works/pi-tui` 组件（Markdown、Input、SelectList…） | 中 | **首选**；文档见 [pi TUI](https://pi.dev/docs/latest/tui) |
| **OpenCode** | TUI 层 / 交互思路 | 中–高 | 适合参考，不宜整仓 fork |
| **自研** | 继续增强 `src/tui/log.ts` | 低 | 当前方案；演示感弱但实验诚实 |

### 触发条件（**增强**项，基础版已可用）

- [ ] 现有 TUI 无法满足日常演示 / 给他人用（workflow 分栏、jobs 面板等）
- [x] `--json-events` 事件字段可供第三方 UI 消费
- [ ] session 内压测结论稳定，愿为 UI polish 分心

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
- **主 Agent + 子 Agent（`spawn_policy.max_parallel: 2→3`）均满并发** 时，**单 turn 墙钟明显变长** — 同步 IO 已队列化，**待 P0 复测**是否仍有拐点。

### 同步 IO 热点（审查 + 代码路径）

| 调用点 | 模块 | 时机 | 放大因子 |
|--------|------|------|----------|
| `saveAction()` → 队列 | `action-write-queue.ts` | 每个 tool 完成 **enqueue**；后台批量 `writeFile` | × 并行 tool 数（已异步，非 sync） |
| `appendTaskTranscript()` → 队列 | `session-transcript-queue.ts` | 每个 task 完成 **enqueue**；后台 append | × workflow 多角色 |
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

| 步骤 | 内容 | 文件 | 状态 |
|:----:|------|------|------|
| **B-IO-1** | `ActionWriteQueue` 异步批量写盘；run/spawn 结束 `flush`；abort `flushSync` | `action-write-queue.ts`, `action-store.ts` | ✅ |
| **B-IO-2** | 队列按 session 合并 flush（批量 drain） | `action-write-queue.ts` | ✅ |
| **B-IO-3** | `TranscriptWriteQueue` 异步 append | `session-transcript-queue.ts` | ✅ |
| **B-IO-4** | `turn_io` + `action_flush` 指标；`ACTION_IO_METRICS=1` | `action-io-metrics.ts`, `events.ts` | ✅ |
| **B-IO-5** | spawn action 写入 `actions/spawn/<parent>/` | `action-paths.ts`, `spawn/runner.ts` | ✅ |
| **B-IO-6** | `ActionIndexQueue` 串行索引 + spawn 暂停 | `action-index-queue.ts` | ✅ |
| **B-IO-7** | P0 遥测 `runs.jsonl` + `summary.tsv`（可选） | `p0-telemetry.ts`, `p0-summary.ts` | ✅ 骨架 |

**明确不做（本阶段）**：

- 把 `saveAction` 改成纯内存、丢冷存（违背 recall 叙事）
- 为 IO 改 `runAgent` 语义或 pointerize 规则
- 未测就先上 Rust（轨 C）

### 优先怀疑点（Node / TS，含非 IO）

| 区域 | 模块 | 典型症状 |
|------|------|----------|
| action 写盘队列积压 | `action-write-queue.ts` | 满并发时队列深度 / flush 延迟（**待 P0 量化**） |
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

**P1 异步 IO 实作**：

- [x] B-IO-1～6 已合入（见上表）
- [ ] P0 复测确认 turn P95 较 2026-07 主观卡顿有改善（填压测表）

**其他 B 项**（非 IO）：

- [ ] turn > **N**（如 50）时 RSS > **X MB** 或明显 GC 卡顿
- [ ] embedding 索引阻塞主循环可感知

### 候选优化（按性价比，IO 优先）

1. **B-IO-1～3** 同步写盘队列化（见上表）
2. `saveSession` 增量 / 节流（已有 `saveSessionThrottled`；评估是否够）
3. embedding 懒加载、批量 `indexActionAsync` 限流
4. 压缩后释放大 `content` 引用（仅留 action_id）
5. `assembleApiMessages` 结果缓存失效策略收紧
6. 系统提示词 `Agent.md` — 见 **轨 F-1**

### 验收

- 同任务复测（尤其 **spawn max_parallel=2** 场景）：turn P95 或 RSS 明显改善（记入上表）
- headless / TUI 行为与 spec 一致；abort 后冷存完整
- `npm test` 无回归

---

## 轨 F：个性化与依赖减负

### 目标

**文件即配置、文件即记忆**；削减 ZVEC / embedding 开销；与 ReAct 主线正交，可小步 PR。

### F-1：`Agent.md` 工作区系统提示词

| 项 | 说明 |
|----|------|
| 文件 | `cwd/Agent.md` 或 `AGENTS.md`（先命中先用） |
| 注入 | `buildSystemPrompt()` 之后追加；设字符上限（如 8k） |
| 优先级 | base prompt < **Agent.md** < `agent.json` extension < workflow 角色 |
| 路径 | `src/agent-prompt.ts` + run 前 loader（`runner.ts`） |

- [x] 读取 + 截断 + 单测（缺失文件不报错）；模板 `Agent.md.example`
- [x] 每 task run 重新加载（`buildSystemPrompt`）；TUI `run_start` 显示 `📋 Agent.md`
- [ ] TUI `/reload` 显式刷新（可选）

### F-2：轻量跨 session 记忆（Obsidian-lite，无 RAG）

不内置向量检索；**Markdown 文件 + slash + 现有 read/grep**。

```
.agent/memory/
  profile.md        # 用户画像、偏好
  archives.md       # 任务归档索引（路径 + 一句话）
  requirements.md   # 少量硬性要求
```

| 项 | 说明 |
|----|------|
| slash | `/memory` 查看与编辑上述文件（或子命令 `show` / `edit`） |
| 注入 | session 启动将 `profile` + `requirements` 拼入 system 扩展（token 上限） |
| 归档 | 大任务完成写 `archives.md` 一行；召回靠 `grep_search` / `read_file` |
| 与 MemFileCli | **可选并存** — MemFileCli 管深度 Wiki；本仓只管轻量用户层 |

- [x] 目录约定 `.agent/memory/` + `src/workspace-memory.ts`
- [x] `/memory` slash（status / show / init / paths）+ system 注入 profile + requirements
- [ ] 更新 `SPEC_CONTEXT_MANAGEMENT.md` §Phase 3 职责分界（一句指向轨 F）

### F-3：ZVEC 逐步剔除

| 阶段 | 内容 | 状态 |
|:----:|------|------|
| **F3-a** | 默认 `ENABLE_ZVEC=0`；文档标 deprecated | 待做 |
| **F3-b** | `recall_query` 仅保留 `action_id` + 标量/keyword 过滤 | 待做 |
| **F3-c** | 删除 `action-index.ts`、`embedding.ts`、`@zvec/zvec` | 待做 |

**保留**：`action-store` 冷存、`recall_query(action_id)`、transcript 内 grep。  
**删除**：384 维 embedding、`@xenova/transformers` 索引路径（若仅服务 ZVEC）。  
**收益**：安装体积、索引 CPU/RSS、轨 B 表「混合检索」一行可填「已移除」。

### 触发条件

- [x] 细节打磨期，需要用户可配置行为（Agent.md、/memory）
- [ ] P0 表确认 embedding/zvec 对 turn 延迟有贡献，或维护者主观同意先删

### 验收

- 新 clone：`ENABLE_ZVEC=0` 默认下 `npm test` 全绿
- `Agent.md` 存在时行为可感知变化，不存在时与现版一致
- `/memory` 只动 `.agent/memory/`，不碰 session 冷存格式

### 明确不做

- 内置跨 session 向量库 / RAG pipeline
- 用 `/memory` 替代 `recall_query` 的 session 内冷存

---

## 轨 C：Rust 内核 fork

### 目标

仅将 **已证实的 CPU 密集路径** 迁到 Rust；TS 保留编排、MCP、Skills、workflow、TUI。

### 适合 Rust 化的边界

| 候选 | 现 TS 模块 | 不适合迁 Rust 的 |
|------|------------|------------------|
| Embedding 推理 | `embedding.ts`（**轨 F3 剔除后取消**） | `runAgent` 主循环、LLM 流式 |
| 向量 + FTS 检索 | `action-index.ts`（**轨 F3 剔除后取消**） | workflow 模板、slash |
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
| **MemFileCli** | 可选：深度 Wiki 记忆（轨 F `/memory` 管轻量用户层） |
| **SPEC_TOOLS.md** | 工具能力拓展（web search / LSP / 文档 / Office），与主线解耦 |
| **minimal-agent-rs**（规划） | 可选 CPU 内核，轨 C 触发后再建 |

---

## 版本

| 日期 | 说明 |
|------|------|
| 2026-06-30 | 轨 D：OhMy 式 `spawn_agent` 基础版落地 |
| 2026-06-30 | 初版：轨 A/B/C、触发条件、压测表、对接面 |
| 2026-07-03 | 合并 `CODE_REVIEW_REPORT.md` 勘误优先级；轨 B 增同步 IO 规划与 spawn 满并发 turn 延迟观测 |
| 2026-07-03 | B-IO-4 + B-IO-1：`turn_io`/`action_flush` 指标 + `ActionWriteQueue` 异步写盘 |
| 2026-07-04 | 勘误：轨 A/E 基础版、B-IO-2～7、`code_review`、loop guard；测试 170；公开 GitHub |
| 2026-07-05 | Tier 1 测试补洞（pointerize / action-store / context-prune）；`path_escape` 权限；测试 **211** |
| 2026-07-06 | 轨 F（Agent.md、/memory、ZVEC 剔除）；**SPEC_TOOLS.md** 单开；pi-tui compact tool 显示；测试 **232** |