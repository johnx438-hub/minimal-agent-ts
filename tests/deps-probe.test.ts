import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BUNDLED_NPM_DEPS,
  buildDepProbeReport,
  formatDepProbeReport,
  probeHostDeps,
} from '../src/deps-probe.js';

describe('deps-probe', () => {
  it('always reports node as available', () => {
    const host = probeHostDeps();
    const node = host.find((d) => d.id === 'node');
    assert.ok(node);
    assert.equal(node!.available, true);
    assert.match(node!.detail, /^v\d+/);
  });

  it('includes expected host dep ids', () => {
    const ids = probeHostDeps().map((d) => d.id);
    for (const id of ['node', 'shell', 'git', 'ddgr', 'python', 'cloak_fetch']) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
  });

  it('formatDepProbeReport is non-empty and mentions legend', () => {
    const text = formatDepProbeReport(buildDepProbeReport());
    assert.match(text, /Host dependencies/);
    assert.match(text, /Bundled via npm/);
    assert.match(text, /Legend/);
    assert.ok(BUNDLED_NPM_DEPS.length >= 5);
  });
});
