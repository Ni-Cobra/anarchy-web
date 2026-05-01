/**
 * Client-wide tuning constants. One module so they're greppable, swappable,
 * and (eventually) loadable from a build-time env. Until then, these are
 * compile-time `const`s.
 *
 * What lives here: knobs that affect rendering cadence, prediction, or
 * networking heartbeats — things a tuning pass might touch. What does *not*
 * live here: visual constants that belong with their owning module
 * (mesh sizes, colors, axis line lengths) and anything specific to one test.
 */

// ---- Game ----

/**
 * World units per second. Mirrors `crate::config::SPEED` on the server — the
 * two must stay equal so that predicted client motion converges with the
 * authoritative server tick. See ADR 0001 (movement-intent amendment).
 */
export const SPEED = 5.0;

/**
 * If predicted position diverges from the latest reconcilable server
 * snapshot by more than this many world units, snap to the server. Picked to
 * be larger than the typical server-vs-client lag distance for a player
 * moving at full speed (`|intent| * SPEED * RTT/2` is well under 1.0 on a
 * sub-100 ms link) but small enough that an actual override (collision,
 * future anti-cheat) gets corrected within a single tick.
 */
export const RECONCILE_SNAP_DISTANCE = 1.5;

// ---- Render ----

/**
 * Render-time delay applied to remote players. We draw remote players
 * ~100 ms behind real time and lerp between bracketing snapshots, so a
 * typical jitter or a single dropped tick never produces a visible jump.
 */
export const REMOTE_RENDER_DELAY_MS = 100;

/**
 * How high the top-down camera floats above the local player. Pure visual
 * choice — large enough to see neighbors, small enough to keep tiles legible.
 */
export const CAMERA_HEIGHT = 14;

// ---- Input ----

/**
 * 20 Hz matches the server tick (ADR 0001). The input controller polls the
 * held key set this often and pushes intent to the sink whenever it changes.
 */
export const INPUT_TICK_INTERVAL_MS = 50;

/**
 * Resend the current intent every N ticks even when it hasn't changed, so a
 * dropped frame can't leave the server with a stale view of the player's
 * intent for more than ~N * INPUT_TICK_INTERVAL_MS. 10 ticks ≈ 500 ms.
 */
export const INPUT_HEARTBEAT_TICKS = 10;

// ---- Network ----

/**
 * Heartbeat: send a Ping every PING_INTERVAL_MS, and close the socket if no
 * frame at all has arrived from the server within RECV_TIMEOUT_MS. The server
 * kicks idle clients on its own clock — see anarchy-server `RECV_IDLE_TIMEOUT`.
 */
export const PING_INTERVAL_MS = 5_000;
export const RECV_TIMEOUT_MS = 15_000;
