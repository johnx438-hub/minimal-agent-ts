# minimal-agent-ts

> [中文版](./README_CN.md) | English

## Contextual Event Position Encoding: From Tokens to Events

LLMs understand language partly through position encoding — each token's ordinal position tells the model "this word follows that word." Transformer architectures have done this from day one.

But if we treat an agent's conversation history as "text" the LLM needs to understand, a question arises: **does conversation history have position encoding?**

It doesn't. Every agent framework today treats conversation history as a flat message array: user said X, assistant replied Y, tool returned Z — new messages pile on top of old ones, and when the window fills up, the framework either truncates, summarizes, or offloads to a vector database. Nobody addresses the **temporal structure** of the message array itself.

A key phenomenon in long-running tasks — Lost in the Middle — correlates directly with this missing structure: the LLM doesn't "forget" the context; in a flat pile of messages with no temporal markers, its attention has nowhere to anchor.

### From Token-Level to Event-Level

minimal-agent-ts does one thing: **gives conversation events a position encoding.**

On top of the native message array, it replaces full result insertions with pointer cards that preserve temporal structure. Each pointer card carries three pieces of information:

- **Temporal coordinate**: `turn=N` — exactly which turn this event occurred in
- **Event summary**: `read_file(path=agent-prompt.ts, sha256=xxx)` — content fingerprint without reading the full result
- **Recall entry**: `action_id` — on-demand full-content loading from cold storage

This turns conversation history from "a bowl of porridge" into "a timeline." When the model reads it, attention heads naturally anchor on event cards with explicit spatiotemporal coordinates. This is an upward borrowing of the LLM's own position-encoding capability: token position encoding makes word order comprehensible; event position encoding makes conversational structure navigable.

### No External Dependencies

This approach requires no vector databases, no RAG, no complex state machines, no Memory modules. It does one thing: **return to the native message array and apply fine-grained structural engineering.**

- **Pointer-based hot/cold separation**: long results land on disk (`.sessions/actions/`), leaving only pointer cards in the conversation
- **Funnel compression**: manage context like an OS manages memory — pointerize → prune → compact → threshold-triggered summarization, stepwise
- **Prefix cache-friendly**: static system prompt + stable pointer card format → KV-cache reusable → 95%+ steady-state hit rate
- **LLM self-regulation**: the model can proactively extend the inline retention window for critical events via the `context_focus` tool — the framework doesn't make every decision for it

TypeScript implementation, hand-written ReAct main loop, ~600 test cases, no vendor lock-in to any commercial API or closed runtime.

**Repository**: https://github.com/johnx438-hub/minimal-agent-ts

### Repo Layout: Core + TUI (recommended) · GUI (WIP)

Single monorepo. **Default path = terminal TUI + core**; the browser UI is **not** the front door.

| Path | Contents | Who needs it |
|------|----------|-------------|
| Root `src/` · `bin/` | Agent Runtime, **TUI**, Web **API** (`npm run web`) | **Almost everyone** |
| `public/web-ui/` | Info page when running `npm run web` (not a product UI) | Incidental when opening the API port |
| `public/web-ui-legacy/` | Early static shell, **archived** | Archaeology only |
| `minimal-gui/` | Next.js browser UI | **Maintainer dogfood · WIP · not recommended** |
| `docs/EVAL_LITM.md` etc. | Long-horizon experiments & specs | Evaluation / secondary development |

**Convention:**

| Label | Meaning |
|-------|---------|
| **Without GUI (recommended)** | Terminal agent only; don't `cd minimal-gui` |
| **GUI · WIP** | Optional; rough edges; not listed under "stable capabilities" |

> The npm package does **not** include `minimal-gui`. `git clone` brings it along — **ignore it** unless you maintain the browser UI.

| Doc | Purpose |
|-----|---------|
| [QUICKSTART.md](./QUICKSTART.md) | Install & common commands |
| [docs/DEPS.md](./docs/DEPS.md) | Required/optional deps |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Project direction |
| [docs/EVAL_LITM.md](./docs/EVAL_LITM.md) · [eval/README.md](./eval/README.md) | Lost in the Middle eval plan + harness E0–E3 |
| [SPEC_CONTEXT_MANAGEMENT.md](./SPEC_CONTEXT_MANAGEMENT.md) | Context & pointerize design details |
| [SPEC_CONTEXT_POLICY.md](./SPEC_CONTEXT_POLICY.md) · [agent.context.example.json](./agent.context.example.json) | Tunable context knobs (`context_policy` in agent.json) |
| [SPEC_TOOLS.md](./SPEC_TOOLS.md) · [SPEC_TUI.md](./SPEC_TUI.md) · [SPEC_LLM_ROUTER.md](./SPEC_LLM_ROUTER.md) | Tools / TUI / multi-model router specs |

Verify: `npm test` · `npm run typecheck` (~600 test cases)

---

## Updates · 2026-07-23

Ship notes between product framing (above) and install (below). Details: [eval/NOTES_live_2026-07-23.md](./eval/NOTES_live_2026-07-23.md) · [eval/README.md](./eval/README.md) · [docs/EVAL_LITM.md](./docs/EVAL_LITM.md) · [SPEC_CONTEXT_POLICY.md](./SPEC_CONTEXT_POLICY.md).

### What we optimized for (read this first)

| Priority | Claim | Today’s stance |
|----------|--------|----------------|
| **P0** | **Event structure** — turn-marked pointer cards, timeline hot path, cold `recall_query` | Core product bet (same as the framing above); not a separate “structure score” metric yet |
| **P1** | **Pointerize does not imply higher prompt cost** vs keeping full tool bodies | On a clean multi-turn multi_doc pair, **eager ≤ no-pointerize** on hot tokens (~1.6–2.3% lower mean/p95/Σ, n=1) — see live note |
| **P2** | Large funnel savings under heavy pressure | **Not** the headline of this task (little early pointerize) |

Skeptics often say “rewriting earlier turns into cards wastes more tokens.” Our aligned live trajectory **does not support that**; the larger product answer is still **clearer event structure**, not a giant compression percentage.

### Live snapshot worth citing (narrow)

- **Task**: `multi_doc_01` segmented (≤2 `docs/*` reads/turn, 7 files, large distractors)  
- **Pair**: `minimal_pointerize_eager` (`keep=0`, `tool_deny: [context_focus]`) vs `minimal_no_pointerize` (`keep=200`)  
- **Model**: `deepseek-v4-pro` · both **script-pass** · 8 turns / 10 tools · `repeat_tool_rate=0`  
- **Hot path**: eager mean **15615** vs no-ptr **15870**; prompt Σ **124918** vs **126957**  
- **Report**: [eval/reports/live_multi_doc_segmented.md](./eval/reports/live_multi_doc_segmented.md) (use `--run-ids` only — do not mix older multi_doc runs)  
- **Full write-up**: [eval/NOTES_live_2026-07-23.md](./eval/NOTES_live_2026-07-23.md)

**Not claimed:** large token savings, LITM accuracy win, or n≥3 distributions.

### Context engineering shipped

| Area | What landed |
|------|-------------|
| **Token self-calibration** | Session EWMA from `prompt_tokens` / local estimate (`TokenCalibrator`); scale=1 until samples; `DEBUG_TOKEN_CAL=1` |
| **`context_policy` (C1–C4)** | Budget / heavy / protect / prune / calibrator knobs in `agent.json`; [agent.context.example.json](./agent.context.example.json) · [QUICKSTART.md](./QUICKSTART.md) §6.1 |

### Eval harness (E0–E3+)

| Stage | Capability |
|-------|------------|
| **E0–E2** | Tasks, strategies, `eval:run` / `aggregate` / `compare`, dry-run, reports |
| **E3+** | `multi_doc_01` (segmented reads), `minimal_pointerize_eager`, path fingerprints, `tool_deny`, aggregate `--run-ids` / `--git-sha` |

```bash
npm run eval:list
npm run eval:run -- --task multi_doc_01 --strategy minimal_pointerize_eager --max-turns 50
npm run eval:run -- --task multi_doc_01 --strategy minimal_no_pointerize --max-turns 50
npm run eval:aggregate -- --no-dry-run --run-ids <eager_id>,<nop_id> --out-name clean_pair
```

### Notable commits (today’s arc)

`92842c4` calibrator · `d393377`/`cfa06ef` context_policy · eval E0–E3 · fingerprint / `tool_deny` / segmented multi_doc · `0269a3a` live notes

---

## Quick Start

### A. Without GUI (recommended for trying out / TUI only)

Requires only **Node ≥ 22** + an API key. **No** Next.js install, **no** browser needed.

#### Option 1: npm BETA — **not yet published** (packaging ready, coming soon)

> ⚠️ **No `minimal-agent-ts` package exists on the registry yet.**  
> The repo has completed `0.1.0-beta.1` packaging with `bin`/`dist`/`files` and `npm pack` self-testing; the author will `npm publish --tag beta` after completing npm 2FA.  
> **Use Option 2 (source) to try it now.** The install commands below are crossed out and will be un-struck when published.

```bash
# ── Available after publish (core + TUI only, no GUI in package) ──
# npm install -g minimal-agent-ts@beta
# # In a directory with agent.json and .env:
# minimal-agent                    # interactive TUI
# minimal-agent-run "your task"   # headless single task
```

~~`npm install -g minimal-agent-ts@beta`~~ · ~~`minimal-agent`~~ · ~~`minimal-agent-run "…"`~~  
(Same — **not yet available**, pending npm publish.)

#### Option 2: From source (**works now** · no GUI)

```bash
git clone https://github.com/johnx438-hub/minimal-agent-ts.git
cd minimal-agent-ts
npm install                      # root package.json only (no GUI Next.js deps)
cp .env.example .env             # keys go in .env only, never commit
# Edit .env: at minimum DEEPSEEK_API_KEY=sk-xxx (or your profile's env var)

npm run tui                      # interactive TUI (no GUI)
npm start -- "Read the README and summarize the project in three sentences" # headless
```

Terminal only — you're done. Do **not** run `cd minimal-gui && npm install`.

Optional: clone without the GUI directory (cleaner):

```bash
git clone --filter=blob:none --sparse https://github.com/johnx438-hub/minimal-agent-ts.git
cd minimal-agent-ts
git sparse-checkout set '/*' '!minimal-gui'
npm install && cp .env.example .env && npm run tui
```

### B. GUI · WIP (maintainer dogfood · **not recommended**)

The browser UI was used for internal demos and **has not been polished for recommendation**. See [`minimal-gui/README.md`](./minimal-gui/README.md) if needed.

```bash
# After completing option A (source) steps:
npm run web -- --allow-shell --web-port 7788   # terminal 1: API only
cd minimal-gui && npm install && npm run dev   # terminal 2: Next.js WIP
```

| Command | Product GUI? | Notes |
|---------|-------------|-------|
| ~~`minimal-agent` / `minimal-agent-run`~~ | No | npm CLI · **not yet published** |
| `npm run tui` / `npm start` | No | **Currently recommended** · terminal agent |
| `npm run web` | No | harness **API**; browser only shows an info page (not a chat UI) |
| `public/web-ui-legacy/` | No | **Archived** old static shell |
| `minimal-gui` → `npm run dev` | WIP | Experimental Next.js UI; requires `npm run web` first |

In the TUI, `npm run tui -- --web` only starts the API alongside — it does **not** launch `minimal-gui`.

---

## Five-Layer Value Pyramid

The target pain points gave rise to five architectural layers, from foundation to apex:

```
           ┌──────────────────────────┐
           │ ⑤ Source economy          │  ~100 TS files doing what others need 300+ for
           ├──────────────────────────┤
           │ ④ Background multi-agent   │  No message bus — filesystem as communication
           ├──────────────────────────┤
           │ ③ Prefix-cache friendly    │  Frozen pointer cards → 95%+ cache hit in steady state
           ├──────────────────────────┤
           │ ② Structured context       │  Event timeline vs. traditional flat information stream
           ├──────────────────────────┤
           │ ① Long-horizon stability   │  90 turns without degradation, confusion, or cost explosion
           └──────────────────────────┘
```

- **① Long-horizon stability**: After 90 turns, the agent is still "writing a diary" recalling the temporal order of task events.
- **② Structured context**: Conversation history is not one long text blob — it's an "event card" timeline (type + hash + summary + pointer). The agent sees a timeline, not information porridge.
- **③ Prefix cache**: Card = hash reference = stable prefix = KV-cache hit. The architecture itself is cache-friendly — no extra hacks needed.
- **④ Background multi-agent**: `spawn_background` + filesystem job logs. No Redis, Kafka, gRPC — pure Node process orchestration.
- **⑤ Source economy**: Core engine + TUI + MCP + multi-model routing + approval gate + workflows — all in ~100 files. Not less code; denser code.

---

## Design Philosophy

The project started from three practical problems with multi-turn tool use:

1. Context bloats as conversations grow; long tasks explode the window
2. When long results get truncated, event order and details get lost — the agent often confuses which result came from which call
3. The whole thing should run in a Node/TypeScript stack — testable, hackable, shareable

Core approach:

- **Hot/cold separation**: long tool results land on disk in `.sessions/actions/`; the conversation only carries fixed-format `[action:…]` pointer cards
- **On-demand recall**: use `recall_query` to pull full text when needed; otherwise zero context footprint
- **End-of-turn pipeline**: after each turn, automatically run pointerize → prune → pointer-compact → threshold-triggered heavy summarization — never touching the leading system prompt
- Tools, sub-agents, workflows, and TUI all build on this foundation

The project is positioned as a context-structure experiment that also balances prefix-cache friendliness and packs mainstream harness capabilities into a small footprint. It is not a replacement or competitor to any other agent framework.

> ⚠️ **Honest caveat**  
> At this stage there is **no** `npx skills add` one-click installer.  
> Want a new skill? Two options:  
> 1. Copy-paste the `SKILL.md` + scripts into `skills/<name>/`  
> 2. Tell the agent: "connect the xxx skill to my skills folder" — it'll handle it  
> ——— the agent is literally built for this; why write another installer 😄

---

## Current Features

| Module | Capabilities |
|--------|-------------|
| **Main loop** | Streaming LLM output, parallel tool calls, loop deadlock prevention, session resume from checkpoint |
| **Context management** | Pointer cards, async write queue, task summaries, token-budget auto-pruning; `invoke_skill` full-text resident protection (inspired by a friend complaining that Codex often missed skill details in long tasks) |
| **Observability** | TUI status bar showing real-time tokens / session count / context ratio / prefix cache hit rate; `--json-events` structured event output |
| **Built-in tools** | File editing, patch application, full Git suite, LSP queries, Office document read/write (docx/pptx/xlsx in pure Node), shell/test execution, web fetch/search, Skill/MCP extensions |
| **Sub-agents** | `spawn_agent` / background spawn / three-role code review; task logs land in `workspace/jobs/` |
| **Workflows** | JSON-format workflows supporting multi-role orchestration like Planner→Worker→Reviewer |
| **TUI** | Terminal interface: session list management, bilingual (Chinese/English) toggle, startup splash, high-risk operation permission confirmation |
| **Multi-model** | `agent.json` multi-profile config, automatic fallback, reasoning level mapping; prefix-cache-friendly architecture, steady-state session cache hit rate **95%+** |

### Sync vs. Background Sub-agents

| Mode | Tool | Behavior | Use case |
|------|------|----------|----------|
| **Sync** | `spawn_agent` | Blocks until sub-agent completes, returns result | When API has concurrency limits (e.g. free tier allows 1 concurrent request) |
| **Background** | `spawn_background` | Returns `job_id` immediately; sub-agent runs async, progress written to files | Multiple independent tasks in parallel (auto-wakes main agent on completion) |

> ⚠️ **API concurrency limits**: If using rate-limited APIs like DeepSeek or OpenRouter (e.g. 1 concurrent request per API key), parallel sub-agents in background mode will trigger 429 errors. In that case, explicitly specify `spawn_agent` (sync mode) in your prompt — sub-agents will queue and run serially.  
> The framework does **not auto-downgrade** — sync vs. background is chosen by the agent based on your prompt. So if you want serial execution, say "use spawn_agent one at a time."  
> **Background communication**: Background sub-agents use no message bus. They write progress via file event streams (`workspace/jobs/<id>/events.jsonl`) and land results to `report.md` / `result.json`. When all background jobs settle, the framework emits a `jobs_all_settled` system event that **auto-wakes the main agent** for review (synthetic prompt triggers a new turn without interrupting the active conversation) — no manual reminders needed. To check progress mid-flight, run `npm run spawn:status` to inspect the `/jobs` panel, or terminate stray jobs (`npm run spawn:kill`).

---

## FAQ

### Why almost 100% TypeScript? Isn't Go / Rust faster?

An agent framework's performance bottleneck is not CPU — it's LLM API latency. Making the main loop 10× faster gains nothing when you're still waiting on HTTP responses. TypeScript's async/await handles I/O concurrency naturally, JSON operations have zero parsing overhead, the npm ecosystem gets first LLM SDK and MCP Server support, and TS iteration/debugging is faster.

### With 1M context windows now available, are pointer cards still necessary?

1M context solves **"can it fit?"** — pointer cards solve **"can it still think effectively once it's in there?"** They are not substitutes:

- **Cost**: Running 100 turns with 1M context re-encodes the full history every turn — linear token cost growth. Pointerize keeps context volume stable.
- **Quality**: LLM attention is not uniform across long contexts (see "Lost in the Middle"). The longer the history, the easier it is to miss critical information. Pointer cards ensure the active context only contains "what matters right now."
- **Prefix cache**: Pointer cards are hash-referenced; stable prefixes yield high KV-cache hit rates. Raw full-history insertion breaks the cache every turn.

### Why is the context pipeline run every turn instead of on-demand?

On-demand triggering creates a prediction problem: you need to know *in advance* whether the next turn will overflow the window. When it does, the emergency failsafe (mid-turn cut-off) is far more disruptive than proactive end-of-turn processing. The cost of running the pipeline when context is small is negligible. This is the same reason operating systems reclaim memory proactively rather than waiting for OOM.

---

## LLM Router

The framework accesses LLM APIs through `agent.json` profile configuration. No API keys go in `agent.json` — only environment variable names. Refer to `.env.example`.

### Quick Setup (typical)

**1. Configure profiles in `agent.json`**:

```json
{
  "api_profiles": {
    "my-gw": {
      "base_url": "https://my-gw.example/v1",
      "api_key_env": "MY_GW_KEY",
      "default_model": "my-model",
      "models": ["my-model"]
    }
  },
  "default_api_profile": "my-gw"
}
```

**2. Set keys in `.env`**:

```bash
MY_GW_KEY=sk-xxxxxxxx
```

**3. Done**: Restart TUI or a single task; the variable referenced by `api_key_env` is automatically read from `.env`.

> For fallback across multiple APIs, use the `fallback_profiles` array and `FALLBACK=1` env var for automatic switching. See the template `agent.llm.2key.example.json`.

---

## Web Fetch / Search Optional Dependencies

`web_fetch` and `web_search` depend on external host tools. The framework **auto-detects** them and degrades gracefully when absent.

### CloakFetch (web scraping)

- **Depends on**: Python 3 + [`cloak_fetch.py`](https://github.com/Agents365-ai/cloakFetch) script (or `cloak_fetch.py` in the same directory)
- **Purpose**: JS-rendered web scraping (L2 channel for `web_fetch`); falls back to plain HTTP fetch when absent
- **Auto-detection**: priority search → env var `CLOAK_FETCH_SCRIPT` → `skills/cloak-fetch/` → `~/.claude/skills/` → `~/github/cloakFetch/`
- **Detection logic**: `src/tools/cloak-resolve.ts` (cross-platform: Linux / macOS / Windows / Git Bash)

### ddgr (web search)

- **Depends on**: [`ddgr`](https://github.com/jarun/ddgr) (DuckDuckGo CLI search)
- **Purpose**: `web_search` backend; search is unavailable without it (local cache still works)
- **Install**: `pip install ddgr` or `brew install ddgr`; on Windows ensure it's in PATH
- **Auto-detection**: `ddgr` → `ddgr.exe` → `ddgr.cmd` → `ddgr.bat` (Windows); can also configure `web_search.ddgr_path` in `agent.json`

### Cross-platform notes

Different platforms (Linux / macOS / Windows / Git Bash) have different install paths and executable suffixes — the detection code covers common cases. If auto-detection fails:

1. **Set env vars**: `CLOAK_FETCH_SCRIPT=/your/path/cloak_fetch.py`, `DDGR_PATH=/your/path/ddgr`
2. **Or configure paths in `agent.json`**: `web_search.ddgr_path`, `cloak_fetch.script_path`
3. **Let the agent fix it**: Detection source is in `src/tools/cloak-resolve.ts`; tell the agent "help me configure the ddgr path" — it'll read the code, find the right config key, and fix it for you.

---

## Recommended Community Skills

Beyond the core built-in skills, `skills/` ships with a few useful community ones (decide yourself whether to include them in `.gitignore`):

| Skill | Purpose | Upstream / Credit |
|-------|---------|-------------------|
| `opencli-usage` | OpenCLI universal adapter — lets the agent drive websites, desktop apps, and external CLIs uniformly | [OpenCLI](https://github.com/johnx438-hub/opencli) |
| `cli-web-search` | Cross-platform CLI search engine (Google/Bing/Brave/DuckDuckGo + 7 backends) + MCP support | [scottgl9/cli-web-search](https://github.com/scottgl9/cli-web-search) (Apache-2.0) |

> 🙏 Thanks to Scott Glover and the above open-source maintainers.
>
> 🙏 Thanks to [Agents365-ai/cloakFetch](https://github.com/Agents365-ai/cloakFetch) (MIT) for the CloakBrowser scraping approach; this project's `skills/cloak-fetch/` and L2 fetch channel are built on it.

---

## Acknowledgments

This project was developed with deep use of the following models:

| Model | Role |
|-------|------|
| **Grok 4.5 + Composer 2.5** | Primary development — most source code directly generated by it |
| **DeepSeek V4 Pro** | Full dogfooding + code review + long-running validation |
| **Doubao 2.1 Pro** | Documentation & README text polish |
| **Kimi K3** | Hidden risk audits (verdict protocol cracks / stream-draft compound bugs) + aesthetic contributions (starry sky landing page / mechanism notes docx) |
