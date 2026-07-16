# Session 存储、项目分桶与同会话切目录 Spec（设计）

> **定位**: 全局安装后多目录使用时，如何 **按项目分类会话**，又允许用户在 **同一 session 内** 切换工作目录，并对指定路径做 **手动授权 + 可选权限继承**。  
> **状态**: Design draft v0.2（2026-07-17）· **SW-1～SW-4 初版已落地**（默认仍 `project_local`）  
> **代码锚点**: `src/workspace.ts` · `path-utils.ts` · `runner.setCwd` / `allowWorkspacePath` · `/cwd allow|list|revoke|primary`  
> **相关**: [SPEC_SESSION_AUTO_RUN.md](./SPEC_SESSION_AUTO_RUN.md) · [docs/ROADMAP.md](./docs/ROADMAP.md) §6  

---

## 1. 目标（你要的三件事）

| # | 目标 | 含义 |
|---|------|------|
| **B′** | 保留「项目分类」 | 列表/磁盘按 **项目** 分桶，不把所有聊天糊成一个无限列表 |
| **S** | 同 session 可切目录 | 用户允许时，**不换 session_id** 即可改「当前工作区」 |
| **G** | 手动允许指定目录 + 可选继承权限 | 显式 grant 路径；shell/web 等能力可选择是否跟着 cwd 一起带走 |

**非目标（本草案）**

- 跨机器同步 session  
- 无授权任意写系统目录  
- 把 session 文件本身散落在每个曾访问过的 cwd（见 §3 对比）

---

## 2. 概念拆分（关键）

今天「cwd」混了三件事，要拆开：

| 概念 | 符号 | 职责 |
|------|------|------|
| **Agent 主目录** | `AGENT_HOME` | 全局配置、**会话库根**、可选默认 prefs。例：`~/.minimal-agent` |
| **项目键** | `project_id` | 会话分桶 ID（由「主工作区路径」派生，稳定、可展示） |
| **会话** | `session_id` | 对话/tasks/消息的身份；**跨目录切换时不变** |
| **当前工作区** | `active_cwd` | 工具读写、Agent.md、agent.json merge、workflow 扫描的 **当前** 根 |
| **授权根集合** | `workspace_grants[]` | 本 session 允许触达的路径 + 模式 + 权限继承标记 |

```text
AGENT_HOME/
  agent.json                          # 用户级默认（已有 merge 思路）
  sessions/
    by-project/
      <project_id>/
        session_….json
        transcript_….jsonl
        actions/ …
    index.jsonl                       # 可选：全局最近 session 索引
  projects.json                       # project_id → 展示名、default_cwd、last_seen
```

**原则**:  
- **Session 文件位置** 跟 `project_id`（及 AGENT_HOME），**不**再默认写在「随便 cd 到的目录」里。  
- **工具沙箱** 跟 `active_cwd` + `workspace_grants`，与 session 落盘解耦。

---

## 3. 与现状 / 纯 B 的对比

| 模式 | Session 在哪 | 换目录 | 列表 |
|------|--------------|--------|------|
| **现状** | `<cwd>/.sessions` | `/cwd` 换 root → **另一套** session 库 | 仅当前 cwd |
| **纯 B 全局一把梭** | `~/.minimal-agent/sessions/*` 无分桶 | 可统一 | 易乱 |
| **本设计 B′+S+G** | `AGENT_HOME/sessions/by-project/<id>/` | **同 session** 改 `active_cwd` + grants | 先选项目再选 session，或全局 recent |

---

## 4. `project_id` 怎么定

```text
project_id = hash(real_path(primary_root))  // 如 sha256 前 16 hex
display_name = basename(primary_root) 或用户备注
```

| 字段 | 说明 |
|------|------|
| `primary_root` | 创建 session 时的「主项目路径」（通常是启动 cwd） |
| `project_id` | 稳定键；路径 rename 后可「迁移/重绑」UI，不静默合并 |

`/sessions` 可两级：

1. 项目（最近用过的 primary_root）  
2. 该项目下的 sessions  

可选「全部最近」视图读 `index.jsonl`。

---

## 5. Session 持久化扩展（草案）

```typescript
// 追加到 SessionFile（示意）
interface SessionWorkspaceState {
  /** 分桶键 */
  project_id: string;
  /** 主项目根（创建时）；展示与默认回跳 */
  primary_root: string;
  /** 当前工具 cwd */
  active_cwd: string;
  /** 本 session 授权的额外/含主根的路径 */
  workspace_grants: WorkspaceGrant[];
  /** 切换 active_cwd 时，shell/web 是否继承（默认 false 更安全） */
  inherit_capabilities_on_cwd_switch?: boolean;
}

interface WorkspaceGrant {
  /** 绝对路径，已 realpath */
  root: string;
  /** read_only | read_write */
  mode: 'read_only' | 'read_write';
  /** once | session | sticky（写入用户 prefs，跨 session） */
  scope: 'once' | 'session' | 'sticky';
  /** 在该 root 下是否默认允许 shell（仍受全局 allowShell 总闸） */
  shell?: boolean;
  /** 在该 root 下是否默认允许 web */
  web?: boolean;
  granted_at: number;
  label?: string;  // 用户备注 "lab repo"
}
```

- **创建 session**: `primary_root = active_cwd = 启动 cwd`；`grants = [{ root: primary, mode: 'read_write', scope: 'session' }]`。  
- **不在** SessionFile 里存全量消息的第二套 cwd 历史亦可：`active_cwd` 一条足够；切换可记 `cwd_history[]` 可选。

---

## 6. 同 session 切目录（流程）

### 6.1 用户动作

| 动作 | 行为 |
|------|------|
| `/cwd <path>` | 解析绝对路径 → 见 6.2 |
| `/cwd allow <path> [--ro\|--rw] [--shell] [--web] [--sticky]` | 只加 grant，不立刻切 |
| `/cwd list` | 列 active_cwd + grants |
| `/cwd primary` | 切回 `primary_root` |

### 6.2 切换判定

```text
target = realpath(path)

if target under any grant with sufficient mode:
  set active_cwd = target
  maybe re-load project-local agent.json / Agent.md from target
  if inherit_capabilities_on_cwd_switch:
    保持 config.allowShell/Web
  else:
    可降级为「仅 grant 上标注的 shell/web」，或回到 session 级 grant
else:
  prompt user:
    [Allow once] [Allow session] [Allow sticky] [Deny]
    mode: read-only / read-write
    optional: inherit shell/web for this root?
  if approved → push grant → set active_cwd
```

### 6.3 与「换项目」的区别

| | 同 session 切目录 | 新开项目 session |
|--|-------------------|------------------|
| `session_id` | 不变 | 新 |
| `project_id` | **默认不变**（仍挂在 primary 桶） | 新桶 |
| 适用 | lab 挂载、monorepo 子包、临时 /tmp | 完全另一个产品 |

**可选高级**: 「把当前 session 重绑到新 project_id」= 迁移文件 + 改 index（慎用，单独命令 `/session rebind`）。

**默认建议**: 切到「另一个 git 根」时 **警告**：「仍记在项目 A 的会话下；是否新开 session？」避免历史错位。

---

## 7. 路径解析（工具层）

替换「仅 cwd」为：

```text
resolveReadable(path):
  abs = resolve(active_cwd or absolute)
  if under any grant (read_only or read_write): ok
  else if under path_escape JIT (legacy): ok once
  else: deny

resolveWritable(path):
  abs = …
  if under some grant with mode read_write: ok
  else: deny   // 永不因 JIT 放行写（与现状一致）
```

`setWorkspaceRoot` 语义调整为：

- **session 库根** = `AGENT_HOME`（固定）  
- **active_cwd** = 当前工具根（可变）  
- 或保留 `setWorkspaceRoot` 只改 active，sessionsDir 改为 `agentHome/sessions/by-project/…`

Jobs 路径建议：

```text
AGENT_HOME/jobs/<session_id>/… 
// 或仍 active_cwd/workspace/jobs 但 session 元数据在 AGENT_HOME
```

（实现时二选一写死，避免双写。）

---

## 8. 权限继承（「可选」怎么定义）

分三层，避免「一切目录自动 sudo」：

| 层 | 内容 | 默认 |
|----|------|------|
| **L0 全局 prefs** | alwaysShell / alwaysWeb（已有） | 用户显式 |
| **L1 Session 能力** | 本 session 曾批准的 shell/web（已有 sessionGrants） | 不自动因 cwd 清空 |
| **L2 Grant 绑定** | 某 `root` 上的 shell/web 标记 | **默认 false** |

切换 `active_cwd` 时：

| 策略名 | 行为 | 适用 |
|--------|------|------|
| `strict`（推荐默认） | 新 root 若 grant 未标 shell/web，则 **即使** session 有 shell，在该 root 跑 shell 仍再确认一次（或拒绝直到 grant） | 实验仓 |
| `inherit_session` | session 级 shell/web **带到** 新 active_cwd | 信任的 monorepo |
| `inherit_grant_only` | 仅当 grant.shell/web 为 true 才允许 | 精细控制 |

配置：

```jsonc
// agent.json 或 ~/.minimal-agent/agent.json
{
  "agent_home": "~/.minimal-agent",
  "session_store": "agent_home",   // agent_home | project_local（兼容现状）
  "cwd_switch": {
    "default_capability_policy": "strict",
    "warn_if_leaving_primary_git_root": true
  }
}
```

---

## 9. 生命周期示意

```text
$ minimal-agent                    # 全局 bin，cwd=/work/app
  → project_id=hash(/work/app)
  → session 存在 AGENT_HOME/sessions/by-project/<id>/
  → active_cwd=/work/app
  → grant[/work/app]=rw session

用户: /cwd allow ../lab --rw --shell --session
  → grant[realpath(../lab)]=rw+shell session

用户: /cwd ../lab
  → active_cwd=lab
  → 工具读写 lab；session_id 不变；列表仍在 app 项目桶
  → strict 下 web 若未 grant 仍 JIT

用户: /cwd /tmp/scratch
  → 未授权 → 弹窗 Allow session ro?
  → 用户选 session + ro → grant + 切换
```

---

## 10. 兼容与迁移

| 阶段 | 行为 |
|------|------|
| **P0 现状** | `session_store=project_local`（`<cwd>/.sessions`） |
| **P1** | `session_store=agent_home` + project 分桶；创建新 session 用新路径 |
| **P2** | 启动时扫描旧 `<cwd>/.sessions` 提供「导入到 AGENT_HOME」 |
| **P3** | SessionFile 写入 `workspace` 块；`/cwd allow`；路径多根解析 |
| **P4** | sticky grants 进 prefs；capability 策略 strict/inherit |

全局安装默认：`session_store=agent_home`；纯源码开发可继续 project_local。

---

## 11. 安全红线

1. **写** 永不靠「误点 once」放到 `$HOME` 任意处；rw grant 必须路径明确。  
2. sticky grant 进磁盘 prefs，列表可 `/cwd list` 与 `/cwd revoke`。  
3. `primary_root` 外的 rw+shell 默认 **二次确认**。  
4. spawn 子 Agent：默认 **仅继承 active_cwd + 同 grants 的只读子集** 或仅 active_cwd（实现时写死更严的一种）。  
5. path_escape 旧 JIT 可保留为「未进 grant 表的临时读」。

---

## 12. 实施切片（有需求再开）

| ID | 内容 |
|----|------|
| **SW-1** | `AGENT_HOME` + `sessions/by-project/<id>/` + project_id 派生 | ✅ `session_store` / `agent_home` |
| **SW-2** | SessionFile.workspace；create/resume 恢复 | ✅ |
| **SW-3** | 多根 resolveReadable/Writable via grants | ✅ |
| **SW-4** | `/cwd allow|list|revoke|primary` + setCwd grantIfMissing | ✅ 基础 |
| **SW-5** | capability 策略 strict 初值（切外国 root 时收紧 shell/web） | 部分 |
| **SW-6** | 从 project_local `.sessions` 导入 | ⏳ |

启用 agent_home（`agent.json`）:

```json
"session_store": "agent_home",
"agent_home": "~/.minimal-agent"
```

---

## 13. 验收（设计层）

- [ ] 两项目 A/B：session 列表按项目分；不混文件  
- [ ] 同 session 授权 lab 后切换：`session_id` 不变，对话连续，文件写在 lab  
- [ ] 未授权目录写失败；读可 JIT 或拒绝  
- [ ] strict 下切到无 shell grant 的目录，危险命令再确认  
- [ ] 全局 bin 在任意 cwd 启动，session 进 AGENT_HOME 而非「装 bin 的 node_modules」  

---

## 14. 版本

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-17 | v0.1 | 初稿：AGENT_HOME 分桶、active_cwd、grants、权限继承策略、切片 |

---

*本文件为设计占位；落地前以「session 身份 / 项目分桶 / 工具沙箱」三分离为验收准绳。*
