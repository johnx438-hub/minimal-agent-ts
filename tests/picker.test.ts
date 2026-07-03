import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSelectItems } from '../src/tui/pi/picker.js';

describe('buildSelectItems', () => {
  it('maps picker entries to SelectItem shape', () => {
    const items = buildSelectItems([
      { value: 'a', label: 'Alpha', description: 'First' },
      { value: 'b', label: 'Beta' },
    ]);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.value, 'a');
    assert.equal(items[0]?.label, 'Alpha');
    assert.equal(items[0]?.description, 'First');
    assert.equal(items[1]?.description, undefined);
  });
});