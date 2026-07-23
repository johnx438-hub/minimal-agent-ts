# Eval harness (Lost-in-Middle / long-horizon)

> **Status**: **E0 ✅ · E1 ✅** — `eval:run` writes manifest / turns.jsonl / summary; dry-run without API.  
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
| `minimal_no_pointerize` | `strategies/minimal_no_pointerize.json` | Ablation: huge keep window |
| `naive_full` | `strategies/naive_full.json` | Approximate full hot path (late heavy + huge keep) |
| `aggressive_compress` | `strategies/aggressive_compress.json` | Early compression stress |

Merge strategy JSON **into** a working `agent.json` (or pass as overlay when E1 lands). Never put API keys in strategy files.

## Tasks

| ID | Family | Score |
|----|--------|-------|
| `state_chain_01` | `state_chain` | `tasks/state_chain_01/score.sh` |

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
| `turns.jsonl` | per-turn usage / tools / compression |
| `events.jsonl` | raw RuntimeEvents (LLM runs only) |
| `summary.json` | task_success, repeat_tool_rate, hot_tokens_* |
| `score.json` | score.sh JSON |
| `final.txt` | model final text |

### Live agent run (needs API key in `.env`)

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

## Metrics

| Field | Source |
|-------|--------|
| `task_success` | `score.sh` exit |
| `repeat_tool_rate` | duplicate tool name+arg fingerprints |
| `hot_tokens_mean` / `p95` | `llm_done.usage.prompt_tokens` |
| `turns_used` | turns with events |

## Next (E2)

- Aggregate multi-run table (`minimal_full` vs `minimal_no_pointerize`)
- Optional markdown report under `eval/reports/`
