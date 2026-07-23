# Eval harness (Lost-in-Middle / long-horizon)

> **Status**: **E0–E3 ✅** — run · aggregate · compare · second task family (`multi_doc_01`).  
> **Spec**: [docs/EVAL_LITM.md](../docs/EVAL_LITM.md) · knobs: [SPEC_CONTEXT_POLICY.md](../SPEC_CONTEXT_POLICY.md)

## Layout

```text
eval/
  strategies/     # frozen agent.json overlays (no secrets)
  tasks/          # one dir per task_id
  scripts/        # helpers (setup/score wrappers)
  runs/           # gitignored: per-run outputs
  reports/        # optional committed summaries
```

## Reproducibility contract (E1+)

Each API run must write `eval/runs/<run_id>/manifest.json` with at least:

- `git_sha`, `task_id`, `strategy_id`, `model`
- normalized `context_policy` / `pointerize_policy` snapshot
- `max_turns`, `timeout_sec`, timestamps

Do not change config mid-run. Prefer script exit codes over model self-report.

## Strategies

| ID | File | Intent |
|----|------|--------|
| `minimal_full` | `strategies/minimal_full.json` | Production defaults (pointerize + pipeline) |
| `minimal_pointerize_eager` | `strategies/minimal_pointerize_eager.json` | **keep=0** + soft_force + **`tool_deny: [context_focus]`** |
| `minimal_no_pointerize` | `strategies/minimal_no_pointerize.json` | Ablation: huge keep window |
| `naive_full` | `strategies/naive_full.json` | Approximate full hot path (late heavy + huge keep) |
| `aggressive_compress` | `strategies/aggressive_compress.json` | Early compression stress |

Merge strategy JSON **into** a working `agent.json` (or pass as overlay when E1 lands). Never put API keys in strategy files.

Optional strategy fields:

| Field | Effect |
|-------|--------|
| `tool_deny` | Hide tools from the model for this run (e.g. `["context_focus"]` so keep boosts cannot fight pointerize) |

## Tasks

```bash
npm run eval:list
```

| ID | Family | Pressure | Score |
|----|--------|----------|-------|
| `state_chain_01` | `state_chain` | tool chain + noise blobs | `score.sh` |
| `multi_doc_01` | `multi_doc` | mid-doc needle among fillers | `score.sh` |

### Local smoke (no API)

```bash
npm run eval:smoke
# or
npm run eval:run -- --task state_chain_01 --strategy minimal_full --dry-run --plant
```

Artifacts land in `eval/runs/<run_id>/`:

| File | Content |
|------|---------|
| `manifest.json` | git_sha, model, strategy, policies, paths |
| `workspace/` | per-run sandbox (setup output; agent cwd) |
| `turns.jsonl` | per-turn usage / tools / compression |
| `events.jsonl` | raw RuntimeEvents (LLM runs only) |
| `summary.json` | task_success, repeat_tool_rate, hot_tokens_* |
| `score.json` | score.sh JSON |
| `final.txt` | model final text |

### Live agent run (needs API key in `.env`)

Uses the **same** `agent.json` profiles + `.env` as TUI — no separate eval key.  
`api_profiles.*.api_key_env` is the **env var name** (e.g. `DEEPSEEK_API_KEY`); the secret lives only in `.env`.

```bash
# from repo root (agent.json + .env)
npm run eval:run -- \
  --task state_chain_01 \
  --strategy minimal_full \
  --max-turns 30

# ablation
npm run eval:run -- --task state_chain_01 --strategy minimal_no_pointerize --max-turns 30
```

Exit code: `0` if `score.sh` passes, else `1`.  
Stdout: one JSON object with `run_dir` and headline metrics.

Options: `--allow-shell` · `--allow-web` · `--timeout-sec N` · `--run-id <id>` · `--project-root <dir>`.

If you see `No available LLM profile in chain: deepseek-main → …`: `.env` was not loaded or the key is empty. Eval CLI loads `projectRoot/.env` (same as TUI after fix). Confirm `default_api_profile` / `api_key_env` match a non-empty line in `.env`.

## Metrics

| Field | Source |
|-------|--------|
| `task_success` | `score.sh` exit |
| `repeat_tool_rate` | duplicate tool name+arg fingerprints |
| `hot_tokens_mean` / `p95` | `llm_done.usage.prompt_tokens` |
| `turns_used` | turns with events |

## Aggregate & compare (E2)

```bash
# Table over existing eval/runs (includes dry-run by default)
npm run eval:aggregate -- --task state_chain_01 --out-name latest_state_chain

# Exclude dry-run (live API only)
npm run eval:aggregate -- --task state_chain_01 --no-dry-run --out-name live_only

# Run two strategies then write a compare report under eval/reports/
npm run eval:compare -- \
  --task state_chain_01 \
  --strategies minimal_full,minimal_no_pointerize \
  --dry-run --plant \
  --out-name cmp_pointer_ablation

# Live API compare (costs money)
npm run eval:compare -- \
  --task state_chain_01 \
  --strategies minimal_full,minimal_no_pointerize \
  --max-turns 30 --n 1
```

Reports: `eval/reports/<name>.md` + `.json`  
Columns: n · success_rate · turns̄ · hot_tokens̄ · repeat_tool̄ · tools̄ · $̄ · dry_n  

Optional cost: set `EVAL_PRICE_PROMPT_PER_1M` and/or `EVAL_PRICE_COMPLETION_PER_1M` (USD per 1M tokens).

```bash
# multi_doc needle task (dry)
npm run eval:run -- --task multi_doc_01 --strategy minimal_full --dry-run --plant

# both tasks × two strategies (dry matrix)
npm run eval:compare -- --task multi_doc_01 \
  --strategies minimal_full,minimal_no_pointerize --dry-run --plant

# stress pointerize (keep_inline_turns=0) vs ablation
npm run eval:compare -- --task multi_doc_01 \
  --strategies minimal_pointerize_eager,minimal_no_pointerize --max-turns 40
```

## Next

- Live API n≥3 on both tasks before claiming trends in README  
- Optional `repo_long_01` family
