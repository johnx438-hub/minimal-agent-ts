# 给 Agent 写提示词时，我们忘了定义「失败」

> 传统 Prompt Engineering 几乎全在讲正向引导。但让模型不搞砸的方式，可能不是告诉它怎么做对，而是明确定义什么算搞砸。

---

## 一个被忽略的问题

翻遍 LangChain、CrewAI、AutoGen 的文档，关于提示词的建议高度一致：

- 给 Agent 一个角色（"你是一个资深研究员"）
- 给一个目标（"找出关于 AI Agent 的最新进展"）
- 给工具（"你可以调用 search、read_file..."）
- 给输出格式（"请用 Markdown 输出"）

很完善。但漏了一件事：

**"什么情况下你算失败了？失败的后果是什么？"**

没有人写这段。所有提示词都是正向的——告诉模型怎么往前进，不告诉它什么是悬崖。而模型在长任务中的很多退化行为（重复探索、拒绝收手、把结论塞在 chat 里不传递），根因恰恰是：**它不知道"停在这里就算搞砸了"。**

---

## minimal-agent-ts 的答案：Envelope 负反馈提示词

minimal-agent-ts 有一个专门的多 Agent 工作流系统。每个角色在启动时，收到的不是一段角色描述的 System Prompt，而是一个 **Envelope**——用显式的负反馈边界把角色的职责和能力范围框死。

以 `review-loop` 工作流中的 reviewer 角色为例，它收到的 Envelope 片段：

```
[workflow_envelope]
workflow: review-loop
step: reviewer | role: reviewer | slot: reviewer | phase: role

Duty: verify work and set a verdict (approved | needs_revision | needs_human).
Do not re-implement. Prefer needs_human over endless revision when the goal is unclear.

## What counts as success for this step
Only a clear handoff into slot `reviewer` advances the pipeline.
Exploration and edits that never become a handoff are treated as incomplete work.

## How to hand off (pick one)
1. Preferred: call workflow_handoff once with a complete, self-contained summary
   (the next role does not see this chat; reviewers: include verdict).
   Then send a short final reply and end the step.
2. Also valid: end with a single final message that is the full handoff body
   (no tool required). Downstream reads that text as this slot's output.

## Negative feedback (what hurts this step)
- Tooling with no eventual handoff burns max_turns and still fails the step.
- After the deliverable is already clear, more tool calls do not improve the
  handoff and risk turn_ceiling / early handback.
- Vague or empty endings leave the next role with nothing usable.
- A long plan in chat plus a tiny handoff.summary starves the next role
  (downstream reads the slot, not your monologue).

## If there is no usable handoff
This step fails. Control returns to the parent session (chat history preserved).
The workflow does not invent a substitute deliverable for you.
[/workflow_envelope]
```

### 这里发生了什么

| 传统 Prompt | Envelope |
|-------------|----------|
| "你是一个 reviewer" | "你是 reviewer。**你不能重新实现。**" |
| "请输出审查结果" | "只有向 reviewer 槽位完成交接才算成功。探索和编辑不交接 = 失败。" |
| 无 | "目标不清晰时，优先 needs_human，而不是无限修订。" |
| 无 | "交接完再闲聊会消耗 max_turns，不算改进。" |
| 无 | "chat 里写长方案但 summary 留空 = 下游拿不到信息 = 失败。" |

**每一条负反馈都明确了一种失败模式，并且定义了失败的后果——控制权交回主对话，工作流不会替你编造一个替代交付物。**

---

## 为什么负反馈比正反馈更关键

这是一个信息论问题。

模型"做对"的路径有无数条。你给 plancer 一个任务，它可以产出 50 种合理的计划——告诉它"要产出结构化计划"能覆盖吗？部分能，但它在实践中可能产出计划后继续动手实现（planner 越界），或者在 chat 里写完计划但 handoff 时只交了一个摘要。

但模型"做砸"的方式只有几种：

1. **越界** — 做了不属于自己角色的事（reviewer 动手改了代码）
2. **不交付** — 探索了很多，但没做 handoff
3. **信息截断** — chat 里写了很多，handoff 里几乎为空
4. **无限循环** — 永远觉得还可以优化一轮

定义了这四种失败模式的后果，模型的行为边界就变成硬约束而非软建议。

### 一个具体的负反馈链路

在实际运行中，这条链路会这样触发：

```
reviewer: 在 chat 里详细分析了代码问题（500 行分析）
          → 调用 workflow_handoff(summary="需要修改，见上文")
          → summary 只有 12 个字符
          
框架检测: summary < 160 字符 + final text > 400 字符
          + final 长度 > summary × 2.5
          → Thin-handoff 警报
          → 自动将 final text 膨胀为 summary body
          → 下游 worker 拿到的是完整分析而非 "见上文"
```

这不是提示词的功劳。这是"负反馈边界 + 框架硬检测"双层机制。提示词告诉模型不要做，框架在模型仍然做了的时候兜底。

---

## 跟传统做法的对比

### LangChain / LangGraph

角色 prompt 是自然语言描述，你可以写负反馈但不是结构化协议：

```python
# 你可以但不一定
system_prompt = "你是 reviewer。不要重新实现。"
```

平台不强制 handoff 语义，不检测 thin summary，失败模式靠开发者自觉。

### CrewAI

有 `role` + `goal` + `backstory`，没有负反馈。

```python
Agent(role="reviewer", goal="审查代码质量", backstory="资深代码审查专家")
```

没有 "什么算失败"、"失败的后果是什么"。

### Dify / Coze

可视化工作流，有判断节点。但判断的是业务数据流（"如果输出包含 ERROR 则走分支 B"），不是角色行为的失败模式（"如果 reviewer 动手改了代码"）。

### minimal-agent-ts

每个 role 的 Envelope 包含：

| 内容 | 回答问题 |
|------|----------|
| 角色 + 能力边界 | "你是谁，能干什么，不能干什么" |
| 成功定义 | "怎么做才算完成这个步骤" |
| 交付方式 | "怎么传递产出给下游" |
| 负反馈列表 | "什么事会让你搞砸，搞砸了会怎样" |
| 失败后果 | "工作流不会替你编造替代品——控制权交回人类" |

这不是提示工程的一个小技巧。这是一个**结构化的行为契约**。

---

## 这套思路不只适用于 Agent

任何将 LLM 作为系统中可替换决策组件的场景，都可以借鉴 Envelope 的负反馈结构：

1. **定义失败模式** — 不告诉模型怎么做对，告诉它什么是悬崖
2. **定义失败后果** — 不要让模型觉得"反正系统会兜底"
3. **框架做硬检测** — 提示词是软约束，代码是硬约束

---

## 下一步

minimal-agent-ts 的 workflow 系统还有更多机制值得展开：handoff 结构化解耦、verdict 三态归一化、thin-handoff 膨胀检测、6 种 handback 退出路径的全覆盖。这些会在后续文章中逐一分析。

**仓库地址**: [github.com/johnx438-hub/minimal-agent-ts](https://github.com/johnx438-hub/minimal-agent-ts)
