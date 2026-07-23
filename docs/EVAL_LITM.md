# EVAL · Lost in the Middle 与长程 Agent 实验纲要

> **状态**: Draft v1.1（2026-07-23）· **E0 scaffold ✅**（`eval/` 金题 + 策略；无 API run CLI）  
> **目标**: 用可复现的对比实验，说明 minimal-agent-ts 的存在意义——在**原生消息数组**上做细粒度上下文工程，而不是再堆一层 Memory/RAG/状态机外挂。  
> **原则**: 不宣称银弹；先少而硬的任务与指标；数字必须可复现。  
> **相关**: [README.md](../README.md) · [eval/README.md](../eval/README.md) · [SPEC_CONTEXT_MANAGEMENT.md](../SPEC_CONTEXT_MANAGEMENT.md) · [SPEC_POINTERIZE_SCOPE.md](../SPEC_POINTERIZE_SCOPE.md) · [docs/ROADMAP.md](./ROADMAP.md)

---

## 0. 一句话主张

长程 Agent 失败，常常不是「窗口不够大」，而是：

1. **热路径结构失真**——工具全文、重复历史把注意力淹没；  
2. **注意力几何**——装得下 ≠ 找得到（Lost in the Middle）；  
3. **前缀不稳**——摘要/重写破坏 cache，越跑越贵。

**minimal-agent-ts** 的实验切入点：在**不依赖向量库、黑盒 Memory、重状态机**的前提下，用指针化冷热分离、漏斗式压缩、可选的 LLM 侧工作记忆控制，改造**最原生的 messages 数组**。

对外可检验声明（待数据填空）：

> 在固定模型与任务下，相对「全量 transcript 回写」基线，minimal 在足够长的 turn 档上应表现为：**成功率更稳、热路径 token 增长更慢、重复工具更少、单位成功成本更低**。

---

## 1. 问题：Lost in the Middle 与长程失忆

### 1.1 现象谱（工程侧）

| 阶段（约） | 常见表现 |
|------------|----------|
| ~10 turn | 目标、文件、工具结果仍连贯 |
| ~20 turn | 偶发遗忘细节；重复读已读文件 |
| ~30 turn | 局部循环；刚写的改动转头就问「我改了哪」 |
| ≥50 turn | 目标漂移；token 已烧、任务仍迷 |

### 1.2 问题分层（实验必须拆开）

| 层 | 代号 | 含义 | 经典线索 |
|----|------|------|----------|
| A | **注意力几何** | 中间段 recall 差；装下 ≠ 找到 | Liu et al., *Lost in the Middle* (2023) |
| B | **上下文膨胀** | tool dump 线性进 messages，每轮重编码 | 各 harness 默认 transcript |
| C | **前缀不稳** | 历史被 rewrite/摘要 → cache 失效 | 商业 API prefix/KV cache 实践 |
| D | **控制失效** | 循环工具、目标漂移 | loop guard / 规则补丁 |
| E | **外挂失真** | RAG 错召回、摘要丢关键细节 | Memory 系统常见 failure |

**本仓库主攻 B + C**（结构与膨胀），用结构手段**缓解** A/D 的工程表现；**不把 E 当默认解**，但可作对照条件。

### 1.3 不是本实验的目标

- 全面对标所有商业 Agent 产品的功能清单  
- 证明「永远不需要 Memory/DAG」  
- 在无验收脚本的开放任务上「主观感觉更好」  
- 用不可复现的单次 demo 曲线当论文结论  

---

## 2. 行业解法地图（对比用，非踩踏）

| 族 | 思路 | 主要缓解 | 典型代价 / 盲区 |
|----|------|----------|-----------------|
| **W 窗口派** | 更大 context | 装得下 | 不保证找得到；成本↑ |
| **M Memory/RAG 派** | 向量库 + 召回 | 外存 | 召回误差、系统复杂、与当前 turn 结构脱节 |
| **S 摘要/裁剪派** | 滚动 summary、drop 旧轮 | 压长度 | 不可逆丢信息；前缀抖动 |
| **F 流程/状态机派** | DAG/图、节点局部上下文 | 控制与分工 | 灵活性↓；节点内仍可能 LITM |
| **R 规则守卫派** | 循环检测、强制 stop | 止血 | 不改善表征质量 |
| **P 指针/冷热分离派** | 长结果落盘 + 热路径卡片 + 漏斗压缩 + 可选 LLM 工作记忆控制 | 膨胀、前缀、可 recall | 工程纪律要求高；**非银弹** |

### 2.1 minimal 在地图上的位置

```text
默认路径：P（结构）
可选对照：S（摘要）、W（更大预算）、M（外挂 Memory，可选）
编排能力：F（workflow/DAG）是产品能力，长程 LITM 主实验可先固定「单 Agent 长 transcript」以免混杂
```

**话术锚点**：

- 别人常在 **messages 之外** 加系统；  
- 我们在 **messages 之上** 改结构；  
- 目标是 **可检验的 tradeoff**，不是唯一正确宗教。

---

## 3. 实验设计：控制变量

### 3.1 自变量

| 变量 | 建议水平 | 备注 |
|------|----------|------|
| **策略 / 框架** | `naive_full` · `summary_rolling` · `minimal_full` · `minimal_no_pointerize`（消融） | 第一批只做这些即可 |
| **模型** | 固定 1 个主模型；可选 +1 | 先锁模型，避免 confounds |
| **上下文预算** | small / medium / large（token 上限或 keep window） | 测「装得下仍失败」 |
| **任务长度档** | 目标 turn：10 / 30 / 60 / 90+ | 长程曲线横轴 |
| **工具噪声** | low / high（小文件 vs 大 read、多 shell dump） | 放大 B 层 |
| **外挂 Memory** | off（默认）/ on（可选对照） | 证明无外挂也能干活 |

### 3.2 应固定的混淆因素

| 固定项 | 说明 |
|--------|------|
| 同一 `cwd` 与只读/可写沙箱规则 | 任务可脚本验收 |
| 同一 tool 集合（或明确子集） | 禁止一边能 web 一边不能 |
| 同一随机种子 / 温度（若 API 支持） | 可复现 |
| 同一超时与 max_turns 硬顶 | 失败可归因 |
| 禁止人工中途改 prompt | 除「任务规范内」的中途改需求脚本 |

### 3.3 因变量：四层指标

对外主叙事优先用 **L1 + L3**；L2 证明「结构在起作用」；L4 可选学术强度。

#### L1 任务成功（主叙事）

| 指标 ID | 名称 | 定义 |
|---------|------|------|
| `task_success` | Task Success | 验收脚本通过（0/1 或 checklist 比例） |
| `goal_retention` | Goal Retention | 第 N 轮探针题：能否复述初始目标（0/1 或分数） |
| `repeat_tool_rate` | Repeat Tool Rate | 重复（同 tool + 同关键参，如 path）调用占比 |
| `loop_incidents` | Loop Incidents | 循环检测触发次数或人工标注死循环次数 |

#### L2 上下文健康（特殊性证据）

| 指标 ID | 名称 | 定义 |
|---------|------|------|
| `hot_tokens_mean` / `hot_tokens_p95` | Hot Context Tokens | 每轮送入 API 的 messages 估计 token（均值 / P95） |
| `cold_store_bytes` | Cold Store Bytes | action / 冷存落盘字节（信息未丢的对照） |
| `pointer_density` | Pointer Density | 热路径中 pointer 卡片 vs 全文 tool 比例 |
| `prefix_stability` | Prefix Stability | 相邻轮 system+前缀长度/哈希变化率（cache 友好代理） |

#### L3 成本与延迟

| 指标 ID | 名称 | 定义 |
|---------|------|------|
| `cost_per_success` | $ / 成功任务 | 或 `tokens_per_success_turn` |
| `cache_hit_rate` | Cache Hit Rate | API 若暴露则记；否则缺省用 `prefix_stability` |
| `wall_ms_per_turn` | Wall time / turn | 工程体验 |

#### L4 中间定位（可选）

| 指标 ID | 名称 | 定义 |
|---------|------|------|
| `needle_recall` | Needle-in-history | 第 k 轮植入事实，第 k+Δ 轮探测准确率 |
| `mid_context_probe` | Mid-context Probe | 对中间段 tool 结果的问答准确率 |

### 3.4 主图约定（避免仪表盘爆炸）

默认只发 **4 条曲线**，横轴为 turn 档（或累计 turn）：

1. `task_success`  
2. `repeat_tool_rate`  
3. `hot_tokens_mean`（或 P95）  
4. `cost_per_success`（或 tokens / success）

其余指标进附录表。

---

## 4. 长程 Benchmark 任务族

### 4.1 设计原则

- **少而硬**：第一批建议 **3 族 × 2 题 = 6 题**  
- **可脚本验收**：`score` 退出码或 JSON  
- **可重复**：固定 prompt、cwd 模板、工具策略  
- **噪声可控**：每题标注 `noise: low|high`

### 4.2 任务族定义

| 族 ID | 名称 | 形态 | 主要压力 |
|-------|------|------|----------|
| `repo_long` | Repo 改造长程 | 多文件实现 + 可选中途改需求 + 自测 | 真实工具噪声、目标保持 |
| `multi_doc` | 多文档综合 | 读多份文档/代码后写报告或改一处 | 中间段信息、综合 |
| `state_chain` | 状态依赖链 | 每步依赖前序 tool 输出（hash/路径/配置） | 是否靠热路径 vs 可 recall |

### 4.3 单题目录约定（建议）

```text
eval/
  tasks/
    <task_id>/
      TASK.md           # 人类可读题面
      meta.json         # 族、噪声、turn 预算、模型约束
      setup.sh          # 可选：准备沙箱 cwd
      score.sh          # 验收：0=pass
      probes/           # 可选：goal_retention / needle 探针 prompt
  runs/                 # gitignore：跑分原始日志
  reports/              # 汇总表与图（可提交精选）
```

#### `meta.json` 示例字段

```json
{
  "id": "repo_long_01",
  "family": "repo_long",
  "noise": "high",
  "max_turns": 60,
  "timeout_sec": 3600,
  "tools": "default",
  "acceptance": "score.sh"
}
```

### 4.4 策略配置约定（建议）

| 策略 ID | 含义 | minimal 实现方向 |
|---------|------|------------------|
| `naive_full` | 全量 tool 回写、无 pointerize | 关闭 pointerize / 放大 keep，或独立 thin harness |
| `summary_rolling` | 每 N 轮摘要替换旧历史 | 实验脚本层或配置开关（待实现） |
| `minimal_full` | 默认 pointerize + context pipeline | 生产默认路径 |
| `minimal_no_pointerize` | 同 harness 消融 | 配置关 pointerize |

第一阶段允许 **只对比 `naive_full` vs `minimal_full`**，再补消融。

---

## 5. 实验分期与交付物

### Phase 0 — 定义与仪表（文档期：本文）

| 交付 | 说明 |
|------|------|
| 本文 `docs/EVAL_LITM.md` | 问题、地图、变量、指标、任务族 |
| 指标词典冻结 | §3.3 的 ID 不随意改名 |
| 遥测缺口表 | 见 §6（随实现更新） |

### Phase 1 — 单 harness 长程曲线（minimal 自身）

| 内容 | 说明 |
|------|------|
| 固定 1 模型 | 扫 turn 档 10 / 30 / 60 / 90 |
| 消融 | pointerize on/off；不同 `keep_inline_turns` |
| 产出 | Success & Hot Tokens vs turns |
| 叙事 | 「结构旋钮改变了膨胀与重复读」 |

### Phase 2 — 策略对比

| 内容 | 说明 |
|------|------|
| 同模型同题同预算 | `naive_full` / `summary_rolling` / `minimal_full` |
| 产出表 | Success · Repeat · Hot Tokens · $ |
| 叙事 | 补丁派 vs 结构派的 tradeoff（不是道德审判） |

### Phase 3 — LITM 探针（可选）

| 内容 | 说明 |
|------|------|
| `needle_recall` · `mid_context_probe` | 学术强度 |
| 对照 | 更大 context 预算（W 派）是否单独救场 |

### Phase 4 — 对外包装

| 内容 | 说明 |
|------|------|
| README「实验与数字」 | 可复现命令 + 主图 |
| 局限声明 | 非全面榜；非替代所有 Memory/DAG 场景 |
| 开源 `eval/` 与精选 `reports/` | 欢迎复现与挑刺 |

---

## 6. 遥测与实现缺口（与代码对齐）

> 本节随实现更新。v1.0 仅列**目标字段**与已知锚点。

### 6.1 每轮建议记录（JSONL 一行一 turn）

| 字段 | 来源方向 |
|------|----------|
| `run_id`, `task_id`, `strategy`, `model`, `turn` | harness |
| `prompt_tokens`, `completion_tokens`, `cache_*` | LLM 响应 / 现有 cache 遥测 |
| `messages_chars` / `est_tokens` | assemble 前后估计 |
| `tool_calls[]`：name, path/key, call_id | tool_result 事件 |
| `pointerized` / `inline` 计数 | pointerize 管线 |
| `action_store_bytes` | action IO（参见 `action-io-metrics`） |
| `loop_guard_fired` | loop guard |
| `wall_ms` | harness 计时 |

### 6.2 已知代码锚点（非完整列表）

| 区域 | 路径 |
|------|------|
| 上下文 / 指针化 | `SPEC_CONTEXT_MANAGEMENT.md`, `src/pointerize.ts`, `src/context/*` |
| Action 落盘与 IO 指标 | `src/action-io-metrics.ts`, tests |
| Token / cache | LLM 绑定与 run 事件（TUI 底栏曾展示 cache） |
| Loop | loop guard 配置与事件 |

### 6.3 明确待补（实现期）

- [x] **E0**: `eval/` 骨架 · 策略 JSON · `state_chain_01` + `setup.sh`/`score.sh` · `npm run eval:smoke`  
- [ ] **E1**: 统一 `eval run` CLI：题 × 策略 × 导出 JSONL + manifest  
- [x] `naive_full` / 消融的**稳定开关**（`eval/strategies/*.json` 配置覆盖；E1 接线）  
- [x] `score.sh` 约定与 1 道金题端到端（本地无 API smoke）  
- [ ] 主图生成脚本（CSV/JSONL → png 或 markdown 表）  
- [ ] API cache 字段各厂商差异的归一化层  

---

## 7. 存在意义与特殊性（对外表述）

### 7.1 三段式

1. **问题**：长程失败主因常是热路径结构失真 + 注意力几何，不单是窗口大小。  
2. **路径**：在原生 messages 上做冷热分离与漏斗压缩，默认不引入向量库与重状态机服务。  
3. **可检验**：固定模型与任务下，用 §3–§4 的变量与指标公开对比；数字说话，失败也公开。

### 7.2 特殊性（相对「又一个 Agent 壳」）

| 不是 | 而是 |
|------|------|
| 功能最多的 IDE 插件 | 上下文结构的实验床 |
| 必须绑定某云 Memory | 可选外挂；默认结构自洽 |
| 口头「90 轮还行」 | 可复现 turn 档曲线与消融 |
| 贬低 DAG/RAG | 在地图上定位 P 族，并能量化 tradeoff |

### 7.3 与产品功能的边界

- Web UI / MCP / workflow 等**可以继续存在**，但**不占用本实验主叙事**。  
- 长程 LITM 主实验优先 **单 Agent 长任务**；多角色 DAG 作为**另一条轨**（控制变量不同）。  

---

## 8. 决策默认值（v1.0）

| # | 决策 | 默认 |
|---|------|------|
| 1 | 主模型 | 1 个成本可控、稳定的 OpenAI 兼容 API（具体型号写入每次 report） |
| 2 | 第一批题量 | **6**（3 族 × 2） |
| 3 | 主 baseline | `naive_full` |
| 4 | 主指标四件套 | `task_success` · `repeat_tool_rate` · `hot_tokens_*` · `cost_per_success` |
| 5 | 文档 | 本文 + 后续 `eval/` |
| 6 | Memory 外挂 | 默认 **off** |
| 7 | 运行中改配置 | 禁止；策略在 run 启动时冻结 |

---

## 9. 伦理与诚实声明

- 实验使用真实 API 时注明**费用与模型名**；不隐藏失败 run。  
- 不把单次最优 run 当分布结论；至少报告 n 与方差/区间（n 小时也要写清）。  
- 不暗示「已解决 Lost in the Middle」；只报告**相对策略的可复现差异**。  
- 任务数据若含敏感路径，report 中脱敏。  

---

## 10. 修订记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-20 | v1.0 | 首版：问题分层、解法地图、变量/指标、任务族、分期、遥测缺口、对外表述 |
| 2026-07-23 | v1.1 | E0：`eval/` 骨架、strategies、`state_chain_01`、本地 smoke |

---

## 11. 下一步（实现清单）

1. ~~建立 `eval/tasks/` 与至少 1 道金题 + `score.sh`~~ ✅ E0  
2. **E1**: 导出每轮 JSONL + `eval run`（对接 metrics / json-events）  
3. 跑通 `minimal_full` vs `minimal_no_pointerize` 在 turn≤30 的小 n 对比  
4. 把第一张主图链回 README「实验与数字」（有稳定数字后再写）  

操作入口：[eval/README.md](../eval/README.md) · `npm run eval:smoke`
