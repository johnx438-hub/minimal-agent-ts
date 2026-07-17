# Vision Message 管线 Spec（设计）

> **定位**: 为多模态（vision）模型接入 **用户图片输入 → session → LLM API** 的端到端管线，兼容现有纯文本路径。  
> **原则**: content parts 扩展、落盘优先不撑爆 session JSON、发送时再 materialize、路径受 workspace grants 约束。  
> **状态**: Design draft v0.3（2026-07-17）· **VI-0～VI-3 / 部分 VI-4～5 已落地**（TUI 剪贴板粘贴 VI-6 仍待）  
> **代码锚点**: `src/vision.ts` · `types.ChatMessage.vision_refs` · `assembleApiMessages` · CLI `--image` · TUI `src/tui/vision-input.ts` · `/image`  
> **相关**: [SPEC_LLM_ROUTER.md](./SPEC_LLM_ROUTER.md) · [SPEC_CONTEXT_MANAGEMENT.md](./SPEC_CONTEXT_MANAGEMENT.md) · [SPEC_SESSION_WORKSPACE.md](./SPEC_SESSION_WORKSPACE.md) · [SPEC_TUI.md](./SPEC_TUI.md)

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 |
|---|------|
| **V1** | User 消息可携带 **1+ 张图** + 文本，以 OpenAI-compatible `image_url` parts 调 vision 模型 |
| **V2** | TUI / CLI 均可注入图（路径引用为主；可选粘贴/base64） |
| **V3** | Session **可恢复**：图以 workspace 内文件或 `.sessions` 旁路存储，不把巨型 base64 长期塞进 `session_*.json` |
| **V4** | 纯文本模型/路径 **零回归**（无图时行为与今日一致） |
| **V5** | Token/预算粗估 + 可选上限（张数、单张字节、总 parts） |

### 1.2 非目标（本阶段）

- 模型 **生成** 图片（image out）  
- 视频 / 音频  
- 工具结果自动截图喂回（可后接）  
- 所有 provider 专有格式（先 **OpenAI chat vision** 形；其它 wire 映射表后置）  
- OCR 本地预处理（用户可用工具链，不进 V1 必做）

---

## 2. 现状缺口（对照）

```text
用户输入(text) → ChatMessage{ content: string }
  → assembleApiMessages → buildChatBody({ messages }) → fetch
```

| 层 | 缺口 |
|----|------|
| 类型 | `content` 不能是 part 数组 |
| 入站 | 无 `@image` / `--image` / 粘贴协议 |
| LLM | 无 data URL / remote URL part 组装 |
| 持久化 | 若硬塞 base64 会爆 session / 压缩逻辑只懂 string |
| 预算 | `estimateTokens` 按字符，图未计价 |

---

## 3. 数据模型

### 3.1 Content parts（内部 + API 对齐）

```typescript
/** OpenAI-compatible multimodal user content */
type TextContentPart = { type: 'text'; text: string };

type ImageUrlPart = {
  type: 'image_url';
  image_url: {
    url: string;           // https://... or data:image/png;base64,...
    detail?: 'auto' | 'low' | 'high';
  };
};

type ContentPart = TextContentPart | ImageUrlPart;

type MessageContent = string | ContentPart[] | null;
```

```typescript
// ChatMessage 演进
interface ChatMessage {
  role: Role;
  content: MessageContent;   // 原 string | null 的超集
  // ... 现有 tool_calls / action_id / turn 不变
  /**
   * 可选：session 落盘用的本地图引用（不直接发给 API）。
   * materialize 时转为 image_url data URL 或 https。
   */
  vision_refs?: VisionRef[];
}

type VisionRef = {
  /** 相对 active_cwd 或 session 资产目录的路径 */
  path: string;
  mime?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  detail?: 'auto' | 'low' | 'high';
  /** 可选：发送时用 https 而不是读盘 base64 */
  remote_url?: string;
};
```

**双轨**:

| 形态 | 用途 |
|------|------|
| `content: string` | 兼容旧 session、assistant/tool 消息（V1 仍强制 string） |
| `content: ContentPart[]` | 已 materialize、即将/已经发 API 的 user 消息 |
| `vision_refs` | **推荐持久化**：session JSON 只存路径；发送前 `materializeVisionMessage` |

V1 约定：

- **user** 可多模态；**system / assistant / tool** 保持纯文本（简化 assemble/repair）。  
- 有 `vision_refs` 时，`content` 在盘上可为纯文本 caption；发送前合成 parts。

### 3.2 资产落盘

```text
# 推荐（与 session 同库，随 project bucket）
.sessions/vision/<session_id>/<uuid>.png
# 或 agent_home 模式：
$AGENT_HOME/sessions/by-project/<id>/vision/<session_id>/...

# 用户项目内已有文件
./screenshots/ui.png   # 经 grants 可读即可引用
```

| 策略 | 说明 |
|------|------|
| **引用优先** | `vision_refs[].path` 指向已有文件，不复制 |
| **导入复制** | TUI 粘贴/临时文件 → 写入 `vision/<session_id>/` 再引用 |
| **体积上限** | 默认单张 e.g. 4–8 MiB；超限拒绝或提示压缩（实现定数） |

---

## 4. 管线阶段

```text
┌─────────────┐    ┌──────────────────┐    ┌────────────────────┐
│ Ingress     │───►│ Session message  │───►│ Materialize        │
│ TUI/CLI     │    │ text + vision_refs│    │ → ContentPart[]    │
└─────────────┘    └──────────────────┘    └─────────┬──────────┘
                                                     │
                                                     ▼
                                           ┌────────────────────┐
                                           │ assembleApiMessages│
                                           │ (+ strip internal) │
                                           └─────────┬──────────┘
                                                     ▼
                                           ┌────────────────────┐
                                           │ buildChatBody      │
                                           │ wire: openai_chat  │
                                           └────────────────────┘
```

### 4.1 Ingress（入站）

#### CLI

```bash
npm start -- --image ./a.png --image ./b.jpg "图里按钮文案是什么？"
# 或
npm start -- --image-url https://example.com/x.png "描述这张图"
```

- 多 `--image` 按顺序 append  
- 路径走 **readable** 解析（cwd + grants + path_escape JIT）  
- remote URL：可选允许列表（默认仅 https；可关）

#### TUI

| 方式 | 行为 |
|------|------|
| **V1 推荐** | 输入行约定：`@path/to.png` 或 `/image path/to.png` 附加到下一条 / 当前缓冲 |
| **V1 可选** | 剪贴板粘贴：检测 PNG/JPEG 魔数 → 写入 `vision/<sid>/` → 附加 ref |
| **展示** | chat 显示 `[image: screenshots/a.png]` 文本占位，不在终端渲图像素 |

伪协议（用户可见文本可保留）：

```text
用户输入: 看看这张图的布局 @./shot.png 有没有重叠
→ user message:
   content: "看看这张图的布局 有没有重叠"  // 或保留 @ 字面量
   vision_refs: [{ path: "shot.png", mime: "image/png", detail: "auto" }]
```

### 4.2 Materialize（发送前）

```typescript
function materializeVisionMessage(msg: ChatMessage, opts: {
  cwd: string;
  grants?: WorkspaceGrant[];
  maxBytesPerImage: number;
  preferRemoteUrl: boolean;
}): ChatMessage  // content: ContentPart[]
```

规则：

1. 无 `vision_refs` 且 `content` 为 string → 原样返回。  
2. 有 refs：  
   - parts = `[{ type:'text', text: caption }, ...image parts]`  
   - 本地 path → `data:${mime};base64,${...}`（读盘；受 maxBytes）  
   - `remote_url` 且 allow → `image_url.url = remote_url`  
3. 读盘失败 / 超限 → 该 ref 降级为 text 行 `[image load failed: path (reason)]`，不整请求炸掉（可配置 strict fail）。  
4. **不**把 data URL 写回 session（仅 API 用 ephemerals 或内存副本）。

### 4.3 assemble / LLM

- `assembleApiMessages`：对 user 消息先 `materialize` 再 strip 内部字段（`vision_refs` / `action_id` / `pointerized` 不发送）。  
- `buildChatBody`：继续 `messages` 直出；OpenAI 兼容 API 认 `content: ContentPart[]`。  
- wire 非 `openai_chat`：V1 可 **拒绝带图请求** 并提示换 profile，或查映射表（V2）。

### 4.4 出站（模型回复）

- Assistant 仍 **纯文本**（V1）。  
- TUI 正常流式文本；无需图渲染。

---

## 5. Token / 预算

| 项 | 建议 |
|----|------|
| 文本 | 现有 `estimateTokens` |
| 图片 | 粗估：`low` ≈ 85 tokens；`high`/`auto` 按边长档（对齐 OpenAI 公开公式的简化版）或固定 **每图 1000/2000** 占位 |
| 压缩 | 优先 **drop 最旧 user 消息的 vision_refs**（保留 text）；不要把 data URL 放进 cold action 除非专门设计 |
| 上限配置 | 见 §7 |

指针化：工具结果仍按文本 pointerize；**用户图不走 action 卡**（除非将来「模型要看工具截图」）。

---

## 6. 安全与权限

| 规则 | 说明 |
|------|------|
| 路径 | 与 `resolveReadablePath` / grants 一致；**禁止**任意 `/etc` 无授权 |
| 写资产目录 | `vision/<session_id>/` 在 session 库或 cwd 下，受 writable 规则 |
| Remote URL | 默认可选 `vision.allow_remote_url: false`；开启后仅 https |
| 隐私 | data URL 不进 transcript 明文（transcript 记 path + mime） |
| Spawn/workflow | V1：**子 Agent / workflow role 默认不传 vision_refs**（避免 silent 成本）；主 Agent only。可选后续 `forward_vision: true` |

---

## 7. 配置（草案）

```jsonc
// agent.json
{
  "vision": {
    "enabled": true,
    "max_images_per_message": 4,
    "max_bytes_per_image": 5242880,
    "default_detail": "auto",
    "allow_remote_url": false,
    "asset_dir": "vision",          // under session dir or cwd
    "materialize_fail": "degrade"   // degrade | throw
  }
}
```

`api_profiles` 可增：

```jsonc
"supports_vision": true
```

无 vision 的 profile 收到图 → 启动时/发送前 clear 报错或自动剥图留 text。

---

## 8. API / 类型迁移注意

| 代码触点 | 改动 |
|----------|------|
| `types.ChatMessage` | `content` 联合类型 |
| `llm.buildChatBody` / stream | 透传 parts；类型放宽 |
| `context/estimate` | 图粗估 |
| `context/assemble` | materialize + strip `vision_refs` |
| `agent.ts` `buildUserTaskMessage` | 支持 refs |
| `runner.runTask` / CLI argv | `--image` |
| TUI submit | 解析 `@path` 或 `/image` |
| session save/load | 校验 refs 路径仍存在（resume 时 warn） |
| pointerize / prune | 仅处理 string content；parts 取 text 拼接做摘要 |

**向后兼容**: 旧 session 全是 string content → 无需迁移。

---

## 9. 实施切片

| ID | 内容 | 依赖 |
|----|------|------|
| **VI-0** | 类型 + `materializeVisionMessage` + 单测 | ✅ |
| **VI-1** | assemble/llm 接线；纯文本回归 | ✅ |
| **VI-2** | CLI `--image` / `--image-url` | ✅ |
| **VI-3** | TUI `@path` 或 `/image` + chat 占位展示 | ✅ `src/tui/vision-input.ts` · `/image` · `pi-app` `visionRefs` |
| **VI-3b** | `read_file` 图片路径 → tool 附加 vision（浏览器截图连贯） | ✅ 无 vision 时返回 profile 切换提示 |
| **VI-4** | session `vision_refs` 持久化 + 资产目录 | VI-2/3 |
| **VI-5** | 预算/上限/profile `supports_vision` | VI-1 |
| **VI-6** | 粘贴剪贴板（可选） | VI-3 |
| **VI-7** | 非 OpenAI wire 映射（可选） | VI-1 |

**建议开工顺序**: VI-0 → VI-1 → VI-2 → VI-4 → VI-3 → VI-5。

---

## 10. 验收

### 功能

- [ ] 无图：与现网一致（单测 + 手测一轮对话）  
- [ ] CLI 一张 png + 文本 → API body 含 `image_url` data URL 或 https  
- [ ] 多图顺序稳定  
- [ ] 路径越界拒绝；grant 内可读  
- [ ] 超大图 degrade/throw 符合配置  
- [ ] session 落盘无巨型 base64；resume 后仍能带图再问（文件仍在）  

### 兼容

- [ ] 旧 session 加载正常  
- [ ] tool_calls / pointerize / workflow / spawn **无图路径** 无回归  

### 安全

- [ ] 不能通过 `@/etc/passwd` 当图发送（非图片或越界）  
- [ ] remote URL 默认关闭  

---

## 11. 风险

| 风险 | 缓解 |
|------|------|
| Session JSON 膨胀 | 只存 refs；materialize 临时 |
| Provider 不认 parts | `supports_vision` + 清晰错误 |
| Token 低估导致超窗 | 保守 per-image 占位 + 张数上限 |
| TUI 无法预览图 | 文本占位足够 V1 |
| 压缩丢掉图语义 | 先丢最旧图 ref，保留 caption |

---

## 12. 版本

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-17 | v0.1 | 初稿：parts 模型、落盘、ingress、materialize、切片 VI-0～7 |

---

*实现以本 spec 验收为准；与 LLM wire 细节冲突时，以所选 profile 的 OpenAI-compatible vision 文档为准做映射表，而不是改 ReAct 主循环语义。*
