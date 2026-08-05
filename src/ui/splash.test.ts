/**
 * The small-screen boundary, which is the one decidable thing in `splash.ts`.
 *
 * The rest of the file is DOM wiring and untestable here; the predicate is
 * pure precisely so the phone/tablet line -- the part that would fail silently
 * as "the warning just never shows" -- can be pinned against real device
 * viewports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SMALL_SCREEN_MIN_DIM, isSmallScreen } from './splash.ts';

test('phones are small in BOTH orientations; tablets and desktops in neither', () => {
  // The landscape rows are the reason the predicate takes min(w, h): every one
  // of these widths clears any plausible width breakpoint.
  const phones: Array<[number, number]> = [
    [390, 844], // iPhone 15 portrait
    [844, 390], // ...and landscape
    [430, 932], // iPhone Pro Max portrait
    [932, 430], // ...and landscape
    [360, 800], // common Android portrait
  ];
  for (const [w, h] of phones) {
    assert.equal(isSmallScreen(w, h), true, `${w}x${h} is a phone`);
  }

  const bigger: Array<[number, number]> = [
    [744, 1133], // iPad mini portrait -- the smallest screen that must PASS
    [1133, 744], // ...and landscape
    [820, 1180], // iPad Air
    [1920, 1080],
  ];
  for (const [w, h] of bigger) {
    assert.equal(isSmallScreen(w, h), false, `${w}x${h} is not a phone`);
  }
});

test('the boundary is exactly the Android sw600dp line, exclusive', () => {
  assert.equal(isSmallScreen(SMALL_SCREEN_MIN_DIM, 1000), false, 'at the line is not small');
  assert.equal(isSmallScreen(SMALL_SCREEN_MIN_DIM - 1, 1000), true, 'under it is');
});
