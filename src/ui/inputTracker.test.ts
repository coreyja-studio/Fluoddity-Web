/**
 * The input tracker's asymmetries, which are silent when wrong.
 *
 * WHY THIS TEST EXISTS. Every property asserted here was learned on the desktop
 * from how drags actually behave (`ui.py:166-190`), and every one of them fails
 * QUIETLY: a capture-filtered release does not throw, it leaves the canvas
 * permanently grabbed; a one-shot that forgets to drain does not throw, it picks
 * a particle every frame for as long as the mouse is still. Each is a bug you
 * find by using the app for a while and being confused, which is exactly the
 * kind worth pinning in a test.
 *
 * There is no DOM here and the tracker imports none -- that split is the whole
 * reason `inputTracker.ts` and `inputBinding.ts` are separate files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InputTracker, LEFT_BUTTON, RIGHT_BUTTON } from './inputTracker.ts';

/** A frame's worth of nothing, so a test can advance without adding input. */
const TICK = 1 / 60;

// --- 1. a captured press is dropped entirely ------------------------------
// The panel gets the click; the canvas must not see a press OR open a drag.

test('a press on the UI neither fires a one-shot nor starts a drag', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, true);

  const state = tracker.freeze(TICK);
  assert.equal(state.leftPressed, false, 'a captured press must not select');
  assert.equal(state.leftDragging, false, 'a captured press must not open a drag');
});

test('moving onto the canvas mid-press does not retroactively start a drag', () => {
  const tracker = new InputTracker();
  // Press on the panel, then wander over the canvas with the button still down.
  tracker.onPointerDown(LEFT_BUTTON, true);
  tracker.onPointerMove(400, 300);

  assert.equal(
    tracker.freeze(TICK).leftDragging,
    false,
    'a drag belongs to whoever received the press -- and the panel did',
  );
});

// --- 2. a release is never capture-filtered -------------------------------
// The case the desktop comment calls out: a drag that ends over a panel must
// still end. There is deliberately no way to express a filtered release.

test('a drag that begins on the canvas and ends over the UI still ends', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, false);
  assert.equal(tracker.freeze(TICK).leftDragging, true);

  // The cursor is over the panel now. The release arrives all the same.
  tracker.onPointerUp(LEFT_BUTTON);

  assert.equal(
    tracker.freeze(TICK).leftDragging,
    false,
    'the canvas would stay grabbed forever',
  );
});

test('a drag survives the cursor crossing the UI without ending', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(RIGHT_BUTTON, false);
  tracker.onPointerMove(10, 10);
  assert.equal(tracker.freeze(TICK).rightDragging, true);

  // Several frames pass with the cursor over the panel and the button down.
  for (let i = 0; i < 3; i += 1) {
    tracker.onPointerMove(900, 20);
    assert.equal(
      tracker.freeze(TICK).rightDragging,
      true,
      'a stroke must not break when the cursor passes over a panel',
    );
  }
});

// --- 3. one-shots drain, conditions persist -------------------------------

test('a press fires for exactly one frame', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, false);

  assert.equal(tracker.freeze(TICK).leftPressed, true);
  assert.equal(
    tracker.freeze(TICK).leftPressed,
    false,
    'a held button would select a new particle every frame',
  );
});

test('dragging persists across frames but pressed does not', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, false);
  tracker.freeze(TICK);

  const second = tracker.freeze(TICK);
  assert.equal(second.leftPressed, false, 'events drain');
  assert.equal(second.leftDragging, true, 'conditions do not');
});

test('the two buttons are independent', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, false);
  tracker.onPointerDown(RIGHT_BUTTON, false);
  tracker.onPointerUp(LEFT_BUTTON);

  const state = tracker.freeze(TICK);
  assert.equal(state.leftDragging, false);
  assert.equal(state.rightDragging, true, 'releasing left must not end a right drag');
});

// --- 4. scroll accumulates within a frame ---------------------------------
// `zoomAtPixel` takes notches as an EXPONENT, so three events between two
// frames must be worth three notches rather than the last one.

test('scroll accumulates within the frame and resets after it', () => {
  const tracker = new InputTracker();
  tracker.onWheel(1, false);
  tracker.onWheel(1, false);
  tracker.onWheel(0.5, false);

  assert.equal(tracker.freeze(TICK).scroll, 2.5, 'a fast flick is worth more than one notch');
  assert.equal(tracker.freeze(TICK).scroll, 0, 'scroll is an event, not a condition');
});

test('scroll over the UI is dropped', () => {
  const tracker = new InputTracker();
  tracker.onWheel(3, true);
  assert.equal(tracker.freeze(TICK).scroll, 0, 'scrolling the panel must not zoom the camera');
});

test('opposite scroll directions cancel', () => {
  const tracker = new InputTracker();
  tracker.onWheel(2, false);
  tracker.onWheel(-2, false);
  assert.equal(tracker.freeze(TICK).scroll, 0);
});

// --- 5. keyboard ----------------------------------------------------------

test('keysHeld persists until the key comes up; keysPressed drains', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyW', false, false);

  const first = tracker.freeze(TICK);
  assert.equal(first.keysHeld.has('KeyW'), true);
  assert.equal(first.keysPressed.has('KeyW'), true);

  const second = tracker.freeze(TICK);
  assert.equal(second.keysHeld.has('KeyW'), true, 'panning must continue while held');
  assert.equal(second.keysPressed.has('KeyW'), false, 'the one-shot already fired');

  tracker.onKeyUp('KeyW', false);
  assert.equal(tracker.freeze(TICK).keysHeld.has('KeyW'), false);
});

test('a key released while a text field has focus still leaves keysHeld', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyW', false, false);
  tracker.freeze(TICK);

  // Focus moved to a panel input mid-hold; the keyup is not capture-filtered.
  tracker.onKeyUp('KeyW', false);

  assert.equal(
    tracker.freeze(TICK).keysHeld.has('KeyW'),
    false,
    'the view would pan by itself with nothing held down',
  );
});

test('keys typed into an editable element never reach the canvas', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyR', false, true);

  const state = tracker.freeze(TICK);
  assert.equal(state.keysPressed.has('KeyR'), false, 'typing "r" must not reset');
  assert.equal(state.keysHeld.has('KeyR'), false);
});

test('auto-repeat re-enters keysPressed every frame, as on the desktop', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyR', false, false);
  assert.equal(tracker.freeze(TICK).keysPressed.has('KeyR'), true);

  // The OS repeats. GLFW cannot tell PRESS from REPEAT and neither does this.
  tracker.onKeyDown('KeyR', false, false);
  assert.equal(tracker.freeze(TICK).keysPressed.has('KeyR'), true);
});

test('shift tracks the most recent key event, including the release', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyZ', true, false);
  assert.equal(tracker.freeze(TICK).shift, true);

  tracker.onKeyUp('KeyZ', false);
  assert.equal(tracker.freeze(TICK).shift, false);
});

test('shift is recorded even when the keystroke went to a text field', () => {
  const tracker = new InputTracker();
  // `ui.py:143` writes the modifier before the capture check, deliberately.
  tracker.onKeyDown('ShiftLeft', true, true);
  assert.equal(tracker.freeze(TICK).shift, true);
});

// --- 6. focus loss, which the desktop never had to handle -----------------

test('losing focus clears held keys and drags', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyW', false, false);
  tracker.onPointerDown(LEFT_BUTTON, false);
  tracker.freeze(TICK);

  // Alt-tab. The browser stops delivering keyup and pointerup entirely.
  tracker.onFocusLost();

  const state = tracker.freeze(TICK);
  assert.equal(state.keysHeld.size, 0, 'the view would pan forever after alt-tab');
  assert.equal(state.leftDragging, false, 'the drag would never end');
});

// --- 7. the snapshot is a snapshot ----------------------------------------
// Every consumer in a frame must see identical input, so a later event cannot
// reach back into a state something is still holding.

test('a frozen state is not disturbed by later events', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyW', false, false);
  tracker.onPointerMove(100, 200);
  const state = tracker.freeze(TICK);

  tracker.onKeyDown('KeyA', false, false);
  tracker.onKeyUp('KeyW', false);
  tracker.onPointerMove(999, 999);

  assert.equal(state.keysHeld.has('KeyW'), true, 'the snapshot must not alias live state');
  assert.equal(state.keysHeld.has('KeyA'), false);
  assert.deepEqual(state.mousePos, [100, 200]);
});

test('mousePos and dt come through as given', () => {
  const tracker = new InputTracker();
  tracker.onPointerMove(12.5, 640);
  const state = tracker.freeze(0.25);

  assert.deepEqual(state.mousePos, [12.5, 640]);
  assert.equal(state.dt, 0.25);
});

// ---------------------------------------------------------------------------
// Touch: one finger is the left button, two are the camera
// ---------------------------------------------------------------------------
//
// The properties pinned here are the touch analogues of the three asymmetries,
// plus the two that are new with fingers: the TAP SLOP (a press must not fire
// until the release proves it was a tap) and the CAMERA LATCH (a sequence that
// ever held two fingers belongs to the camera until every finger lifts). All
// of them fail quietly -- a select firing at the start of every pinch is the
// showcase, because the pick is async and the damage (an adopted rule) lands
// frames later, nowhere near the gesture that caused it.

test('a clean tap fires leftPressed on the release, not the press', () => {
  const tracker = new InputTracker();
  tracker.onTouchDown(1, 100, 100, false);

  // While the finger is down, nothing has happened yet: within the slop it is
  // not a drag, and until the release it is not a tap.
  let state = tracker.freeze(TICK);
  assert.equal(state.leftPressed, false, 'a tap must wait for its release');
  assert.equal(state.leftDragging, false);

  tracker.onTouchUp(1);
  state = tracker.freeze(TICK);
  assert.equal(state.leftPressed, true);
  assert.deepEqual(state.mousePos, [100, 100], 'the tap picks where the finger landed');

  // One-shot: drained like a mouse press.
  assert.equal(tracker.freeze(TICK).leftPressed, false);
});

test('a tap survives sub-slop roll; a real drag does not fire one', () => {
  const tracker = new InputTracker();
  tracker.onTouchDown(1, 100, 100, false);
  tracker.onTouchMove(1, 104, 103); // fingers roll -- still a tap
  tracker.onTouchUp(1);
  assert.equal(tracker.freeze(TICK).leftPressed, true, 'rolling a few pixels is still a tap');

  tracker.onTouchDown(1, 100, 100, false);
  tracker.onTouchMove(1, 160, 100); // well past the slop
  const dragging = tracker.freeze(TICK);
  assert.equal(dragging.leftDragging, true, 'past the slop the finger is the held button');
  assert.deepEqual(dragging.mousePos, [160, 100], 'the cursor follows the finger');

  tracker.onTouchUp(1);
  const released = tracker.freeze(TICK);
  assert.equal(released.leftDragging, false);
  assert.equal(released.leftPressed, false, 'a drag is not also a tap');
});

test('a finger landing on the UI is dropped entirely, moves and all', () => {
  const tracker = new InputTracker();
  tracker.onTouchDown(1, 100, 100, true);
  tracker.onTouchMove(1, 300, 300);
  tracker.onTouchUp(1);

  const state = tracker.freeze(TICK);
  assert.equal(state.leftPressed, false);
  assert.equal(state.leftDragging, false);
  assert.equal(state.pinch, null);
  assert.deepEqual(state.mousePos, [0, 0], 'a captured finger must not move the cursor');
});

test('a second finger ends the tool drag and latches the camera', () => {
  const tracker = new InputTracker();
  tracker.onTouchDown(1, 100, 100, false);
  tracker.onTouchMove(1, 200, 100); // a real drag is in progress
  assert.equal(tracker.freeze(TICK).leftDragging, true);

  tracker.onTouchDown(2, 300, 100, false);
  const state = tracker.freeze(TICK);
  assert.equal(state.leftDragging, false, 'the second finger releases the tool');
  assert.notEqual(state.pinch, null, 'two fingers are the camera');

  // The latch holds through the release order: lifting back down to ONE finger
  // keeps the survivor on the camera, and lifting the last must not fire a tap
  // -- the user was navigating, not selecting.
  tracker.onTouchUp(1);
  assert.notEqual(tracker.freeze(TICK).pinch, null, 'the survivor keeps the camera');
  tracker.onTouchUp(2);
  const done = tracker.freeze(TICK);
  assert.equal(done.pinch, null);
  assert.equal(done.leftPressed, false, 'ending a camera gesture is not a tap');
});

test('pinch reports centroid movement as pan and spread ratio as zoom', () => {
  const tracker = new InputTracker();
  tracker.onTouchDown(1, 100, 200, false);
  tracker.onTouchDown(2, 300, 200, false); // centroid (200,200), spread 100
  tracker.freeze(TICK); // settle the down frame

  // Both fingers translate +40x: pure pan, no zoom.
  tracker.onTouchMove(1, 140, 200);
  tracker.onTouchMove(2, 340, 200);
  let state = tracker.freeze(TICK);
  assert.notEqual(state.pinch, null);
  // Each move shifts the centroid by half the finger's travel: 20 + 20.
  assert.deepEqual(state.pinch?.panPixels, [40, 0]);
  assertNear(state.pinch?.zoomFactor ?? NaN, 1.0, 'translation must not zoom');

  // Fingers part to double the spread: pure zoom, factor 2.
  tracker.onTouchMove(1, 40, 200);
  tracker.onTouchMove(2, 440, 200);
  state = tracker.freeze(TICK);
  assertNear(state.pinch?.zoomFactor ?? NaN, 2.0, 'doubling the spread doubles the zoom');
  assert.deepEqual(state.pinch?.panPixels, [0, 0], 'a symmetric pinch must not pan');
});

test('the deltas drain each frame; the gesture itself persists', () => {
  const tracker = new InputTracker();
  tracker.onTouchDown(1, 100, 200, false);
  tracker.onTouchDown(2, 300, 200, false);
  tracker.onTouchMove(1, 120, 200);
  tracker.freeze(TICK);

  // No movement since: the pinch is still live, its deltas are spent.
  const quiet = tracker.freeze(TICK);
  assert.notEqual(quiet.pinch, null, 'fingers on the glass are a condition, not an event');
  assert.deepEqual(quiet.pinch?.panPixels, [0, 0]);
  assertNear(quiet.pinch?.zoomFactor ?? NaN, 1.0);
});

test('a finger lifting mid-pinch does not fling the view', () => {
  const tracker = new InputTracker();
  tracker.onTouchDown(1, 0, 0, false);
  tracker.onTouchDown(2, 400, 0, false); // centroid (200, 0)
  tracker.freeze(TICK);

  // Finger 2 leaves. The centroid teleports to (0,0) -- which must NOT read
  // as 200 pixels of pan, because no finger moved.
  tracker.onTouchUp(2);
  const state = tracker.freeze(TICK);
  assert.deepEqual(state.pinch?.panPixels, [0, 0], 'a count change is not movement');

  // The survivor panning from its own position works from the new baseline.
  tracker.onTouchMove(1, 30, 10);
  assert.deepEqual(tracker.freeze(TICK).pinch?.panPixels, [30, 10]);
});

test('a cancelled finger is not a tap', () => {
  const tracker = new InputTracker();
  tracker.onTouchDown(1, 100, 100, false);
  tracker.onTouchCancel(1); // the platform reclaimed it -- alert, edge gesture

  const state = tracker.freeze(TICK);
  assert.equal(state.leftPressed, false, 'the user did not choose this release');
  assert.equal(state.leftDragging, false);
});

test('focus loss forgets the fingers, not just the buttons', () => {
  const tracker = new InputTracker();
  tracker.onTouchDown(1, 100, 100, false);
  tracker.onFocusLost();

  // The up for that finger never arrives. The NEXT touch must be a first
  // finger -- a ghost entry would make it a "second" and latch the camera.
  tracker.onTouchDown(2, 50, 50, false);
  tracker.onTouchUp(2);
  assert.equal(tracker.freeze(TICK).leftPressed, true, 'a fresh tap after focus loss still taps');
});

/** Float comparison for spread ratios, which divide and so are never exact. */
function assertNear(actual: number, expected: number, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    message ?? `expected ${actual} to be within 1e-9 of ${expected}`,
  );
}
