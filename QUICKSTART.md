# minimal-agent-ts 快速上手

> 5 分钟跑起来。详细设计见 `SPEC_CONTEXT_MANAGEMENT.md`，代码导读见 `README.md`。

## 环境要求

- **Node.js ≥ 22**
- OpenAI 兼容 API Key（默认 Gemini）

## 1. 安装

```bash
cd minimal-agent-ts
npm install
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY
```

## 2. 第一次运行

```bash
npm start -- "列出当前目录文件，读 README，用一句话总结"
```

终端会打印：model、cwd、session_id、每轮 tool 调用与流式输出。

## 3. 常用命令

| 场景 | 命令 |
|------|------|
| 指定项目目录 | `npm start -- --cwd /path/to/project "任务"` |
| 续接会话 | `npm start -- --resume <session_id> "继续"` |
| 允许 shell | `npm start -- --allow-shell "npm run typecheck"` |
| 长命令 shell | Agent 可对 `run_shell` 传 `auto_extend: true`、`timeout_ms`、`max_timeout_ms` |
| 加载 Skill | `npm start -- --load-skills context-design "任务"` |
| 查看工具列表 | `npm start -- --list-tools` |
| 关闭流式 | `STREAM=0 npm start -- "任务"` |

`session_id` 在每次启动时打印，会话文件在本地 `.sessions/`（**不会进 git**）。

## 4. 配置 `agent.json`

```json
{
  "builtin_tools": ["read_file", "grep_search", "recall_query", "run_shell", ...],
  "pointerize_policy": { "keep_inline_turns": 2 },
  "recall_policy": { "auto_full_max_chars": 24000 },
  "mcp_servers": []
}
```

- **工具开关**：`builtin_tools` 列表；`run_shell` 还需 `--allow-shell`
- **大输出**：最近 2 turn 工具结果保持完整；更早的变 `[action:…]` 卡片（含 smart 摘要：shell/grep/read/mcp）
- **捞回历史**：`recall_query(action_id=…)`，≤24KB 默认返回全文
- **MCP**：参考 `agent.mcp.example.json`，工具名形如 `mcp_<server>_<tool>`

## 5. 推荐试手任务

```bash
# 只读探索
npm start -- --cwd . "grep 一下 agent.ts 里 loop 相关逻辑，总结 ReAct 循环"

# 带 shell
npm start -- --allow-shell "运行 npm run typecheck，有错误就概括"

# 续接（把上次的 session_id 换掉）
npm start -- --resume session_20260628090040 "接着查上次没看完的文件"
```

## 6. 本地数据说明

| 路径 | 内容 | 是否提交 git |
|------|------|----------------|
| `.sessions/` | 会话、冷存储、向量索引 | ❌ 已 ignore |
| `.env` | API Key | ❌ 已 ignore |
| `node_modules/` | 依赖 | ❌ 已 ignore |

换机器或分享仓库时：别人只需 `npm install` + 自己的 `.env`，`.sessions` 从零开始。

## 7. 源码阅读顺序（学习向）

1. `src/agent.ts` — ReAct 主循环
2. `src/tools/registry.ts` — 工具注册 + MCP
3. `src/pointerize.ts` + `src/recall.ts` — 大结果瘦身与捞回
4. `src/loop-guard.ts` — 循环检测与收口总结

## 8. 常见问题

**Q: 工具输出太长，后面看不到了？**  
A: 当 turn 仍完整；更早的用 `recall_query(action_id=…)`。浏览器/MCP 大结果 ≤24KB 可一次 recall 全文。

**Q: Agent 一直调工具不停？**  
A: 默认 `LOOP_GUARD=inject` 会 nudge → 强制文字总结；也可设 `MAX_TURNS=30` 硬顶。

**Q: 推 git 会泄露什么？**  
A: 确认 `.env` 和 `.sessions/` 不在仓库里；若 `.env` 曾误提交过，需清 git 历史再公开推送。