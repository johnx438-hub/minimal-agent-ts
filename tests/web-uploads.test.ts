import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  sanitizeUploadName,
  saveGuiUpload,
} from '../src/web/uploads.js';

describe('gui uploads', () => {
  it('sanitizes dangerous names', () => {
    assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
    assert.match(sanitizeUploadName('我的 报告.pdf'), /报告\.pdf|_\.pdf|pdf/);
  });

  it('writes under workspace/gui-inbox and returns relative path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gui-up-'));
    try {
      const out = saveGuiUpload({
        cwd,
        sessionId: 'session_test',
        filename: 'note.txt',
        bytes: Buffer.from('hello agent'),
      });
      assert.match(out.relativePath, /^workspace\/gui-inbox\/session_test\//);
      assert.equal(readFileSync(out.absolutePath, 'utf8'), 'hello agent');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
