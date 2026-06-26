# minimal-agent-ts 上下文管理与动态提示词设计 Spec

> **目标**: 让最简 ReAct Agent 具备分层上下文管理能力，支持长对话不丢失关键信息  
> **日期**: 2026-06-26  
> **状态**: Draft v1.0

---

## 🎯 核心设计理念

**渐进式上下文 + 动态提示词**：
- 近期内容完整回填，中期给 task 摘要，早期给 session 摘要
- 系统提示词根据当前压缩状态动态调整，按需激活 recall_query tool
- 结构化摘要模板保证分层可追溯，避免信息断裂

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

```typescript
interface TaskSummaryDoc {
  task_id: string;           // "task_a1b2c3_005"
  session_id: string;        // "session_20260626_143000"
  
  turn_range: [number, number];  // [15, 22]
  action_count: number;          // 8 (包含多少个 actions)
  
  summary_text: string;    // Agent 返回的最终总结
  key_outcome: string;     // 关键成果描述
  
  entities_touched: string[];  // 涉及的文件/实体
  tools_used: string[];        // 使用的工具列表
  
  content: string;         // 组合文本（用于 embedding）
  embedding: float[];      // task 级别向量
}
```

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

## 📐 上下文分层架构

```
┌─────────────────────────────────────────────────┐
│  System Prompt (动态生成)                        │
│  → 基础指令 + 条件性 recall_query 提示           │
├─────────────────────────────────────────────────┤
│  Layer 1: 近期 (Recent) ~40% budget             │
│  → 完整 action_block，保留所有工具调用细节        │
│  → 最近 2-3 个 task                             │
├─────────────────────────────────────────────────┤
│  Layer 2: 中期 (Mid-term) ~30% budget           │
│  → task_block 结构化摘要                         │
│  → 往前 5-8 个 task，每个只留 summary            │
├─────────────────────────────────────────────────┤
│  Layer 3: 早期 (Early) ~20% budget              │
│  → session 级压缩摘要                            │
│  → 更早内容合并为一段话                          │
├─────────────────────────────────────────────────┤
│  Current Task (~10%)                             │
│  → 当前用户提问 + 工作目录信息                   │
└─────────────────────────────────────────────────┘
```

---

## 📋 Phase 1: 基础滑动窗口 + Task 摘要

**目标**: 实现 token 驱动的滑动窗口，task 结束时生成结构化摘要

### 功能清单
- [ ] **Token 预算管理器**
  - 估算每条消息 token 数（使用 `tiktoken` 或简化方案）
  - 按 40/30/20/10 比例切分近期/中期/早期/当前
  
- [ ] **Task Block 识别**
  - 一次用户提问 → 多轮工具调用 → Agent 返回总结 = 一个 task_block
  - 每个 task_block 带唯一 ID 和时间戳

- [ ] **结构化摘要模板**
  ```typescript
  interface TaskSummary {
    task_id: string;           // "task_20260626_003"
    turn_range: [number, number];  // [15, 22]
    summary: string;           // "修改了 config.ts 的 API_URL"
    entities_touched: string[];    // ["config.ts", "API_URL"]
    tools_used: string[];          // ["read_file", "write_file"]
    key_outcome: string;           // "将 API_URL 从 localhost 改为 openrouter"
  }
  ```

- [ ] **惰性压缩机制**
  - 只在预算快满时触发压缩，平时零开销
  - task 结束时用 Agent 自己的总结当摘要（不额外调 LLM）

### 验收标准
- ✅ 30+ 轮对话不爆 token 上限
- ✅ 近期内容完整保留，中期有结构化摘要
- ✅ Agent 在长对话中仍能准确完成当前任务

---

## 📋 Phase 2: Recall Query Tool + 动态提示词

**目标**: Agent 能主动检索历史细节，系统提示词根据压缩状态动态调整

### 功能清单
- [ ] **recall_query tool**
  ```typescript
  {
    name: "recall_query",
    description: "检索早期对话的历史细节。当滑动窗口中的摘要不够详细时使用。",
    parameters: {
      query: string,   // 搜索关键词或自然语言描述
      scope?: "task" | "action" | "session",  // 可选粒度
      turn_range?: [number, number]            // 可选时间范围
    }
  }
  ```

- [ ] **本地向量索引**
  - 使用 ChromaDB（与 MemFileCli 一致）存储 action_block 向量
  - 支持按 `entities_touched`、`tools_used`、`turn_range` 过滤
  
- [ ] **动态系统提示词生成器**
  ```typescript
  function buildSystemPrompt(context: ContextState): string {
    let prompt = BASE_PROMPT;
    
    if (context.hasCompressedHistory) {
      prompt += `\n\n可选工具: recall_query — 用于检索早期对话的历史细节。`;
    }
    
    if (context.compressionLevel === "heavy") {
      prompt += `\n本次会话已讨论多个主题，需要历史详情时优先使用 recall_query。`;
    }
    
    return prompt;
  }
  ```

- [ ] **提示词分层策略**
  - 无压缩: 基础指令 + 工具列表
  - 轻度压缩: + "recall_query 可用于早期细节"
  - 重度压缩: + "本次会话已讨论 X、Y、Z 主题，需要详情用 recall_query"

### 验收标准
- ✅ Agent 能在摘要不够时主动调用 recall_query
- ✅ recall_query 返回相关 action_blocks（准确率 >80%）
- ✅ 短对话不触发 recall_query（避免无意义调用）

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

## 🔧 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| Token 估算 | `tiktoken` (npm) | OpenAI 官方方案，准确度高 |
| 向量存储 | ChromaDB | 与 MemFileCli 一致，本地轻量 |
| Embedding | bge-m3 (本地) | 小模型，适合个人场景 |
| Session 持久化 | JSON 文件 | 简单直接，Agent 可读 |

---

## 📊 数据流图

```
用户提问
   ↓
[Task Block 开始]
   ↓
LLM → tool_calls → executeTool → 结果回注 (循环)
   ↓
Agent 返回总结 → [Task Block 结束]
   ↓
生成 TaskSummary (结构化模板)
   ↓
存入 ChromaDB (向量索引) + session.json (持久化)
   ↓
预算检查 → 需要压缩？
   ├─ 否 → 继续对话
   └─ 是 → 早期 task → session 摘要，中期 task → 结构化摘要
   ↓
构建上下文 (近期完整 + 中期摘要 + 早期摘要)
   ↓
动态生成系统提示词
   ↓
注入 LLM → 下一轮
```

---

## 🎓 学习对照点

| 概念 | minimal-agent-ts | Scream Code | Zerostack |
|------|------------------|-------------|-----------|
| 上下文管理 | Token 驱动滑动窗口 | 短期/长期记忆分离 | 委托 rig 处理 |
| 历史检索 | recall_query tool | memory_recall hook | 无（依赖上下文） |
| 摘要生成 | 结构化模板 + Agent 自身总结 | LLM summarize | 无 |
| 持久化 | session.json | SQLite + 向量库 | 内存为主 |

---

*创建者: 小千 & 哥 💛 | 最后更新: 2026-06-26*
