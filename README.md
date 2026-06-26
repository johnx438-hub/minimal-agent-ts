# minimal-agent-ts

用 TypeScript 写的**最简 ReAct Agent**，用来学习 Agent 核心循环（不依赖 pi / rig / scream / zerostack）。

## 核心结构

```
src/
  types.ts    # Message / ToolCall 类型
  llm.ts      # 一次 chat/completions 调用
  tools.ts    # 3 个工具 + executeTool()
  agent.ts    # ReAct while 循环（核心）
  main.ts     # CLI 入口
```

### ReAct 循环（`agent.ts`）

```
turn 1..N:
  1. messages → LLM（Reason + 可能 Act）
  2. 若有 tool_calls → 执行工具 → 结果以 role=tool 塞回 messages（Observe）
  3. 若无 tool_calls 且有文本 → 返回最终答案
  4. 若空响应 → 注入 "Please continue" 再试
```

对应 scream 的 `runTurn` / zerostack 的 `spawn_agent` + rig，这里**全部手写**，方便对照阅读。

## 快速开始

```bash
cd /home/archer/zerostack-analysis/minimal-agent-ts
npm install

# 使用 Gemini API（默认）
export OPENAI_API_KEY="your-gemini-key"

# 只读任务（默认关闭 run_shell）
npm start -- "列出当前目录有哪些文件，读 README 如果有的话，用一句话总结"

# 允许执行 shell（慎用）
ALLOW_SHELL=1 npm start -- "运行 npm run typecheck 并汇报结果"

# 指定工作目录
npm start -- --cwd /home/archer/zerostack-analysis/zerostack "用一句话说明这个项目是做什么的"

# 续接之前的会话
npm start -- --resume session_20260627203000 "继续上次的工作"
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | — | API Key（Gemini/OpenAI 兼容） |
| `OPENAI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini OpenAI 兼容端点 |
| `MODEL` | `gemini-2.0-flash` | 模型名 |
| `MAX_TURNS` | `10` | 最大 ReAct 轮数 |
| `ALLOW_SHELL` | `0` | 设为 `1` 才启用 `run_shell` |
| `MAX_CONTEXT_TOKENS` | — | 手动覆盖模型上下文上限（如 262000） |

## 建议学习顺序

1. 先读 `src/agent.ts`（~80 行）— 理解循环
2. 再读 `src/tools.ts` — 工具如何注册与执行
3. 再读 `src/llm.ts` — API 请求长什么样
4. 对照 `../SCREAM_VS_ZEROSTACK.md` 里 scream 的 `run-turn.ts`

## 下一步（可选练习）

- [ ] 加 `permission`：写文件前 `readline` 问用户
- [ ] 加 `session.json` 持久化 messages
- [ ] 把同样逻辑移植到 Rust（第二版）