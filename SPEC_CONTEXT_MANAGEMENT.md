# minimal-agent-ts 上下文管理与动态提示词设计 Spec

> **目标**: 让 ReAct Agent harness 具备分层上下文管理能力，支持长对话不丢失关键信息  
> **日期**: 2026-07-15  
> **状态**: **v2.0 与代码对齐**（Phase 1–2、4–6 ✅；L2 turn-end pipeline ✅；Phase 3 外置 MemFileCli）  
> **产品/底座总规划**: [docs/ROADMAP.md](./docs/ROADMAP.md) · 工具面: [SPEC_TOOLS.md](./SPEC_TOOLS.md) · LLM: [SPEC_LLM_ROUTER.md](./SPEC_LLM_ROUTER.md)

### 2026-07 现状速览（对齐代码）

| 域 | 现状 | 代码锚点 |
|----|------|----------|
| **Turn-end 上下文** | pointerize → prune → pointer-compact → heavy compression | `src/context/pipeline.ts` → `runTurnEndPipeline` / `runTurnEndCompression` |
| **兼容入口** | `context-policy.ts` / `context-budget.ts` 为 **re-export** | `src/context/*` 为真源 |
| **冷存 + 指针** | ActionStore + 指针卡片 + `recall_query` | `action-store.ts`, `pointerize.ts`, `recall.ts` |
| **Recall 检索** | **action_id 精确** + **session 内关键词**（非向量） | `recall.ts`（**无** `@zvec/zvec` / 本地 embedding 依赖） |
| **工具调度** | 并行/串行启发式 + `tool_plan` 可观测 | `tool-scheduler.ts` |
| **插件** | ToolProvider 拆分；MCP stdio + streamable-http + sse | `tools/providers/*`, `plugins/mcp-*` |
| **Skills** | `invoke_skill`；仓库自带 `context-design`、`office-layout` | `skills/`（`.gitignore` 白名单） |
| **Office** | `office_read`/`office_write` **light schema**；富排版见 skill | `tools/office.ts` + `skills/office-layout` |
| **Spawn / jobs** | 同步 spawn + 后台 job 磁盘状态机 | `spawn/*`, `spawn_background` |
| **IM 出站** | MessageBridge 类型与部分接线 | `hooks/message-bridge.ts` |
| **入站 / 定时** | 契约在 ROADMAP §6；**未实现** daemon | 见 docs/ROADMAP Inbound + Schedule |

下文 Phase 1–6 保留设计史与验收叙事；**与上表冲突时以上表与代码为准**。

---

## 🗺️ 总路线图（Phase 1 → 6 + 后续）

| Phase | 主题 | 优先级 | 依赖 | 状态 |
|-------|------|--------|------|------|
| **1** | 会话续接 + TaskSummary + 滑动窗口 | P0 | — | ✅ |
| **2** | 冷存储 + 指针化 + recall + prune/compress | P0 | Phase 1 | ✅（策略已迁入 `src/context/`） |
| **2d′** | 向量语义 recall（历史草案 Zvec） | — | Phase 2 | ⏸ **未合入当前树**；现用关键词 + action_id |
| **3** | 跨 session / 跨 Agent 记忆 | P1 | — | 🔗 **外部** MemFileCli |
| **4** | 工具扩展 + 并行执行 + 流式 | P1 | Phase 1 | ✅（工具集已远超初版 4a 列表） |
| **5** | MCP / Skills | P2 | Phase 4a | ✅（含 HTTP MCP） |
| **6** | 多角色工作流 | P2 | 稳定 ReAct | ✅ 6a–6d |
| **L2** | Context pipeline 模块化 | 底座 | Phase 2 | ✅ L2-0～L2-6 |
| **L3+** | MessageBridge / Inbound / Schedule | 底座 | — | 出站类型 ✅；入站+定时 规划中 |

**原则**：先「单 Agent + 干净上下文」，再工具与运行时，再编排。产品迭代与打包见 **docs/ROADMAP.md**，本文专注上下文语义。

```
Phase 1 ──► Phase 2 (session 内) ──► MemFileCli（跨 session）
                │
                ├── L2: src/context/pipeline（turn-end 统一）
                │
                └──► Phase 4 工具 ──► Phase 5 MCP/Skills
                                   └──► Phase 6 workflow
                                        └──► Spawn/jobs · Office · Bridge…
```

---

## 🎯 核心设计理念

**热路径瘦身 + 冷存储保全 + 按需召回**（借鉴 OpenCode prune 哲学，用指针化 + recall 增强可恢复性）：

- **热路径**（API `messages[]`）：近期完整、中期摘要、大 tool 结果降级为 `[action:…]` 指针卡片
- **冷路径**（`ActionStore`）：每次 tool 执行双写全文，供 `recall_query` 与索引检索
- **假删除而非真销毁**：OpenCode 式 `compacted_at` 整段隐藏 + 指针化内容降级，数据均可回溯
- **压缩是事件**：摘要/指针一旦写入即 frozen，利于前缀缓存；动态提示走 **压缩事件消息**，不改 system
- 结构化 `TaskSummary` + `action_id` 保证分层可追溯，避免信息断裂

---

## 🏗️ 核心概念模型：分层 ID 定义

整个上下文管理系统基于四层 ID 层级，每层有明确的边界和职责。

### 层级结构

```
user_id (用户标识)
 └── session_id (会话标识)
      └── task_id (任务块标识)
           └── action_id (行动单元标识)
```

### user_id — 用户隔离层
- **用途**: 区分不同用户的记忆空间，实现数据隔离
- **格式**: `"user_001"` 或 UUID
- **生命周期**: 持久化，不随会话结束而失效
- **存储**: 顶层目录/数据库 schema 分隔

### session_id — 会话层
- **用途**: 标识一次完整的对话会话（从打开终端到关闭）
- **格式**: `"session_20260626_143000"` (日期时间戳)
- **生命周期**: 会话开始创建，会话结束归档
- **包含**: 多个 task_id，一个 session_summary
- **边界判定**: 
  - 开始: 首次用户输入
  - 结束: 进程退出或超过空闲超时（如 24h）

### task_id — 任务块层
- **用途**: 一次完整的"提问 → 工具调用 → 总结"闭环
- **格式**: `"task_{session_hash}_{seq}"` 如 `"task_a1b2c3_005"`
- **生命周期**: 用户提交问题开始，Agent 返回最终答案结束
- **包含**: 多个 action_id，一个 task_summary
- **边界判定**:
  - 开始: 用户发送新消息（role=user）
  - 中间: LLM → tool_calls → executeTool → 结果回注（循环）
  - 结束: LLM 返回无 tool_calls 的文本答案

### action_id — 行动单元层（最小粒度）
- **用途**: 一次"工具调用 + 执行结果"的完整记录
- **格式**: `"action_{task_hash}_{seq}"` 如 `"action_x9y8z7_012"`
- **生命周期**: 单次工具调用，不可再分
- **包含**: 
  ```typescript
  interface ActionBlock {
    action_id: string;
    task_id: string;
    turn_number: number;        // 全局轮次编号
    tool_name: string;          // "read_file" / "write_file" / ...
    args: Record<string, unknown>;
    result: string;
    timestamp: Date;
    token_cost: number;         // 本次 action 消耗的 token
  }
  ```

### 层级关系示例

```
user_id: "user_archer"
 └── session_id: "session_20260626_143000"
      │   session_summary: "今天讨论了 MemFileCli 升级和 Agent 上下文设计"
      │
      ├── task_id: "task_a1b2c3_001"
      │   │   task_summary: "读取并分析 minimal-agent.ts 的代码结构"
      │   │
      │   ├── action_x9y8z7_001: read_file(agent.ts) → 返回 93 行代码
      │   ├── action_x9y8z7_002: read_file(tools.ts) → 返回 128 行代码
      │   └── action_x9y8z7_003: [LLM 总结] "核心是 ReAct while 循环..."
      │
      ├── task_id: "task_a1b2c3_002"
      │   │   task_summary: "设计上下文管理的分层架构"
      │   │
      │   ├── action_x9y8z7_004: write_file(SPEC.md) → 写入 spec 文档
      │   └── action_x9y8z7_005: [LLM 总结] "三层架构已定义..."
      │
      └── ... (更多 tasks)
```

### ID 生成策略

| 层级 | 生成时机 | 格式 | 示例 |
|------|---------|------|------|
| user_id | 系统初始化 | `user_{identifier}` | `user_archer` |
| session_id | 会话启动 | `session_YYYYMMDD_HHMMSS` | `session_20260626_143000` |
| task_id | 用户新消息到达 | `task_{session_hash_short}_{seq}` | `task_a1b2c3_005` |
| action_id | 工具调用前 | `action_{task_hash_short}_{seq}` | `action_x9y8z7_012` |

---

## 💾 数据结构设计

### Zvec Collection Schema（历史草案 · Phase 2d，**当前未启用**）

> 2026-07：`package.json` **无** `@zvec/zvec` / transformers。跨 session 记忆走 MemFileCli；session 内 recall 为 **action_id + 关键词**。下列 schema 仅作设计存档。

```typescript
// agent_memory collection schema（草案）
const SCHEMA = {
  name: "agent_memory",
  
  // 向量字段：action_block 文本的 embedding
  vectors: {
    embedding: { dim: 384, metric: "cosine" }  // all-MiniLM-L6-v2 输出维度
  },
  
  // 标量字段：用于过滤和排序
  scalars: {
    user_id:     "text",      // 用户标识
    session_id:  "text",      // 会话标识
    task_id:     "text",      // 任务块标识
    action_id:   "text",      // 行动单元标识（主键）
    turn_number: "int",       // 全局轮次编号
    tool_name:   "text",      // 工具名称
    timestamp:   "int",       // Unix 时间戳 (ms)
    token_cost:  "int"        // 本次 action 消耗的 token
  },
  
  // 全文索引字段：action 内容文本
  text: {
    content: "fts"            // 工具调用参数 + 执行结果的完整文本
  }
};
```

### ActionBlock 文档结构

```typescript
interface ActionDoc {
  // ID 层级
  user_id: string;           // "user_archer"
  session_id: string;        // "session_20260626_143000"
  task_id: string;           // "task_a1b2c3_005"
  action_id: string;         // "action_x9y8z7_012"
  
  // 元数据
  turn_number: number;       // 15 (全局轮次)
  tool_name: string;         // "read_file" / "write_file" / "run_shell"
  timestamp: number;         // 1750963200000
  token_cost: number;        // 本次 action 消耗的 token
  
  // 内容
  args_json: string;         // JSON 字符串：工具调用参数
  result_text: string;       // 工具执行结果
  content: string;           // 组合文本（用于 embedding + FTS）
  
  // 向量
  embedding: float[];        // all-MiniLM-L6-v2 生成的 384 维向量
  
  // 标签（Phase 2+ 扩展）
  entities_touched?: string[];  // ["config.ts", "API_URL"]
}
```

### TaskSummary 文档结构 (Phase 1+)

**混合版设计**: 自动提取字段（零 LLM 开销）+ Agent 补充字段（~50 tokens/task）

```typescript
interface TaskSummaryDoc {
  task_id: string;           // "task_a1b2c3_005"
  session_id: string;        // "session_20260626_143000"
  
  turn_range: [number, number];  // [15, 22]
  action_count: number;          // 8 (包含多少个 actions)
  
  // === 自动提取字段（零 LLM 开销，从 messages/tool_calls 解析）===
  
  // 1. 用户意图 → 取第一条 user message
  user_intent: string;           // "主要请求和意图"
  
  // 6. 所有用户消息 → 过滤 role=user（非工具结果）
  user_messages: string[];       // "对于理解用户反馈至关重要"
  
  // 2. 技术概念 → 从文件扩展名/工具名推断
  tech_concepts: string[];       // ["TypeScript", "Node.js", "Zvec"]
  
  // 3. 文件与工作区 → 从 tool_calls.args.path 提取
  files_touched: string[];       // ["src/config.ts", "README.md"]
  
  // tools_used → 从 tool_calls.name 去重
  tools_used: string[];          // ["read_file", "write_file"]
  
  // === Agent 补充字段（task 结束时输出，~50 tokens）===
  
  // 7. Pending Tasks → Outline any pending tasks explicitly asked to work on
  pending_tasks: string[];       // ["测试连接", "更新文档"]
  
  // 8. Current Work → Describe in detail what was worked on immediately before summary
  current_work: string;          // "已修改 config.ts 的 API_URL，包含文件名和代码片段"
  
  // === 可选扩展（Phase 2+）===
  errors_encountered?: Array<{ error: string, fix?: string }>;  // 4-5. 错误与修复
  
  // === 向量检索字段（Phase 2+）===
  content: string;         // 组合文本（用于 embedding）
  embedding: float[];      // task 级别向量 (384 维)
}
```

### 摘要生成策略

| 字段 | 来源 | Token 开销 | 实现方式 |
|------|------|-----------|---------|
| user_intent | 第一条 user message | 0 | 直接提取 |
| user_messages | 过滤 role=user | 0 | 数组筛选 |
| files_touched | tool_calls.args.path | 0 | Set 去重 |
| tech_concepts | 文件扩展名映射 | 0 | 规则推断 |
| tools_used | tool_calls.name | 0 | Set 去重 |
| pending_tasks | Agent 最终回答后处理 | ~20 | 正则/LLM 提取 |
| current_work | Agent 最终回答 | ~30 | 一句话摘要 |

### SessionSummary 文档结构（原 Phase 3 草案，**不内置**）

> **决策 (2026-06-30)**：跨 session / 跨 Agent 长期记忆由 **MemFileCli**（`memfilecli` CLI + `MemFileCli-skill`）承接。minimal 专注 **单 session 内** 的 TaskSummary、pointerize、recall_query；不在本仓库实现 `SessionSummaryDoc` 写入与跨 session 索引。

以下为历史草案，仅供对照；集成方式见下文 Phase 3。

```typescript
// 不在 minimal-agent-ts 实现 — 记忆落 MemFileCli Wiki 节点
interface SessionSummaryDoc {
  session_id: string;
  user_id: string;
  task_count: number;
  total_turns: number;
  time_range: [number, number];
  summary_text: string;
  topics_covered: string[];
  content: string;
  embedding: float[];
}
```

---

## 🔧 技术选型（早期表 · 已修订）

| 组件 | 当前选择 | 说明 |
|------|----------|------|
| **Session / 冷存** | `.sessions/*.json` + `actions/` | 真源；不进 git |
| **Token 估算** | `context/budget` + `estimate` | 启发式；无 tiktoken |
| **Turn-end** | `context/pipeline` | 四段式 |
| **Recall** | action_id + 关键词 | 非向量 |
| **跨 session** | MemFileCli（外置） | 非本仓库 Zvec |
| **向量 / embedding** | ⏸ 未合入 | 历史 Zvec 草案见上节 schema |

> 旧版「Zvec 一库 + transformers」决策表作废；勿再按该表加依赖。

---

## 📐 上下文分层架构（热路径 + 冷路径）

```
冷路径 ActionStore (.sessions/actions/)     热路径 API messages[]
─────────────────────────────────────     ─────────────────────────
全文 args + result（永不指针化丢失）          ┌──────────────────────────────┐
关键词索引（session 内 list + match）        │ System Prompt (immutable)     │
                                           │ + 固定 recall 使用说明         │
                                           ├──────────────────────────────┤
                                           │ Layer 1 近期 ~40%              │
                                           │ → 当前 turn: inline 工具结果    │
                                           │ → 较早 turn: [action:…] 指针   │
                                           │ → 最近 2-3 task               │
                                           ├──────────────────────────────┤
                                           │ Layer 2 中期 ~30%              │
                                           │ → TaskSummary（frozen）        │
                                           ├──────────────────────────────┤
                                           │ Layer 3 早期 ~20%              │
                                           │ → compacted_at 消息已隐藏      │
                                           │ → 跨 session 不在此层（MemFile）│
                                           ├──────────────────────────────┤
                                           │ Current Task ~10%              │
                                           │ → 用户提问 + cwd               │
                                           │ → 压缩事件通知（append 一次）   │
                                           └──────────────────────────────┘
```

---

## 📋 Phase 1: 会话续接 + Task 摘要 + 滑动窗口

**目标**: 实现会话持久化（关闭后可 resume）、Task 混合版摘要、Token 驱动滑动窗口

### 功能清单

#### Step 1: Session ID 生成器与持久化
- [ ] **Session ID 生成**
  - 格式: `session_YYYYMMDD_HHMMSS`
  - 启动时自动生成或加载已有 session_id
  
- [ ] **session.json 持久化**
  ```typescript
  interface SessionFile {
    session_id: string;
    user_id: string;
    created_at: number;
    tasks: TaskSummaryDoc[];      // 已完成的任务摘要
    current_messages: ChatMessage[];  // 当前未完成任务的消息
  }
  ```
  
- [ ] **CLI 支持 --resume-session-id**
  - `npm start -- --resume session_20260627_203000 "继续上次的工作"`

#### Step 2: Task Block 识别器
- [ ] **Task 边界检测**
  - 开始: 用户新消息（role=user）
  - 结束: LLM 返回无 tool_calls 的文本答案
  - 每个 task_block 带唯一 ID: `task_{session_hash}_{seq}`

#### Step 3: TaskSummary 混合版生成器
- [ ] **自动提取字段（零 LLM 开销）**
  ```typescript
  // 从 messages/tool_calls 解析，不调 LLM
  user_intent: string;           // 第一条 user message
  user_messages: string[];       // 所有 role=user 消息
  files_touched: string[];       // 从 tool_calls.args.path 提取
  tech_concepts: string[];       // 从文件扩展名推断 (.ts→TypeScript)
  tools_used: string[];          // 从 tool_calls.name 去重
  ```

- [ ] **Agent 补充字段（~50 tokens/task）**
  ```typescript
  pending_tasks: string[];    // task 结束时输出未完成任务
  current_work: string;       // 最近一轮工作描述（含文件名/代码片段）
  ```

- [ ] **System Prompt 扩展**
  ```
  When finishing a task, output a brief JSON summary at the end:
  {"pending_tasks": [...], "current_work": "..."}
  ```

#### Step 4: Token 预算管理器（滑动窗口）
- [x] **Token 估算**
  - `context-budget.ts`：`estimateTokens()`，约 1.3 tokens/词
  
- [ ] **预算切分策略**
  | 层级 | 比例 | 内容 |
  |------|------|------|
  | 近期 (Recent) | 40% | 完整 action_block，最近 2-3 个 task |
  | 中期 (Mid-term) | 30% | TaskSummary 结构化摘要，往前 5-8 个 task |
  | 早期 (Early) | 20% | Session 级压缩摘要 |
  | 当前任务 | 10% | 用户提问 + 工作目录信息 |

- [ ] **惰性压缩机制**
  - 只在预算快满时触发压缩，平时零开销
  - 压缩优先级: 早期 task → TaskSummary，中期 task → 一句话摘要

### 验收标准
| 功能 | 验收方式 |
|------|---------|
| **会话续接** | 关闭终端 → 重新 `npm start -- --resume <session_id>` → 能加载历史 tasks |
| **Task 摘要** | 每个 task 结束时生成 TaskSummary（混合版），存入 session.json |
| **滑动窗口** | 30+ 轮对话不爆 token，近期完整、中期有摘要、早期压缩 |
| **Token 开销** | 自动提取字段 0 tokens，Agent 补充 ~50 tokens/task |

### 📁 新增文件结构
```
src/
├── types.ts          # 已有 + 扩展 SessionState, TaskSummaryDoc
├── session.ts        # 新建：Session ID 生成 + session.json 持久化
├── task-tracker.ts   # 新建：Task Block 识别 + 边界检测
├── summary.ts        # 新建：TaskSummary 混合版生成器（自动提取+Agent补充）
├── context-budget.ts # 新建：Token 预算 + 滑动窗口构建
├── agent.ts          # 修改：集成 task-tracker + summary
└── main.ts           # 修改：支持 --resume-session-id 参数
```

---

## 📋 Phase 1.5: （已并入 Phase 4）

> Phase 1.5 原「grep / list_files / streaming / 并行」清单已升级为 **Phase 4** 正式 spec。  
> 若想在 Phase 2 之前快速尝鲜，可只做 **4a-1 + 4c**（工具 + 流式），跳过指针化。

---

## 📋 Phase 2: 冷存储 + 指针化 + Recall Query + 上下文策略

**目标**: 在 Phase 1 会话续接与滑动窗口之上，实现 **Hot/Cold 双写**、**指针化 tool 结果**、**OpenCode 式假删除**、**recall_query 按需解引用**，并在干净上下文与前缀缓存之间取得平衡。

**设计参照**: OpenCode `compaction.ts`（Prune 标记隐藏 → LLM Summary）；本方案用 **指针卡片 + ActionStore** 替代「整段消失后只能靠重跑 tool」。

---

### 2.0 架构总览

```
executeTool(raw)
    │
    ├─► ActionStore (冷路径，always 全文)
    │     .sessions/actions/<action_id>.json
    │
    └─► messages[] (热路径)
          ├─ 小结果 / 错误 / write 确认 → inline 原文
          ├─ 大结果（本 turn）→ inline 截断版（可选）
          ├─ 大结果（下 turn 起）→ [action:…] 指针卡片 (frozen)
          └─ 超老整块（压缩事件）→ compacted_at 整段隐藏 或 task summary 替代

turn 结束 → runTurnEndPipeline (pointerize → prune → pointer-compact → heavy?)
模型需要细节 → recall_query(action_id | keyword query) → head_tail / full / grep
文件已变更   → recall 标注 stale + 建议 read_file 重读
```

| 维度 | OpenCode Prune | 本方案 Phase 2 |
|------|----------------|----------------|
| 冷存储 | Session DB 全消息保留 | `ActionStore` 存 `ActionBlock` 全文 |
| 热路径 | `compacted` 消息从 API 视图消失 | 指针卡片降级 或 整段 `compacted_at` 隐藏 |
| 捞回 | 重跑 read/grep/bash | `recall_query` 解引用；文件变更时 fallback 重读 |
| 第二阶段 | LLM 5 段 session summary | `TaskSummary`（Phase 1 已有）+ 压缩事件消息 |
| 缓存 | 消息变短，前缀可能变化 | 指针/摘要 frozen 一次写入，前缀较稳定 |

---

### 2.1 数据结构扩展

#### ChatMessage 元数据（session 持久化，不一定发给 API）

```typescript
interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;

  // Phase 2 扩展（组装 API 请求时使用）
  action_id?: string;        // 关联 ActionStore 记录
  pointerized?: boolean;     // 热路径内容为指针卡片
  compacted_at?: number;     // OpenCode 式：>0 则从 API 视图整段跳过
}
```

#### ActionBlock（冷存储单元）

```typescript
interface ActionBlock {
  action_id: string;         // "action_{task_hash}_{seq}"
  task_id: string;
  session_id: string;
  turn_number: number;
  tool_name: string;
  args_json: string;
  result_text: string;         // 完整 tool 输出
  result_hash: string;         // sha256 前 16 位，用于变更检测
  byte_size: number;
  line_count: number;
  pointerized: boolean;
  files_touched: string[];     // 从 args 提取
  timestamp: number;
  token_cost: number;          // 估算即可
}
```

#### Recall 请求 / 响应

```typescript
interface RecallQueryParams {
  query?: string;              // 自然语言 / 关键词（向量+FTS）
  action_id?: string;          // 精确解引用（优先）
  task_id?: string;
  scope?: 'action' | 'task' | 'session';
  offset?: number;             // 行偏移（read_file / grep）
  limit?: number;
  format?: 'full' | 'head_tail' | 'grep';  // 默认 head_tail
}

interface RecallResult {
  action_id: string;
  tool_name: string;
  matched: boolean;
  content: string;
  total_chars: number;
  has_more: boolean;
  stale?: boolean;             // 源文件 mtime 已变
  hint?: string;               // "use offset=201 limit=200" / "use read_file for latest"
}
```

---

### 2.2 统一上下文策略（`src/context/*`，兼容 `context-policy.ts`）

所有「留热 / 踢冷 / 隐藏 / 指针化」规则集中管理，避免散落在 agent loop。

| 职责 | 真源模块 | 兼容 re-export |
|------|----------|----------------|
| Turn-end 编排 | `context/pipeline.ts` | `runTurnEndCompression`（agent 调用） |
| 指针化 stage | `context/pointerize-stage.ts` + `pointerize.ts` | — |
| Prune | `context/prune.ts` | `context-policy.ts` |
| Pointer 二次压缩 | `context/pointer-compact.ts` | 同上 |
| Heavy compression | `context/heavy-compression.ts` | 同上 |
| API messages 组装 | `context/assemble.ts` | 同上 |
| Token 预算 | `context/budget.ts` | `context-budget.ts` |
| 估算 / 保护窗 | `context/estimate.ts` | `context-policy.ts` |

历史文档中的 **`context-policy.ts` 单体** 已拆分；导入旧路径仍可用。

#### 2.2.1 免疫区（永不指针化、永不 prune）

| 类型 | 规则 |
|------|------|
| `error:` 开头 | 必须 inline，模型需立刻看到 |
| `write_file` 成功确认 | `ok: wrote N bytes` 永远 inline |
| `skill` 类输出（未来） | 参考 OpenCode，含操作指令的不 prune |
| 当前 turn 内刚产生的 tool 结果 | 本 turn 不 pointerize（防 hallucinate） |

#### 2.2.2 指针化阈值（按工具类型）

```typescript
const POINTER_RULES = {
  read_file:    { minChars: 600,  alwaysIfLines: 40 },
  run_shell:    { minChars: 800,  alwaysIfLines: 30 },
  write_file:   { minChars: Infinity },  // 永不指针化（结果短）
  edit_file:    { minChars: Infinity },  // 永不指针化（ok: edited …）
  grep_search:  { minChars: 500,  alwaysIfLines: 20 },
  list_files:   { minChars: 500,  alwaysIfLines: 30 },
  diff_file:    { minChars: 600,  alwaysIfLines: 30 },
  recall_query: { minChars: 600,  alwaysIfLines: 30 },
} as const;
```

#### 2.2.3 OpenCode 式 Prune 阈值（整段隐藏）

仅在 **预计腾出 > 20_000 tokens** 时触发（小清理不做）：

| 规则 | 值 |
|------|-----|
| 保护区 | 最近 **40_000 tokens** 内消息不 prune |
| User 保护 | 最近 **2 轮** user 消息全文保留 |
| 免疫 | `skill` 输出、`error:`、当前 turn 全部消息 |
| 操作 | 对符合条件的旧 tool/assistant 消息设 `compacted_at = Date.now()` |
| API 组装 | `compacted_at > 0` 的消息 **不进入** LLM 请求 |

> Prune 与指针化分工：**近期大结果** → 指针卡片（保留句柄）；**更老的整块对话** → `compacted_at` 整段隐藏（靠 TaskSummary + recall）。

#### 2.2.4 执行时机（与 pipeline 对齐）

| 时机 | 触发 | 行为 |
|------|------|------|
| **A — 执行当下** | `executeTool` 返回 | 双写 ActionStore；小结果 inline，大结果 inline 截断版（同 turn） |
| **B — Turn 边界** | `runTurnEndPipeline` | ① pointerize ② prune ③ pointer-compact ④ 条件 heavy compression |
| **C — 压缩事件** | heavy 阶段 `runCompressionEvent` | TaskSummary 注入 + notice + replay last user task；system 不变 |

`agent.ts` 在 tool 批处理后调用 `runTurnEndCompression`；noop 时可不发 compression 事件。

#### 2.2.5 指针卡片格式（稳定模板）

```text
[action:action_x9y8z7_012]
tool=read_file path=src/agent.ts lines=1-93 chars=2841 sha256=8f3a…c21
preview="export async function runAgent…"
recall=recall_query(action_id="action_x9y8z7_012", offset?, limit?)
```

- `action_id` 一次生成永不修改
- `preview`：`action-preview.ts` 生成；`preview_mode: smart` 时按工具类型摘要（shell/grep/read/mcp_* 等），否则 head/tail
- 若冷存已截断：`stored=truncated_at_8000 original_chars=245000`

#### 2.2.6 缓存与干净上下文平衡

```
immutable 区（session 级冻结）:
  SYSTEM_PROMPT + TOOL_DEFINITIONS + recall 使用说明（固定一句）

可变区（append-only，写入后 frozen）:
  历史 messages / pointer 卡片 / TaskSummary 消息 / 压缩事件通知

禁止:
  每轮改写 system prompt（改走压缩事件 append 一条 user/dev 通知）

压缩事件消息示例（append 一次，不再改）:
  [context-notice] 早期对话已压缩为摘要。大 tool 输出以 [action:…] 卡片呈现。
  细节请用 recall_query(action_id=...) 获取。已讨论主题: {topics}.
```

压缩后 **replay 最后一条 user task**（借鉴 OpenCode）：在 messages 末尾再 append 当前任务描述，锚定模型注意力。

---

### 2.3 功能清单

#### Step 1: ActionStore（冷存储）

- [x] `src/action-store.ts`（+ `action-write-queue.ts` 异步刷盘）
  - `saveAction` / `loadAction` / list → `.sessions/actions/`
  - stale：mtime vs `timestamp`（recall 路径）
- [x] `TaskTracker`：`recordToolCall()` → `action_id`
- [x] `write_file` 冷存：确认信息为主，避免 content 双份膨胀

#### Step 2: 指针化模块

- [ ] `src/pointerize.ts`
  - `shouldPointerize(tool, raw): boolean`
  - `buildPointerCard(block: ActionBlock): string`
  - `materializeAtTurnEnd(messages, currentTurn): ChatMessage[]` — turn 边界替换
- [ ] `agent.ts` 集成：executeTool 后双写 + 按策略决定 inline/pointer

#### Step 3: 上下文策略模块

- [ ] `src/context-policy.ts`
  - `estimateProtectedTokens(messages): number`
  - `shouldPrune(session, budget): boolean` — 是否值得 prune（>20k 收益）
  - `applyPrune(messages): ChatMessage[]` — 打 `compacted_at`
  - `assembleApiMessages(messages): ChatMessage[]` — 过滤 compacted、展开 pointer
  - `appendCompressionNotice(session, topics): ChatMessage`
  - `replayLastUserTask(prompt, cwd): ChatMessage`

#### Step 4: recall_query tool

- [x] `src/recall.ts` + `src/tools/recall.ts` 注册到 `tools/registry.ts`
  ```typescript
  {
    name: "recall_query",
    description: "检索早期 tool 执行的完整结果。热路径中的 [action:…] 卡片可用 action_id 精确解引用；也可用 query 做语义/关键词搜索。",
    parameters: {
      query: { type: "string", description: "搜索关键词或自然语言（与 action_id 二选一或组合）" },
      action_id: { type: "string", description: "精确解引用，优先于 query" },
      task_id: { type: "string" },
      scope: { type: "string", enum: ["action", "task", "session"] },
      offset: { type: "integer", description: "行偏移" },
      limit: { type: "integer", description: "最多返回行数/字符块" },
      format: { type: "string", enum: ["full", "head_tail", "grep"], description: "默认 head_tail" },
    },
  }
  ```
- [ ] 默认 `head_tail`：≤2000 字符全文；否则前 800 + `…[more via offset]…` + 后 200
- [ ] `isStale` 时返回 `stale: true` + 片段 + hint 建议 `read_file`

#### Step 5: Zvec 向量索引

- [ ] `src/action-index.ts`（或复用 MemFileCli 模式）
  - Collection `agent_memory`，384 维 cosine + FTS `content` 字段
  - 索引文本：`tool + args + result[:4000] + files_touched`
  - 标量过滤：`session_id`, `task_id`, `tool_name`, `turn_number`, `pointerized`
- [ ] task 完成 / 压缩事件时异步 upsert（不阻塞主 loop）

#### Step 6: System Prompt 调整（静态为主）

- [ ] `SYSTEM_PROMPT` 追加 **固定** recall 说明（immutable）：
  ```
  Large tool outputs appear as [action:…] cards. Use recall_query(action_id=...) for details.
  If recall marks stale, use read_file for the latest file content.
  ```
- [ ] **废弃**每轮动态 `buildSystemPrompt()`；压缩级别提示改由 `appendCompressionNotice()` 一次写入

---

### 2.4 数据流（Phase 2 完整路径）

```
用户提问 → TaskTracker.onUserMessage
    ↓
ReAct loop (每 turn):
    LLM → tool_calls → executeTool(raw)
        ├─ ActionStore.saveAction (冷，全文)
        └─ messages.push (热，inline 或截断)
    ↓
turn 结束 → context-policy:
    ├─ materializeAtTurnEnd (大结果 → pointer, frozen)
    └─ shouldPrune? → applyPrune (compacted_at)
    ↓
预算检查 shouldCompress?
    ├─ 否 → assembleApiMessages → 下一轮 LLM
    └─ 是 → 压缩事件:
            ├─ 老 task → TaskSummary (frozen)
            ├─ compacted_at 标记
            ├─ appendCompressionNotice
            └─ replayLastUserTask
    ↓
模型调用 recall_query → recall.ts → head_tail / keyword → tool result 回注
    ↓
task 结束 → TaskSummary 写入 session.tasks (Phase 1)
```

---

### 2.5 文件结构（2026-07 真源）

```
src/
├── action-store.ts / action-write-queue.ts / action-preview.ts / action-paths.ts
├── pointerize.ts                 # 卡片生成与规则（与 stage 协作）
├── recall.ts                     # recall_query：action_id + 关键词（非向量）
├── task-tracker.ts / summary.ts / session*.ts
├── agent.ts                      # ReAct；turn-end 调 pipeline
├── context/
│   ├── pipeline.ts               # runTurnEndPipeline / runTurnEndCompression
│   ├── pointerize-stage.ts
│   ├── prune.ts
│   ├── pointer-compact.ts
│   ├── heavy-compression.ts
│   ├── assemble.ts
│   ├── budget.ts / estimate.ts
│   └── types.ts
├── context-policy.ts             # re-export → context/*
├── context-budget.ts             # re-export → context/budget
└── types.ts

.sessions/
├── session_<id>.json             # 含 note 等元数据（TUI /sessions）
└── actions/
    └── <action_id>.json
```

---

### 2.6 实施顺序（历史；均已落地）

| 顺序 | 模块 | 向量库 | 说明 |
|------|------|--------|------|
| 2a | action-store + pointerize | 否 | 双写 + turn 边界指针化 |
| 2b | recall_query (action_id) | 否 | 精确解引用 + head_tail |
| 2c | prune + compression 事件 | 否 | OpenCode 式假删除 |
| 2d′ | 关键词 query（现网） | 否 | `findBestActionByKeyword` |
| 2d | Zvec 混合检索（草案） | 曾规划 | **当前树未依赖 zvec**；若重做单独立项 |

---

### 2.7 验收标准

| 功能 | 验收方式 | 状态 |
|------|---------|------|
| **冷存储双写** | 大 `read_file` 后 actions 下有全文 | ✅ |
| **指针化** | 后续 turn 热路径为 `[action:…]` | ✅ |
| **同 turn 不指针化** | 本 turn 大结果仍可推理 | ✅ |
| **recall 解引用** | `action_id` + format/head_tail | ✅ |
| **stale 检测** | 文件改后 stale + hint | ✅ |
| **prune 假删除** | `compacted_at` 不进 API | ✅ |
| **压缩事件** | notice + replay；system 不变 | ✅ |
| **Turn pipeline** | 单步 compression 事件可观测 | ✅ |
| **关键词 recall** | `query=` session 内命中 | ✅（非向量） |
| **向量语义 recall** | 原 2d 准确率目标 | ⏸ 未合入 |

---

### 2.8 已知陷阱（实现时必读）

1. **指针化太早** → 同 turn 看不到全文，幻觉文件内容；严格遵守「本 turn inline，下 turn pointer」
2. **recall 返回全文** → 干净上下文前功尽弃；默认 `head_tail`，大结果分次拉取
3. **每轮改 system** → 打碎前缀缓存；压缩提示走 append-only 事件消息
4. **write_file 双重存储** → `result_text` 不存 content 全文，避免 ActionStore 膨胀
5. **prune 与 pointer 重复操作** → 已 pointerize 的不再 compacted；已 compacted 的无需 pointer

---

## 🔗 Phase 3: 跨 session 记忆 — 外部 MemFileCli（不内置）

**决策**: 不在 minimal-agent-ts 内实现 Session 层压缩与跨 session 索引；由 **MemFileCli** 作为生态级记忆底座，可跨 session、跨 Agent 复用。

### 职责分界

| 范围 | 负责方 | 能力 |
|------|--------|------|
| **Session 内** | minimal | `.sessions/`、`TaskSummary`、`pointerize`、`recall_query`、compression |
| **跨 session / 跨 Agent** | MemFileCli | `search` / `get` / `neighbors` / `recent`，UUID + Wiki 链接漫游 |

### Agent 接入（已实现路径，无需新 TS 模块）

- TUI 默认 `shell:on`；加载 skill：`MemFileCli-skill`（或 `agent.json` `loaded_skills`）
- 典型命令（`--format json` 供程序解析）：
  ```bash
  memfilecli search "<query>" --limit 5
  memfilecli get <uuid_or_prefix> --format json
  memfilecli neighbors <uuid> --format json
  memfilecli recent --format json
  ```
- 可选后续：包一层 `memfile_query` builtin（内部仍调 CLI），**非 P0**

### 验收（生态级，非 minimal 代码验收）

- ✅ 新 session 可通过 `memfilecli search` / `recent` 找到历史项目记忆
- ✅ minimal session 内 recall 与 MemFileCli 语义搜索不冲突（各管一层）
- ⏸️ 内置 `SessionSummaryDoc`、多层 SummaryBlock 同步 — **明确不做**

### 当前验证重点（2026-06）

压测 **session 内** 上下文上限：长轮次任务下指针化 + prune 应保持可续跑。系统提示词 MD / Agent.md 实验不在本 Phase。  
**产品 / TUI / 压测 harness / 入站与定时** 见 **[docs/ROADMAP.md](./docs/ROADMAP.md)**（根目录 [ROADMAP.md](./ROADMAP.md) 为轨 A–G 缩写）。

---

## 📋 Phase 4: 工具扩展 + 并行执行 + SSE 流式

**目标**: 在稳定 ReAct 内核上提升 **开发实用性**（更多工具）、**执行效率**（并行 tool）、**终端体感**（流式 token）。与 Phase 2 正交，可并行开发，但 **合并 PR 时 Phase 2 优先**（指针化需覆盖新工具的大结果）。

---

### 4.0 设计原则

- 新工具遵循 Phase 2 **POINTER_RULES**（大结果 → 冷存 + 指针卡片）
- 工具实现与注册分离：`tools/` 目录 + `tools/registry.ts`
- 并行执行 **默认保守**：不确定依赖时串行，避免写读竞态
- 流式与 tool_calls **互斥展示**：有 tool_calls 时缓冲 assistant 文本，final 路径才逐 token 打印

---

### 4.1 内置工具扩展（4a）

#### 4a-1 文件探索三件套（优先）

| 工具 | 实现 | 参数 | 指针化 |
|------|------|------|--------|
| `grep_search` | `rg` 子进程，fallback `grep -rn` | `pattern`, `path?`, `glob?`, `context_lines?`, `max_matches?` | 是（>500 chars） |
| `list_files` | `fs.readdir` 递归 | `path`, `max_depth?`, `include_hidden?` | 是（>40 entries 展平） |
| `diff_file` | `diff -u` 或自研行 diff | `path`, `before_action_id?`, `before_text?` | 是（大 diff） |

`diff_file` 与冷存储联动：

```typescript
// 优先从 ActionStore 取 write_file 之前的快照；无则 read 当前文件
diff_file({ path: "src/agent.ts", before_action_id: "action_xxx_003" })
```

#### 4a-2 联网

| 工具 | 实现 | 安全 |
|------|------|------|
| `web_fetch` | fetch + readability / cloak 可选 | allowlist；`ALLOW_WEB` / TUI `/web` |
| `web_search` | `ddgr --json` + spill cache（v1/v1.5） | 与 web 同源权限；见 SPEC_TOOLS |

#### 4a-3 编码 / 工程常用（后续扩展，已落地）

| 工具 | 说明 |
|------|------|
| `git_status` / `git_diff` / `git_log` | 只读 git |
| `lsp_query` | 语言服务查询 |
| `test_run` | 测试命令封装 |
| `office_read` / `office_write` | Office 读写；**light schema** + skill `office-layout` |
| `spawn_agent` / `spawn_background` / `code_review` | 子 Agent / 后台 job |
| `apply_patch` | 补丁式编辑 |

完整清单与策略以 **[SPEC_TOOLS.md](./SPEC_TOOLS.md)**、`agent.json` `builtin_tools` 为准。

#### 4a-4 工具目录结构（2026-07）

```
src/tools/
├── registry.ts
├── providers/          # Builtin / Cli / Skills / Spawn / Mcp ToolProvider
├── read-write.ts · edit-file.ts · apply-patch.ts · file-hash.ts
├── explore.ts · shell.ts · git.ts · lsp.ts · test-run.ts
├── office.ts           # office_read/write（light defs，全量 handler）
├── web-fetch.ts · web-search.ts · web-*-spill/cache
├── recall.ts · skills-tool.ts
├── spawn.ts · spawn-background.ts · code-review.ts
└── tool-args.ts · path-utils.ts · …

src/action-preview.ts · loop-guard.ts · tool-scheduler.ts
```

---

### 4.2 工具并行执行（4b）

**状态**: ✅ 已实现（`tool-scheduler.ts`；TUI/`tool_plan` 可观测 reason）。

#### 4b-1 启发式分批

同一 turn 内多个 tool_call，按 **资源键** 分桶后并行：

```typescript
interface ToolCallPlan {
  parallel: ToolCall[];   // Promise.all
  serial: ToolCall[];   // 顺序执行
}

// 规则（保守）:
// - read/grep/list/diff/web → 默认 parallel（路径不同即可）
// - write_file / run_shell → 默认 serial
// - 同一 path 的 read+write → serial（写优先或读优先由拓扑决定）
// - run_shell 含 ">" 重定向到某 path → 与对该 path 的 read 串行
```

实现：`src/tool-scheduler.ts`

```typescript
export function scheduleToolCalls(calls: ToolCall[]): ToolCallPlan[];
export async function executeToolBatch(
  plan: ToolCallPlan,
  config: AgentConfig,
  hooks: { onResult: (call, output) => void },
): Promise<void>;
```

**消息顺序**：并行结果按 **原始 tool_calls 数组顺序** 回注 `messages[]`（与 OpenAI API 期望一致），仅 **执行** 并行。

#### 4b-2 依赖图（进阶，4b+）

当启发式不够时，引入显式 **Tool Dependency Graph**：

```typescript
interface ToolDependencyEdge {
  from: string;          // tool_call_id
  to: string;
  reason: 'same_path' | 'write_before_read' | 'shell_redirect';
}

// 拓扑排序 → 每层 Promise.all，层间串行
export function buildDependencyGraph(calls: ToolCall[]): ToolDependencyEdge[];
export function topologicalLayers(calls, edges): ToolCall[][];
```

可选：让模型在 tool schema 里声明 `depends_on: [tool_call_id]`（Phase 5+，多数模型做不好，**不依赖**）。

#### 4b-3 与 ActionStore / 指针化

- 并行执行的每个结果 **独立** `action_id`、独立双写
- `onStep` 事件新增 `{ type: 'tool_batch_start', count, parallel: number }`

---

### 4.3 SSE 流式输出（4c）

**目标**：改造 `llm.ts`，final 回答路径逐 token 输出；`onStep` 增加 `token` 事件。

#### API 形态

```typescript
// llm.ts
export interface StreamChatOptions {
  stream: boolean;
  onToken?: (delta: string) => void;
  onToolCallsComplete?: (toolCalls: ToolCall[]) => void;
}

export async function chat(..., opts): Promise<LlmResult> {
  if (!opts.stream) { /* 现有非流式路径 */ }
  // stream: true → fetch + ReadableStream / SSE 解析
}
```

#### 请求体

```json
{ "model": "...", "messages": [...], "tools": [...], "stream": true }
```

#### 解析策略

- `delta.content` → `onToken` / `onStep({ type: 'token', delta })`
- `delta.tool_calls` → 累积至完整 tool_call 后 **一次性** 触发 `tool_call` 事件（流式 tool args 可选手枪模式拼接）
- `finish_reason` → 结束

#### agent.ts 集成

```typescript
onStep?.({ type: 'token', turn, delta });  // main.ts 直接 process.stdout.write(delta)
// tool 路径不流式打印 assistant 中间废话，避免与 tool_call 日志交错
```

#### 验收

- 无 tool_calls 的 final 回答：终端逐字输出
- 有 tool_calls：行为与现版一致，不 broken
- `stream: false` 回归路径不变

---

### 4.4 Phase 4 实施顺序

| 步骤 | 内容 | 预估耦合 |
|------|------|----------|
| 4a-1 | grep + list_files + diff_file + tools/ 拆分 | 低 |
| 4c | SSE 流式 | 低（仅 llm.ts + main.ts） |
| 4b-1 | 启发式并行 scheduler | 中（agent.ts） |
| 4a-2 | web_fetch + allowlist + cloakFetch L2 | ✅ `src/tools/web-fetch.ts` |
| 4b-2 | 依赖图拓扑分层 | 中 |

---

### 4.5 Phase 4 验收标准

| 功能 | 验收方式 |
|------|---------|
| grep_search | `grep_search("import.*from")` 返回匹配行 + 文件路径 |
| list_files | 输出树状结构，`max_depth` 生效 |
| diff_file | 对 `before_action_id` 与当前文件输出 unified diff |
| 并行读 | 同 turn 3 个 `read_file` 不同路径，wall-clock < 串行 50% |
| 写读安全 | 同 path read+write 同 turn 保持串行，无竞态 |
| 流式 | final 回答逐 token 打印；tool turn 不乱序 |
| 指针化兼容 | 大 grep 结果在 Phase 2 启用后正确 pointerize |

---

## 📋 Phase 5: MCP / Skills 插件层

**目标**: 在不改 ReAct 内核的前提下，外接 MCP server 与本地 Skills（类似 Cursor / OpenCode 的 `@skill`），工具定义 **运行时合并** 进 `TOOL_DEFINITIONS`。

**依赖**: Phase 4a 的 `tools/registry.ts` 抽象到位。

---

### 5.1 架构

```
config.json / agent.json
    │
    ├─ builtin_tools: ["read_file", "grep_search", ...]
    ├─ mcp_servers: [{ name, command, args, env }]
    └─ skills_dirs: ["./skills", "~/.minimal-agent/skills"]

启动时:
    registry.loadBuiltin()
    registry.loadMcp()      // stdio MCP → ToolDefinition[]
    registry.loadSkills()   // SKILL.md frontmatter → 注入 system 或 skill 工具
```

### 5.2 MCP 集成（5a）

- 传输：✅ **stdio** + **streamable-http** + legacy **sse**（`mcp-transport.ts`）
- 每个 MCP tool → `mcp_<server>_<tool>`
- 权限：`allow` / `deny` 列表
- 指针化：大结果走 Phase 2 `POINTER_RULES` / preview

### 5.3 Skills 集成（5b）

| 方式 | 行为 |
|------|------|
| **Skill 工具** | `invoke_skill(name, query)` 读 SKILL.md 返回指引（**主路径**） |
| **启动加载** | `--load-skills` / `loaded_skills` 可注入 system 块（可选） |

仓库默认白名单 skill（`.gitignore`）：`context-design`、`office-layout`。其余可放本地 `skills/` 不提交。

**Office 约定**：tools 仅 light schema；富排版配方在 `invoke_skill("office-layout")`，避免每 turn 胀 tools[]。

### 5.4 验收标准

- ✅ 配置 MCP server 后可调用其工具
- ✅ `skills/` 下 SKILL.md 可通过 `invoke_skill` 触发
- ✅ deny 列表中的 tool 不出现在 API tools 数组
- ✅ HTTP MCP 可配置（见 `agent.mcp.example.json`）

### 5.5 实现（对齐 2026-07）

| 模块 | 文件 | 说明 |
|------|------|------|
| 配置 | `agent.json`, `plugins/config-loader.ts` | builtin_tools / mcp / skills_dirs |
| MCP | `mcp-manager.ts`, `mcp-transport.ts` | stdio + streamable-http + sse |
| Skills | `skills.ts`, `skills-tool.ts` | 发现 SKILL.md |
| Provider | `tools/providers/*` | Builtin / Cli / Skills / Spawn / Mcp |
| 注册表 | `tools/registry.ts` | 运行时合并 |
| CLI | `main.ts` / TUI | `--list-tools`、`/tools` |

```bash
npm start -- --list-tools
npm start -- --load-skills office-layout "写周报 docx"
# MCP: 复制 agent.mcp.example.json 片段 → agent.json
```

---

## 📋 Phase 6: 多角色工作流（Config 驱动 Agent Loop）

**目标**: 用 **JSON/YAML/Markdown frontmatter** 定义多个 Agent 角色与它们之间的 **工作循环**，实现「planner → worker → reviewer → 循环或结束」等 DIY 编排，而无需改 TypeScript 代码。

**依赖**: 单 Agent ReAct 稳定（Phase 2–4）；每个角色 = 不同 `system` + `tools` 子集 + 可选 `model`。

**状态**: ✅ 已实现（`src/workflow/` + `workflows/review-loop.json` + `roles/*.md`）

> 这是 **编排层**，不是替代 ReAct 内核。每个角色内部仍跑 `runAgent()`。

---

### 6.1 配置文件形态

支持两种（二选一，JSON 优先实现）：

**`workflows/review-loop.json`**（内置示例）

```json
{
  "name": "review-loop",
  "share_session": false,
  "roles": {
    "planner": {
      "prompt_file": "../roles/planner.md",
      "tools": ["read_file", "grep_search", "list_files", "recall_query"],
      "max_turns": 8
    },
    "worker": {
      "prompt_file": "../roles/worker.md",
      "tools": ["read_file", "write_file", "edit_file", "grep_search", "list_files", "diff_file", "recall_query"],
      "max_turns": 15
    },
    "reviewer": {
      "prompt_file": "../roles/reviewer.md",
      "tools": ["read_file", "grep_search", "diff_file", "recall_query"],
      "max_turns": 6
    }
  },
  "flow": [
    { "role": "planner", "input": "{{user_task}}" },
    { "role": "worker", "input": "## Plan (from planner)\n{{planner.output}}\n\n## Original task\n{{user_task}}" },
    { "role": "reviewer", "input": "## Work output\n{{worker.output}}\n\nReview. End with JSON: {\"verdict\":\"approved\"|\"needs_revision\",\"notes\":\"...\"}" },
    {
      "loop": {
        "when": "{{reviewer.verdict}} == 'needs_revision'",
        "max_rounds": 2,
        "steps": [
          { "role": "worker", "input": "## Reviewer feedback\n{{reviewer.output}}\n\n## Original task\n{{user_task}}" },
          { "role": "reviewer", "input": "## Revised work\n{{worker.output}}\n\nRe-review. End with JSON: {\"verdict\":\"approved\"|\"needs_revision\",\"notes\":\"...\"}" }
        ]
      }
    }
  ]
}
```

**`roles/planner.md`**（OpenCode 风格 frontmatter）

```markdown
---
name: planner
description: 分析问题并输出步骤计划，不直接改代码
tools: [read_file, grep_search, list_files]
---

你是规划者。只输出计划，不调用 write_file。
```

### 6.2 运行时：`WorkflowRunner`

```typescript
interface WorkflowContext {
  user_task: string;
  [role: string]: { output: string; messages: ChatMessage[]; summary?: TaskSummaryDoc };
}

// src/workflow/runner.ts
export async function runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowResult>;
```

- 每步调用 `runAgent({ prompt, config, session, roleSystem })`
- 步骤间 **共享 session**（同 `session_id`）或 **隔离上下文**（reviewer 只看 worker 的 `output` 模板变量，省 token）——config 可选 `share_session: true|false`
- `{{role.output}}` 模板替换；`verdict` 由 reviewer 末尾 JSON 约定：`{"verdict":"approved"|"needs_revision"}`

### 6.3 与 Phase 2 上下文策略的配合

| 模式 | 行为 |
|------|------|
| `share_session: true` | 全角色共用一个 context-policy / ActionStore，recall 可跨角色 |
| `share_session: false` | 每角色独立 `current_messages`，只传递上一步 `output` 摘要（更干净，推荐 reviewer） |

### 6.4 CLI

```bash
npm start -- --workflow workflows/review-loop.json "修复登录 401"
npm start -- --resume session_xxx --workflow workflows/review-loop.json "继续审查"
npm start -- --allow-shell --workflow workflows/review-loop.json "实现并跑测试"
```

> `--role` 单角色快捷入口**未实现**；请用完整 `--workflow` 或单 Agent 模式。

### 6.5 实施顺序

| 步骤 | 内容 | 状态 |
|------|------|------|
| 6a | JSON workflow 解析 + 线性 flow（无 loop） | ✅ `load-workflow.ts` |
| 6b | `loop` + `when` 条件 + `max_rounds` | ✅ `runner.ts` + `template.ts` + `verdict.ts` |
| 6c | Markdown role 文件 + frontmatter | ✅ `load-role.ts` + `roles/*.md` |
| 6d | `share_session` 策略 + 跨角色 TaskSummary | ✅ 默认隔离；`onTaskComplete` 写入 `session.tasks` |

### 6.6 验收标准

- ✅ 三角色线性流：planner → worker → reviewer 跑通
- ✅ reviewer 返回 `needs_revision` 时 worker↔reviewer 循环 ≤ `max_rounds`
- ✅ `--workflow` 与 `--resume` 可组合（共用 `session_id`，各角色 TaskSummary 累积）
- ✅ 改 `roles/planner.md` 无需改 TypeScript

### 6.7 刻意不做（避免 scope 膨胀）

- 非 DAG 的任意图编排（先限 loop + 线性）
- 角色间并行（Phase 6+ 再考虑）
- 可视化 workflow 编辑器
- `--role` 单角色快捷 CLI（请用 `--workflow` 或单 Agent）

### 6.8 Phase 6 同期落地（非独立 Phase）

| 能力 | 模块 | 说明 |
|------|------|------|
| 锚点编辑 | `edit-file.ts`, `file-hash.ts` | `read_file` 返回 hash → `edit_file` 带 `expected_hash` |
| Smart 预览 | `action-preview.ts` | 指针卡片按工具类型生成摘要；配置见 `agent.json` `pointerize_policy` |
| 循环收口 | `loop-guard.ts` | `LOOP_GUARD=inject` 检测重复 tool 调用并强制文字总结 |
| Shell 长命令 | `shell.ts` | `delay_ms`、poll 间隔、`auto_extend` / `max_timeout_ms` |

---

## 🔧 技术选型（当前树）

| 组件 | 选择（实现） | 说明 |
|------|-------------|------|
| Token 估算 | `context/budget` + `estimate` | 启发式缩放；无 `tiktoken` |
| Turn-end | `context/pipeline` | 四段式；事件 `compression` |
| 冷存 | `.sessions/actions/` + 可选写队列 | 不进 git |
| 历史检索 | `recall_query` action_id + **关键词** | **无** zvec / transformers 依赖 |
| Session | `.sessions/*.json` | `--resume`、TUI `/sessions`、note/delete |
| MCP | `@modelcontextprotocol/sdk` | stdio / streamable-http / sse |
| LLM 路由 | api_profiles / fallback | 见 SPEC_LLM_ROUTER |
| 向量 2d | 历史草案 | ⏸ 未合入；跨 session 用 MemFileCli |

---

## 📊 数据流图（Phase 2 + L2 pipeline）

```
用户提问 → [Task Block 开始]
   ↓
LLM → tool_calls → tool-scheduler（parallel/serial）
   ├─ ActionStore 冷写 (全文)
   └─ messages 热写 (inline / 截断)
   ↓
turn 结束 → runTurnEndPipeline
   ① pointerize  ② prune  ③ pointer-compact  ④ heavy compression?
   ↓
assembleApiMessages → 下一轮 LLM
   ↓
需要历史细节 → recall_query (action_id | keyword) → head_tail / full
   ↓
Agent 返回总结 → [Task Block 结束] → session.tasks
```

后台 job / spawn 使用独立 spawn session + `workspace/jobs/`（或配置路径），**不**污染主会话热路径；结果可经 MessageBridge 出站（规划/部分接线）。

---

## 🎓 学习对照点

| 概念 | minimal-agent-ts（现） | OpenCode 等 |
|------|------------------------|-------------|
| 上下文管理 | 滑动窗口 + 指针 + prune + pipeline | Prune / summary |
| 大 tool 结果 | 指针卡片 + ActionStore | compacted 隐藏 |
| 历史检索 | recall action_id / **keyword** | 重跑工具 / 向量库 |
| 假删除 | `compacted_at` + pointerized | compacted 时间戳 |
| 工具并行 | `tool-scheduler` 启发式 | 内置 |
| 多角色 | workflow JSON + roles | subagent / `@agent` |
| 重工具契约 | **light schema + skill**（如 office） | 常驻大 tools[] |
| 跨 session | MemFileCli 外置 | 产品内记忆 |

---

## 🧭 与产品轨的边界（避免本文膨胀）

| 主题 | 文档 |
|------|------|
| TUI、jobs 面板、i18n、token 状态条 | SPEC_TUI · docs/ROADMAP |
| Office / web_search / git / spawn 工具形状 | SPEC_TOOLS |
| api_profiles、cache、fallback | SPEC_LLM_ROUTER |
| Inbound / Schedule / 飞书 | docs/ROADMAP §6 |
| 宿主依赖、打包 | docs/DEPS.md |

本文 **不** 再维护完整工具清单与 cron 设计细节；只保留对上下文语义的约束（POINTER_RULES、压缩事件、recall 协议）。

---

## 📝 版本历史

| 日期 | 版本 | 变更内容 |
|------|------|---------|
| 2026-07-15 | **v2.0** | **与代码对齐**：L2 `src/context/pipeline`；recall 关键词非 Zvec；tools Provider + office light schema；MCP HTTP；skills 白名单；速览表与产品文档索引；修正过时 checklist/文件树 |
| 2026-06-30 | v1.9 | **Phase 3 外置** + **ROADMAP.md**：MemFileCli 承接跨 session；轨 A/B/C（TUI / TS 性能 / Rust） |
| 2026-06-29 | v1.8 | **文档对齐**: README/SPEC 与代码同步；Phase 6 标为已实现；补充 `edit_file`、`action-preview`、`loop-guard` |
| 2026-06-29 | v1.7 | **Phase 6 + 工具增强**: `src/workflow/` 多角色 runner（6a–6d）、`workflows/review-loop.json`、`edit_file`（hash 锚定）、smart action preview、`loop-guard`、`run_shell` 长命令轮询 |
| 2026-06-28 | v1.6 | **Phase 5 实现**: `agent.json` 插件配置、stdio MCP（`@modelcontextprotocol/sdk`）、`invoke_skill` + `--load-skills`、`ToolRegistry` 运行时合并、`--list-tools` |
| 2026-06-27 | v1.4 | **Phase 2c 实现**: OpenCode 式 `compacted_at` prune（40k/2-user 保护、20k 阈值）、`runCompressionEvent`（摘要注入 + notice + replay user task） |
| 2026-06-27 | v1.5 | **Phase 2d**: Zvec `agent_memory` 混合检索（向量+FTS）、`embedding.ts`、recall query 语义搜索 |
| 2026-06-27 | v1.4 | **Phase 2c**: `compacted_at` prune、`runCompressionEvent`（摘要 + notice + replay） |
| 2026-06-27 | v1.3 | **长期路线图**: 总览 Phase 1–6；Phase 1.5 并入 Phase 4（工具扩展、diff_file、并行 scheduler、依赖图、SSE 流式）；新增 Phase 5 MCP/Skills、Phase 6 多角色 workflow（JSON/MD config） |
| 2026-06-27 | v1.2 | **Phase 2 整合版**: 冷存储 ActionStore、指针化 tool 结果、OpenCode 式 `compacted_at` prune、`context-policy.ts` 统一策略、`recall_query` 解引用协议（head_tail / stale）、缓存平衡（immutable system + 压缩事件消息）、分阶段实施 2a–2d |
| 2026-06-27 | v1.1 | **Phase 1 细化**: 混合版 TaskSummary（自动提取+Agent补充）、会话续接 (--resume)、滑动窗口预算策略、Zvec 替代 ChromaDB |
| 2026-06-26 | v1.0 | 初始版本: 核心概念模型（四层 ID）、数据结构设计、三阶段规划、技术选型 (Zvec + all-MiniLM-L6-v2) |

---

*创建者: 小千Chikusa & 哥Jawn  | 最后更新: 2026-07-15 (v2.0 与代码对齐)*
