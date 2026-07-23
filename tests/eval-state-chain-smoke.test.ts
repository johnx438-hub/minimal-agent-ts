import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { normalizeContextPolicy } from '../src/context/policy-config.js';

const ROOT = join(import.meta.dirname, '..');

function runBash(scriptRel: string, args: string[] = []): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync('bash', [join(ROOT, scriptRel), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('eval E0 state_chain_01', () => {
  it('setup creates workspace with brief, step1, and noise files', () => {
    const r = runBash('eval/scripts/setup-task.sh', ['state_chain_01']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const ws = join(ROOT, 'eval/tasks/state_chain_01/workspace');
    assert.ok(existsSync(join(ws, 'data/brief.md')));
    assert.ok(existsSync(join(ws, 'data/step1.txt')));
    assert.match(readFileSync(join(ws, 'data/step1.txt'), 'utf8'), /token=cherry-42/);
    assert.ok(existsSync(join(ws, 'noise/blob_1.txt')));
    assert.ok(existsSync(join(ws, 'noise/blob_3.txt')));
    // expected must stay outside workdir
    assert.equal(existsSync(join(ws, 'expected.json')), false);
  });

  it('score passes on correct fixture and fails on wrong answer', () => {
    const smoke = runBash('eval/scripts/smoke-state-chain.sh');
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    assert.match(smoke.stdout, /eval smoke ok/);
  });

  it('strategy overlays normalize without throw', () => {
    for (const name of [
      'minimal_full',
      'minimal_no_pointerize',
      'naive_full',
      'aggressive_compress',
    ]) {
      const raw = JSON.parse(
        readFileSync(join(ROOT, 'eval/strategies', `${name}.json`), 'utf8'),
      ) as { context_policy?: unknown };
      const resolved = normalizeContextPolicy(
        raw.context_policy as Parameters<typeof normalizeContextPolicy>[0],
      );
      assert.ok(resolved.heavy_compression.first_ratio >= 0.5);
      assert.ok(resolved.heavy_compression.first_ratio <= 0.95);
    }
  });
});
