import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AgentConfig } from '../src/types.js';
import {
  detectOfficeKind,
  runOfficeTool,
} from '../src/tools/office.js';

function cfg(cwd: string): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'https://example.com',
    model: 'test',
    maxTurns: 5,
    cwd,
    allowShell: false,
    allowWeb: false,
  };
}

describe('office tools', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'office-tools-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects kinds by extension', () => {
    assert.equal(detectOfficeKind('a.docx'), 'docx');
    assert.equal(detectOfficeKind('b.PPTX'), 'pptx');
    assert.equal(detectOfficeKind('c.xlsx'), 'xlsx');
    assert.equal(detectOfficeKind('d.pdf'), null);
  });

  it('writes and reads docx', async () => {
    const path = 'notes/hello.docx';
    const w = await runOfficeTool(
      'office_write',
      {
        path,
        paragraphs: ['Hello Office', 'Second paragraph with 中文.'],
      },
      cfg(dir),
    );
    assert.ok(w);
    assert.match(w!, /^ok: wrote docx/);

    const r = await runOfficeTool('office_read', { path }, cfg(dir));
    assert.ok(r);
    assert.match(r!, /Hello Office/);
    assert.match(r!, /Second paragraph/);
    assert.match(r!, /中文/);
  });

  it('writes and reads pptx outline', async () => {
    const path = 'decks/demo.pptx';
    const w = await runOfficeTool(
      'office_write',
      {
        path,
        title: 'Demo Deck',
        slides: [
          { title: 'Agenda', bullets: ['Intro', 'Architecture', 'Q&A'] },
          { title: 'Next', body: 'Ship the package.' },
        ],
      },
      cfg(dir),
    );
    assert.ok(w);
    assert.match(w!, /pptx/);
    assert.match(w!, /2 slides/);

    const r = await runOfficeTool('office_read', { path }, cfg(dir));
    assert.ok(r);
    assert.match(r!, /Slide 1/);
    assert.match(r!, /Agenda|Intro/);
    assert.match(r!, /Slide 2/);
  });

  it('xlsx read + light append/set_cells', async () => {
    const path = 'data/table.xlsx';
    const w1 = await runOfficeTool(
      'office_write',
      {
        path,
        sheet: 'Main',
        headers: ['name', 'qty'],
        append_rows: [
          ['apple', 3],
          ['banana', 5],
        ],
        replace_sheet: true,
      },
      cfg(dir),
    );
    assert.ok(w1);
    assert.match(w1!, /ok: wrote/);

    const r1 = await runOfficeTool(
      'office_read',
      { path, sheet: 'Main', max_rows: 10 },
      cfg(dir),
    );
    assert.ok(r1);
    assert.match(r1!, /Main|apple|banana/i);

    const w2 = await runOfficeTool(
      'office_write',
      {
        path,
        sheet: 'Main',
        set_cells: [{ cell: 'B2', value: 99 }],
        append_rows: [['cherry', 1]],
      },
      cfg(dir),
    );
    assert.ok(w2);
    assert.match(w2!, /set_cells=1/);

    const r2 = await runOfficeTool(
      'office_read',
      { path, sheet: 'Main', format: 'json' },
      cfg(dir),
    );
    assert.ok(r2);
    assert.match(r2!, /99|cherry/);
  });

  it('rejects missing path and bad extension', async () => {
    const a = await runOfficeTool('office_read', {}, cfg(dir));
    assert.match(a!, /path is required/);
    const b = await runOfficeTool(
      'office_write',
      { path: 'x.pdf', paragraphs: ['a'] },
      cfg(dir),
    );
    assert.match(b!, /unsupported/);
  });
});
