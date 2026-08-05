/**
 * First-run GPU calibration: walk `PROGRESSION` until the machine says no.
 *
 * A new visitor otherwise lands on `worldSize: 1.0, physicsSteps: 30` -- 600k
 * particles and 90 GPU passes per frame -- whatever their hardware is. On a
 * discrete GPU that is fine; on an integrated laptop GPU it is a slideshow, and
 * their first impression of the app is that it is broken.
 *
 * ## The shape of the thing
 *
 * Probe each rung in ascending order, stop at the first one that misses the
 * frame budget, keep the last one that made it. No cost model, no extrapolation,
 * no arithmetic that can be subtly wrong: whatever passed IS the answer, because
 * it was measured on this machine running this simulation.
 *
 * That also makes it self-limiting in the direction that matters. A slow GPU
 * fails an early, cheap rung and never runs the expensive ones -- which is the
 * whole reason the ladder ascends. Probing at full size first to "see what it
 * can do" would hand the weakest machines the heaviest workload in the app
 * before anything was on screen.
 *
 * ## Everything here is best-effort
 *
 * Calibration is a convenience, and it runs on the startup path. Nothing in it
 * may take the app down, and nothing in it may hang the app either. Hence the
 * try/catch around the whole walk, the wall-clock ceiling, and the cancellation
 * check between rungs. If any of those fire, whatever passed so far is
 * committed and the app carries on -- the same fail-soft posture `main.ts`
 * takes with a bad share link.
 */

import { PROGRESSION, budgetMs, type Rung } from './progression.ts';

/**
 * The Orchestrator surface calibration uses. Three methods, named structurally
 * rather than by importing the class: this module has no business reaching any
 * further into it, and a narrow interface is what lets the ladder be tested
 * against a fake with no GPU in sight.
 */
export interface CalibrationTarget {
  /** Applies a rung. Resolves to whether the simulation was rebuilt. */
  calibrateTo(worldSize: number, physicsSteps: number): Promise<boolean>;
  /**
   * Submit `count` frames and resolve when the GPU has finished ALL of them.
   *
   * A batch, not a loop of single frames, and the batching is load-bearing --
   * see PROBE_BATCH for the Safari failure that forced it. One completion
   * await per batch is the entire point; an implementation that awaited each
   * frame internally would faithfully reintroduce the bug.
   */
  probeFrames(count: number): Promise<void>;
  /** Persists the result, rebuilds if needed, and restarts the simulation. */
  commitCalibration(worldSize: number, physicsSteps: number): Promise<void>;
}

export interface CalibrationOptions {
  /** Progress, as `(rungIndex, total)`, before each rung is probed. */
  readonly onProgress?: (done: number, total: number) => void;
  /**
   * Asked between rungs; true abandons the walk and commits what passed.
   *
   * **NOTHING IN THE APP PASSES THIS TODAY.** It existed for the splash being
   * dismissed mid-walk, which is no longer reachable -- the splash is locked
   * shut while calibrating, precisely so a user cannot land in an app that is
   * still reshaping itself. Kept because the ladder needs a way to be stopped
   * from outside for reasons the ladder cannot see, and because the tests use
   * it to exercise the early-exit path that the wall-clock ceiling shares.
   */
  readonly cancelled?: () => boolean;
  /** Injected for tests. Defaults to `performance.now`. */
  readonly now?: () => number;
}

/**
 * Timed samples per rung, reduced by a median. Each sample is a BATCH of
 * `PROBE_BATCH` frames, so a rung is measured across 18 frames in three
 * completion waits.
 *
 * Three, down from ten single-frame samples, because the batching does most of
 * the outlier work the sample count used to do: a GC pause or a waking tab
 * lands inside one batch and is diluted across its six frames, and the median
 * then discards that batch entirely if it is still the odd one out.
 */
const SAMPLES = 3;

/**
 * Frames per timed sample -- and THE FIX FOR A REAL FAILURE, not a tuning
 * knob.
 *
 * The ladder originally timed one frame per sample: submit, await
 * `onSubmittedWorkDone`, subtract. **Safari resolves that completion on the
 * next VSYNC**, so every sample on every iOS device read as ~16.7 ms
 * regardless of how fast the GPU actually finished -- over an 11.7 ms budget,
 * always, on hardware of any speed. Every rung "failed", every iPhone and
 * iPad committed the unprobed floor (world 0.05, physics 1), and because tool
 * strength deliberately scales with the physics rate, the whole app ran at
 * 1/30th speed and the drag tools read as dead. Chromium resolves completions
 * promptly, which is why desktop testing never saw any of this.
 *
 * Submitting six frames and awaiting ONE completion amortizes the quantum:
 * the vsync rounding lands once on the batch instead of once per frame, so a
 * fast GPU measures ~16.7/6 = 2.8 ms per frame and passes honestly. A slow
 * GPU's real work dominates the quantum and still fails honestly. Near the
 * budget boundary the rounding can only overestimate -- at most one rung of
 * caution, in the direction that was already policy (see HEADROOM).
 *
 * Six is deliberately modest: a batch must stay well inside the walk's
 * wall-clock ceiling even at the most expensive rung on a slow machine
 * (rung cost 20 x 6 frames at a miss-worthy 30 ms is ~0.6 s), while being
 * long enough that a 16.7 ms quantum cannot push a comfortable rung over
 * budget (16.7/6 < 11.7 with room to spare).
 */
const PROBE_BATCH = 6;

/**
 * Discarded frames after a change that did NOT rebuild.
 *
 * Covers the one-off costs a physics-rate change still pays: pipeline warm-up
 * and `ensureUniformCapacity` growing the uniform buffers as the rate rises
 * (`particleSystem.ts:1159-1175`). The simulation itself carries on from where
 * the previous rung left it, so there is no simulation state to settle.
 */
const WARMUP = 2;

/**
 * Discarded frames after a REBUILD, which is a far more expensive start.
 *
 * A world-size change constructs a new `ParticleSystem`, and a new system's
 * `_frameCount` is zero -- the reset sentinel every shader watches for. The
 * frames immediately after it regenerate every entity's position, velocity and
 * rule, and clear the canvas, so they cost materially more than the steady
 * state that follows.
 *
 * **THIS IS WHY FIRST-RUN CALIBRATION CAME OUT TOO CONSERVATIVE.** Measuring
 * across those frames charges a rung for startup work it never repeats, so
 * machines were failing rungs they could hold comfortably -- which is exactly
 * why re-running calibration afterwards (from an already-warm simulation)
 * landed somewhere better. Burning them first is the fix.
 *
 * Only spent when a rebuild actually happened. Three of the six probed rungs
 * change physics rate alone, and those keep the warm simulation they inherited.
 */
const REBUILD_WARMUP = 25;

/**
 * Wall-clock ceiling for the whole walk.
 *
 * The budget bounds a single frame, not the sum of them, and on a very slow
 * machine even passing rungs are slow. This bounds the total, so nobody waits
 * behind the splash indefinitely. Checked between rungs rather than mid-rung so
 * a rung is never half-measured.
 *
 * Raised from 3 s to 8 s along with the burn-in: three rebuild rungs now spend
 * 25 discarded frames each before they measure anything, and the old ceiling
 * would have cut the walk short on precisely the mid-range machines this is
 * meant to place accurately -- turning a fix for over-conservatism into a
 * different cause of it. Still bounded, because it must be.
 */
const CEILING_MS = 8000;

/**
 * Walk the progression and commit the heaviest rung that held the budget.
 *
 * Returns the chosen rung, for logging and tests. Never throws.
 */
export async function calibrate(
  target: CalibrationTarget,
  opts: CalibrationOptions = {},
): Promise<Rung> {
  const now = opts.now ?? ((): number => performance.now());
  const started = now();
  const total = PROGRESSION.length;

  // The floor, accepted without being probed: there is nothing lighter to fall
  // back to, so measuring it could only tell us something we cannot act on.
  let best: Rung = PROGRESSION[0]!;

  try {
    for (let i = 1; i < total; i++) {
      if (opts.cancelled?.() === true) break;
      if (now() - started > CEILING_MS) break;

      const rung = PROGRESSION[i]!;
      opts.onProgress?.(i, total - 1);

      // A rebuild restarts the simulation, and the frames right after a restart
      // are the expensive ones -- so those rungs burn far more before measuring.
      // A physics-only rung inherits the warm simulation the previous rung left
      // running and needs no such settling.
      const rebuilt = await target.calibrateTo(rung.worldSize, rung.physicsSteps);
      // One batch, one completion wait: on Safari, N awaited single frames
      // cost N vsyncs of pure waiting before anything is even measured.
      const warmup = rebuilt ? REBUILD_WARMUP : WARMUP;
      await target.probeFrames(warmup);

      const samples: number[] = [];
      for (let s = 0; s < SAMPLES; s++) {
        const t0 = now();
        await target.probeFrames(PROBE_BATCH);
        // The PER-FRAME estimate, so the budget comparison below is unchanged.
        samples.push((now() - t0) / PROBE_BATCH);
      }

      if (median(samples) > budgetMs()) break;
      best = rung;
    }
  } catch (err: unknown) {
    // A probe that threw tells us nothing about the rung, so the last rung that
    // actually passed stands. Warn rather than surface it: there is nothing
    // here a user could act on, and the app is fine.
    console.warn(`Calibration stopped early: ${String(err)}`);
  }

  // ALWAYS commits, including on the catch path and including when the walk was
  // cancelled. The alternative is leaving `calibrated` false, which re-runs the
  // whole thing on the next load -- so a machine that cannot finish calibration
  // would pay for it on every single visit, forever.
  //
  // AWAITED, and its own try/catch: the commit rebuilds the simulation and
  // resets it, and returning before that settles would release the splash over
  // an app still reshaping itself -- which is the state the lock exists to hide.
  try {
    await target.commitCalibration(best.worldSize, best.physicsSteps);
  } catch (err: unknown) {
    console.warn(`Calibration could not commit its result: ${String(err)}`);
  }
  return best;
}

/**
 * Middle value of a copy. `samples` is 10 long, so sorting cost is irrelevant.
 *
 * With an even count this takes the UPPER of the two middle values rather than
 * averaging them. Deliberate, and the conservative direction: it never invents
 * a timing that was not actually observed, and it leans very slightly toward
 * calling a rung expensive -- which costs at most one rung, where the opposite
 * error ships someone a setting their machine cannot hold.
 */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
