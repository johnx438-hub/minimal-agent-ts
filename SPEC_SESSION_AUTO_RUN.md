# Session auto_run / SystemEvent 二次开发占位 Spec

> **定位**: 把「系统事件 → 可选踢主 Agent」做成 **可扩展公共能力** 的设计锚点与二次开发注意事项。  
> **读者**: 后续接 **定时任务、Inbound、Webhook、其它 producer** 的实现者。  
> **状态**: Placeholder v0.1（2026-07-17）· **行为实现见既有代码**；本文件不重复 Job/Workflow 细节。  
> **已实现锚点**: `src/hooks/system-event.ts` · `session-inbound-queue.ts` · `runner.ts`（idle drain）· `src/tui/pi/bridge-sink.ts`  
> **专项实现**: [SPEC_JOB_SESSION_NOTIFY.md](./SPEC_JOB_SESSION_NOTIFY.md)（job/workflow producer）  
> **总图**: [docs/ROADMAP.md](./docs/ROADMAP.md) §6 MessageBridge / Inbound / Schedule  

---

## 1. 一句话

**Producer 只负责 `notify(SystemEvent)`；出站给人看，入队在 idle 时可选 `auto_run`；禁止在 MessageSink / cron 回调里直接 `runTask`。**

---

## 2. 模块边界（二次开发必须守住）

```text
┌─────────────────────────────────────────────────────────────┐
│  Producers（可无限加）                                        │
│  job-registry · workflow runner · ScheduleFire · Feishu …   │
└───────────────────────────┬─────────────────────────────────┘
                            │ notify(SystemEvent)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  SystemEventHub（公共）                                        │
│  dedupe → MessageBridge.emit(system_notice)                  │
│        → SessionInboundQueue.enqueue (if auto_run policy)    │
│        → RuntimeEvent system_event（可选）                    │
└───────────────────────────┬─────────────────────────────────┘
                            │ idle + debounce
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  AgentRuntime drain（公共调度）                                 │
│  !running → synthetic prompt → runSingleTask                 │
│  禁止 armed workflow；固定 not_user_message 包装               │
└─────────────────────────────────────────────────────────────┘
```

| 层 | 放什么 | 不放什么 |
|----|--------|----------|
| **Producer** | 何时、何种 kind、session_id、摘要字段 | runTask、改 pointerize、飞书协议解析（adapter 另层） |
| **Hub** | 去重、bridge、入队策略、格式化 | cron 表达式、job 磁盘细节 |
| **Runtime drain** | idle 判定、合成 prompt、防重入 | 业务「验收逻辑」（那是主 Agent prompt 的事） |
| **MessageBridge sink** | 展示 notice | start job / 入队 / runTask |

---

## 3. 与「真人用户消息」的硬区分

| | 系统事件 auto_run | 真人输入 |
|--|-------------------|----------|
| 标记 | `<system_event not_user_message="true">` 或 `role: system_notice` | 普通 user 文本 |
| arm workflow | **禁止** | 可 one-shot arm |
| 默认是否踢 LLM | `auto_run` **默认 false** | 用户提交即跑 |
| bridge role | `system_notice` | `user`（H1） |

**禁止**：把 cron/job 完成伪装成无前缀的用户闲聊再 `runTask`。

---

## 4. 扩展 Producer 检查清单

新触发源（定时 / webhook / 其它）按序做：

1. **定义 `kind`**  
   - 加入 `SystemEventKind` 联合类型（或文档约定字符串 + 运行时校验）。  
   - 示例预留（未实现）：`schedule_fire` · `inbound_system` · `webhook_complete` · `manual_nudge`。

2. **填 `SystemEvent` 必填字段**  
   - `event_id`：全局唯一、可去重（同 tick 重入不双踢）。  
   - `session_id`：目标主会话（定时须有绑定策略，见 §6）。  
   - `timestamp`、人类可读摘要字段（`summary_line` / `digest` / 自定义扩展字段）。

3. **只调用**  
   - `getGlobalSystemEventHub()?.notify(ev)` 或注入的 hub（测试可本地 `createSystemEventHub`）。  
   - **不要** `import` runner 私有方法直接跑。

4. **配置**  
   - 若需自动踢主 Agent：把 kind 放进 `session_notify.auto_run_kinds`，且 `auto_run: true`。  
   - 仅通知：只开 `bridge: true` 即可。

5. **文案**  
   - 优先扩展 `formatSystemEventForHumans` / `formatSystemEventSyntheticPrompt` 的 kind 分支。  
   - 保持首行/包装含 **not a user message** 语义。

6. **测试**  
   - hub 单测：notify → sink 收到 `system_notice`；dedupe；auto_run 入队条件。  
   - 不强制上完整 TUI / 真 cron。

---

## 5. `session_notify` 配置契约（占位稳定）

`agent.json`（已部分接线）：

```jsonc
{
  "session_notify": {
    "bridge": true,                 // 出站 system_notice
    "auto_run": false,              // 默认关：安全
    "auto_run_kinds": [
      "workflow_complete",
      "workflow_handback",
      "jobs_all_settled"
      // 后续: "schedule_fire", ...
    ],
    "merge": "debounce",            // per_event | debounce | settle_only
    "debounce_ms": 800,
    "max_digest_chars": 4000
  }
}
```

| 字段 | 二次开发注意 |
|------|----------------|
| `auto_run` | 全局总闸；定时场景可考虑 **按 schedule 覆盖**（未实现，见 §8） |
| `auto_run_kinds` | 白名单；新 kind 默认不踢，避免 silent 连环 |
| `merge: settle_only` | 只对「收束类」kind 入队（如 all_settled / workflow_*） |
| `debounce_ms` | 多 producer 连发时合并一轮 drain；勿在 producer 内 sleep |

---

## 6. 定时任务（Schedule）对接约定（未实现 · 占位）

对齐 ROADMAP §6.6：**Schedule 是 producer，不是 bridge 插件。**

```text
croner onTick(scheduleId)
  → ScheduleFire(def)
      → target=job     → spawn_background（已有）
      → target=session → 构造 SystemEvent { kind: 'schedule_fire', session_id, … }
                         → hub.notify
                         → （若 auto_run）idle 后主 Agent 执行 brief
      → 可选同时 bridge notice「定时任务已触发」
```

| 注意 | 说明 |
|------|------|
| **session 绑定** | 定义表须有 `session_id` / `session: last_active` 策略；无 session 则只 job 或只 log |
| **与 job target 分工** | 重活、隔离权限 → job；要续聊上下文 → session + auto_run |
| **overrun** | 上一 tick 未结束：跳过或入队合并，**禁止**并行多个 auto_run 抢同一 session（drain 已有 `inboundAutoRunBusy`） |
| **进程保活** | 无常驻 Node 则无法 kick；与「用户挂机但 TUI 仍开」同理 |

**禁止**：在 `MessageSink.onMessage` 里解析 cron 或 start schedule。

---

## 7. Inbound / IM 对接约定（未实现 · 占位）

| 事件类型 | 建议路径 |
|----------|----------|
| 用户聊天 | 现有 user 输入 / 未来 InboundAdapter → **user** 路径，**不是** system_event |
| 通道系统通知（进群、机器人 kick） | 可选 `kind: inbound_system` → hub（只 notice 或 auto_run 问主 Agent） |
| 出站回复用户 | MessageBridge / FeishuSink 消费 `system_notice` 或 assistant 流 |

飞书回帖策略、鉴权、重试在 **adapter**；与 hub 仅共享事件类型。

---

## 8. 后续演进占位（有需求再开）

| ID | 项 | 说明 |
|----|-----|------|
| **AR-1** | 包结构调整 | 抽 `src/session-dispatch/`（hub + queue + policy），runner 只依赖接口 |
| **AR-2** | `SystemEventKind` 注册表 | 避免改联合类型散落；plugin 可注册 kind + formatter |
| **AR-3** | 按 schedule/source 覆盖 `auto_run` | 全局 false，单一定时 true |
| **AR-4** | 合成 prompt 模板表 | `kind → prompt template` 可配置 |
| **AR-5** | 入队持久化 | 进程崩溃不丢 nudge（可选） |
| **AR-6** | 补漏扫描 J0 | 重启后扫未 notify 的 completed job |
| **AR-7** | 指标 | auto_run 次数、丢弃、debounce 合并率 |

当前 **不必** 为 AR-* 提前大重构；新 producer 先 `notify` 即可。

---

## 9. 反模式（二次开发常见坑）

1. 在 job finally / cron 回调里 **直接** `runtime.runTask`。  
2. Sink 里 start job 或改 `current_messages`。  
3. 新 kind 默认加入所有 `auto_run_kinds` 且全局 `auto_run: true`。  
4. 用 auto_run 模拟「假停会话等后台」——session 是真 idle；完成靠事件踢。  
5. 合成 prompt 再次 fan-out 无确认的大批 `spawn_background`。  
6. 与 `armedWorkflow` 共用路径却忘记 system_event 禁用 arm。  
7. 轮询磁盘代替 settle 钩子作为热路径（补漏扫描除外）。

---

## 10. 最小接入示例（伪代码）

```typescript
// 未来 ScheduleFire(session target) 或任意 producer
import { notifySystemEvent } from './hooks/system-event.js';

notifySystemEvent({
  kind: 'schedule_fire',           // 需先扩展 SystemEventKind + formatter
  timestamp: Date.now(),
  session_id: boundSessionId,
  event_id: `sched:${scheduleId}:${tickId}`,
  summary_line: def.taskPreview ?? def.id,
  // 可选: digest / 自定义字段
});
// hub 已由 AgentRuntime 构造时 setGlobalSystemEventHub
// auto_run 由 agent.json session_notify 控制
```

---

## 11. 文档与代码索引

| 资源 | 用途 |
|------|------|
| 本文件 | 二次开发边界与扩展清单 |
| [SPEC_JOB_SESSION_NOTIFY.md](./SPEC_JOB_SESSION_NOTIFY.md) | Job/workflow 字段、J1–J7 验收 |
| `src/hooks/system-event.ts` | Hub / format / 全局 notify |
| `src/hooks/session-inbound-queue.ts` | 入队 |
| `src/runner.ts` | `scheduleInboundDrain` / `drainInboundAutoRun` |
| `src/tui/pi/bridge-sink.ts` | TUI 展示 system_notice |
| `tests/system-event-notify.test.ts` | 回归 |

---

## 12. 版本

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-17 | v0.1 | 占位：边界、Producer 清单、Schedule/Inbound 约定、反模式、AR 演进 |

---

*实现冲突时：以「Bridge 只出站、auto_run 只经 hub 入队、idle 才 drain」为准；本文件描述扩展约定，不替代 Job 专项 spec 的字段细节。*
