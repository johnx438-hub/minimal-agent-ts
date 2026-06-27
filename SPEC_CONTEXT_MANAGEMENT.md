# minimal-agent-ts 上下文管理与动态提示词设计 Spec

> **目标**: 让最简 ReAct Agent 具备分层上下文管理能力，支持长对话不丢失关键信息  
> **日期**: 2026-06-26  
> **状态**: Draft v1.6 (Phase 5 完整)

---

## 🗺️ 总路线图（Phase 1 → 6）

| Phase | 主题 | 优先级 | 依赖 | 状态 |
|-------|------|--------|------|------|
| **1** | 会话续接 + TaskSummary + 滑动窗口 | P0 学习核心 | — | ✅ 已实现 |
| **2** | 冷存储 + 指针化 + recall + context-policy | P0 长会话质量 | Phase 1 | ✅ 已实现 |
| **3** | Session 层压缩 + 跨 session 索引 | P1 记忆纵深 | Phase 2d | 📋 草案 |
| **4** | 工具扩展 + 并行执行 + SSE 流式 | P1 实用性与体感 | Phase 1 | ✅ 已实现 |
| **5** | MCP / Skills 插件层 | P2 生态扩展 | Phase 4a | ✅ 已实现 |
| **6** | 多角色工作流（config 驱动 Agent Loop） | P2 编排能力 | Phase 4c + 稳定 ReAct | 📋 本版新增 |

**原则**：先让「单 Agent + 干净上下文」跑稳（Phase 2），再叠工具与运行时（Phase 4），最后做编排（Phase 6）。Phase 1.5 内容并入 Phase 4，避免两条线并行改 `agent.ts`。

```
Phase 1 ──► Phase 2 (上下文) ──► Phase 3 (跨 session)
                │
                └──► Phase 4 (工具/并行/流式) ──► Phase 5 (MCP/Skills)
                                              └──► Phase 6 (多角色 Loop)
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

### Zvec Collection Schema (Phase 1)

```typescript
// agent_memory collection schema
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

### SessionSummary 文档结构 (Phase 3)

```typescript
interface SessionSummaryDoc {
  session_id: string;       // "session_20260626_143000"
  user_id: string;          // "user_archer"
  
  task_count: number;       // 包含多少个 tasks
  total_turns: number;      // 总轮次数
  time_range: [number, number];  // [start_ts, end_ts]
  
  summary_text: string;     // session 级摘要
  topics_covered: string[]; // 讨论的主题列表
  
  content: string;
  embedding: float[];
}
```

---

## 🔧 技术选型

| 组件 | 选择 | npm 包 | 理由 |
|------|------|--------|------|
| **向量数据库** | Zvec v0.5+ | `@zvec/zvec` | 进程内嵌入式，混合检索（向量+全文+标量过滤），零服务依赖 |
| **Token 估算** | tiktoken | `tiktoken` | OpenAI 官方方案，准确度高 |
| **Embedding 模型** | all-MiniLM-L6-v2 | `@xenova/transformers` | 22MB、384 维、CPU 最快（~5ms/文档）、ONNX 量化，速度优先场景最优解 |
| **Session 持久化** | JSON 文件 | — | Phase 1 简单直接，Phase 2+ 可迁移至 Zvec |

### 技术栈决策记录

| 决策点 | 选择 | 备选 | 理由 |
|--------|------|------|------|
| 一库 vs 分库 | **Zvec 一库到底** (Phase 1) | SQLite + Zvec | Phase 1 混合检索够用，简单快速验证；Phase 2+ 评估是否分库 |
| Embedding 方案 | **本地 all-MiniLM-L6-v2** | API 调用 / bge-m3 | 零网络依赖，22MB 体积，CPU ~5ms/文档，速度优先场景最优解 |
| 向量维度 | **384 维** (all-MiniLM) | 768/1024 维 | 语义检索只是补充，核心靠结构化导航+关键词，384 维够用且更快 |

---

## 📐 上下文分层架构（热路径 + 冷路径）

```
冷路径 ActionStore (.sessions/actions/)     热路径 API messages[]
─────────────────────────────────────     ─────────────────────────
全文 args + result（永不指针化丢失）          ┌──────────────────────────────┐
Zvec 索引（recall_query 语义检索）           │ System Prompt (immutable)     │
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
                                           │ → session 摘要                 │
                                           │ → compacted_at 消息已隐藏      │
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
- [ ] **Token 估算**
  - 使用 `tiktoken` 或简化方案（每词 ~1.3 tokens）
  
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
    │     + Zvec 索引 (embedding + FTS)
    │
    └─► messages[] (热路径)
          ├─ 小结果 / 错误 / write 确认 → inline 原文
          ├─ 大结果（本 turn）→ inline 截断版（可选）
          ├─ 大结果（下 turn 起）→ [action:…] 指针卡片 (frozen)
          └─ 超老整块（压缩事件）→ compacted_at 整段隐藏 或 task summary 替代

模型需要细节 → recall_query(action_id | query) → head_tail 切片
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

### 2.2 统一上下文策略：`context-policy.ts`

所有「留热 / 踢冷 / 隐藏 / 指针化」规则集中在此模块，避免散落在 agent loop。

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
  read_file:   { minChars: 600,  alwaysIfLines: 40 },
  run_shell:   { minChars: 800,  alwaysIfLines: 30 },
  write_file:  { minChars: Infinity },  // 永不指针化（结果短）
  grep_search: { minChars: 500,  alwaysIfLines: 20 },  // Phase 1.5
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

#### 2.2.4 三个执行时机

| 时机 | 触发 | 行为 |
|------|------|------|
| **A — 执行当下** | `executeTool` 返回 | 双写 ActionStore；小结果 inline，大结果 inline 截断版（同 turn） |
| **B — Turn 边界** | 每 turn 结束 | 非当前 turn 且超阈值 → 原地替换为 pointer 卡片（**仅一次，frozen**） |
| **C — 压缩事件** | `shouldCompress()` 为 true | 最老 task → TaskSummary；相关 messages 设 `compacted_at`；append 压缩通知消息 |

#### 2.2.5 指针卡片格式（稳定模板）

```text
[action:action_x9y8z7_012]
tool=read_file path=src/agent.ts lines=1-93 chars=2841 sha256=8f3a…c21
preview="export async function runAgent…"
recall=recall_query(action_id="action_x9y8z7_012", offset?, limit?)
```

- `action_id` 一次生成永不修改
- `preview`：首 80 字符或首 2 行
- 若 `tools.ts` 已截断：`stored=truncated_at_8000 original_chars=245000`

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

- [ ] `src/action-store.ts`
  - `saveAction(block: ActionBlock): void` → `.sessions/actions/<action_id>.json`
  - `getAction(action_id, slice?: { offset, limit }): ActionBlock | null`
  - `isStale(action_id): boolean` — 对比 `files_touched` 的 mtime vs `timestamp`
- [ ] `TaskTracker` 扩展：`recordToolCall()` 生成 `action_id` 并返回
- [ ] `write_file` 冷存策略：`result_text` 只存确认信息；全文仅在 `args_json`

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

- [ ] `src/recall.ts` + 注册到 `tools.ts`
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
            ├─ replayLastUserTask
            └─ Zvec upsert
    ↓
模型调用 recall_query → recall.ts → head_tail 切片 → 作为 tool result 回注
    ↓
task 结束 → TaskSummary 写入 session.tasks (Phase 1)
```

---

### 2.5 新增文件结构

```
src/
├── action-store.ts      # 冷存储 CRUD
├── action-index.ts      # Zvec 索引（可选 Phase 2b） 
├── pointerize.ts        # 指针卡片生成 + turn 边界物化
├── context-policy.ts    # Prune / 指针 / 组装 API messages / 压缩事件
├── recall.ts            # recall_query 实现
├── agent.ts             # 集成双写 + assembleApiMessages
├── task-tracker.ts      # + recordToolCall / action_id
└── types.ts             # + ActionBlock, RecallQueryParams, message 元数据

.sessions/
├── session_<id>.json
└── actions/
    └── action_<hash>_<seq>.json
```

---

### 2.6 实施顺序（推荐）

| 顺序 | 模块 | 依赖 Zvec | 说明 |
|------|------|-----------|------|
| 2a | action-store + pointerize + context-policy (不含 prune) | 否 | 最小闭环：双写 + turn 边界指针化 |
| 2b | recall_query (action_id 精确解引用) | 否 | 先不做语义搜索 |
| 2c | context-policy prune + 压缩事件消息 | 否 | OpenCode 式假删除 |
| 2d | action-index + query 语义检索 | 是 | 混合检索 |

---

### 2.7 验收标准

| 功能 | 验收方式 |
|------|---------|
| **冷存储双写** | 大 `read_file` 后 `.sessions/actions/<action_id>.json` 含完整 result |
| **指针化** | 第 2 turn 起，热路径 tool 消息变为 `[action:…]` 卡片，字符数 < 300 |
| **同 turn 不指针化** | 第 1 turn 大 read 仍为 inline/截断，模型能继续推理 |
| **recall 解引用** | `recall_query(action_id=…)` 返回 head_tail 切片，`has_more` 正确 |
| **stale 检测** | 文件修改后 recall 返回 `stale: true` 并 hint `read_file` |
| **prune 假删除** | 长会话触发后，旧 tool 消息 `compacted_at > 0` 且不进 API 请求 |
| **压缩事件** | 触发压缩后 append 通知 + replay user task；system prompt 不变 |
| **短对话零开销** | <600 字符 tool 结果无 pointer、无 prune、无 recall 提示泛滥 |
| **语义 recall** (2d) | `recall_query(query="auth middleware")` 命中正确 action，准确率 >80% |

---

### 2.8 已知陷阱（实现时必读）

1. **指针化太早** → 同 turn 看不到全文，幻觉文件内容；严格遵守「本 turn inline，下 turn pointer」
2. **recall 返回全文** → 干净上下文前功尽弃；默认 `head_tail`，大结果分次拉取
3. **每轮改 system** → 打碎前缀缓存；压缩提示走 append-only 事件消息
4. **write_file 双重存储** → `result_text` 不存 content 全文，避免 ActionStore 膨胀
5. **prune 与 pointer 重复操作** → 已 pointerize 的不再 compacted；已 compacted 的无需 pointer

---

## 📋 Phase 3: Session 层压缩 + 多层索引同步

**目标**: 支持跨 session 记忆，多层摘要保持结构一致性

### 功能清单
- [ ] **Session 级摘要**
  - 每 N 个 task 后生成一次 session summary
  - 异步后台执行，不阻塞当前对话
  
- [ ] **引用追踪机制**
  ```typescript
  interface SummaryBlock {
    references: string[];        // 原始 action_block uuids
    entities_touched: string[];  // 结构化标签
    summary_text: string;        // 人类可读摘要
    version: number;             // 版本号，用于一致性校验
  }
  ```

- [ ] **多层索引同步保障**
  - 压缩和存储原子操作
  - 定期清理孤儿引用（summary 指向不存在的 action）
  - 写入时双重校验（uuid 存在性 + 版本匹配）

- [ ] **跨 session 持久化**
  - session.json 文件存储完整消息历史
  - 新 session 启动时加载相关历史摘要

### 验收标准
- ✅ 跨 session 能检索到之前的任务记录
- ✅ 多层摘要引用不断裂（无孤儿引用）
- ✅ Agent 能区分"本次会话"和"之前讨论过"的内容

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
| `web_fetch` | `fetch` + `text/html` → markdown 简化 | 域名 allowlist（config）；默认关闭，`ALLOW_WEB=1` |

#### 4a-3 文件结构

```
src/tools/
├── registry.ts       # 汇总 TOOL_DEFINITIONS + executeTool 路由
├── read-write.ts     # 现有 read_file / write_file
├── explore.ts        # grep_search / list_files / diff_file
├── shell.ts          # run_shell
└── web.ts            # web_fetch
```

---

### 4.2 工具并行执行（4b）

**问题**：当前 `agent.ts` 对 `message.tool_calls` 串行 `for` 循环；多文件 `read_file` 浪费 wall-clock。

#### 4b-1 启发式分批（MVP，推荐先做）

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
| 4a-2 | web_fetch + allowlist | 低 |
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

- 传输：stdio（先不做 HTTP MCP）
- 每个 MCP tool → 映射为 `mcp_<server>_<tool>` 名称，避免冲突
- 权限：`mcp.json` 里 `allow` / `deny` 列表
- 指针化：MCP 大结果走 Phase 2 同一套 `POINTER_RULES`

### 5.3 Skills 集成（5b）

| 方式 | 行为 |
|------|------|
| **System 注入** | `skill load <name>` 将 `SKILL.md` body prepend 到 immutable system 子段（需新 session 生效，保缓存） |
| **Skill 工具** | `invoke_skill(name, query)` 由运行时读 SKILL.md 并返回指引文本（轻量，学习项目推荐） |

### 5.4 验收标准

- ✅ 配置一个 MCP server（如 filesystem）后 Agent 可调用其工具
- ✅ `skills/` 下 SKILL.md 可通过 `invoke_skill` 触发
- ✅ 禁用列表中的 MCP tool 不出现在 API tools 数组

### 5.5 实现（v1.6）

| 模块 | 文件 | 说明 |
|------|------|------|
| 配置 | `agent.json`, `src/plugins/config-loader.ts` | cwd + `~/.minimal-agent/agent.json` 合并 |
| MCP | `src/plugins/mcp-manager.ts`, `agent.mcp.example.json` | stdio MCP → `mcp_<server>_<tool>`，`allow`/`deny` 过滤 |
| Skills | `src/plugins/skills.ts`, `src/tools/skills-tool.ts`, `skills/` | 发现 `**/SKILL.md`，`invoke_skill` 工具 |
| 注册表 | `src/tools/registry.ts` | `ToolRegistry.initialize()` 运行时合并 builtin + MCP |
| CLI | `src/main.ts` | `--list-tools`、`--load-skills <name>` |

**CLI 示例**

```bash
npm start -- --list-tools
npm start -- --load-skills context-design "你的任务"
# MCP: 复制 agent.mcp.example.json → agent.json，设 enabled: true
```

---

## 📋 Phase 6: 多角色工作流（Config 驱动 Agent Loop）

**目标**: 用 **JSON/YAML/Markdown frontmatter** 定义多个 Agent 角色与它们之间的 **工作循环**，实现「planner → solver → reviewer → 循环或结束」等 DIY 编排，而无需改 TypeScript 代码。

**依赖**: 单 Agent ReAct 稳定（Phase 2–4）；每个角色 = 不同 `system` + `tools` 子集 + 可选 `model`。

> 这是 **编排层**，不是替代 ReAct 内核。每个角色内部仍跑 `runAgent()`。

---

### 6.1 配置文件形态

支持两种（二选一，JSON 优先实现）：

**`workflows/debug-loop.json`**

```json
{
  "name": "debug-loop",
  "roles": {
    "planner": {
      "prompt_file": "./roles/planner.md",
      "tools": ["read_file", "grep_search", "list_files"],
      "model": "gemini-2.0-flash",
      "max_turns": 5
    },
    "solver": {
      "prompt_file": "./roles/solver.md",
      "tools": ["read_file", "write_file", "run_shell", "diff_file"],
      "max_turns": 10
    },
    "reviewer": {
      "prompt_file": "./roles/reviewer.md",
      "tools": ["read_file", "grep_search", "diff_file"],
      "model": "gemini-2.0-flash",
      "max_turns": 3
    }
  },
  "flow": [
    { "role": "planner", "input": "{{user_task}}" },
    { "role": "solver", "input": "Plan:\n{{planner.output}}" },
    {
      "role": "reviewer",
      "input": "Changes:\n{{solver.output}}\n\nDiff summary requested."
    },
    {
      "loop": {
        "when": "{{reviewer.verdict}} == 'needs_revision'",
        "max_rounds": 3,
        "steps": [
          { "role": "solver", "input": "Review feedback:\n{{reviewer.output}}" },
          { "role": "reviewer", "input": "Re-review:\n{{solver.output}}" }
        ]
      }
    },
    { "emit": "{{reviewer.verdict}} == 'approved' ? solver.output : reviewer.output" }
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

// src/workflow-runner.ts
export async function runWorkflow(
  workflowPath: string,
  userTask: string,
  config: AgentConfig,
): Promise<WorkflowResult>;
```

- 每步调用 `runAgent({ prompt, config, session, roleSystem })`
- 步骤间 **共享 session**（同 `session_id`）或 **子 session**（reviewer 只看 solver 摘要，省 token）——config 可选 `share_session: true|false`
- `{{role.output}}` 模板替换；`verdict` 由 reviewer 末尾 JSON 约定：`{"verdict":"approved"|"needs_revision"}`

### 6.3 与 Phase 2 上下文策略的配合

| 模式 | 行为 |
|------|------|
| `share_session: true` | 全角色共用一个 context-policy / ActionStore，recall 可跨角色 |
| `share_session: false` | 每角色独立 `current_messages`，只传递上一步 `output` 摘要（更干净，推荐 reviewer） |

### 6.4 CLI

```bash
npm start -- --workflow workflows/debug-loop.json "修复登录 401"
npm start -- --role planner "只分析不改代码：..."
```

### 6.5 实施顺序

| 步骤 | 内容 |
|------|------|
| 6a | JSON workflow 解析 + 线性 flow（无 loop） |
| 6b | `loop` + `when` 条件 + `max_rounds` |
| 6c | Markdown role 文件 + frontmatter |
| 6d | `share_session` 策略 + 跨角色 TaskSummary |

### 6.6 验收标准

- ✅ 三角色线性流：planner → solver → reviewer 跑通
- ✅ reviewer 返回 `needs_revision` 时 solver↔reviewer 循环 ≤ `max_rounds`
- ✅ `--workflow` 与 `--resume` 可组合（workflow 状态写入 session）
- ✅ 改 `planner.md` 无需改 TypeScript

### 6.7 刻意不做（避免 scope 膨胀）

- 非 DAG 的任意图编排（先限 loop + 线性）
- 角色间并行（Phase 6+ 再考虑）
- 可视化 workflow 编辑器

---

## 🔧 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| Token 估算 | `tiktoken` (npm) | OpenAI 官方方案，准确度高 |
| 向量存储 | ChromaDB | 与 MemFileCli 一致，本地轻量 |
| Embedding | bge-m3 (本地) | 小模型，适合个人场景 |
| Session 持久化 | JSON 文件 | 简单直接，Agent 可读 |

---

## 📊 数据流图（含 Phase 2）

```
用户提问 → [Task Block 开始]
   ↓
LLM → tool_calls → executeTool
   ├─ ActionStore 冷写 (全文)
   └─ messages 热写 (inline / 截断)
   ↓
turn 结束 → pointerize (frozen) / prune (compacted_at)
   ↓
预算检查 → shouldCompress?
   ├─ 否 → assembleApiMessages → 继续 ReAct
   └─ 是 → TaskSummary + 压缩事件消息 + replay user task
   ↓
需要历史细节 → recall_query → head_tail 回注
   ↓
Agent 返回总结 → [Task Block 结束] → session.tasks + Zvec upsert
```

---

## 🎓 学习对照点

| 概念 | minimal-agent-ts | OpenCode | Scream Code | Zerostack |
|------|------------------|----------|-------------|-----------|
| 上下文管理 | 滑动窗口 + 指针化 + prune | Prune 标记隐藏 → LLM summary | 短期/长期记忆分离 | 委托 rig 处理 |
| 大 tool 结果 | 指针卡片 + 冷存储 | `compacted` 整段隐藏 | 结构化 action blocks | 在上下文中流转 |
| 历史检索 | recall_query (action_id / 语义) | 重跑 read/grep | memory_recall hook | 无 |
| 假删除 | `compacted_at` + `pointerized` | `compacted` 时间戳 | SQL 持久化 | session compaction |
| 摘要生成 | TaskSummary 混合版 | LLM 5 段 summary | LLM summarize | rig 侧压缩 |
| 缓存策略 | frozen 指针 + immutable system | 未特别强调 | 未特别强调 | rig prompt caching |
| 持久化 | session.json + actions/ | DB 全消息 | SQLite + 向量库 | 内存为主 |
| 工具并行 | 依赖图 + 启发式分批 (Phase 4b) | 内置 | — | — |
| 多角色编排 | JSON/MD workflow (Phase 6) | `@agent` 切换 | subagent | `.` prompt 切换 |

---

---

## 📝 版本历史

| 日期 | 版本 | 变更内容 |
|------|------|---------|
| 2026-06-28 | v1.6 | **Phase 5 实现**: `agent.json` 插件配置、stdio MCP（`@modelcontextprotocol/sdk`）、`invoke_skill` + `--load-skills`、`ToolRegistry` 运行时合并、`--list-tools` |
| 2026-06-27 | v1.4 | **Phase 2c 实现**: OpenCode 式 `compacted_at` prune（40k/2-user 保护、20k 阈值）、`runCompressionEvent`（摘要注入 + notice + replay user task） |
| 2026-06-27 | v1.5 | **Phase 2d**: Zvec `agent_memory` 混合检索（向量+FTS）、`embedding.ts`、recall query 语义搜索 |
| 2026-06-27 | v1.4 | **Phase 2c**: `compacted_at` prune、`runCompressionEvent`（摘要 + notice + replay） |
| 2026-06-27 | v1.3 | **长期路线图**: 总览 Phase 1–6；Phase 1.5 并入 Phase 4（工具扩展、diff_file、并行 scheduler、依赖图、SSE 流式）；新增 Phase 5 MCP/Skills、Phase 6 多角色 workflow（JSON/MD config） |
| 2026-06-27 | v1.2 | **Phase 2 整合版**: 冷存储 ActionStore、指针化 tool 结果、OpenCode 式 `compacted_at` prune、`context-policy.ts` 统一策略、`recall_query` 解引用协议（head_tail / stale）、缓存平衡（immutable system + 压缩事件消息）、分阶段实施 2a–2d |
| 2026-06-27 | v1.1 | **Phase 1 细化**: 混合版 TaskSummary（自动提取+Agent补充）、会话续接 (--resume)、滑动窗口预算策略、Zvec 替代 ChromaDB |
| 2026-06-26 | v1.0 | 初始版本: 核心概念模型（四层 ID）、数据结构设计、三阶段规划、技术选型 (Zvec + all-MiniLM-L6-v2) |

---

*创建者: 小千Chikusa & 哥Jawn  | 最后更新: 2026-06-28 (v1.6)*
