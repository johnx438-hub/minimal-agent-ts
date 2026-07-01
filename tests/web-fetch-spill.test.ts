import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { setWorkspaceRoot } from '../src/workspace.js';
import {
  buildSpillDocument,
  formatSpillResult,
  markdownByteSize,
  writeWebFetchSpill,
} from '../src/tools/web-fetch-spill.js';

describe('web-fetch spill', () => {
  it('buildSpillDocument keeps source url in frontmatter', () => {
    const doc = buildSpillDocument({
      url: 'https://example.com/article',
      title: 'Example Article',
      markdown: 'Hello **world**.',
      via: 'http',
    });
    assert.match(doc, /^---\nurl: https:\/\/example\.com\/article\n/);
    assert.match(doc, /title: Example Article/);
    assert.match(doc, /# Example Article\n\nHello \*\*world\*\*\./);
  });

  it('formatSpillResult points to read_file and source_url', () => {
    const out = formatSpillResult('https://ex.com', 'T', 'http', {
      relativePath: '.cache/web-fetch/s1/file.md',
      bytes: 1200,
      lines: 40,
    });
    assert.match(out, /^\[web_spill url=https:\/\/ex\.com/);
    assert.match(out, /^source_url=https:\/\/ex\.com/m);
    assert.match(out, /read_file\(path="\.cache\/web-fetch\/s1\/file\.md"/);
  });

  it('writes markdown only under .cache/web-fetch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maf-spill-'));
    setWorkspaceRoot(root);
    try {
      const big = `${'paragraph line.\n'.repeat(40_000)}`;
      assert.ok(markdownByteSize(big) > 512 * 1024);

      const spill = await writeWebFetchSpill({
        url: 'https://example.com/big',
        title: 'Big Page',
        markdown: big,
        via: 'http',
        sessionId: 'sess_test',
      });

      assert.match(spill.relativePath, /^\.cache\/web-fetch\/sess_test\/.+\.md$/);
      const full = resolve(root, spill.relativePath);
      const onDisk = readFileSync(full, 'utf8');
      assert.match(onDisk, /^---\nurl: https:\/\/example\.com\/big/);
      assert.ok(onDisk.includes(big.trim()));
      assert.ok(!onDisk.includes('<html'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      setWorkspaceRoot(process.cwd());
    }
  });
});