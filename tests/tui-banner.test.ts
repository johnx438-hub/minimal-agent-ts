import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBannerMetaLines,
  buildBannerText,
  logoCompactLine,
  logoFullLines,
  LOGO_FULL_MIN_WIDTH,
  renderLogoLines,
} from '../src/tui/pi/banner.js';

describe('tui banner', () => {
  it('full logo contains brand marks', () => {
    const lines = logoFullLines();
    assert.ok(lines.length >= 3);
    const text = lines.join('\n');
    assert.match(text, /m·a/);
    assert.match(text, /minimal-agent-ts/);
    assert.match(text, /long-context/);
  });

  it('switches to compact under min width', () => {
    assert.deepEqual(renderLogoLines(LOGO_FULL_MIN_WIDTH - 1), [logoCompactLine()]);
    assert.deepEqual(renderLogoLines(LOGO_FULL_MIN_WIDTH), logoFullLines());
    assert.deepEqual(renderLogoLines(120), logoFullLines());
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
    assert.match(text, /m·a/);
    assert.match(text, /no session yet/);
  });
});
