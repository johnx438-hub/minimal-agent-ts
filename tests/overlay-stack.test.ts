import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  getOverlayDepth,
  isOverlayOpen,
  popOverlay,
  pushOverlay,
  resetOverlayStackForTests,
} from '../src/tui/pi/overlay-stack.js';

describe('overlay-stack', () => {
  afterEach(() => {
    resetOverlayStackForTests();
  });

  it('starts closed', () => {
    assert.equal(isOverlayOpen(), false);
    assert.equal(getOverlayDepth(), 0);
  });

  it('tracks nested push/pop', () => {
    pushOverlay();
    assert.equal(isOverlayOpen(), true);
    assert.equal(getOverlayDepth(), 1);
    pushOverlay();
    assert.equal(getOverlayDepth(), 2);
    popOverlay();
    assert.equal(getOverlayDepth(), 1);
    assert.equal(isOverlayOpen(), true);
    popOverlay();
    assert.equal(isOverlayOpen(), false);
  });

  it('does not go negative on extra pop', () => {
    popOverlay();
    popOverlay();
    assert.equal(getOverlayDepth(), 0);
    assert.equal(isOverlayOpen(), false);
  });
});
