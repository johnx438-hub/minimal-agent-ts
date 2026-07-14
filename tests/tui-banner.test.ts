import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBannerMetaLines,
  buildBannerText,
  logoCompactLine,
  logoFullLines,
  LOGO_FULL_MIN_WIDTH,
  renderBlockWord,
  renderLogoLines,
} from '../src/tui/pi/banner.js';

describe('tui banner', () => {
  it('renders MINIMAL as 5-row block letters', () => {
    const lines = logoFullLines();
    assert.equal(lines.length, 5);
    const text = lines.join('\n');
    assert.match(text, /█/);
    // Each letter row present (block art is contiguous █ runs)
    for (const line of lines) {
      assert.ok(line.includes('█'), line);
    }
    const raw = renderBlockWord('MINIMAL');
    assert.equal(raw.length, 5);
    // Word width roughly 7 letters * ~6 cols
    assert.ok(raw[0]!.length >= 40);
  });

  it('switches to compact MINIMAL under min width', () => {
    assert.deepEqual(renderLogoLines(LOGO_FULL_MIN_WIDTH - 1), [logoCompactLine()]);
    assert.equal(logoCompactLine().trim(), 'MINIMAL');
    assert.deepEqual(renderLogoLines(LOGO_FULL_MIN_WIDTH), logoFullLines());
  });

  it('meta lines include model session shell and optional flags', () => {
    const meta = buildBannerMetaLines({
      model: 'deepseek-v4-flash',
      cwd: '/tmp/proj',
      sessionLabel: 'session_test',
      shellOn: true,
      webOn: false,
      hasActiveSession: true,
      hasPendingHandoff: true,
      alwaysShell: true,
      locale: 'zh',
    });
    const text = meta.join('\n');
    assert.match(text, /deepseek-v4-flash/);
    assert.match(text, /session_test/);
    assert.match(text, /shell:\s+on/);
    assert.match(text, /lang:\s+zh/);
    assert.match(text, /brief queued/);
    assert.match(text, /always-approve: shell/);
  });

  it('buildBannerText joins logo and meta', () => {
    const text = buildBannerText(
      {
        model: 'm',
        cwd: '/c',
        sessionLabel: 's',
        shellOn: false,
        webOn: false,
        hasActiveSession: false,
        hasPendingHandoff: false,
      },
      80,
    );
    assert.match(text, /█/);
    assert.match(text, /no session yet/);
  });
});
