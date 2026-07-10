# minimal-agent-ts LLM Router Spec（轨 G）

> **定位**: OpenAI-compatible **传输与配置中间层**——多 API profile、子 Agent 绑模型、fallback、reasoning/extra_body 透传。与 ReAct 主循环、上下文策略 **正交**；不进 `agent.ts` 语义。  
> **参考**: [cc-connect](https://github.com/chenhg5/cc-connect) 的 `provider-presets.json` + `/provider` `/model` `/reasoning` 思路（**不**复制 IM 桥接与外部 CLI 适配器）。  
> **状态**: Draft v0.1（2026-07-10）  
> **顺序**: B（P0 填表）→ F3-c → **G1–G2** → G3 → G4 → G5（可选）

---

## 1. 非目标

| 不做 | 原因 |
|------|------|
| 飞书 / Telegram / 企业微信等 IM 桥接 | 属 cc-connect `platform/`；本仓用 TUI / `--json-events` |
| Claude Code / Codex / Cursor 等 **外部 CLI** 适配 | 本仓 **已是** Agent 运行时 |
| 同一请求多 wire 协议（`responses` vs `anthropic` vs `chat`） | v1 统一 `POST …/chat/completions`；多 wire 单开 adapter PR |
| Provider 市场、invite URL、sponsor 预设同步 | 只借鉴 **数据结构**；运营层外置 |
| 把 `minimal-agent-ts-ds-cache` 默认行为 merge 进 master | 前缀缓存实验留在 sibling fork；主线只留可选钩子 |
| 在 `llm.ts` 内硬编码每家厂商 SDK | 保持薄 `fetch` + `extra_body` 合并 |

---

## 2. 与现有文档 / 仓库的关系

```
                    ┌─────────────────────────┐
                    │   minimal-agent-ts      │
                    │   runAgent（语义不变）   │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │  轨 G：LlmRouter（本 spec） │
                    │  resolve → chat → retry   │
                    └───────────┬─────────────┘
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   agent.json            spawn / workflow        job meta.json
   api_profiles          api_profile 绑定         profile + model
```

| 仓库 / 文档 | 关系 |
|-------------|------|
| [ROADMAP.md](./ROADMAP.md) 轨 B | P0 填表后再量化 profile 切换对 turn 延迟影响 |
| [ROADMAP.md](./ROADMAP.md) 轨 F | `Agent.md` / `/memory` 注入在 **system prompt** 层，与 profile 正交 |
| [docs/BRANCH_PLAN_TUI_EXPERIENCE.md](./docs/BRANCH_PLAN_TUI_EXPERIENCE.md) §8 | M5 `api_profiles` 草案；本 spec 为其正式化 |
| `minimal-agent-ts-ds-cache` | 上下文 **组装** 缓存友好；本 spec 管 **请求路由** |
| cc-connect `provider-presets.json` | 可选 **只读导入** 为 `api_profiles`（脚本，非运行时依赖） |

---

## 3. 现状（2026-07-10）

| 项 | 当前实现 | 缺口 |
|----|----------|------|
| 主 Agent | `env` `MODEL` / `BASE_URL` / `API_KEY` → `runner.buildAgentConfig()` | 单 profile |
| LLM 调用 | `src/llm.ts` → `chat/completions` + `llm-retry.ts` | 无 `extra_body`、无 profile fallback |
| workflow role | `roles.*.model` 可选，**共用**父级 key/url | 无 `api_profile` |
| spawn / background | 继承整个 `parentConfig`（含同一 `model`） | preset 无法绑便宜模型 |
| code_review job | `meta.json` 有 preset/task；**无** profile/model 字段 | 事后难追溯用的哪套 API |
| TUI | 启动显示 `model:` 一行 | 无 `/model` `/profile` `/reasoning` |

---

## 4. 架构：LlmRouter

### 4.1 概念

- **ApiProfile**：命名的一套连接参数（base_url、鉴权、默认 model、models 列表、extra_body、fallback 链）。
- **LlmBinding**：某次运行解析出的 `{ profile, model, extra_body }`（主 Agent、spawn preset、workflow role、job 各有一份解析规则）。
- **LlmRouter**：纯函数层：`resolveLlmBinding()` → `chat()` 入参；**不**改 `ChatMessage` 语义。

### 4.2 数据流

```text
agent.json api_profiles
        +
env 回退（MODEL/BASE_URL/API_KEY）
        +
绑定（main | spawn_preset | workflow_role）
        ↓
resolveLlmBinding(name?, overrides?)
        ↓
LlmProfile { baseUrl, apiKey, model, extraBody?, label }
        ↓
llm.chat(messages, tools, { ...profile, signal, onToken })
        ↓
失败且可重试 → 同 profile 退避 →（G3）fallback_profiles 下一 profile
```

### 4.3 模块边界（拟新增 / 修改）

| 模块 | 职责 |
|------|------|
| `src/llm-profiles.ts`（新） | 加载、校验 `api_profiles`；`resolveLlmBinding`；`listModels` |
| `src/llm.ts` | `buildChatBody` 浅合并 `extra_body`；不改 stream 组装逻辑 |
| `src/llm-retry.ts` | G3：profile 级 fallback 与现有 429 退避协作 |
| `src/runner.ts` | 主 run 默认 profile；`run_start` 元数据带 `llm_profile` |
| `src/spawn/runner.ts` / `job-store.ts` | 子 Agent / job 用 preset 绑定的 profile |
| `src/workflow/load-role.ts` | role 级 `api_profile` + `model` |
| `src/plugins/types.ts` | `AgentPluginConfig.api_profiles` schema |
| `src/tui/slash.ts` | G2：`/model` `/profile`；G4：`/reasoning` |

**禁止**：在 `agent.ts` ReAct 循环内分支 profile 逻辑；解析在 `buildRunConfig` / spawn 入口 **一次** 完成。

---

## 5. 配置：`api_profiles`

### 5.1 放置位置

`agent.json` 顶层（与 `spawn_presets` 同级），示例见 [agent.mcp.example.json](./agent.mcp.example.json) 未来附录或 `agent.llm.example.json`。

环境变量 **回退**（无 `api_profiles` 或未指定绑定时）：

```text
API_KEY / BASE_URL / MODEL   → 隐式 profile "__env__"
```

### 5.2 Schema（TypeScript 草案）

```typescript
export interface ApiProfileConfig {
  /** OpenAI-compatible base，含 /v1 与否均可；代码 normalize 尾随斜杠 */
  base_url: string;
  /** 环境变量名；禁止在 json 内写明文 key */
  api_key_env: string;
  /** 未显式指定 model 时的默认 */
  default_model: string;
  /** 静态 catalog（cc-connect 同款）；供 TUI / 校验；可选 */
  models?: string[];
  /** 浅合并进 chat/completions body（G4 reasoning 主要走这里） */
  extra_body?: Record<string, unknown>;
  /** G3：按顺序尝试的 profile 名 */
  fallback_profiles?: string[];
  /** 可选显示名 */
  display_name?: string;
}

export interface AgentPluginConfig {
  // …existing…
  /** 默认主 Agent profile；缺省 "__env__" 或第一个 profile */
  default_api_profile?: string;
  api_profiles?: Record<string, ApiProfileConfig>;
}
```

### 5.3 示例

```json
{
  "default_api_profile": "openrouter-main",
  "api_profiles": {
    "openrouter-main": {
      "display_name": "OpenRouter (main)",
      "base_url": "https://openrouter.ai/api/v1",
      "api_key_env": "OPENROUTER_API_KEY",
      "default_model": "x-ai/grok-4.5",
      "models": [
        "x-ai/grok-4.5",
        "google/gemini-2.5-flash",
        "anthropic/claude-sonnet-4"
      ],
      "extra_body": {
        "provider": {
          "order": ["xAI"],
          "allow_fallbacks": true
        }
      },
      "fallback_profiles": ["gemini-flash"]
    },
    "gemini-flash": {
      "display_name": "Gemini Flash (cheap)",
      "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
      "api_key_env": "GOOGLE_API_KEY",
      "default_model": "gemini-2.0-flash",
      "models": ["gemini-2.0-flash", "gemini-2.5-flash"]
    },
    "review-local": {
      "display_name": "Local review",
      "base_url": "http://127.0.0.1:11434/v1",
      "api_key_env": "OLLAMA_API_KEY",
      "default_model": "qwen2.5-coder:7b",
      "models": ["qwen2.5-coder:7b"]
    }
  },
  "spawn_presets": [
    {
      "name": "code-review-bug",
      "api_profile": "gemini-flash",
      "model": "gemini-2.0-flash",
      "prompt_file": "agents/code-review-bug.md",
      "tools": ["read_file", "grep_search", "write_file"],
      "max_turns": 12
    }
  ]
}
```

### 5.4 解析优先级（单字段 `model`）

对某次 LLM 调用，model 字符串解析顺序：

1. 绑定覆盖：`spawn_presets[].model` / `workflow.roles.*.model` / TUI `/model switch` 会话覆盖（G2）
2. profile.`default_model`
3. env `MODEL`
4. 解析失败 → 启动时报错，不 silent fallback 到空 model

`api_key`：**仅** `process.env[api_key_env]`；缺失时该 profile 标记为 unavailable，fallback 链继续（G3）。

---

## 6. 绑定表

| 消费方 | 配置键 | 默认 profile | 写入可追溯元数据 |
|--------|--------|--------------|------------------|
| 主 Agent | `default_api_profile` 或 `__env__` | `default_api_profile` | `run_start.llm` |
| `spawn_agent` / `spawn_background` | `spawn_presets[].api_profile` | 继承主 Agent | spawn action / job `meta.json` |
| `code_review` 后台 job | 同 preset 的 `api_profile` | 同左 | `workspace/jobs/<id>/meta.json` |
| workflow role | `workflow.roles.<name>.api_profile`（新增） | 继承主 Agent | `workflow_step` event（可选） |
| workflow role model | `roles.*.model` 覆盖 profile 默认 | — | 同上 |

### 6.1 `AgentConfig` 扩展（草案）

```typescript
export interface LlmProfile {
  /** 逻辑名，如 openrouter-main / __env__ */
  profileName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraBody?: Record<string, unknown>;
}

export interface AgentConfig {
  // …existing…
  /** 已解析的 LLM 连接；替代散落的 apiKey/baseUrl/model 三元组（可保留兼容字段至 G1 完成） */
  llm?: LlmProfile;
}
```

`buildRunConfig()` 在每次 `run_start` 前解析一次；`workspacePrompt` 与 `llm` 并列注入，保证 `run_start` 与首条 system 一致。

### 6.2 Job `meta.json` 扩展（G2）

```json
{
  "preset": "code-review-bug",
  "api_profile": "gemini-flash",
  "model": "gemini-2.0-flash",
  "llm_base_url": "https://…"
}
```

不写入 `api_key`。`llm_base_url` 便于用户核对，非 secret。

---

## 7. `extra_body` 与 reasoning / effort（G4）

### 7.1 合并规则

```typescript
function buildChatBody(model, messages, tools, stream, extraBody?) {
  const body = { model, messages, stream, tools, tool_choice };
  if (extraBody) Object.assign(body, extraBody); // 浅合并；用户键覆盖默认
  return body;
}
```

TUI `/reasoning <level>` 不直接改厂商字段，而是更新 **会话级** `reasoning_patch`，合并进 `extra_body` 后再请求。

### 7.2 厂商映射表（v1 文档化，按 profile 配置）

| 生态 / 中转 | 典型字段 | 示例值 | 备注 |
|-------------|----------|--------|------|
| OpenAI o-series / Codex 系 | `reasoning_effort` | `low` / `medium` / `high` | 写在 profile 或 `/reasoning` 映射 |
| Anthropic（含 OR Anthropic route） | `thinking` / `budget_tokens` | 依 API 版本 | 中转需走 Anthropic 兼容 path 时由 **上游** 保证；本仓 v1 只透传 |
| xAI / Grok（OpenRouter 或直连） | 透传 OpenAI 兼容字段 | 依 xAI 文档 | 已有 tool args 严格校验教训 → **勿**改写字段名 |
| Gemini OpenAI 兼容 | `thinkingConfig` 等 | 依 Google 文档 | 同上，profile 级配置 |
| OpenRouter 路由 | `provider.order` / `allow_fallbacks` | 见 zerostack / cc-connect | 与 profile fallback **不同层** |

`/reasoning` 实现建议：

```text
/reasoning        → 显示当前 level + 生效的 extra_body 片段
/reasoning medium → 设置 session override → 映射到 profile 的 reasoning_map
```

`reasoning_map` 可选挂在 profile 上：

```json
"reasoning_map": {
  "low":    { "reasoning_effort": "low" },
  "medium": { "reasoning_effort": "medium" },
  "high":   { "reasoning_effort": "high" }
}
```

未配置 `reasoning_map` 的 profile：`/reasoning` 返回「该 profile 不支持」。

---

## 8. Fallback（G3）

### 8.1 两层 fallback（勿混）

| 层 | 机制 | 配置位置 |
|----|------|----------|
| **应用 profile 链** | A 失败 → 试 `fallback_profiles[]` 中的 B | `api_profiles.A.fallback_profiles` |
| **OpenRouter 路由** | 单请求内 vendor 排序 | `extra_body.provider` |
| **HTTP 退避** | 同 profile 429 retry-after | 现有 `llm-retry.ts` |

G3 只实现 **应用 profile 链** + 与 429 退避的协作顺序：

```text
同 profile 可重试错误 → 退避重试（现有）
同 profile 耗尽 → 下一个 fallback profile（新）
全部耗尽 → 向上抛 LlmHttpError
```

### 8.2 不宜 fallback 的场景

- 流式已输出 token 后（现有 `isRetriableLlmError` 已禁止）→ **不**切 profile
- 用户显式 `--model` 覆盖且 `FALLBACK=0` → 不自动切（env 开关）

---

## 9. 模型列表（G2）

### 9.1 静态 catalog

profile.`models[]` 与 cc-connect preset 一致，用于：

- TUI `/model` 补全
- `spawn_presets[].model` 启动校验（warn 不在列表中，不 hard fail）

### 9.2 动态刷新（可选）

```http
GET {base_url}/models
Authorization: Bearer {api_key}
```

实现参考 zerostack `list_models_manual`：

- 成功 → 缓存 10 分钟（内存，按 profile 名）
- 失败 → 回退静态 `models[]`

不在 v1 阻塞 G1。

---

## 10. 实施分期与验收

### G1 — `api_profiles` + 绑定（P1，1–2 天）

| 任务 | 说明 |
|------|------|
| G1-a | `llm-profiles.ts`：加载、校验、`resolveLlmBinding` |
| G1-b | `AgentConfig.llm`；`runner.buildRunConfig` / spawn / workflow 注入 |
| G1-c | `spawn_presets[].api_profile` + 可选 `model` |
| G1-d | `workflow.roles.*.api_profile`（`load-role.ts`） |
| G1-e | 单测：解析、env 回退、缺 key 报错 |

**验收**

- [ ] 主 Agent 与 `code-review-bug` 后台 job 可使用 **不同** profile
- [ ] 无 `api_profiles` 时行为与现网一致（`__env__`）
- [ ] `npm test` 全绿；headless / TUI 主路径不变

### G2 — 可观测 + TUI（P1，~1 天）

| 任务 | 说明 |
|------|------|
| G2-a | `run_start` 增加 `llm: { profile, model, base_url_host }` |
| G2-b | job `meta.json` 写入 `api_profile` + `model` |
| G2-c | TUI `/profile` `/model`（list + switch，会话级覆盖） |
| G2-d | 可选 `GET /models` |

**验收**

- [ ] 三个并行 `code_review` job 的 meta 可区分 profile/model
- [ ] `/model switch` 只影响当前 session 后续 turn，不写 `agent.json`

### G3 — Fallback 链（P2，~1 天）

**验收**

- [ ] 主 profile 401/429 耗尽后自动试 `fallback_profiles`
- [ ] 流式 partial 后不切换 profile
- [ ] 事件 `llm_fallback` 写入 `--json-events`（可选）

### G4 — Reasoning / extra_body（P2，1–2 天）

**验收**

- [ ] `/reasoning high` 改变请求 body 且可 `/reasoning` 查看当前值
- [ ] 至少一家厂商（建议 OpenAI-compatible `reasoning_effort`）E2E 可测

### G5 — 缓存钩子（P3，可选）

| 选项 | 说明 |
|------|------|
| A | `llm.cache_policy: "prefix_stable"` 仅文档化，实现仍在 ds-cache fork |
| B | `assembleApiMessages` 可选 `cache_control` 断点（Claude/OR Anthropic route） |

**验收**

- [ ] master 默认行为不变；钩子默认 off

---

## 11. cc-connect 预设导入（可选工具）

非运行时依赖。维护脚本 `scripts/import-cc-connect-profiles.ts`（未来 PR）：

```text
cc-connect provider-presets.json
  → 过滤 agents.opencode（或固定 agent 槽）
  → 生成 api_profiles 片段（base_url + models + default_model）
  → 用户手工合并 api_key_env
```

**不**自动拉取 cc-connect 更新；**不**打包 invite URL。

---

## 12. 安全与运维

- API key **只**来自环境变量或本地 secret 文件（未来）；`agent.json` 进 git 时不得含 key。
- 日志 / `meta.json` / `--json-events`：**禁止**记录完整 apiKey；`base_url` 可记录 host。
- Profile 切换不改变 `cwd`、权限门、`allowShell` / `allowWeb`（继承父 `AgentConfig`）。
- 子 Agent `spawnDepth` 限制不变；profile 不得绕过 `toolAllowlist`。

---

## 13. 测试策略

| 层 | 内容 |
|----|------|
| 单元 | `resolveLlmBinding`、extra_body 合并、fallback 顺序、env 回退 |
| 集成 | mock `fetch`：profile A 失败 → B 成功 |
| 回归 | 无 `api_profiles` 的 `agent.json` 与现网 snapshot 一致 |
| 不测 | 真实各家厂商 reasoning 效果；仅测 body 含预期字段 |

---

## 14. 版本

| 日期 | 说明 |
|------|------|
| 2026-07-10 | v0.1 初稿：轨 G 范围、schema、绑定、cc-connect 对齐、G1–G5 验收 |

---

## 15. 明确不做（本 spec 范围外）

- 在线热重载 `api_profiles`（需重启或 `/reload` 显式，与 ROADMAP F-1 可选项一致）
- 按 token 计费 UI / 账单对账
- 替换 OpenRouter / 自建网关
- 用 LlmRouter 改 context prune / pointerize 规则