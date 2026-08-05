/**
 * InputState: one frame's input, frozen.
 * The type half of `ui/input_state.py` (86 lines, 24 fields).
 *
 * ## Who fills this in
 *
 * Written in Step 7 as the TYPE the frame loop is coded against --
 * `applyCanvasInput` and `applyCameraKeys` are ports of real desktop methods
 * and would otherwise have had nothing to read. **Step 8 built the producer**,
 * and split it in two so that the half with the decisions in it is testable
 * without a DOM:
 *
 *   - `inputTracker.ts` -- accumulates events and freezes this snapshot. Pure;
 *     never touches `window`. The port of `ui.py:82-255`.
 *   - `inputBinding.ts` -- the DOM listeners, which only translate events into
 *     tracker calls. The port of `ui.py:141-190`.
 *   - `hotkeys.ts` -- the focus-aware table, read from `keysPressed` below.
 *
 * ## Rebuilt once per frame, never mutated
 *
 * The desktop's is a frozen dataclass rebuilt each frame, so **every consumer
 * within a frame sees identical input**. `readonly` is the port of that, and it
 * matters more than it looks: `applyCanvasInput` and `status()` both read
 * `mousePos`, and a value that could change between them would put the readout
 * and the pick at different pixels.
 *
 * ## The asymmetries Step 8 must keep
 *
 * Stated here rather than in Step 8's handler because they are properties of
 * what these FIELDS MEAN, and a handler written without them produces fields
 * that are subtly the wrong thing:
 *
 *   - **Releases are never capture-filtered.** A button that went down on the
 *     canvas must be able to come up over a panel, or the drag never ends.
 *   - **A drag belongs to whoever received the press.** `leftDragging` stays
 *     true while the cursor wanders over the UI. That is why the drawing and
 *     shove tools read `*Dragging` rather than `*Held`.
 *   - **Capture is resolved ONCE, at the event handler.** By the time input
 *     reaches here, plain fields already mean "meant for the canvas". **No
 *     consumer downstream checks a capture flag** -- if you find yourself
 *     wanting to, the filtering belongs upstream.
 */

/**
 * One frame of the two-finger camera gesture.
 *
 * Deltas rather than absolutes, for the same reason `scroll` is: the tracker
 * accumulates within the frame (`+=` for pan, `*=` for zoom) so a fast gesture
 * that delivers three moves between two frames is worth all three, and
 * `freeze()` drains them. The consumer applies the deltas through the camera's
 * own methods and never needs to know where the fingers started.
 */
export interface PinchState {
  /**
   * Where the gesture is anchored: the touch centroid, framebuffer pixels.
   * The zoom pins the world point under this, exactly as wheel zoom pins the
   * point under the cursor.
   */
  readonly centroid: readonly [number, number];
  /** Centroid movement this frame, framebuffer pixels. */
  readonly panPixels: readonly [number, number];
  /** Spread ratio this frame. `1` means the fingers did not converge or part. */
  readonly zoomFactor: number;
}

/** One frame's input, already filtered for UI capture. */
export interface InputState {
  /** Cursor position in framebuffer pixels, top-left origin. */
  readonly mousePos: readonly [number, number];
  /** Seconds since the previous frame. Zero on the first frame. */
  readonly dt: number;

  /** Went down THIS frame, on the canvas. One-shot. */
  readonly leftPressed: boolean;
  readonly rightPressed: boolean;
  /**
   * A drag owned by the canvas is in progress.
   *
   * NOT the same as "the button is down": a press that landed on a panel never
   * starts one, and a drag that began on the canvas survives the cursor
   * crossing a panel.
   */
  readonly leftDragging: boolean;
  readonly rightDragging: boolean;

  /**
   * Scroll notches this frame, positive up. Zero when the wheel did not move.
   *
   * A NUMBER, not a boolean plus a direction, because `zoomAtPixel` takes
   * notches and a fast flick is worth more than one.
   */
  readonly scroll: number;

  /**
   * Physical key codes currently held (`KeyW`, `KeyA`, ...).
   *
   * **`KeyboardEvent.code`, not `.key`** -- the port reads WASD as physical
   * positions, so the same keys work on AZERTY and Dvorak. `.key` would give
   * `z` where `w` sits on a French layout, and the pan would go sideways.
   *
   * HELD, not pressed: continuous motion for as long as the key is down. See
   * `applyCameraKeys` for why these deliberately bypass the hotkey table.
   */
  readonly keysHeld: ReadonlySet<string>;

  /**
   * Physical key codes that went down THIS frame. One-shot, canvas only.
   *
   * **Auto-repeat IS included**, matching the desktop: `ui.py:154-156` treats
   * GLFW's PRESS and REPEAT identically, so a held key re-enters this set every
   * repeat tick. That is harmless for the one-shots the hotkey table dispatches
   * (holding `R` re-resets, which is what a held reset key should do) and it is
   * exactly why continuous motion reads `keysHeld` instead -- repeat RATE is an
   * OS setting, so panning through this set would move at a speed the app does
   * not control.
   */
  readonly keysPressed: ReadonlySet<string>;

  /**
   * The two-finger camera gesture, or `null` when none is live.
   *
   * `null` and not a zeroed value, so consumers can distinguish "no gesture"
   * from "a gesture that happens not to have moved this frame" -- the latter
   * still means fingers are on the glass and the tool layer stays out of it.
   *
   * Touch only ever reaches the frozen state as this field or as the
   * left-button fields (a single finger IS the left button; see
   * `inputTracker.ts`). There is deliberately no touch analogue of the right
   * button: every right-button gesture has a two-finger future, and inventing
   * one per tool now would pre-empt that design with three ad-hoc ones.
   */
  readonly pinch: PinchState | null;

  /**
   * Shift, from the most recent key event. The trimmed port of `mods`.
   *
   * Only Shift, because the hotkey table is deliberately Ctrl-free (see
   * `hotkeys.ts`) and `Shift+Z` is the one binding a modifier discriminates.
   * The desktop carries a full GLFW bitmask; porting one would mean four fields
   * nothing reads.
   */
  readonly shift: boolean;
}

/**
 * No input at all. The first frame's value, and what a headless driver passes.
 *
 * `dt: 0` is load-bearing rather than a placeholder: `applyCameraKeys` returns
 * early on a non-positive `dt`, so a frame with no measured delta cannot move
 * the camera by an unscaled step. The desktop guards the same way
 * (`orchestrator.py:447-448`).
 */
export const EMPTY_INPUT: InputState = Object.freeze({
  mousePos: Object.freeze([0, 0]) as readonly [number, number],
  dt: 0,
  leftPressed: false,
  rightPressed: false,
  leftDragging: false,
  rightDragging: false,
  scroll: 0,
  pinch: null,
  keysHeld: Object.freeze(new Set<string>()),
  keysPressed: Object.freeze(new Set<string>()),
  shift: false,
});
