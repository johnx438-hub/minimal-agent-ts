# Web UI Spec（浏览器第二 UI）

> **状态**: Draft v0.4（2026-07-19）· **W0–W3 ✅** · slash 公共层 ✅ · session 历史 API ✅  
> **定位**: 浏览器作为与 TUI 对等的 **第一公民 UI**，走 L3 MessageBridge 出站 + 薄 HTTP/WS 入站，不 fork 第二套 ReAct。  
> **代码锚点**: `src/web/*` · `src/slash/*` · `src/session-chat-history.ts` · `src/hooks/message-bridge.ts` · `public/web-ui/`  
> **相关**: [docs/ROADMAP.md](./docs/ROADMAP.md) §6 · [SPEC_JOB_SESSION_NOTIFY](./SPEC_JOB_SESSION_NOTIFY.md)

---

## 1. 目标与非目标

### 目标

| ID | 描述 |
|----|------|
| G1 | 同进程 `AgentRuntime` 上挂 HTTP + WebSocket，默认 `127.0.0.1` |
| G2 | 出站：`MessageBridge.addSink(WsSink)` → 所有已鉴权 WS 客户端 |
| G3 | 入站：`POST /v1/task`、`POST /v1/abort` 调 Runtime 已有方法 |
| G4 | 鉴权：启动生成 token；无 token 拒绝（防本机其它网页 RCE 面） |
| G5 | 静态托管 Web 客户端（`public/web-ui`）；可只读挂 workspace |
| G6 | **W3**：Markdown 渲染、profile/model 切换、workflow/skills 快捷、可选 slash 命令条 |

### 非目标（本阶段）

- 公网 / 多租户 / OAuth  
- Schedule / 飞书 Inbound 完整实现（形状预留）  
- newspaper 皮肤真接线  
- 与 TUI 像素级 1:1（slash 子集即可）  
- `/approve` 交互式授权 UI  

---

## 2. 架构

```
Browser AgentUI
    │  REST task/abort/sessions/llm/workflows/skills/command
    │  WS SessionMessage + control frames
    ▼
src/web (auth · routes · command · event-bridge · ws-hub · ws-sink · static)
    │
    ├── AgentRuntime.* (runTask, LLM override, armWorkflow, loadSkill, …)
    └── MessageBridge ──► WsSink ──► ws-hub.broadcast
              RuntimeEvent ──► event-bridge ──► control frames
```

**原则**

1. Sink 内禁止 `runTask`。  
2. **控件 + slash 共用 Runtime**；slash 仅复用 `parseSlashLine`，不复用 TUI overlay。  
3. 默认不监听 `0.0.0.0`。  
4. running 中禁止 profile/model/session 切换。

---

## 3. 鉴权

- Token：`randomBytes(24).toString('base64url')`，或 `MINIMAL_WEB_TOKEN` / `--web-token`。  
- HTTP：`Authorization: Bearer <token>` 或 query `?token=`。  
- WS：`/v1/ws?token=`。  
- 启动打印：`Web UI http://127.0.0.1:<port>/?token=<token>`  
- UI shell（html/css/js）可无 token 加载；**API / workspace / WS 必须 token**。

---

## 4. HTTP API

### 4.1 核心（W1–W2）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 探活 + model/profile/armed（可无 token） |
| POST | `/v1/task` | `{ text, workflow?, session_id? }`；省略 workflow 时用 **armed** |
| POST | `/v1/abort` | 中止 |
| GET | `/v1/sessions` | 列表 |
| POST | `/v1/sessions/:id/switch` | 切换；响应含 `messages[]`（历史水合） |
| GET | `/v1/sessions/:id/messages` | 会话聊天历史（transcript + in-flight） |
| GET | `/v1/messages` | 当前会话历史 |
| GET | `/v1/session` | 当前 |
| GET | `/v1/jobs` | 后台 jobs |
| GET | `/` `/ui/*` | 静态 UI |
| GET | `/workspace/*` | cwd/workspace 只读（需 token） |

### 4.2 LLM（W3a）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/llm/status` | profile / model / armed / skills |
| GET | `/v1/llm/profiles` | `listSessionProfileChoices` |
| POST | `/v1/llm/profile` | `{ name }` 或 `{ reset: true }` |
| GET | `/v1/llm/models` | 可选 `?async=1` remote enrich |
| POST | `/v1/llm/model` | `{ model }` 或 `{ reset: true }` |

### 4.3 Workflow / Skills（W3b）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/workflows` | meta 列表 + armed |
| POST | `/v1/workflows/arm` | `{ name }` 武装；`{ name: null }` 取消 |
| GET | `/v1/workflows/armed` | 当前武装 path |
| GET | `/v1/skills` | 列表 + loaded |
| POST | `/v1/skills/load` | `{ name }`（catalog 内） |

### 4.4 命令总线（W3c）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/command` | `{ line: "/profile kimi-main" }` → `parseSlashLine` + dispatch |
| GET | `/v1/catalog` | 一次打包 profiles/models/workflows/skills |

**Slash 子集（Web）**: `/help` `/profile` `/model` `/reasoning` `/workflow` `/skills` `/stop`  
未支持的 `__*` 伪指令返回明确错误，不崩。

错误：`401` / `409` agent_running / `400` / `404`。

---

## 5. WebSocket 控制帧

```ts
{ type: 'hello', session_id?, model?, profile?, running, sessions?, jobs?, armed_workflow?, loaded_skills? }
{ type: 'run_state', state: 'idle'|'running'|'aborted'|'error', detail?, session_id?, model? }
{ type: 'job', id, status, label? }
{ type: 'workflow_step', phase, role, nodeId?, as?, round?, status? }
{ type: 'workflow_handback', workflow, reason, detail, role?, round? }
{ type: 'workflow_armed', path: string|null, name? }
{ type: 'llm', profile?, model?, … }
{ type: 'skills', loaded: string[] }
```

SessionMessage 不变（user/assistant/tool/system_notice）。

---

## 6. 客户端（W3）

- **主**: `public/web-ui/index.html`  
- **Markdown**: CDN `marked` + `DOMPurify`；assistant final 全量渲染；delta 节流重渲  
- **顶栏**: Profile / Model 下拉（running 禁用）  
- **侧栏 Tabs**: Workflow 步骤 | Jobs | Sessions | Skills | Catalog workflows  
- **输入**: 可选 workflow 武装 chips；以 `/` 开头走 `POST /v1/command`  
- **武装条**: 显示当前 armed workflow  

---

## 7. CLI

```bash
npm run web -- --allow-web --web-port 7788
npm run tui -- --web --web-port 7788
```

Flags：`--web` · `--web-port` · `--web-token` · `--web-host 127.0.0.1`

---

## 8. 交付切片

| 切片 | 内容 | 状态 |
|------|------|------|
| **W0** | 本 SPEC + ROADMAP 指针 | ✅ |
| **W1** | auth + server + task/abort + WsSink + 静态 UI | ✅ |
| **W2** | sessions / run_state / jobs + workflow 步骤 | ✅ |
| **W3a** | Markdown + profile/model REST + 顶栏 | ✅ |
| **W3b** | workflows arm + skills load + 侧栏 | ✅ |
| **W3c** | `/v1/command` slash 子集 | ✅ |
| **slash 公共层** | `src/slash/parse.ts` + `dispatch-runtime.ts`；TUI re-export | ✅ |
| **session 历史** | `buildSessionChatHistory` + messages API | ✅ |
| **W4** | 展示彩排 / action 详情 / workspace 预览 / UI 库对接 | 待定（UI 壳 hold） |

### 模块边界

```
src/slash/parse.ts           纯解析（原 tui/slash.ts）
src/slash/dispatch-runtime.ts  Runtime 副作用（原 web/command 主体）
src/tui/slash.ts             re-export 兼容
src/tui/slash-handlers.ts    TUI-only overlays（不进公共层）
src/session-chat-history.ts  transcript + current_messages 展平
```

---

## 9. 验收

### W1–W2（回归）

1. `npm run web` 打印带 token URL  
2. 对话 + 工具流 + abort + 401  

### W3

1. Assistant 消息渲染 Markdown（代码块/列表）  
2. 切换 profile/model 成功，顶栏更新；running 时拒绝  
3. 武装 `dag-review` 后发消息进入 workflow；步骤栏更新  
4. Skills 列表可 load  
5. `/profile list`、`/workflow` 经命令条返回可读结果  
6. `npm run typecheck` + web 相关测试通过  
