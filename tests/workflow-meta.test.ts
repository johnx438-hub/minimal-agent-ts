import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listWorkflowMetaForCwd } from '../src/workflow/catalog.js';

describe('listWorkflowMetaForCwd', () => {
  it('reads roles and share_session from workflow json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-wf-meta-'));
    const wfDir = join(dir, 'workflows');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, 'demo.json'),
      JSON.stringify({
        name: 'demo-flow',
        share_session: true,
        roles: { planner: {}, worker: {} },
        flow: [],
      }),
      'utf8',
    );

    const metas = listWorkflowMetaForCwd(dir);
    assert.equal(metas.length, 1);
    assert.equal(metas[0]?.name, 'demo-flow');
    assert.deepEqual(metas[0]?.roles.sort(), ['planner', 'worker']);
    assert.equal(metas[0]?.shareSession, true);
  });
});