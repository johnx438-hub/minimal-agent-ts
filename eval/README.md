# Eval harness (Lost-in-Middle / long-horizon)

> **Status**: E0 scaffold — task + strategies + local score; **no** full `eval run` CLI yet (E1).  
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
# prepare sandbox under tasks/state_chain_01/workspace
bash eval/scripts/setup-task.sh state_chain_01

# plant a correct answer (agent would write this)
cp eval/tasks/state_chain_01/fixtures/answer.correct.json \
   eval/tasks/state_chain_01/workspace/answer.json

bash eval/scripts/score-task.sh state_chain_01
# exit 0

# wrong answer fails
echo '{"token":"nope"}' > eval/tasks/state_chain_01/workspace/answer.json
bash eval/scripts/score-task.sh state_chain_01
# exit 1
```

Or: `npm run eval:smoke` (setup + correct score + wrong score).

### Agent run (manual until E1)

1. `bash eval/scripts/setup-task.sh state_chain_01`
2. Point agent cwd at `eval/tasks/state_chain_01/workspace`
3. Prompt = contents of `TASK.md` (or paste)
4. Use strategy overlay as needed
5. `bash eval/scripts/score-task.sh state_chain_01`

## Metrics (E1+)

Turn telemetry → `turns.jsonl`; rollups → `summary.json`  
Primary: `task_success`, `repeat_tool_rate`, `hot_tokens_*`, tokens/cost per success.

## Next (E1)

- `eval run --task … --strategy …` writing manifest + JSONL
- Wire `json-events` / Runtime listener
- Aggregate table for `minimal_full` vs `minimal_no_pointerize`
