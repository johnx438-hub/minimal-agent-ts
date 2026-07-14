import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import type { AgentConfig } from '../src/types.js';
import {
  detectOfficeKind,
  loadDocxSidecar,
  normalizeTableMatrix,
  parseMarkdownInline,
  runOfficeTool,
} from '../src/tools/office.js';

const FIXTURE_PNG = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'pixel.png',
);

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

  it('writes structured docx blocks (heading/list/table/runs)', async () => {
    const path = 'notes/layout.docx';
    const w = await runOfficeTool(
      'office_write',
      {
        path,
        doc_title: 'Layout Demo',
        header: 'Confidential',
        footer: true,
        page: { orientation: 'portrait', margins_in: { top: 0.8, left: 0.8, right: 0.8, bottom: 0.8 } },
        blocks: [
          { type: 'heading', level: 1, text: 'Project Overview', align: 'center' },
          {
            type: 'paragraph',
            runs: [
              { text: 'Bold lead. ', bold: true },
              { text: 'Normal body with 中文.' },
            ],
          },
          { type: 'bullet', items: ['Alpha', 'Beta'] },
          { type: 'number', items: ['First', 'Second'] },
          {
            type: 'table',
            headers: ['Name', 'Status'],
            rows: [
              ['API', 'ok'],
              ['TUI', 'ok'],
            ],
          },
          { type: 'pagebreak' },
          { type: 'heading', level: 2, text: 'Appendix' },
          { type: 'paragraph', text: 'After break.', align: 'right' },
        ],
      },
      cfg(dir),
    );
    assert.ok(w);
    assert.match(w!, /mode=blocks/);

    const r = await runOfficeTool('office_read', { path }, cfg(dir));
    assert.ok(r);
    assert.match(r!, /Project Overview|Overview/);
    assert.match(r!, /Alpha|Beta/);
    assert.match(r!, /API|Status/);
    assert.match(r!, /Appendix|After break/);
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

  it('writes pptx with layouts, objects, notes', async () => {
    const path = 'decks/rich.pptx';
    const w = await runOfficeTool(
      'office_write',
      {
        path,
        title: 'Rich Deck',
        layout: 'LAYOUT_16x9',
        slides: [
          {
            layout: 'title',
            title: 'Welcome',
            subtitle: 'Q3 update',
            notes: 'Open with metrics.',
          },
          {
            layout: 'section',
            title: 'Architecture',
            subtitle: 'System map',
          },
          {
            layout: 'two_column',
            title: 'Compare',
            left: { title: 'Before', bullets: ['Slow', 'Manual'] },
            right: { title: 'After', bullets: ['Fast', 'Automated'] },
          },
          {
            layout: 'blank',
            background: 'F5F7FA',
            objects: [
              {
                kind: 'shape',
                shape: 'rect',
                x: 0.5,
                y: 0.5,
                w: 9,
                h: 0.15,
                fill: '0088CC',
              },
              {
                kind: 'text',
                text: 'Custom panel',
                x: 0.5,
                y: 1,
                w: 9,
                h: 0.6,
                fontSize: 24,
                bold: true,
                color: '1A1A1A',
              },
              {
                kind: 'table',
                x: 0.5,
                y: 2,
                w: 9,
                rows: [
                  ['Metric', 'Value'],
                  ['Latency', '12ms'],
                ],
              },
            ],
          },
        ],
      },
      cfg(dir),
    );
    assert.ok(w);
    assert.match(w!, /4 slides/);

    const r = await runOfficeTool('office_read', { path }, cfg(dir));
    assert.ok(r);
    assert.match(r!, /Welcome|Architecture|Compare|Custom panel|Latency/);
  });

  it('writes docx with embedded image', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    copyFileSync(FIXTURE_PNG, join(dir, 'assets', 'logo.png'));
    const path = 'notes/with-image.docx';
    const w = await runOfficeTool(
      'office_write',
      {
        path,
        blocks: [
          { type: 'heading', level: 1, text: 'With Image' },
          {
            type: 'image',
            path: 'assets/logo.png',
            width_in: 1.5,
            height_in: 1.5,
            alt: 'logo',
            align: 'center',
          },
          { type: 'paragraph', text: 'Caption under image.' },
        ],
      },
      cfg(dir),
    );
    assert.ok(w);
    assert.match(w!, /mode=blocks/);

    const r = await runOfficeTool('office_read', { path }, cfg(dir));
    assert.ok(r);
    assert.match(r!, /With Image|Caption under image/);
  });

  it('writes pptx with chart + custom slide master', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    copyFileSync(FIXTURE_PNG, join(dir, 'assets', 'logo.png'));
    const path = 'decks/chart-master.pptx';
    const w = await runOfficeTool(
      'office_write',
      {
        path,
        title: 'Chart Master Deck',
        layout: 'LAYOUT_16x9',
        masters: [
          {
            name: 'CORP',
            background: 'FFFFFF',
            slide_number: { x: 9.0, y: 5.15, color: '888888', fontSize: 10 },
            objects: [
              {
                kind: 'rect',
                x: 0,
                y: 0,
                w: '100%',
                h: 0.45,
                fill: '1E3A5F',
              },
              {
                kind: 'text',
                text: 'Acme Corp',
                x: 0.3,
                y: 0.05,
                w: 4,
                h: 0.35,
                color: 'FFFFFF',
                fontSize: 12,
                bold: true,
              },
              {
                kind: 'line',
                x: 0,
                y: 5.35,
                w: '100%',
                color: 'CCCCCC',
                line_width: 1,
              },
            ],
          },
        ],
        slides: [
          {
            master: 'CORP',
            layout: 'title_body',
            title: 'Revenue',
            body: 'Quarterly trend',
            objects: [
              {
                kind: 'chart',
                chart_type: 'bar',
                x: 0.5,
                y: 1.5,
                w: 9,
                h: 3.5,
                title: 'Revenue by Quarter',
                show_legend: true,
                labels: ['Q1', 'Q2', 'Q3', 'Q4'],
                values: [12, 18, 15, 22],
                series_name: '2026',
                colors: ['0088CC'],
              },
            ],
          },
          {
            master: 'CORP',
            layout: 'blank',
            objects: [
              {
                kind: 'chart',
                chart_type: 'line',
                x: 0.5,
                y: 0.8,
                w: 9,
                h: 4,
                title: 'Two series',
                show_legend: true,
                series: [
                  {
                    name: 'A',
                    labels: ['Jan', 'Feb', 'Mar'],
                    values: [1, 3, 2],
                  },
                  {
                    name: 'B',
                    labels: ['Jan', 'Feb', 'Mar'],
                    values: [2, 2, 4],
                  },
                ],
              },
            ],
          },
        ],
      },
      cfg(dir),
    );
    assert.ok(w);
    assert.match(w!, /2 slides/);
    assert.match(w!, /masters=1/);

    const r = await runOfficeTool('office_read', { path }, cfg(dir));
    assert.ok(r);
    assert.match(r!, /Revenue|Acme Corp|Two series|2026|Q1|Jan/);
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

  it('parseMarkdownInline expands bold/italic/code/strike', () => {
    const runs = parseMarkdownInline('**bold** and *italic* and ~~x~~ and `code`');
    const joined = runs.map((r) => r.text).join('');
    assert.match(joined, /bold/);
    assert.match(joined, /italic/);
    assert.ok(runs.some((r) => r.bold && r.text === 'bold'));
    assert.ok(runs.some((r) => r.italic && r.text === 'italic'));
    assert.ok(runs.some((r) => r.strike && r.text === 'x'));
    assert.ok(runs.some((r) => r.font === 'Consolas' && r.text === 'code'));
  });

  it('normalizeTableMatrix accepts string[] and pipe columns', () => {
    const single = normalizeTableMatrix({ rows: ['Alpha', 'Beta'] });
    assert.deepEqual(single, [['Alpha'], ['Beta']]);
    const piped = normalizeTableMatrix({
      headers: ['K', 'V'],
      rows: ['a | 1', 'b | 2'],
    });
    assert.equal(piped.length, 3);
    assert.deepEqual(piped[1], ['a', '1']);
  });

  it('docx markdown text + table string[] rows', async () => {
    const path = 'notes/md-table.docx';
    const w = await runOfficeTool(
      'office_write',
      {
        path,
        blocks: [
          {
            type: 'paragraph',
            text: 'Lead with **bold** and *italic*.',
          },
          {
            type: 'table',
            headers: ['Item', 'Note'],
            rows: ['Apple | **fresh**', 'Banana | *ripe*'],
          },
          {
            type: 'table',
            rows: ['Only column row one', 'Only column row two'],
          },
        ],
      },
      cfg(dir),
    );
    assert.ok(w);
    assert.match(w!, /mode=blocks/);
    assert.match(w!, /sidecar=/);

    const r = await runOfficeTool('office_read', { path }, cfg(dir));
    assert.ok(r);
    assert.match(r!, /bold|Lead/);
    assert.match(r!, /Apple|Banana|fresh|Only column/);
  });

  it('docx append_blocks merges sidecar draft', async () => {
    const path = 'notes/draft.docx';
    const w1 = await runOfficeTool(
      'office_write',
      {
        path,
        header: 'Draft',
        footer: true,
        blocks: [
          { type: 'heading', level: 1, text: 'Draft v1' },
          { type: 'paragraph', text: 'First section.' },
        ],
      },
      cfg(dir),
    );
    assert.ok(w1);
    assert.match(w1!, /mode=blocks/);

    const sc = loadDocxSidecar(join(dir, path));
    assert.ok(sc);
    assert.equal(sc!.blocks.length, 2);

    const w2 = await runOfficeTool(
      'office_write',
      {
        path,
        append_blocks: [
          { type: 'heading', level: 2, text: 'Added later' },
          { type: 'bullet', items: ['**one**', 'two'] },
        ],
      },
      cfg(dir),
    );
    assert.ok(w2);
    assert.match(w2!, /mode=append/);
    assert.match(w2!, /appended=2/);
    assert.match(w2!, /blocks=4/);

    const sc2 = loadDocxSidecar(join(dir, path));
    assert.ok(sc2);
    assert.equal(sc2!.blocks.length, 4);

    const r = await runOfficeTool('office_read', { path }, cfg(dir));
    assert.ok(r);
    assert.match(r!, /Draft v1|First section/);
    assert.match(r!, /Added later|one|two/);
  });

  it('docx append without sidecar fails clearly', async () => {
    const path = 'notes/no-sidecar.docx';
    // raw overwrite without going through our writer would not exist; empty path new file
    const w = await runOfficeTool(
      'office_write',
      {
        path,
        append_blocks: [{ type: 'paragraph', text: 'orphan' }],
      },
      cfg(dir),
    );
    assert.ok(w);
    assert.match(w!, /error:.*sidecar|append_blocks requires/i);
  });
});
