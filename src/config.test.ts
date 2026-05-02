import { describe, expect, it } from "vitest";

import { PLAYER_RADIUS, REACH_BLOCKS, SPEED } from "./config.js";

// These constants must stay equal to their `crate::config` /
// `crate::game::player` counterparts on the server. Pin them here so a
// drift on either side surfaces immediately rather than as gameplay
// divergence (out-of-reach interactions accepted on one side and not the
// other; visual hitbox not matching authoritative collision).
describe("client/server mirror constants", () => {
  it("SPEED equals server crate::config::SPEED", () => {
    expect(SPEED).toBe(5.0);
  });

  it("REACH_BLOCKS equals server crate::config::REACH_BLOCKS", () => {
    expect(REACH_BLOCKS).toBe(4.0);
  });

  it("PLAYER_RADIUS equals server crate::game::player::PLAYER_RADIUS", () => {
    // 70% of a tile width — the visual sphere and authoritative collision
    // circle share this radius. Changing it requires a coordinated server
    // edit + e2e retune.
    expect(PLAYER_RADIUS).toBe(0.35);
  });
});
