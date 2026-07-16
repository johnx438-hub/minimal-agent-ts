# Job / Workflow 完成通知与主会话续跑 Spec

> **定位**: 后台 job（及同步 workflow）结束后，如何 **可观测** 地通知人类通道，并可选 **触发主 Agent 一轮**（验收 / 询问下一步）——与真人用户消息严格区分。  
> **原则**: MessageBridge **只出站**；触发 ReAct 走 **session 入队**；事件驱动优先于轮询；不抢主 Agent 正在跑的 turn。  
> **状态**: Draft v0.2（2026-07-16）· **J1–J3/J5 落地**（auto_run 默认 false）  
> **代码锚点**: `src/hooks/system-event.ts` · `session-inbound-queue.ts` · `job-registry.ts` · `runner.ts`  
> **相关**: [docs/ROADMAP.md](./docs/ROADMAP.md) §6 · [SPEC_WORKFLOW.md](./SPEC_WORKFLOW.md) ·  
> **扩展/二次开发**: [SPEC_SESSION_AUTO_RUN.md](./SPEC_SESSION_AUTO_RUN.md)（定时、其它 producer、反模式）

---

## 1. 非目标

- 在 MessageBridge 内 start job / 跑 ReAct / 实现 cron  
- 飞书 SDK / 真 IM 闭环（可消费同一契约，实现后置）  
- 把 job 完成伪造成 **真人 user** 消息（禁止无标记注入）  
- 改变 pointerize / compression / workflow 槽位语义  
- 无界自动连环：验收轮再无限 `spawn_background` 而不确认  

---

## 2. 问题与目标

| 痛点 | 目标 |
|------|------|
| 后台 job 完成后主会话「无感」 | 完成即 **notice**（bridge + 可选 RuntimeEvent） |
| 多 job 并行时状态难拼 | **每完成 1 个** 一条通知 + **still_running** 计数 |
| 想自动验收 / 追问用户 | 主会话 **idle** 时入队合成 prompt，踢一轮主 Agent |
| 与真人输入混淆 | 结构化标记 `not_user_message` / `kind=job_complete` 等 |
| workflow 结束摘要散落 | **同一管道**：workflow_complete / handback 复用 notice + 可选入队 |

**一句话**:  
**出站让人看见；入队让主 Agent 在安全时机续跑；二者共享文案模板，职责分离。**

---

## 3. 双通道模型

```text
                    ┌─────────────────────────────┐
  job settle /      │  SystemEventProducer         │
  workflow end  ───►│  (JobRegistry / runWorkflow) │
                    └───────────┬─────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
   MessageBridge.emit                    SessionInboundQueue
   role: system_notice                   enqueue(SystemEvent)
   source: job | workflow                │
   (IM / log / TUI sink)                 ▼
                              when main idle:
                              runTask(formatSyntheticPrompt(ev))
                              ─ 不走 armed workflow
                              ─ 不记为真人 user 意图
```

| 通道 | 职责 | 非职责 |
|------|------|--------|
| **MessageBridge** | 人类可读 fan-out（`system_notice`） | 不入队、不 `runTask`、不改 `current_messages` 契约 |
| **SessionInboundQueue** | 按 session 缓冲系统事件；idle 时投递主 Agent | 不替代 job-store；不解析飞书协议 |
| **RuntimeEvent** | 机器可读遥测（可选并行 emit） | 不替代 bridge 文案 |

与 ROADMAP §6 对齐：Bridge 出站；「踢主 Agent」属于 **session target Dispatch** 的一种 **内部 producer**（不是 cron，不是 IM adapter）。

---

## 4. 事件类型

### 4.1 统一 envelope

```typescript
/** Producer → bridge formatter + optional session queue */
type SystemEventKind =
  | 'job_complete'
  | 'job_failed'
  | 'job_cancelled'
  | 'jobs_all_settled'      // optional batch footer
  | 'workflow_complete'
  | 'workflow_handback';

interface SystemEvent {
  kind: SystemEventKind;
  /** Wall clock ms */
  timestamp: number;
  /** Main session that owns this work */
  session_id: string;
  /** Stable id for dedupe (e.g. job_id or workflow run id) */
  event_id: string;

  // --- job fields (when kind starts with job_) ---
  job_id?: string;
  preset?: string;
  status?: 'completed' | 'failed' | 'cancelled';
  ok?: boolean;
  /** Short line from job result (not full report.md) */
  summary_line?: string;
  /** report path if any */
  report_path?: string;
  /** Sibling jobs still running under same parent session */
  still_running?: number;
  still_running_ids?: string[];

  // --- workflow fields ---
  workflow?: string;
  workflow_path?: string;
  /** Compact digest (may be truncated for bridge; full text may live on session) */
  digest?: string;
  handback_reason?: string;
}
```

### 4.2 多 job 语义

| 规则 | 说明 |
|------|------|
| **粒度** | 每个 job **settle 一次** → 至多一条 `job_complete` / `job_failed` / `job_cancelled` |
| **still_running** | 统计同一 `parent_session_id` 下 status ∈ {queued, running} 的个数（读 registry + meta） |
| **顺序** | 先完成先通知；**不**等全部结束才发第一条 |
| **全部结束** | 可选：当 `still_running === 0` 且本 session 曾有 ≥1 后台 job，再发 `jobs_all_settled` |
| **去重** | 同一 `event_id`（建议 `job_id + status`）只处理一次（内存 Set + 可选落盘） |

**不推荐**热路径轮询 meta 文件；以 `JobRegistry` `promise.finally` / settle 钩子为真源。  
轮询仅作 **补漏**（进程重启后扫描 parent 的未通知 completed job）——实现阶段可选 J0。

### 4.3 Workflow 语义

| 时机 | kind | 说明 |
|------|------|------|
| 成功跑完 | `workflow_complete` | digest = 现有 `formatWorkflowReturnSummary` 或截断版 |
| handback | `workflow_handback` | 含 reason + detail；父 session 已 restore + digest 时仍可 notice |
| 取消 / 权限拒绝 | 可选 `workflow_handback` 或单独 kind | 实现时与 runner 取消路径对齐 |

同步 workflow 结束时主 Agent 通常 **idle** → 入队后可立即 `runTask`（若开启 auto）。

---

## 5. 出站：MessageBridge 文案

### 5.1 SessionMessage 映射

```typescript
// 扩展 source（实现时改 message-bridge.ts）
type SessionMessageSource = 'main' | 'spawn' | 'job' | 'workflow' | 'system';

// emit 示例
{
  session_id,
  turn: 0,
  role: 'system_notice',
  source: 'job',              // or 'workflow'
  source_id: job_id,          // or workflow name
  timestamp,
  content: formatSystemEventForHumans(ev),
}
```

### 5.2 人类可读模板（规范）

**单 job 完成（示意）:**

```text
[system_event · not a user message]
kind: job_complete
job_id: job_xxx
preset: dev-worker
status: completed · ok=true
summary: <summary_line>
report: workspace/jobs/job_xxx/report.md   # if any
still_running: 2
  - job_aaa (running)
  - job_bbb (queued)
```

**全部结束:**

```text
[system_event · not a user message]
kind: jobs_all_settled
session_id: …
message: All background jobs for this session have settled.
```

**Workflow:**

```text
[system_event · not a user message]
kind: workflow_complete
workflow: dag-review
digest:
<truncated or full digest>
```

要求：

- 首行或固定前缀标明 **not a user message**（给人 / IM / 模型共用）  
- 多行纯文本；bridge 不做 Markdown 强渲染依赖  
- summary/digest **截断**（建议 bridge ≤ 2–4KB；全文可指 path）  

### 5.3 RuntimeEvent（可选并行）

```typescript
// 概念；实现时并入 events.ts
| { type: 'system_event'; event: SystemEvent }
// 或拆分:
| { type: 'job_settled'; job_id: string; ok: boolean; still_running: number }
| { type: 'workflow_settled'; workflow: string; handback?: boolean }
```

与现有 `job_list` / `job_status`（查询型）并存：settled 是 **推送**，list/status 是 **拉取**。

---

## 6. 入站：SessionInboundQueue（触发主 Agent）

### 6.1 队列契约

```typescript
interface SessionInboundItem {
  event: SystemEvent;
  enqueued_at: number;
  /** If true, when drained, call runTask with synthetic prompt */
  auto_run: boolean;
}

interface SessionInboundQueue {
  enqueue(sessionId: string, item: SessionInboundItem): void;
  /** Peek / drain for idle runner */
  drain(sessionId: string, max?: number): SessionInboundItem[];
  pendingCount(sessionId: string): number;
}
```

- 进程内内存队列即可（v0）；持久化后置  
- 绑定 `session_id` = job 的 `parent_session_id` 或当前 TUI session  

### 6.2 合成 prompt（进 LLM）

```text
<system_event type="job_complete" not_user_message="true">
...same body as human template or structured JSON...
</system_event>

You are the main agent. This is NOT a human user message.
Review the job/workflow result: accept, suggest follow-ups, or ask the user what to do next.
Do not re-arm a workflow unless the user already asked. Prefer not to fan out many new background jobs without confirmation.
```

写入 `current_messages` 时：

| 方案 | 说明 |
|------|------|
| **A（推荐）** | 作为 **user** 消息，但 body 带固定 `<system_event` 前缀；run 路径检测后 **禁止** armed workflow |
| **B** | 专用 `role: system` 段 + 短 user「请处理系统事件」 | 更清晰，需确认 assemble 路径支持 |

**禁止**：无前缀纯文本伪装用户闲聊。

### 6.3 调度规则

| 主 Agent 状态 | 行为 |
|---------------|------|
| **idle** | drain 队列（默认合并策略见下）→ `runTask(synthetic)` |
| **running / stopping** | 只 enqueue；本 run 的 `run_end` 后再 drain |
| **workflow 同步执行中** | 不插队；workflow 结束事件在 finally 后处理 |

**合并策略（多 job 连发）**

| 模式 | 行为 |
|------|------|
| `per_event`（默认 J3） | 每个 complete 可各踢一轮（简单；可能多轮） |
| `debounce`（J4） | 例如 800ms 窗口合并为一条 multi-job digest |
| `settle_only` | 仅 `jobs_all_settled` / `workflow_*` 才 auto_run |

配置建议（`agent.json` 草案，实现时再接线）：

```jsonc
{
  "session_notify": {
    "bridge": true,
    "auto_run": false,           // 演示可 true；默认 false 更安全
    "auto_run_kinds": ["workflow_complete", "workflow_handback", "jobs_all_settled"],
    "merge": "debounce",
    "debounce_ms": 800,
    "max_digest_chars": 4000
  }
}
```

### 6.4 安全闸

1. **不走** `armedWorkflow` / 不因 system_event 重新 arm workflow。  
2. `auto_run` 默认 **false**；开启时 prompt 含「勿无确认大批 fan-out」。  
3. 同一 `event_id` 不重复 auto_run。  
4. 用户 `/stop` 或 session 切换：队列可丢弃或保留（实现选：切换 session 时不清全局，只 drain 当前 id）。  
5. 与 `publishUserTaskToBridge` 区分：真人任务仍 `role: user` + 无 `system_event` 包装。

---

## 7. 生产钩子（代码落点）

| 源 | 钩子 | 产出 |
|----|------|------|
| `JobRegistry.start` | `promise.then/catch/finally` → classify status | `job_*` + still_running |
| `runSpawnBackground` / code_review bg | 不重复发；registry 单点 | — |
| `AgentRuntime.runWorkflowTask` | success / handback / cancel 返回前 | `workflow_*` |
| 进程启动 | 可选扫描 parent 未通知 job | 补漏 |

**伪代码（J1）:**

```typescript
// job-registry after settle
const still = countRunningForParent(parentSessionId);
const ev = buildJobSystemEvent(meta, result, still);
notifySystemEvent(ev); // bridge + optional queue + optional RuntimeEvent
```

`notifySystemEvent` 集中实现，避免 spawn / workflow / TUI 各写一套。

---

## 8. TUI / CLI 行为

| 面 | 行为 |
|----|------|
| TUI sink | `system_notice` 以状态色/前缀显示「job · not user」 |
| `/jobs` | 仍可手动查；与推送互补 |
| CLI `--json-events` | 可选 `system_event` / `job_settled` |
| 自动跑 | 若 `auto_run`：状态栏可闪「system event → agent」 |

---

## 9. 实施切片

| 切片 | 内容 | 依赖 | 预估 |
|------|------|------|------|
| **J1** | `SystemEvent` + format + JobRegistry settle → MessageBridge `system_notice` | ✅ |
| **J2** | `still_running` + `jobs_all_settled` | ✅ |
| **J3** | `SessionInboundQueue` + idle drain + 合成 prompt；**auto_run 默认 false** | ✅ |
| **J4** | debounce（`session_notify.merge` / `debounce_ms`） | ✅ 基础 debounce |
| **J5** | workflow complete/handback → 同一 hub | ✅ |
| **J6** | RuntimeEvent `system_event` + 单测 | ✅ |
| **J7a** | TUI MessageBridge sink（system_notice → chat） | ✅ |
| **J7** | 飞书/IM sink | ⏳ 后置 |

配置：`agent.json` → `session_notify: { bridge, auto_run, auto_run_kinds, merge, debounce_ms }`。

---

## 10. 验收

### J1–J2

- [ ] 启动 2 个 background job，第一个完成时 bridge/TUI 出现 notice，且 `still_running ≥ 1`  
- [ ] 第二个完成时 `still_running === 0`；可选 all_settled  
- [ ] notice **不是** `role: user` 的真人任务样式  
- [ ] 零 sinks 时无抛错（现有 bridge 语义）  

### J5

- [ ] `/workflow` 跑完出现 `workflow_complete` notice（文案含 digest 或截断）  
- [ ] handback 出现 `workflow_handback`  
- [ ] 不破坏「父 session restore + digest」既有行为  

### J3

- [ ] `auto_run=false`：仅 notice，不自动 LLM  
- [ ] `auto_run=true` 且 idle：自动一轮主 Agent，prompt 含 `not_user_message`  
- [ ] 主 Agent running 时只入队，结束后再 drain  
- [ ] 合成输入 **不会** 触发 armed workflow  

### 回归

- [ ] `npm test` / typecheck  
- [ ] 真人输入、workflow arm one-shot、spawn 路径无回归  

---

## 11. 风险与对策

| 风险 | 对策 |
|------|------|
| 自动跑连环 spawn | 默认 `auto_run=false`；prompt 约束；可限 `auto_run_kinds` |
| 多 job 刷屏 | still_running 单条信息；J4 debounce |
| 与用户消息混淆 | 固定前缀 + kind；路径上禁用 arm |
| 双发（tool 返回后又 notice） | 可接受：tool 同步结果 vs 异步完成；event_id 去重 |
| 进程崩溃丢通知 | J0 可选扫描；非 v0 阻塞 |

---

## 12. 版本

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-16 | v0.2 | J1–J6 实现：hub、job settle、workflow、inbound auto_run |
| 2026-07-16 | v0.1 | 初稿：双通道、SystemEvent、J1–J7 切片与验收 |

---

*实现以本 spec 验收 + `npm test` 为准；与 ROADMAP §6 冲突时：出站归 Bridge，触发主 Agent 归 session 入队，禁止在 sink 内 runTask。*
