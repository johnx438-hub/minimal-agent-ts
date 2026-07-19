import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enrichToolContentForUi } from '../src/tools/tool-ui-display.js';

describe('enrichToolContentForUi', () => {
  it('rebuilds write_file display from args content', () => {
    const out = enrichToolContentForUi({
      toolName: 'write_file',
      content: 'ok: wrote 10 bytes to workspace/a.ts (new file)',
      argsJson: JSON.stringify({
        path: 'workspace/a.ts',
        content: 'const x = 1;\n',
      }),
    });
    assert.match(out, /\[write_display\]/);
    assert.match(out, /\+\s*const x = 1/);
    assert.match(out, /ok: wrote/);
  });

  it('rebuilds edit_file display with +/- lines', () => {
    const out = enrichToolContentForUi({
      toolName: 'edit_file',
      content:
        'ok: edited workspace/a.ts (12 bytes) file_hash=abc',
      argsJson: JSON.stringify({
        path: 'workspace/a.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      }),
      resultText:
        'ok: edited workspace/a.ts (12 bytes) file_hash=abc',
    });
    assert.match(out, /\[edit_display\]/);
    assert.match(out, /-\s*const x = 1/);
    assert.match(out, /\+\s*const x = 2/);
    assert.match(out, /file_hash=abc/);
  });

  it('leaves already-rich content alone', () => {
    const rich =
      'ok: wrote 1 bytes to a.ts (new file)\n[write_display]\n+hi\n[/write_display]';
    assert.equal(
      enrichToolContentForUi({
        toolName: 'write_file',
        content: rich,
        argsJson: '{"path":"a.ts","content":"other"}',
      }),
      rich,
    );
  });
});
