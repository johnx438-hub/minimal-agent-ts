import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  createMessageBridge,
  type SessionMessage,
} from '../src/hooks/index.js';
import { AgentRuntime } from '../src/runner.js';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ZAI_API_KEY',
  'MODEL',
  'OPENAI_BASE_URL',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    out[key] = process.env[key];
  }
  return out;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function writeMinimalAgentJson(dir: string): void {
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      default_api_profile: 'test-profile',
      api_profiles: {
        'test-profile': {
          base_url: 'http://127.0.0.1:9',
          api_key_env: 'DEEPSEEK_API_KEY',
          default_model: 'test-model',
          models: ['test-model'],
        },
      },
      builtin_tools: ['read_file', 'list_files'],
    }),
  );
}

describe('AgentRuntime MessageBridge (MB-1)', () => {
  let savedEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(savedEnv);
    savedEnv = snapshotEnv();
  });

  it('defaults to an empty bridge and accepts injection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-bridge-rt-'));
    writeMinimalAgentJson(dir);
    process.env.DEEPSEEK_API_KEY = 'test-key';
    delete process.env.OPENAI_API_KEY;

    const defaultRt = new AgentRuntime({ cwd: dir, deferSession: true });
    assert.equal(defaultRt.getMessageBridge().sinkCount(), 0);

    const custom = createMessageBridge();
    const injected = new AgentRuntime({
      cwd: dir,
      deferSession: true,
      messageBridge: custom,
    });
    assert.equal(injected.getMessageBridge(), custom);
  });

  it('emits full user task text via publishUserTaskToBridge (no LLM)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-bridge-user-'));
    writeMinimalAgentJson(dir);
    process.env.DEEPSEEK_API_KEY = 'test-key';
    delete process.env.OPENAI_API_KEY;

    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink({
      name: 'test',
      onMessage(msg) {
        bag.push(msg);
      },
    });

    const runtime = new AgentRuntime({
      cwd: dir,
      deferSession: true,
      messageBridge: bridge,
    });

    const userText = 'implement feature X and report';
    // Same H1 payload as runTask, without invoking the model.
    runtime.publishUserTaskToBridge(userText);

    assert.equal(bag.length, 1);
    assert.equal(bag[0]?.role, 'user');
    assert.equal(bag[0]?.content, userText);
    assert.equal(bag[0]?.turn, 0);
    assert.equal(bag[0]?.source, 'main');
    assert.ok(bag[0]?.session_id);
    assert.match(bag[0]?.session_id ?? '', /^session_/);
  });

  it('does not throw when bridge has no sinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-bridge-nosink-'));
    writeMinimalAgentJson(dir);
    process.env.DEEPSEEK_API_KEY = 'test-key';
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    assert.equal(runtime.getMessageBridge().sinkCount(), 0);
    assert.doesNotThrow(() => runtime.publishUserTaskToBridge('quiet path'));
  });
});
