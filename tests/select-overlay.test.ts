import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SelectList } from '@earendil-works/pi-tui';

import { piSelectListTheme } from '../src/tui/pi/themes.js';

/**
 * Regression guard: overlay panels must forward handleInput to SelectList.
 * Box alone receives focus but drops keyboard events.
 */
describe('SelectOverlayPanel input forwarding', () => {
  it('forwards handleInput so Enter can select an item', () => {
    const list = new SelectList(
      [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
      5,
      piSelectListTheme,
    );

    let selected: string | null = null;
    list.onSelect = (item) => {
      selected = item.value;
    };

    const panel = {
      handleInput(data: string) {
        list.handleInput(data);
      },
    };

    panel.handleInput('\x1b[B'); // down
    panel.handleInput('\r'); // enter

    assert.equal(selected, 'b');
  });
});