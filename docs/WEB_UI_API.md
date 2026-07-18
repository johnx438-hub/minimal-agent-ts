# Web UI 后端接口清单（对接开源组件库）

> 供选型 chat/shell UI 组件库时对照。实现见 `SPEC_WEB_UI.md` · `src/web/routes.ts` · `src/slash/*`。  
> **基址**: `http://127.0.0.1:<port>` · **鉴权**: `Authorization: Bearer <token>` 或 `?token=`（除 `/health` 与静态壳）。

---

## 1. 实时通道

| 通道 | 路径 | 方向 | 载荷 |
|------|------|------|------|
| WebSocket | `/v1/ws?token=` | 服务端→客户端 | `SessionMessage` + 控制帧（下表） |
| REST | 见下 | 客户端→服务端 | JSON |

### 1.1 SessionMessage（对话流）

```ts
{
  session_id: string
  turn: number
  role: 'user' | 'assistant' | 'tool' | 'system_notice'
  timestamp: number
  delta?: string          // assistant 流式增量
  content?: string        // final / tool preview / notice
  tool_name?: string
  call_id?: string
  task_id?: string
  source?: 'main' | 'spawn' | 'job' | 'workflow' | 'system'
}
```

### 1.2 控制帧

| type | 字段 | UI 用途 |
|------|------|---------|
| `hello` | session_id, model, profile, running, sessions[], jobs[], armed_workflow, loaded_skills | 首屏水合 |
| `run_state` | state: idle\|running\|aborted\|error, detail?, session_id?, model? | 发送按钮 / Abort / 状态点 |
| `job` | id, status, label? | Jobs 列表 |
| `workflow_step` | phase, role, nodeId?, as?, round?, status? | 步骤时间线 |
| `workflow_handback` | workflow, reason, detail, role? | 告警 / handback 卡 |
| `workflow_armed` | path, name? | 武装条 |
| `llm` | profile, model, … | 顶栏同步 |
| `skills` | loaded[] | Skills 已加载 |

### 1.3 WS 上行（可选，REST 亦可）

```ts
{ type: 'task', text: string, workflow?: string }
{ type: 'abort' }
```

---

## 2. REST API 全表

### 2.1 健康 / 会话

| Method | Path | Request | Response 要点 |
|--------|------|---------|----------------|
| GET | `/health` | — | `{ ok, running, session_id, model, profile, armed_workflow }` |
| GET | `/v1/session` | — | 当前 session 摘要 |
| GET | `/v1/sessions` | — | `{ sessions: [{session_id, updated_at, task_count, note}], current }` |
| POST | `/v1/sessions/:id/switch` | `{}` | `{ ok, session_id, messages[], message_count }` **含水合历史** |
| GET | `/v1/sessions/:id/messages` | `?limit=500&tools=0\|1` | `{ session_id, count, messages: SessionChatMessage[] }` |
| GET | `/v1/messages` | 同上 | 当前会话历史 |
| POST | `/v1/sessions` | （规划）新建 | 暂可用 slash/command 或后续补 |

### 2.2 对话 / 控制

| Method | Path | Request | Response |
|--------|------|---------|----------|
| POST | `/v1/task` | `{ text, workflow?, session_id? }` | `202 { accepted, session_id, workflow }`；省略 workflow 用 armed |
| POST | `/v1/abort` | `{}` | `{ ok, aborted }` |
| POST | `/v1/command` | `{ line: "/profile x" }` | `{ ok, message, data?, accepted? }` |

### 2.3 LLM

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/v1/llm/status` | — | profile, model, armed_workflow, loaded_skills |
| GET | `/v1/llm/profiles` | — | `{ profiles: [{ name, displayName, available, active, unavailableReason? }] }` |
| POST | `/v1/llm/profile` | `{ name }` 或 `{ reset: true }` | `{ ok, message, …status }` |
| GET | `/v1/llm/models` | `?async=1` | `{ models: [{ model, active }], source? }` |
| POST | `/v1/llm/model` | `{ model }` 或 `{ reset: true }` | `{ ok, message, …status }` |

### 2.4 Workflow / Skills / Jobs

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/v1/workflows` | — | `{ workflows: [{ name, path, kind, roles, share_session }], armed }` |
| POST | `/v1/workflows/arm` | `{ name }` / `{ name: null }` | `{ ok, armed, name? }` |
| GET | `/v1/workflows/armed` | — | `{ armed }` |
| GET | `/v1/skills` | — | `{ skills: [{ name, description }], loaded }` |
| POST | `/v1/skills/load` | `{ name }` | `{ ok, loaded }` |
| GET | `/v1/jobs` | — | `{ jobs: [{ type:'job', id, status, label }], running_count }` |
| GET | `/v1/catalog` | — | 一次打包 llm + profiles + models + workflows + skills |

### 2.5 静态 / 产物

| Method | Path | 说明 |
|--------|------|------|
| GET | `/` `/ui/*` | SPA/HTML 壳 |
| GET | `/workspace/*` | 工作区只读文件（需 token） |
| GET | `/v1/actions/:id` | **规划** action 详情（recall 对等） |

### 2.6 SessionChatMessage（历史）

```ts
{
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  turn?: number
  task_id?: string
  tool_name?: string
  action_id?: string
  source: 'transcript' | 'in_flight'
  completed_at?: number
}
```

来源：`.sessions/transcript_*.jsonl` 完成任务 + `session.current_messages` 进行中（与 TUI `/transcript` 同数据面）。

---

## 3. 错误约定

| HTTP | 含义 |
|------|------|
| 401 | 缺/错 token |
| 400 | 参数错误 |
| 404 | session/workflow/skill 不存在 |
| 409 | agent_running（并发任务或禁切换） |
| 202 | 任务已接受（流走 WS） |

---

## 4. 组件库选型时建议映射

| UI 模块 | 接哪些接口 |
|---------|------------|
| **Chat 时间线** | WS SessionMessage + `GET …/messages` 首屏 + switch 返回的 messages |
| **Composer 发送** | `POST /v1/task`；`/` 前缀 → `POST /v1/command` |
| **停止按钮** | `POST /v1/abort` + `run_state` |
| **Session 侧栏** | `GET /v1/sessions` + switch + messages |
| **Model/Provider 选择** | `/v1/llm/*` |
| **Workflow 选择/武装** | `/v1/workflows*` + `workflow_step` 帧 |
| **Skills 面板** | `/v1/skills*` |
| **Jobs 面板** | `/v1/jobs` + `job` 帧 |
| **Markdown 气泡** | 前端本地（无需后端）；content/delta 来自 WS |
| **文件预览** | `/workspace/*` |
| **命令面板 / slash** | `POST /v1/command` + 可选 `GET` help 词表（可用 command `/help`） |

### 能力矩阵（后端已具备 vs 组件库要自带）

| 能力 | 后端 | 组件库 |
|------|------|--------|
| 流式 token | ✅ WS delta | 流式气泡 / typewriter |
| 历史分页 | ✅ limit 截断（服务端 tail） | 虚拟列表可选 |
| 多会话 | ✅ | Session list UI |
| 工具调用卡 | ✅ tool role / preview | Collapsible tool card |
| 步骤/DAG | ✅ workflow_step | Timeline / stepper |
| 鉴权 | ✅ token | 注入 header / query |
| 附件/图片 | 部分（vision 主在 TUI） | 可后接 |
| 主题/布局 | — | 组件库强项 |

---

## 5. 公共代码层（非 UI）

| 包路径 | 职责 |
|--------|------|
| `src/slash/parse.ts` | 纯解析 slash → `SlashResult` |
| `src/slash/dispatch-runtime.ts` | Runtime 副作用（profile/model/workflow/skills/stop） |
| `src/session-chat-history.ts` | transcript + in-flight 展平 |
| `src/hooks/message-bridge.ts` | 出站 fan-out |

TUI overlay（picker/confirm）**不**在公共层，Web 用 REST 列表替代。

---

## 6. 明确未做 / 选型可忽略

- 公网 OAuth、多租户  
- 完整 `/approve` 交互授权 UI  
- Schedule / 飞书  
- Action 详情 REST（可后续加 `GET /v1/actions/:id`）  
- 新建 session 专用 REST（可用后续 `POST /v1/sessions`）  

---

## 7. 最小对接顺序（给前端）

1. 带 token 连 WS + `GET /v1/catalog`  
2. Chat：history `GET /v1/messages` 或 switch 水合 → 听 WS  
3. 发送 `POST /v1/task`  
4. 顶栏 llm + 侧栏 sessions/workflows  
5. Markdown 与主题用组件库  
