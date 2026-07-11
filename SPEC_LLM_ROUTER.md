# minimal-agent-ts LLM Router Spec（轨 G）

> **定位**: OpenAI-compatible **传输与配置中间层**——多 API profile、子 Agent 绑模型、fallback、reasoning/extra_body 透传、**主流厂商隐式缓存观测**。与 ReAct 主循环、上下文策略 **正交**；目标是将本仓逐步打磨为 **开箱即用的 Agent 底座**。  
> **参考**: [cc-connect](https://github.com/chenhg5/cc-connect) 的 `provider-presets.json` + `/provider` `/model` `/reasoning` 思路（**不**复制 IM 桥接与外部 CLI 适配器）。  
> **状态**: Draft v0.3（2026-07-11）；总路线图见 **[docs/ROADMAP.md](./docs/ROADMAP.md)**  
> **顺序**: **G1 + G1-cache** → G2 → G3 → G4（✅）→ **G5（Anthropic 显式缓存，最后）**

---

## 1. 非目标

| 不做 | 原因 |
|------|------|
| 飞书 / Telegram / 企业微信等 IM 桥接 | 属 cc-connect `platform/`；本仓用 TUI / `--json-events` |
| Claude Code / Codex / Cursor 等 **外部 CLI** 适配 | 本仓 **已是** Agent 运行时 |
| 同一请求多 wire 协议（`responses` vs `anthropic` vs `chat`） | v1 统一 `POST …/chat/completions`；DeepSeek Anthropic wire、xAI `/responses` 单开 adapter PR |
| Provider 市场、invite URL、sponsor 预设同步 | 只借鉴 **数据结构**；运营层外置 |
| 把 `minimal-agent-ts-ds-cache` 默认行为 merge 进 master | 前缀缓存实验留在 sibling fork；主线只做 **隐式缓存 + 可选观测** |
| 在 `llm.ts` 内硬编码每家厂商 SDK | 保持薄 `fetch` + `extra_body` 合并 |
| 为严苛 cache 命中改 pointerize / prune | 开箱底座保持 OpenCode 式上下文；缓存 **best-effort** |

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
                    │  resolve → cache → chat   │
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
| `minimal-agent-ts-ds-cache` | 上下文 **组装** 缓存友好（冻结指针）；本 spec 管 **请求路由 + 隐式缓存观测** |
| cc-connect `provider-presets.json` | 可选 **只读导入** 为 `api_profiles`（脚本，非运行时依赖） |

---

## 3. 现状（2026-07-10）

| 项 | 当前实现 | 缺口 |
|----|----------|------|
| 主 Agent | `env` `MODEL` / `BASE_URL` / `API_KEY` → `runner.buildAgentConfig()` | 单 profile |
| LLM 调用 | `src/llm.ts` → `chat/completions` + `llm-retry.ts` | 无 `extra_body`、无 profile fallback、无 cache usage 解析 |
| workflow role | `roles.*.model` 可选，**共用**父级 key/url | 无 `api_profile` |
| spawn / background | 继承整个 `parentConfig`（含同一 `model`） | preset 无法绑便宜模型 |
| code_review job | `meta.json` 有 preset/task；**无** profile/model 字段 | 事后难追溯用的哪套 API |
| TUI | 启动显示 `model:` 一行 | 无 `/model` `/profile` `/reasoning` |

---

## 4. 厂商生态调研、优先级与难度

> **产品优先级**（开箱底座）：**DeepSeek、GLM（智谱）** 为主力国模 → **xAI 直连 + OpenRouter 中转** 覆盖个人测试 → **Anthropic 显式缓存最后**。

### 4.1 Wire 类型（v1 仅一类实现）

| `wire` | 端点 | 主力厂商 | v1 实现 |
|--------|------|----------|---------|
| `openai_chat`（默认） | `POST {base}/chat/completions` | DeepSeek、GLM、xAI、OpenRouter、多数国模 | ✅ 唯一必做 |
| `openai_responses` | `POST {base}/responses` | xAI（可选）、OpenAI 新栈 | ❌ 未来 PR |
| `anthropic_messages` | `POST {base}/v1/messages` 或 DS `/anthropic` | Anthropic、DeepSeek 备选 wire | ❌ G5 再评估 |

**结论**：v1 全部走 `openai_chat` 即可覆盖目标厂商；不必为 DeepSeek 单独开 Anthropic wire。

### 4.2 缓存机制分档

| 档位 | 机制 | 代表厂商 | 客户端要做什么 | 改 messages？ |
|------|------|----------|----------------|---------------|
| **A 隐式自动** | 前缀/KV 自动识别，零配置 | **DeepSeek**、**GLM**、xAI、OpenRouter 透传上游 | 解析 `usage` 缓存字段；可选 `session_id` / `prompt_cache_key` | **否** |
| **B 中转粘性** | 聚合层 sticky routing | **OpenRouter** | profile `extra_body.session_id` 或 header `x-session-id` | **否** |
| **C 显式断点** | `cache_control` 标块 | Anthropic、OR 上 Qwen/Gemini 路由 | `applyCacheAdapter` 改出站消息结构 | **是**（G5） |
| **D 独立 Cache API** | 预创建 cache id | Gemini `cachedContents` | 另开资源生命周期 | **是**（不做） |

**底座策略**：默认 **档位 A**；不为档位 C 改 pointerize。`minimal-agent-ts-ds-cache` 的「冻结指针」属于上下文层档位 D+，不进 master。

### 4.3 主力厂商 API 要点

#### DeepSeek（P0，难度：低）

| 项 | 说明 |
|----|------|
| Base URL | `https://api.deepseek.com`（`…/v1` 可选，代码 normalize） |
| Wire | OpenAI `chat/completions`；另提供 `/anthropic`（v1 不用） |
| 缓存 | **默认开启** 磁盘 KV cache；无需请求字段 |
| Usage 字段 | `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`（**非** OpenAI 标准名） |
| Reasoning | `thinking: { type: "enabled" }` + `reasoning_effort`（v4 系） |
| 风险 | tool args 须合法 JSON（本仓已修）；`deepseek-chat` 2026-07 弃用 → 用 `deepseek-v4-flash` / `deepseek-v4-pro` |

#### GLM / 智谱（P0，难度：低）

| 项 | 说明 |
|----|------|
| Base URL | `https://open.bigmodel.cn/api/paas/v4/` |
| Wire | OpenAI 兼容 `chat/completions` |
| 缓存 | **隐式自动**；`usage.prompt_tokens_details.cached_tokens` |
| Reasoning | `thinking: { type: "enabled" \| "disabled" }`；GLM-5.2+ 支持 `reasoning_effort` |
| 流式 | delta 可含 `reasoning_content`（展示层可选，非 router 阻塞） |
| 差异 | 文档注明与 OpenAI **部分字段差异**；`temperature` 区间 (0,1]，勿设 0 |
| API Key env | 建议 `ZAI_API_KEY` 或 `GLM_API_KEY` |

#### xAI / Grok（P1 测试，难度：低–中）

| 项 | 说明 |
|----|------|
| Base URL | `https://api.x.ai/v1` |
| Wire | OpenAI `chat/completions`（另有 `/responses`，v1 不用） |
| 缓存 | 自动 + 可选 `prompt_cache_key`（粘性路由，映射 `x-grok-conv-id`） |
| Usage | `usage.prompt_tokens_details.cached_tokens` |
| Reasoning | `reasoning_effort`: `none` / `low` / `medium` / `high`（grok-4.3+） |
| 风险 | **tool_calls.arguments 必须合法 JSON**（已修）；流式 `reasoning_content` |

#### OpenRouter（P1 测试，难度：低）

| 项 | 说明 |
|----|------|
| Base URL | `https://openrouter.ai/api/v1` |
| 路由 | `extra_body.provider.order` / `allow_fallbacks`（**应用层 fallback 不同**） |
| 缓存 | 透传上游；`usage.prompt_tokens_details.{cached_tokens, cache_write_tokens}` |
| 粘性 | `session_id`（body）或 `x-session-id`（header），利于多轮 cache |
| 模型 id | `deepseek/…`、`z-ai/glm-…`、`x-ai/grok-…` 等 slug |

#### Anthropic（P2 最后，难度：中）

| 项 | 说明 |
|----|------|
| 经 OpenRouter | 仍可用 `openai_chat` + `cache_control` 断点（档位 C） |
| 直连 | 需 `anthropic_messages` wire 或 OR 兼容层 |
| 工作量 | 消息 content 改 array + `cache_control`；与 master 指针化 **无耦合** 但实现晚于国模 |

### 4.4 难度总表（实现估时）

| 能力块 | 难度 | 工期 | 阻塞 | 说明 |
|--------|:----:|:----:|------|------|
| G1 profile + binding | ★★☆ | 1–2d | 无 | 纯配置解析与注入 |
| G1-cache 隐式缓存（A 档） | ★☆☆ | 0.5–1d | G1-a | `parseCacheUsage` 归一化 + `llm_done` 事件 |
| G1-cache OR `session_id` | ★☆☆ | 2h | G1-a | `extra_body` 或 `resolveLlmBinding` 注入 |
| G2 可观测 + TUI | ★★☆ | ~1d | G1 | |
| G3 fallback 链 | ★★☆ | ~1d | G1 | 与 OR `provider` 分层 |
| G4 reasoning（DS/GLM/xAI） | ★★☆ | 1d | G1 | `reasoning_map` + `extra_body` |
| G5 Anthropic 显式断点 | ★★★ | 1–2d | G1-cache | 消息结构变换；**最后** |
| xAI `/responses` wire | ★★★ | 2–3d | — | 非 v1 |
| ds-cache 指针冻结 merge | ★★★★ | — | — | **明确不做** |

**整体判断**：在 v1 仅 `openai_chat` 前提下，**DeepSeek + GLM + xAI + OpenRouter 可在 2–3 天内达到「可配置 + 可观测缓存」**；Anthropic 显式缓存不挡国模主线。

### 4.5 与现有上下文策略的衔接

本仓已具备对 **隐式缓存** 友好的习惯（不改 router 即可受益）：

- system + tools 单 run 内稳定（`Agent.md` / memory 在 `run_start` 注入）
- 压缩走 append-only `[context-notice]`，不改写 system
- pointer 卡片一次写入 frozen

**刻意接受**：turn 边界 pointerize、prune 改变 API 可见前缀 → 隐式 cache 命中率波动；**不为命中率改 pointerize**。

---

## 5. 架构：LlmRouter

### 5.1 概念

- **ApiProfile**：命名的一套连接参数（base_url、鉴权、默认 model、wire、cache、models、extra_body、fallback 链）。
- **LlmBinding**：某次运行解析出的 `{ profile, model, extraBody, cache, wire }`。
- **LlmRouter**：纯函数层：`resolveLlmBinding()` → `applyCacheAdapter()` → `chat()`；**不**改 `ChatMessage` 内存语义。

### 5.2 数据流

```text
agent.json api_profiles
        +
env 回退（MODEL/BASE_URL/API_KEY）
        +
绑定（main | spawn_preset | workflow_role）
        ↓
resolveLlmBinding(name?, overrides?)
        ↓
LlmProfile { baseUrl, apiKey, model, wire, cache, extraBody?, label }
        ↓
apiMessages = assembleApiMessages(messages)     # 现有 context-policy
cachedMessages = applyCacheAdapter(apiMessages)   # 默认 no-op（隐式缓存）
        ↓
llm.chat(cachedMessages, tools, { ...profile, signal, onToken })
        ↓
parseCacheUsage(usage) → llm_done.cache
        ↓
失败且可重试 → 同 profile 退避 →（G3）fallback_profiles 下一 profile
```

### 5.3 模块边界（拟新增 / 修改）

| 模块 | 职责 |
|------|------|
| `src/llm-profiles.ts`（新） | 加载、校验 `api_profiles`；`resolveLlmBinding`；`listModels` |
| `src/llm-cache.ts`（新） | `applyCacheAdapter`（G5 前默认 no-op）；`parseCacheUsage` |
| `src/llm.ts` | `buildChatBody` 浅合并 `extra_body`；扩展 `usage` 类型 |
| `src/llm-retry.ts` | G3：profile 级 fallback 与现有 429 退避协作 |
| `src/runner.ts` | 主 run 默认 profile；`run_start` 元数据带 `llm_profile` |
| `src/spawn/runner.ts` / `job-store.ts` | 子 Agent / job 用 preset 绑定的 profile |
| `src/workflow/load-role.ts` | role 级 `api_profile` + `model` |
| `src/plugins/types.ts` | `AgentPluginConfig.api_profiles` schema |
| `src/tui/slash.ts` | G2：`/profile` `/model`；G4：`/reasoning` |

**禁止**：在 `agent.ts` ReAct 循环内分支 profile 逻辑；解析在 `buildRunConfig` / spawn 入口 **一次** 完成。

---

## 6. 配置：`api_profiles`

### 6.1 放置位置

`agent.json` 顶层（与 `spawn_presets` 同级）。提供 `agent.llm.example.json` 作为开箱模板。

环境变量 **回退**（无 `api_profiles` 或未指定绑定时）：

```text
API_KEY / BASE_URL / MODEL   → 隐式 profile "__env__"
```

### 6.2 Schema（TypeScript 草案）

```typescript
export type LlmWire = 'openai_chat'; // v1 仅此；未来扩展

export type CacheMode =
  | 'off'                    // 不解析 cache usage（默认，与现网一致）
  | 'implicit'               // 档位 A：不改消息，解析 usage
  | 'openrouter_sticky'      // 档位 B：注入 session_id
  | 'anthropic_breakpoints'; // 档位 C：G5

export interface CachePolicyConfig {
  mode?: CacheMode;
  /** openrouter_sticky：默认用 session_id */
  session_id_from?: 'session_id' | 'fixed';
  session_id?: string;
  /** anthropic_breakpoints（G5） */
  breakpoints?: Array<'system' | 'tools' | 'first_user'>;
  /** json-events 输出前缀指纹变化（仅观测，不调 pointerize） */
  telemetry?: boolean;
}

export interface ApiProfileConfig {
  base_url: string;
  api_key_env: string;
  default_model: string;
  models?: string[];
  /** v1 默认 openai_chat */
  wire?: LlmWire;
  cache?: CachePolicyConfig;
  extra_body?: Record<string, unknown>;
  fallback_profiles?: string[];
  display_name?: string;
  /** G4：/reasoning 映射到 extra_body 片段 */
  reasoning_map?: Record<string, Record<string, unknown>>;
}

export interface AgentPluginConfig {
  // …existing…
  default_api_profile?: string;
  api_profiles?: Record<string, ApiProfileConfig>;
}
```

### 6.3 开箱示例（国模主力 + 测试中转）

```json
{
  "default_api_profile": "deepseek-main",
  "api_profiles": {
    "deepseek-main": {
      "display_name": "DeepSeek V4",
      "base_url": "https://api.deepseek.com",
      "api_key_env": "DEEPSEEK_API_KEY",
      "default_model": "deepseek-v4-flash",
      "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
      "cache": { "mode": "implicit", "telemetry": true },
      "reasoning_map": {
        "low":    { "thinking": { "type": "enabled" }, "reasoning_effort": "low" },
        "medium": { "thinking": { "type": "enabled" }, "reasoning_effort": "medium" },
        "high":   { "thinking": { "type": "enabled" }, "reasoning_effort": "high" }
      }
    },
    "glm-main": {
      "display_name": "智谱 GLM",
      "base_url": "https://open.bigmodel.cn/api/paas/v4",
      "api_key_env": "ZAI_API_KEY",
      "default_model": "glm-5.2",
      "models": ["glm-5.2", "glm-5-turbo", "glm-4.7"],
      "cache": { "mode": "implicit" },
      "extra_body": { "thinking": { "type": "enabled" } },
      "reasoning_map": {
        "low":    { "thinking": { "type": "enabled" }, "reasoning_effort": "low" },
        "high":   { "thinking": { "type": "enabled" }, "reasoning_effort": "max" }
      }
    },
    "xai-test": {
      "display_name": "xAI Grok（测试）",
      "base_url": "https://api.x.ai/v1",
      "api_key_env": "XAI_API_KEY",
      "default_model": "grok-4.3",
      "models": ["grok-4.3", "grok-4.20"],
      "cache": { "mode": "implicit" },
      "extra_body": { "reasoning_effort": "low" }
    },
    "openrouter-test": {
      "display_name": "OpenRouter（测试）",
      "base_url": "https://openrouter.ai/api/v1",
      "api_key_env": "OPENROUTER_API_KEY",
      "default_model": "x-ai/grok-4.5",
      "models": [
        "x-ai/grok-4.5",
        "deepseek/deepseek-v4-flash",
        "z-ai/glm-5.2"
      ],
      "cache": { "mode": "openrouter_sticky", "session_id_from": "session_id" },
      "extra_body": {
        "provider": { "order": ["DeepSeek", "xAI"], "allow_fallbacks": true }
      }
    },
    "review-cheap": {
      "display_name": "GLM Flash 审查",
      "base_url": "https://open.bigmodel.cn/api/paas/v4",
      "api_key_env": "ZAI_API_KEY",
      "default_model": "glm-4.7-flash",
      "models": ["glm-4.7-flash"]
    }
  },
  "_spawn_preset_llm_overrides": [
    {
      "name": "code-review-bug",
      "api_profile": "review-cheap",
      "model": "glm-4.7-flash",
      "_note": "Merge api_profile + model into existing spawn_presets[] entry"
    }
  ]
}
```

`agent.llm.example.json` 仅含 LLM 配置；**不要**整段覆盖 `agent.json` 的 `spawn_presets`，只把 `_spawn_preset_llm_overrides` 中的字段合并进已有 preset。

### 6.4 解析优先级（单字段 `model`）

1. 绑定覆盖：`spawn_presets[].model` / `workflow.roles.*.model` / TUI `/model switch`
2. profile.`default_model`
3. env `MODEL`
4. 解析失败 → 启动时报错

`api_key`：**仅** `process.env[api_key_env]`；缺失时 profile 标记 unavailable，fallback 链继续（G3）。

---

## 7. 绑定表

| 消费方 | 配置键 | 默认 profile | 写入可追溯元数据 |
|--------|--------|--------------|------------------|
| 主 Agent | `default_api_profile` 或 `__env__` | `default_api_profile` | `run_start.llm` |
| `spawn_agent` / `spawn_background` | `spawn_presets[].api_profile` | 继承主 Agent | spawn action / job `meta.json` |
| `code_review` 后台 job | 同 preset 的 `api_profile` | 同左 | `workspace/jobs/<id>/meta.json` |
| workflow role | `workflow.roles.<name>.api_profile`（新增） | 继承主 Agent | `workflow_step` event（可选） |

### 7.1 `AgentConfig` 扩展（草案）

```typescript
export interface LlmProfile {
  profileName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  wire?: LlmWire;
  cache?: CachePolicyConfig;
  extraBody?: Record<string, unknown>;
}

export interface AgentConfig {
  // …existing…
  llm?: LlmProfile;
}
```

### 7.2 Job `meta.json` 扩展（G2）

```json
{
  "preset": "code-review-bug",
  "api_profile": "review-cheap",
  "model": "glm-4.7-flash",
  "llm_base_url": "https://open.bigmodel.cn/api/paas/v4",
  "cache_mode": "implicit"
}
```

---

## 8. 缓存适配层（G1-cache + G5）

### 8.1 `parseCacheUsage` 归一化

各厂商 `usage` 字段不一，router 统一为：

```typescript
export interface LlmCacheStats {
  prompt_tokens?: number;
  cached_tokens?: number;      // 命中
  cache_miss_tokens?: number;  // DeepSeek 专有，可选
  cache_write_tokens?: number; // OpenRouter / 部分上游
  provider?: string;           // profileName
}
```

| 来源 | 原始字段 | 映射 |
|------|----------|------|
| DeepSeek | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | `cached_tokens` / `cache_miss_tokens` |
| GLM / xAI / OpenAI 系 | `prompt_tokens_details.cached_tokens` | `cached_tokens` |
| OpenRouter | 同上 + `cache_write_tokens` | 全部保留 |
| 无字段 | — | 省略 `cache` 子对象 |

写入 `llm_done`：

```json
{
  "type": "llm_done",
  "turn": 3,
  "usage": { "prompt_tokens": 12000, "completion_tokens": 400 },
  "cache": { "cached_tokens": 9800, "cache_miss_tokens": 2200 }
}
```

### 8.2 `applyCacheAdapter` 行为

| `cache.mode` | 行为 |
|--------------|------|
| `off` | 原样返回 messages |
| `implicit` | 原样返回；仅事后 `parseCacheUsage` |
| `openrouter_sticky` | `extra_body.session_id = session_id`（绑定主 session） |
| `anthropic_breakpoints` | G5：system/tools 内容块加 `cache_control`（**最后实现**） |

### 8.3 开箱默认

- 无 `api_profiles`：`cache.mode = off`（现网一致）
- 提供 `agent.llm.example.json`：DeepSeek / GLM profile 默认 `implicit`

---

## 9. `extra_body` 与 reasoning / effort（G4）

### 9.1 合并规则

```typescript
function buildChatBody(model, messages, tools, stream, extraBody?) {
  const body = { model, messages, stream, tools, tool_choice };
  if (extraBody) Object.assign(body, extraBody);
  return body;
}
```

合并顺序：`profile.extra_body` < 会话 `reasoning_patch` < 运行时覆盖（若有）。

### 9.2 厂商映射表（按优先级）

| 生态 | 典型字段 | 示例 | 难度 | 备注 |
|------|----------|------|:----:|------|
| **DeepSeek** | `thinking` + `reasoning_effort` | `{ "thinking": { "type": "enabled" }, "reasoning_effort": "high" }` | ★☆☆ | v4 系 |
| **GLM** | `thinking` + `reasoning_effort` | `{ "thinking": { "type": "enabled" }, "reasoning_effort": "max" }` | ★☆☆ | GLM-5.2+；流式 `reasoning_content` 展示可选 |
| **xAI** | `reasoning_effort` | `low` / `medium` / `high` / `none` | ★☆☆ | grok-4.3+；勿改 tool 字段名 |
| **OpenRouter** | `provider` + `session_id` | 见 §6.3 | ★☆☆ | 与 profile fallback 分层 |
| Gemini（经 OR） | `thinkingConfig` 等 | profile 透传 | ★★☆ | 非主力 |
| **Anthropic** | `cache_control` / thinking | G5 | ★★★ | **最后** |

`reasoning_map` 挂在 profile 上；`/reasoning` 写入会话级 patch 再合并。

---

## 10. Fallback（G3）

### 10.1 三层机制（勿混）

| 层 | 机制 | 配置位置 |
|----|------|----------|
| **HTTP 退避** | 同 profile 429 retry-after | `llm-retry.ts` |
| **应用 profile 链** | A 失败 → `fallback_profiles[]` | `api_profiles.A` |
| **OpenRouter 路由** | 单请求内 vendor 排序 | `extra_body.provider` |

### 10.2 不宜 fallback 的场景

- 流式已输出 token 后 → **不**切 profile
- `FALLBACK=0` → 不自动切 profile 链
- 显式 **model** 绑定（TUI `/model`、spawn `model`、workflow role `model`）→ 不自动切
- `401` / `403` 等鉴权错误 → **不**切（保守策略；仅 429/5xx/network）

### 10.3 实现（G3 落地）

| 模块 | 职责 |
|------|------|
| `resolveLlmBindingChain()` | primary + `fallback_profiles[]` 扁平链；去重；缺名 warn 跳过 |
| `pickFirstAvailableBinding()` | pre-flight / `run_start.llm` **effective** profile（首个有 key 的项） |
| `configureAgentLlmBinding()` | 写入 `AgentConfig.llm`（effective）+ `llmBindingChain` + `llmProfileFallbackEnabled` |
| `invokeLlmTurnWithFallback()` | 每 profile 内 HTTP retry → 失败且 eligible → 下一 profile |
| `llm_fallback` 事件 | `from_profile/to_profile/from_model/to_model/reason` |

**不变量**

1. fallback profile 使用各自 `default_model`（**不**继承 primary 的 model override）
2. job `meta.json` 仍写 preset **意图** profile；实际切换仅 `llm_fallback` 事件可追溯
3. OpenRouter `extra_body.provider` 与 profile 链 **分层**（单请求内 vendor 路由不变）

**`llm_fallback` 事件（草案）**

```typescript
{
  type: 'llm_fallback';
  turn: number;
  from_profile: string;
  to_profile: string;
  from_model: string;
  to_model: string;
  reason: string;
  attempt: number; // 上一 profile HTTP retry 用尽时的 attempt
}
```

---

## 11. 模型列表与 TUI slash（G2）

### 11.1 数据源

| 来源 | API | 用途 | 阶段 |
|------|-----|------|------|
| **静态** | `listProfileNames()`、`listModelsForProfile()`（`src/llm-profiles.ts`） | pi-tui picker、classic 文本列表、`/model` 直设校验（warn） | **G2 必做** |
| **远程** | `GET {base}/models`，内存缓存 10 分钟，timeout + 失败回退静态 | 配置未列全的 OpenRouter slug 等 | **G2.1 可选** |

静态列表规则（与实现对齐）：

- profile 有 `models[]` → 列表即该数组；否则仅 `[default_model]`
- `__env__` → 仅 `[resolveModel from MODEL env]`（**不是**其他 profile 的 `models[]`）
- `resolveLlmBinding` 的 `model` override **不**要求落在 `models[]` 内（手写 `/model <id>` 仍可透传）；picker 展示的是**建议集**，不是硬白名单

配置校验（加载时 **warn**，不阻塞启动）：

- `default_model` 应出现在 `models[]` 中（若 `models[]` 非空）

### 11.2 TUI slash 交互（G2-c）

**范围**：仅 **主 Agent 会话**（`AgentRuntime` session override）。spawn preset / workflow role / job 的 `api_profile` **不受** `/profile` 影响；见 §11.4 spawn 分裂。

| 命令 | 行为 |
|------|------|
| `/profile` | pi-tui：**picker**（与 `/sessions`、`/skills` 分工一致） |
| `/profile <name>` | 直接设 session profile override |
| `/profile reset` | 清 profile + model override，恢复 `default_api_profile` / env |
| `/model` | 列出**当前生效 profile** 的模型；多项时 pi picker |
| `/model <id>` | 直接设 session model override |
| `/model reset` | 仅清 model override |

**双路径**（与 `/workflow` 相同）：无参 → 列表/picker；有参 → 直设。

**单选项短路**：仅 1 个 profile 或当前 profile 仅 1 个 model 时，无参调用**打印状态**，不弹空 picker。

**pi-tui picker**（复用 `showPickerOverlay` + `buildSelectItems`，可参考 `/skills`）：

- 行标记：`(active)` 当前生效；`(no key)` + description 显示 `unavailableReason`
- 缺 key 的 profile：**选中时拦截**，`say` 错误，**不**写入 override
- `value` 必须为完整 model id（OpenRouter slug 勿在展示层截断 value）
- Enter 才 commit；Esc 取消 = 无变更

**状态栏**（`printStatus`）：`llm:<profile>/<model>`，有 override 时标 `(override)` 或 `*`。

**不持久化**：override 不写 `agent.json`；新 session 清空（与 `/shell on|off` 一致）。

**实现模块**（拟）：

| 模块 | 职责 |
|------|------|
| `src/tui/slash.ts` | parse、`SlashResult` 的 `llmProfileAction` / `llmModelAction` |
| `src/runner.ts` | `sessionLlmOverride`、`buildRunConfig` 合并 `resolveLlmBinding` |
| `src/tui/llm-picker.ts`（可选） | `buildProfilePickerEntries` / `buildModelPickerEntries` |
| `src/tui/pi-app.ts` | picker 与 `say` 反馈 |
| `src/tui/app.ts` | classic 文本列表 + 提示「pi TUI 可用 picker」 |

### 11.3 交互不变量（实现必须满足）

1. **`/model` 列表来源** = `listModelsForProfile(pluginConfig, effectiveProfileName)`，其中 `effectiveProfileName` = session profile override ?? default。
2. **`/profile <name>` 成功后**：默认 **清空 model override**（或：若旧 model 不在新 profile 列表中则清空——二者取并，推荐一律清空以免陈旧）。
3. **`/profile reset`**：清空 profile **与** model override。
4. **`/model reset`**：仅清空 model override；profile override 保留。
5. **缺 key profile**：picker 可选中预览，但 **commit 时拒绝**；`requireAvailableLlmBinding` 在 `run` 前仍作最后防线。
6. **`run_start.llm`**（G2-a）与状态栏使用**同一套** `buildRunConfig` 解析结果，避免「显示 A、请求 B」。
7. **正在运行的 task**：override 仅对 **下一条** `runSingleTask` / workflow 生效；run 中改 slash 不改变当前 in-flight `AgentConfig`（可选：run 中拒绝 `/profile` `/model` 并提示）。

### 11.4 Picker 与模型列表：已知陷阱与防护

#### A. 静态 `models[]`（G2）

| 陷阱 | 表现 | 防护 |
|------|------|------|
| 列表与请求不一致 | picker 显示 A，实际请求 B | 状态栏 + `run_start.llm` 同源；`(active)` 标记对齐 `effective` binding |
| `default_model ∉ models[]` | 默认项不在列表中 | 加载时 warn；picker 始终包含 `default_model` 一项 |
| Profile 切换后陈旧 model | 切到 DeepSeek 仍发 `glm-5.2` | §11.3 规则 2：profile 切换清 model override |
| `__env__` 列表污染 | `/model` 显示上一 profile 的 5 个型号 | 列表 API 必须传 **当前** `effectiveProfileName`，禁止缓存「上一个 profile」的列表 |
| 手写 `/model` 不在列表 | 能跑但 picker 无对应行 | 允许；status 显示 override；picker 无 `(active)` 时以 status 为准 |
| `models[]` 重复 | picker 两条相同 value | 构建 items 时去重 |

#### B. 远程 `GET /models`（G2.1，可选）

| 陷阱 | 表现 | 防护 |
|------|------|------|
| 请求挂住 | 开 picker 卡死 | timeout（如 5s）；失败 → 静态列表 |
| 空列表 / 401 被吞 | 「无模型」 | 显示 `(auth failed)` / `(fetch failed)`；回退静态 |
| 竞态 | 快速切 profile，列表错 profile | 每次 fetch 带 `profileGeneration`；丢弃过期响应 |
| slug 与配置不一致 | 同模型两行不同 id | G2.1 可选去重；静态 `models[]` **置顶** |
| 列表过大 | OpenRouter 数百项难选 | 默认只展示 `models[]`；远程仅作「补全」或 `/model <id>` 直设 |

**G2.1 验收**：网络失败时 picker 与 **仅静态配置** 时完全一致。

#### B.1 实现（G2-d 落地）

| 模块 | 职责 |
|------|------|
| `src/llm-models-remote.ts` | `GET {base}/models`、parse、10min cache、`mergeStaticAndRemoteModels` |
| `AgentRuntime.listSessionModelChoicesAsync()` | 静态 + 可选 remote；`modelListGeneration` 丢弃过期 fetch |
| `listSessionModelChoices()` | **仅静态**（hint、`setSessionLlmProfile` 不变） |
| TUI `/model` list | pi + classic 走 async；**merged 长度 ≤1** 才短路（选项 A） |

环境变量：`REMOTE_MODELS=0` 禁用；`REMOTE_MODELS_MAX`（默认 20）限制 remote 补全条数。

#### C. Picker UI

| 陷阱 | 表现 | 防护 |
|------|------|------|
| Esc 误改 | 用户以为未切换 | 仅 Enter commit |
| 缺 key 仍写入 | 下条 task LLM 硬失败 | commit 拦截 + `unavailableReason` |
| description 截断 value | 选中错误 slug | `truncateToWidth` 只用于 label/description，`value` 完整 |
| run 中修改 | 当前 turn 行为未定义 | 仅下条生效或 run 中禁止（§11.3 规则 7） |

#### D. 与 spawn / job 分裂（非 picker bug，需文案）

| 陷阱 | 表现 | 防护 |
|------|------|------|
| 用户以为 TUI profile 管 spawn | 主 agent GLM，code_review job 仍走 preset | `/profile` status 注明「仅主 Agent；spawn 见 preset / job meta」 |
| 事后追溯 | `spawn:list` 与 TUI 当时不一致 | G2-b：job `meta.json` 写入 `api_profile` / `model` |

#### E. 实现优先级（checklist）

| 优先级 | 项 |
|:------:|-----|
| P0 | profile 切换 ↔ model override 陈旧（§11.3 规则 2） |
| P0 | `/model` 列表绑定当前 `effectiveProfileName` |
| P0 | 缺 key profile commit 拦截 |
| P1 | `default_model ∈ models[]` warn |
| P1 | 远程列表：timeout + 静态 fallback + 竞态取消（G2.1） |
| P2 | 远程与静态 slug 去重；run 中 slash 策略文案 |

---

## 12. 实施分期与验收

### G1 — `api_profiles` + 绑定（P0，1–2 天）

| 任务 | 说明 |
|------|------|
| G1-a | `llm-profiles.ts`：加载、校验、`resolveLlmBinding` |
| G1-b | `AgentConfig.llm`；`runner` / spawn / workflow 注入 |
| G1-c | `spawn_presets[].api_profile` + 可选 `model` |
| G1-d | `workflow.roles.*.api_profile` |
| G1-e | 单测：解析、env 回退、缺 key |
| G1-f | `agent.llm.example.json` 开箱模板（DeepSeek + GLM） |

**验收**

- [ ] 主 Agent DeepSeek、spawn job GLM 可用 **不同** profile
- [ ] 无 `api_profiles` 时行为与现网一致
- [ ] `npm test` 全绿

### G1-cache — 隐式缓存观测（P0，与 G1 并行，0.5–1 天）

| 任务 | 说明 |
|------|------|
| G1-cache-a | `llm-cache.ts`：`parseCacheUsage`（DS/GLM/xAI/OR 字段） |
| G1-cache-b | `applyCacheAdapter`：`implicit` no-op + `openrouter_sticky` |
| G1-cache-c | `llm_done.cache` + `--json-events` |
| G1-cache-d | 单测：各厂商 usage JSON fixture |

**验收**

- [ ] DeepSeek / GLM 多轮对话可在 events 看到 `cached_tokens`（或 miss 字段）
- [ ] OpenRouter profile 自动带 `session_id`
- [ ] **不**改 pointerize / prune

### G2 — 可观测 + TUI（P1，~1 天）

| 任务 | 说明 |
|------|------|
| G2-a | `run_start.llm`：`profile` / `model` / `cache_mode` / `base_url_host`；TUI log + `--json-events` |
| G2-b | job `meta.json`：`api_profile`、`model`、`llm_base_url`、`cache_mode`；`spawn:list` 展示 |
| G2-c | `/profile` `/model`（§11.2–11.4）；`AgentRuntime.sessionLlmOverride`；状态栏 |
| G2-d | 远程 `GET /models`（G2.1）；**须**满足 §11.4-B 回退与竞态防护 |

**验收**

- [ ] `run_start.llm` 含 profile / model / cache_mode
- [ ] job `meta.json` 可区分三并行 `code_review`（不同 profile/model）
- [ ] `/profile` `/model` 会话级覆盖；pi-tui picker + classic 文本列表
- [ ] 满足 §11.3 交互不变量与 §11.4 P0 checklist
- [x] 单测：`sessionLlmOverride` 合并、`listModelsForProfile` 与 profile 切换清 model
- [x] G2-d：`listSessionModelChoicesAsync`；失败 ≡ 静态；`modelListGeneration` 竞态；merged ≤1 短路（选项 A）

### G3 — Fallback 链（P1，~1 天）

| 任务 | 说明 |
|------|------|
| G3-a | `resolveLlmBindingChain` / `pickFirstAvailableBinding` / `configureAgentLlmBinding` |
| G3-b | `invokeLlmTurnWithFallback`；`agent.ts` 接线；spawn/workflow/runner |
| G3-c | `llm_fallback` 事件；`FALLBACK=0` + 显式 model 禁用 |
| G3-d | `agent.llm.example.json` `fallback_profiles`；§10.3 |

**验收**

- [x] profile 链 fallback；流式 partial 不切
- [x] `llm_fallback` 事件（TUI + `--json-events`）
- [x] pre-flight effective profile（`run_start.llm` 与首个可用 binding 一致）
- [x] 401 不 fallback；429/5xx/network 可 fallback

### G4 — Reasoning（P1，1 天）

| 任务 | 说明 |
|------|------|
| G4-a | `llm-reasoning.ts`：`resolveReasoningPatch` / `buildSessionReasoningExtraBody` |
| G4-b | `buildLlmTurnRequestForBinding` 合并顺序 §9.1；`sessionReasoningLevel` on `AgentConfig` |
| G4-c | `/reasoning` slash + pi picker + classic 列表；`run_start.llm.reasoning` |
| G4-d | 单测：DS/GLM body、`xAI` `reasoning_effort` 覆盖 profile `extra_body` |

**验收**

- [x] DeepSeek 或 GLM `reasoning_map` body 含 `thinking` / `reasoning_effort`
- [x] xAI `reasoning_effort` 透传可测
- [x] `/reasoning` / `/reasoning reset`；profile 切换清 reasoning override

### G5 — Anthropic 显式缓存（P2 最后，1–2 天）

| 任务 | 说明 |
|------|------|
| G5-a | `cache.mode = anthropic_breakpoints` |
| G5-b | system/tools 内容块 `cache_control` |
| G5-c | 文档：与隐式国模的差异 |

**验收**

- [ ] 仅显式开启 profile 时改变消息结构
- [ ] master 默认 off

---

## 13. cc-connect 预设导入（可选工具）

```text
cc-connect provider-presets.json
  → 过滤 agents.opencode
  → 生成 api_profiles 片段
  → 用户手工合并 api_key_env、cache.mode
```

---

## 14. 安全与运维

- API key 仅环境变量；`agent.json` 不得含明文 key
- 日志 / events：**禁止** apiKey；可记录 `base_url` host
- Profile 切换不改变权限门、`allowShell` / `allowWeb`
- GLM：`temperature` 勿设 0（厂商区间限制）

---

## 15. 测试策略

| 层 | 内容 |
|----|------|
| 单元 | `resolveLlmBinding`、`parseCacheUsage`（DS/GLM/OR fixtures）、extra_body 合并、fallback；G2：`sessionLlmOverride`、profile 切换清 model、`listModelsForProfile` |
| 集成 | mock `fetch`：profile A 失败 → B；usage 含 DS 字段 |
| 回归 | 无 `api_profiles` 与现网 snapshot 一致 |
| E2E（人工） | DeepSeek + GLM 各跑 3 turn 看 cache 事件 |
| 不测 | 真实 cache 命中率；Anthropic 断点效果（G5 后） |

---

## 16. 版本

| 日期 | 说明 |
|------|------|
| 2026-07-10 | v0.1 初稿：轨 G 范围、schema、绑定、G1–G5 验收 |
| 2026-07-10 | v0.2：厂商调研（DeepSeek/GLM 主力，xAI/OR 测试，Anthropic 最后）；缓存提前至 G1-cache；难度表；`agent.llm.example.json` |
| 2026-07-11 | v0.3：§11 模型列表 + G2-c TUI slash/picker 交互；§11.3 不变量；§11.4 picker/API 联动陷阱与 checklist；G2 任务表 |
| 2026-07-11 | v0.4：G3 fallback 链落地；§10.2–10.3；`llm_fallback` 事件；effective pre-flight |
| 2026-07-11 | v0.5：G2-d 远程 `GET /models`；§11.4-B.1；merged 短路选项 A |
| 2026-07-11 | v0.6：G4 `/reasoning` + `reasoning_map` 会话 patch；`run_start.llm.reasoning` |

---

## 17. 明确不做（本 spec 范围外）

- 在线热重载 `api_profiles`
- 按 token 计费 UI / 账单对账
- 替换 OpenRouter / 自建网关
- 用 LlmRouter 改 context prune / pointerize 规则
- ds-cache 冻结指针 merge 进 master
- v1 实现 xAI `/responses`、DeepSeek `/anthropic` wire