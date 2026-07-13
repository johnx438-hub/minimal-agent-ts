# minimal-agent-ts TUI 美化 Spec（v0.1 草案）

> **版本**: 2026-07-13  
> **定位**: 在 **不改 ReAct / pointerize / compression / 事件 schema** 的前提下，提升 pi-tui 主对话区的可读性与层次感。  
> **依据**: 长 run 截图观感 + `src/tui/pi/*` 现状；总路线图见 [docs/ROADMAP.md](./docs/ROADMAP.md)。  
> **基线 TUI**: [SPEC_TUI.md](./SPEC_TUI.md)（能力与 slash）；本文只覆盖 **呈现层 polish**。  
> **原则**: 默认安静、verbose 可开；小步 PR；与 MessageBridge（人类消息流）正交——bridge 可后接气泡 sink，本 spec 不依赖它。

---

## 1. 非目标

| 不做 | 原因 |
|------|------|
| 改 `agent.ts` 主循环、pointer 卡片文本、`compression` 五字段 | 内核 / 事件 ABI 稳定 |
| GUI / Web / Electron | 仍属终端 |
| Workflow 分栏 / 流程图 | SPEC_TUI 非目标 |
| 强制整屏主题引擎（完整 skin pack） | 成本高；先统一语义色与密度 |
| 依赖 MessageBridge 才能美化 | TUI 继续订 `RuntimeEvent` |
| 花哨 onboarding / 动画堆砌 | 与项目「实验诚实」定位不符 |

---

## 2. 问题陈述（现状）

长 run 截图中常见：

1. **用户原话几乎无独立视觉块** — 时间线从 `▶ task start` 与 tool 日志开始，对话轴弱。  
2. **meta 过密** — 每 turn `[turn N] LLM`、`action_flush`、重复 shell 路径，dim 一片，难扫读。  
3. **语义色不足** — 成功 / 失败 / user / meta 对比度接近，traceback 不够醒目。  
4. **长 stdout 冲断对话** — 失败 shell 全量输出；命令行 cwd 重复冗长。  
5. **run header 多行 dim 日志感** — session / cwd / Agent.md / llm 各占一行。  
6. **底栏弱** — 状态多靠临时 `printStatus` 行，输入区「落地感」不足。

代码锚点（实现时优先改这些，勿扩散）：

| 区域 | 路径 |
|------|------|
| 事件 → 渲染 | `src/tui/pi/event-presenter.ts` |
| 工具展示 | `src/tui/pi/tool-presenter.ts`、`tool-compact.ts`、`shell-display.ts` |
| 主题 | `src/tui/pi/themes.ts` |
| Chat 插入 | `src/tui/pi/chat-log.ts` |
| 启动 / 状态 / 提交 | `src/tui/pi-app.ts` |
| 持久偏好 | `src/tui/prefs.ts`（扩展字段） |

---

## 3. 设计原则

```text
四层视觉（从上到下对比度递增意图）:

  meta / turn / io     → dim，默认可折叠
  tool 轨迹            → 一行摘要；失败加色；长输出限高
  user                 → 明确区块（bold / 前缀）
  assistant final      → markdown 正文（已有，保持）
```

| 原则 | 说明 |
|------|------|
| **Presenter only** | 只动 TUI 渲染；`RuntimeEvent` 字段与发射点不变 |
| **Default quiet** | 默认 compact；`verbose_turns` / `verbose_io` 还原今日详细度 |
| **Fail loud** | 失败 tool / run error 始终可见，不因 compact 隐藏 |
| **Palette tokens** | 颜色集中在 `themes.ts`，禁止各文件散落 `chalk.xxx` 新语义 |
| **Prefs 可选** | 新开关写入 `.tui-prefs.json`，缺省安全 |

---

## 4. 视觉与文案约定

### 4.1 语义色（token 表）

在 `themes.ts` 增加命名 styler（名称可微调，语义固定）：

| Token | 用途 | 建议表现 |
|-------|------|----------|
| `userLine` | 用户提交的 task | bold 或 bold + 非 dim |
| `metaLine` | turn / run_start 细节 / flush | dim |
| `toolOk` | 成功 tool 摘要 | dim green 或 green |
| `toolErr` | 失败 tool / traceback 首行 | red 或 yellow |
| `toolRunning` | shell loader | cyan（已有） |
| `statusOk` | `✓ run completed` | green |
| `statusErr` | `✗ run error` / abort | red |
| `accent` | compression 📦、并行 ⚡ | cyan |
| `md.*` | markdown | 保持现有 `piMarkdownTheme` |

Overlay 继续用 `piOverlayBgHex`；**主 chat 不强制整屏背景**，只统一前景语义。

### 4.2 文案前缀（稳定、可测）

| 角色 | 默认前缀 / 形态 |
|------|-----------------|
| User | `you › ` + 原文（多行时首行前缀，后续缩进对齐） |
| Run header | `▶ run · <session_short> · <model> · …` 单行 |
| Turn（verbose） | `[turn N]` |
| Tool breadcrumb | 保持 `← read:` / `← shell:` 等现有 `tool-compact` 动词 |
| Compression | 保持 `📦 …`（`formatCompressionSummary`） |
| Run end | `✓ run completed` / `⊗ run aborted` / `✗ run error:` |

### 4.3 截断与限高

| 对象 | 默认 | verbose / 展开 |
|------|------|----------------|
| User 展示 | 全文（通常短）；> 20 行可折叠 | 全文 |
| Shell 命令展示 | 单行 100 字；省略重复 cwd 前缀 | 全命令 |
| Shell 成功 stdout | 已有 fold；保持 | 全量 |
| Shell 失败 stdout | **最多 40 行** + `… +N lines` | 全量或 `/log` |
| Tool breadcrumb 路径 | 72 字（现有 clip） | — |
| `action_flush` | 见 §5.2 | 每条都显示 |

---

## 5. 功能分期（TUI-A … TUI-E）

推荐顺序；每期 **一个 PR**，`npm test` 全绿，可独立回滚。

```text
TUI-A  user 样式 + run header 压缩
  ↓
TUI-B  turn / io 默认降噪 + prefs
  ↓
TUI-C  语义色接入 meta / tool / run end
  ↓
TUI-D  shell / 失败输出限高与折叠增强
  ↓
TUI-E  底栏 status 常驻 + 输入 hint
```

### 5.1 TUI-A — 用户消息 + Run header

**目标**: 对话轴出现「人」；开跑信息不刷屏。

| 交付 | 说明 |
|------|------|
| `PiChatLog.appendUserMessage(text)` | 用 `userLine` 样式；提交 task 时调用（非 slash） |
| `beginRun` 单行 header | 例：`▶ run · session_…4003 · deepseek-v4-pro` |
| 次要字段 | `cwd` / `Agent.md` / `memory` / 完整 llm 行：默认 **省略** 或 `verbose_run_header` 时多行 |

**验收**:

1. 发送普通 task 后，scrollback 中可一眼找到 user 行。  
2. 默认 run 开头 meta ≤ 2 行（header + 可选 warning）。  
3. headless / `--json-events` 行为不变。

### 5.2 TUI-B — Turn / IO 降噪

**目标**: 长 session 以 tool + final 为主轴，meta 退居次要。

| 事件 | 默认 compact | `verbose_turns` / `verbose_io` |
|------|--------------|-------------------------------|
| `turn_start` | **不**刷 `[turn N] LLM`；可选写入底栏 `turn:N` | 恢复逐 turn 行 |
| `turn_io` / `action_flush` | 仅当 `pending>0` 或 `flush_ms ≥ 阈值` 或失败相关 | 每条显示 |
| `tool_plan` / `tool_batch` | 保持现阈值（≥2 / parallel>1） | 同左 |

**Prefs 扩展**（`TuiPrefs`）:

```ts
/** Show [turn N] lines (default false). */
verbose_turns?: boolean;
/** Show every action_flush / turn_io when metrics on (default false). */
verbose_io?: boolean;
/** Multi-line run_start details (default false). */
verbose_run_header?: boolean;
```

环境变量可选覆盖（实现时二选一，文档写清）：

- `TUI_VERBOSE=1` → 上述 verbose 全开（调试用）

**验收**:

1. 默认 10+ turn 纯 tool run：scrollback 中无连续 `[turn N] LLM` 墙。  
2. `verbose_turns: true` 时与当前行为等价（允许小文案差）。  
3. 压缩 / loop_guard / 失败 **始终** 显示。

### 5.3 TUI-C — 语义色

**目标**: ok / err / user / meta 可扫读。

| 交付 | 说明 |
|------|------|
| `themes.ts` token 表 | §4.1 |
| `appendRunMeta` / breadcrumb / run end | 按成功失败选 styler |
| 失败 tool | 首行 `toolErr`；不改 output 原文 |

**验收**:

1. 人为制造 `error:` tool 结果：首行非 dim 灰。  
2. user 行与 meta 行在默认主题下可区分。  
3. 单测：纯函数 format 快照或 styler 非 identity（不强绑具体 ANSI 码，可测「调用了 err styler」若注入 theme）。

### 5.4 TUI-D — Tool 输出卡片化

**目标**: 长 stdout 不淹没 final answer。

| 交付 | 说明 |
|------|------|
| 失败 shell 限高 | §4.3；尾部提示 `… +N lines` |
| 命令行压缩 | 去掉与 `cwd` 相同的绝对路径前缀（能匹配时） |
| 成功 shell | 保持现有 fold；可选隐藏重复 call 行仅留 summary |
| 与 overlay | 超长块可复用 `paginated-text-overlay`（按需，非必须） |

**验收**:

1. 故意 `run_shell` 打印 80 行：默认 UI ≤ 约 40 行正文 + 截断提示。  
2. 成功短 shell：仍一行摘要级噪音。  
3. `verbose` 或显式展开策略下可看全文（实现选：prefs `verbose_tools` 或结果行快捷键——v0.1 用 prefs 即可）。

### 5.5 TUI-E — 底栏与输入区

**目标**: 状态常驻、输入区有边界感。

| 交付 | 说明 |
|------|------|
| 状态行策略 | 避免每次 `printStatus` 都往 chat **追加**永久行；优先 **原地更新** 单行 Text 组件（若 pi-tui 难做，则节流：状态变化才追加） |
| 内容 | `session · model · shell/web · jobs:N · turn:N · [io] · Σm · Σs · ctx:prompt[/limit]` |
| Token 分项 | **Σm** = 主 Agent billed 累计；**Σs** = spawn 子 Agent billed（无 spawn 时省略）；**ctx** = 主 Agent 最近一次 `prompt_tokens`/limit；换 session 清零 |
| 输入 hint | Editor 上方或 banner 末行：`Enter send · Esc abort · / commands` |
| Editor 边框 | `piEditorTheme.borderColor` 略强于纯 dim（仍克制） |

**验收**:

1. 连续 `/status` 或 run 中状态变化不产生「status 刷屏墙」。  
2. 新用户看到 hint 知道如何 abort / slash。  
3. 无运行时不强制闪烁 spinner。

---

## 6. Prefs 与配置

### 6.1 扩展 `TuiPrefs`

```ts
export interface TuiPrefs {
  // 已有
  allowShell: boolean;
  allowWeb: boolean;
  alwaysShell?: boolean;
  alwaysWeb?: boolean;
  // 本 spec
  verbose_turns?: boolean;      // default false
  verbose_io?: boolean;         // default false
  verbose_run_header?: boolean; // default false
  verbose_tools?: boolean;      // default false — full shell bodies
}
```

- 读写路径不变：项目 `.tui-prefs.json` / 全局 `~/.config/minimal-agent-ts/tui-prefs.json`。  
- 缺字段 = compact 默认。  
- 可选 slash：`/verbose on|off|turns|io`（v0.1 可只做 prefs 文件 + 文档，slash 为 plus）。

### 6.2 与 `ACTION_IO_METRICS`

| `ACTION_IO_METRICS` | `verbose_io` | 表现 |
|---------------------|--------------|------|
| 未设 | — | 不显示 turn_io / flush |
| `1` | false | 仅「有意义」的 flush（§5.2） |
| `1` | true | 每条指标（接近现网） |

---

## 7. 与 MessageBridge / 事件层关系

```text
RuntimeEvent  ──►  PiEventPresenter  ──►  屏幕（本 spec）
MessageBridge ──►  可选 future sink  ──►  IM / 气泡（非本 spec 必做）
```

- 本 spec **不**要求 TUI 订阅 MessageBridge。  
- 若未来做气泡 UI：user/assistant/tool 对齐 `SessionMessage.role`，可复用 §4 色板。  
- **禁止**为美化新增 AgentStepEvent 类型；需要展示字段时用现有 event。

---

## 8. 测试策略

| 类型 | 内容 |
|------|------|
| 单元 | `tool-compact` / shell 截断 / header 格式化纯函数 |
| 单元 | prefs 缺省与 merge |
| 回归 | 现有 `pi-*-display`、`slash`、`select-overlay` 全绿 |
| 手工 | 对照「长 shell + 多 turn + final markdown」截图场景 checklist |

不强制对 ANSI 序列做脆弱快照；优先测 **字符串结构**（前缀、截断标记、行数上限）。

---

## 9. 验收总表（v0.1 完成定义）

1. **TUI-A～E** 均已合入或明确砍 scope 并记入本文版本记录。  
2. 默认 prefs 下：user 可见、run header 短、无 turn 墙、失败仍醒目。  
3. `verbose_*` 可恢复接近现网详细度。  
4. `npm test` / `npm run typecheck` 全绿。  
5. headless `npm start` 与 `--json-events` 消费者无破坏性变更。  
6. 未引入新运行时依赖（继续 chalk + pi-tui）。

---

## 10. 明确延后（v0.2+）

- 点击 / 键位展开单条 tool（需 pi-tui 交互能力评估）  
- MessageBridge → TUI 双通道气泡  
- 完整 Catppuccin 皮肤包（chat 背景 + 语法高亮）  
- `/theme` 热切换  
- 多会话分屏  

---

## 11. 文档与索引

| 文档 | 关系 |
|------|------|
| [SPEC_TUI.md](./SPEC_TUI.md) | 能力、slash、状态机；本 spec 为呈现层补篇 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 产品轨 M-Prod 已完成；polish 可记「按需 / 体验」 |
| [README.md](./README.md) | 不写细节；需要时一句链到本文 |

实现 PR 描述建议标题：`feat(tui): polish A/B/…` 并勾选本节验收项。

---

## 12. 版本记录

| 日期 | 说明 |
|------|------|
| 2026-07-13 | 初版：TUI-A～E、prefs、语义色、与 MB 正交边界 |
| 2026-07-13 | **实现落地**：TUI-A～E 合入 `src/tui/pi/*` + `prefs.ts`；默认 compact；`TUI_VERBOSE=1` / prefs `verbose_*` |

---

*冲突时：事件与内核以 `RuntimeEvent` / 既有 SPEC 为准；呈现以本文 compact 默认为准。*
