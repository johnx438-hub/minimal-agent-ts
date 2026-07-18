# Web UI 对接路线 A：ExternalStoreRuntime

> **决定**: 状态清晰、好挂 session/workflow → **ExternalStore**  
> **真源**: minimal `AgentRuntime` + REST/WS（`docs/WEB_UI_API.md`）  
> **视图**: assistant-ui `useExternalStoreRuntime` + Thread  
> **代码**: `minimal-gui/lib/minimal/*` · `app/MyRuntimeProvider.tsx`

---

## 1. 数据流

```text
Composer 发送
  → store.onSend(text)
  → POST /v1/task  (+ 可选 armed workflow)
  → isRunning=true

minimal MessageBridge / control frames
  → WS /v1/ws
  → store.applyWsFrame(frame)
  → messages[] 更新
  → useExternalStoreRuntime({ messages, isRunning, onNew, onCancel })
  → <Thread />

Session 切换
  → POST /v1/sessions/:id/switch
  → messages = response.messages (convert)
  → store.setSession

Workflow 武装
  → POST /v1/workflows/arm
  → store.armedWorkflow
  → 下一则 onNew 仍只 POST text（后端吃 armed）
```

**原则**: assistant-ui **不**持有业务真源；Zustand store 是 GUI 唯一可变状态，后端是会话/LLM/workflow 真源。

---

## 2. 模块清单

| 文件 | 职责 |
|------|------|
| `lib/minimal/types.ts` | `MinimalMessage`、控制帧、session/workflow 类型 |
| `lib/minimal/client.ts` | token、`api()` REST、base URL |
| `lib/minimal/convert.ts` | `MinimalMessage` → `ThreadMessageLike` |
| `lib/minimal/store.ts` | Zustand：messages / running / session / catalog / WS handlers |
| `lib/minimal/ws.ts` | 连接、重连、`onmessage` → store |
| `app/MyRuntimeProvider.tsx` | `useExternalStoreRuntime` 接线 |
| （后续）`components/minimal/*` | Session 列表、Workflow 武装、Profile 下拉 |

---

## 3. Store 字段（建议）

```ts
{
  // chat
  messages: MinimalMessage[]
  isRunning: boolean

  // session
  sessionId: string | null
  sessions: SessionMeta[]

  // catalog (sidebar)
  profiles / models / workflows / skills / jobs
  armedWorkflow: string | null
  profile / model

  // connection
  connection: 'idle' | 'connecting' | 'open' | 'closed' | 'error'
  lastError?: string
}
```

### 写入规则

| 事件 | 写什么 |
|------|--------|
| onNew | append user；POST task；isRunning=true |
| WS assistant delta | 末条 assistant 追加 text，或新建 running assistant |
| WS assistant content (final) | 替换/收束末条 assistant，status=complete |
| WS tool | append tool 消息（convert 成 tool-call part 或单独行） |
| run_state idle/error/aborted | isRunning=false；收束 streaming |
| switch session | 整表替换 messages（来自 API） |
| history GET | 同 switch 水合 |

**禁止**: 前端根据本地 mock 再插一条完整 assistant（会导致「结束后变两条」——旧 demo 的坑）。

---

## 4. convertMessage 映射

| MinimalMessage | ThreadMessageLike |
|----------------|-------------------|
| user text | `{ role:'user', content:[{type:'text', text}] }` |
| assistant text (running) | content text + status running |
| assistant text (done) | content text + status complete |
| tool | tool-call part 或 text 降级 `⚙ name\npreview` |
| system / notice | 可降级 assistant 灰色，或过滤不进 Thread |

---

## 5. Runtime 回调

| 回调 | 行为 |
|------|------|
| `onNew` | 只支持 text；调 `store.sendTask` |
| `onCancel` | `POST /v1/abort` |
| `setMessages` | 允许 Thread 编辑时回写 store（若开启 edit） |
| edit/reload | **暂关** capabilities，避免无后端支持 |

---

## 6. 环境变量

```bash
# minimal-gui/.env.local
NEXT_PUBLIC_MINIMAL_BASE_URL=http://127.0.0.1:7788
NEXT_PUBLIC_MINIMAL_TOKEN=   # 与 npm run web 打印的 token 一致
```

---

## 7. 实现阶段

| 阶段 | 交付 |
|------|------|
| **A0** | store + client + convert + Provider 接真 REST/WS（本骨架） | ✅ |
| **A1** | 历史水合：mount / switch 拉 messages | ✅ |
| **A2** | Session 侧栏 + workflow 武装条 | ✅ `components/minimal/sidebar.tsx` |
| **A3** | profile/model 下拉、skills load、jobs/steps UI | ✅ toolbar + sidebar |
| **A4** | slash → `POST /v1/command` | ✅ composer `/…` → `sendCommand` |

---

## 8. 明确不做（本路线）

- 不把 minimal 改成 Assistant Transport 真源  
- 不用 useChatRuntime 直连 OpenAI  
- UI 壳像素级 polish 继续 hold  
