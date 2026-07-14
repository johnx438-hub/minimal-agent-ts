import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeLocale, ui } from '../src/tui/i18n.js';
import { defaultPrefs, normalizePrefs, prefsLocale } from '../src/tui/prefs.js';

describe('tui i18n', () => {
  it('normalizes locale aliases', () => {
    assert.equal(normalizeLocale('en'), 'en');
    assert.equal(normalizeLocale('zh'), 'zh');
    assert.equal(normalizeLocale('cn'), 'zh');
    assert.equal(normalizeLocale('english'), 'en');
    assert.equal(normalizeLocale('nope'), 'zh');
  });

  it('prefs default to zh', () => {
    assert.equal(prefsLocale(defaultPrefs()), 'zh');
    assert.equal(prefsLocale(normalizePrefs({ ...defaultPrefs(), locale: 'en' })), 'en');
  });

  it('ui strings differ by locale', () => {
    assert.match(String(ui('zh', 'sessionsTitle')), /会话/);
    assert.match(String(ui('en', 'sessionsTitle')), /Sessions/);
    assert.notEqual(String(ui('zh', 'hintFooter')), String(ui('en', 'hintFooter')));
  });
});
