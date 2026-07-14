# minimal-agent-ts

TypeScript 写的轻量 Agent Harness，从长会话上下文管理实验演进而来。核心先解决长对话里的三个痛点：事件顺序不丢、历史内容可找回、上下文窗口不爆炸，再在此基础上叠加工具调用、子Agent、TUI和可观测能力。

纯手写ReAct主循环（Reason → Act → Observe），热路径做轻、冷数据存盘，不绑定任何商业Agent产品或闭源运行时。

**仓库地址**: https://github.com/johnx438-hub/minimal-agent-ts

| 文档 | 用途 |
|------|------|
| [QUICKSTART.md](./QUICKSTART.md) | 安装与常用命令 |
| [docs/DEPS.md](./docs/DEPS.md) | 必装/可选依赖说明 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 项目规划与方向 |
| [SPEC_CONTEXT_MANAGEMENT.md](./SPEC_CONTEXT_MANAGEMENT.md) | 上下文与指针化设计细节 |
| [SPEC_TOOLS.md](./SPEC_TOOLS.md) · [SPEC_TUI.md](./SPEC_TUI.md) · [SPEC_LLM_ROUTER.md](./SPEC_LLM_ROUTER.md) | 工具/TUI/多模型路由规范 |

验证命令：`npm test` · `npm run typecheck`（约600个测试用例）

---

## 设计思路

做这个项目最初的出发点很简单，就是解决多轮工具调用后的三个实际问题：

1. 上下文越聊越肿，长任务跑着跑着就爆窗口
2. 长结果被截断后，事件顺序和细节容易丢，Agent经常搞混哪个结果是哪次调用的
3. 希望整个东西跑在Node/TypeScript栈里，可测试、可改、方便分享

核心方案：

- **冷热分离**：长工具结果落地存在 `.sessions/actions/`，对话里只留固定格式的`[action:…]`指针卡片
- **按需召回**：需要看历史结果时用`recall_query`拉全文，不用的时候不占上下文
- **轮末管线**：每轮结束自动跑：指针化→剪枝→指针压缩→阈值触发时做重量级摘要，全程不碰最前面的系统提示
- 工具、子Agent、工作流、TUI都在这个基础上扩展

定位是小而稳的底座，不追求做全功能IDE替代品。

---

## 当前特性

| 模块 | 能力 |
|------|------|
| **主循环** | 流式LLM输出、并行工具调用、循环防死锁、会话断点续跑 |
| **上下文管理** | 指针卡片、异步写队列、任务摘要、token预算自动剪枝 |
| **可观测性** | TUI底栏实时显示token/会话数/上下文占比/前缀缓存命中率；支持`--json-events`输出结构化事件 |
| **内置工具** | 文件编辑、patch应用、git全套、LSP查询、Office文档读写（docx/pptx/xlsx纯Node实现）、shell/测试、网页抓取搜索、Skill/MCP扩展 |
| **子Agent** | `spawn_agent`/后台spawn/三角色代码审查，任务日志落地在`workspace/jobs/` |
| **工作流** | JSON格式工作流，支持Planner→Worker→Reviewer这类多角色编排 |
| **TUI** | 终端交互界面：会话列表管理、中英双语切换、启动LOGO、高危操作权限确认 |
| **多模型支持** | `agent.json`多Profile配置、自动降级、推理力度映射；天然适配大模型前缀缓存，稳态任务缓存命中率极高 |

---

## 快速开始

```bash
git clone https://github.com/johnx438-hub/minimal-agent-ts.git
cd minimal-agent-ts
npm install

# 1. 配置环境变量：密钥只写在.env里，绝对不要提交到git
cp .env.example .env
# 编辑.env，至少填一个可用的API Key，默认配置用DeepSeek：
# DEEPSEEK_API_KEY=sk-xxx
# 可选其他Key：OPENROUTER_API_KEY=xxx / ZAI_API_KEY=xxx / XAI_API_KEY=xxx

# 2. 启动
npm run tui                   # 推荐：启动交互式TUI
# 或者直接命令行跑单次任务：
npm start -- "读一下README，用三句话总结这个项目是做什么的"
```
