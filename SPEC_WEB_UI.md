# Web UI Spec（浏览器第二 UI）

> **状态**: Draft v0.2（2026-07-19）· **W0 契约 ✅** · **W1 竖切 ✅** · **W2 侧栏/会话/workflow 步骤 ✅**  
> **定位**: 浏览器作为与 TUI 对等的 **第一公民 UI**，走 L3 MessageBridge 出站 + 薄 HTTP/WS 入站，不 fork 第二套 ReAct。  
> **代码锚点**: `src/web/*` · `src/hooks/message-bridge.ts` · `src/runner.ts` · `public/web-ui/`  
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
| G5 | 静态托管 Web 客户端（`agent-webui`）；可只读挂 workspace |

### 非目标（本阶段）

- 公网 / 多租户 / OAuth  
- Schedule / 飞书 Inbound 完整实现（形状预留）  
- newspaper 皮肤真接线  
- 与 TUI 像素级 1:1  

---

## 2. 架构

```
Browser AgentUI
    │  REST task/abort/sessions
    │  WS SessionMessage + control frames
    ▼
src/web (auth · routes · ws-hub · ws-sink · static)
    │
    ├── AgentRuntime.runTask / abort / listSessions / resumeSession
    └── MessageBridge ──► WsSink ──► ws-hub.broadcast
```

**约束**

1. Sink 内禁止 `runTask`（与 SPEC_JOB_SESSION_NOTIFY 一致）。  
2. 主流程零第二套 agent 循环。  
3. 默认不监听 `0.0.0.0`。

---

## 3. 鉴权

- Token：`randomBytes(24).toString('base64url')`，或 `MINIMAL_WEB_TOKEN` / `--web-token`。  
- HTTP：`Authorization: Bearer <token>` 或 query `?token=`。  
- WS：连接 URL `?token=` 或首帧前 Sec 头（实现用 query）。  
- 启动时打印一次：`Web UI http://127.0.0.1:<port>/?token=<token>`  

---

## 4. HTTP API

| 方法 | 路径 | 体/说明 | 优先级 |
|------|------|---------|--------|
| GET | `/health` | `{ ok, running, session_id? }` 可无 token | P0 |
| POST | `/v1/task` | `{ text, workflow? }` → runTask / runWorkflowTask | P0 |
| POST | `/v1/abort` | abort 当前 run | P0 |
| GET | `/v1/sessions` | session 列表 | P1 |
| POST | `/v1/sessions/:id/switch` | resumeSession | P1 |
| GET | `/v1/session` | 当前 session 摘要 | P1 |
| GET | `/v1/actions/:id` | action 详情 | P2 |
| GET | `/v1/jobs` | 后台 jobs | P1 |
| GET | `/` `/ui/*` | 静态 Web UI | P0 |
| GET | `/workspace/*` | cwd/workspace 只读 | P1 |

错误：`401` 无/错 token；`409` agent already running；`400` 缺 text。

---

## 5. WebSocket `/v1/ws?token=`

### 下行

- **SessionMessage**（既有类型）：`role` user | assistant | tool | system_notice；assistant 可带 `delta` / `content`。  
- **控制帧**（`type` 字段）：

```ts
{ type: 'hello', session_id?: string, model?: string, running: boolean }
{ type: 'run_state', state: 'idle' | 'running' | 'aborted' | 'error', detail?: string }
{ type: 'job', id: string, status: string, label?: string }  // P1
```

### 上行（可选）

```ts
{ type: 'task', text: string, workflow?: string }
{ type: 'abort' }
```

W1 可用 REST 上行 + WS 下行。

---

## 6. 客户端

- **主**: `workspace/web-ui/index.html`（由 `agent-webui-dag` 进化，`window.AgentUI` + fetch/ws）。  
- **副**: `newspaper-agent-ui.html` 后置换皮。

映射：

| 帧 | AgentUI |
|----|---------|
| user content | appendMessage('user') |
| assistant delta | appendToken |
| assistant content | finalize / appendMessage |
| tool | showToolCall |
| job | setJobStatus |
| run_state | 禁用发送 / Abort |

---

## 7. CLI

```bash
npm run web -- --web-port 7788
# 或
tsx src/tui/main.ts --web --web-port 7788
tsx src/main.ts --web --web-port 7788   # headless web-only
```

Flags：`--web` · `--web-port <n>` · `--web-token <s>` · `--web-host 127.0.0.1`

---

## 8. 交付切片

| 切片 | 内容 | 状态 |
|------|------|------|
| **W0** | 本 SPEC + ROADMAP 指针 | ✅ |
| **W1** | auth + server + task/abort + WsSink + 静态 UI 真接线 | ✅ |
| **W2** | sessions / run_state UX / jobs + workflow 步骤侧栏 | ✅ |
| **W3** | action 详情、workspace 预览、单测加固 | 待定 |
| **W4** | 展示彩排 | 待定 |

---

## 9. 验收（W1）

1. `npm run web`（或 `--web`）启动，打印带 token 的 URL。  
2. 浏览器打开 → 发送消息 → 见 user 气泡 + assistant 流式/终稿和/或 tool 卡。  
3. 无 token / 错 token → 401。  
4. 运行中再 POST task → 409。  
5. abort 可中止。  
6. `npm test` 相关用例通过；typecheck 无新增错误。
