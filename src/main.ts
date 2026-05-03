import { runMain, type AnarchyHandle } from "./bootstrap.js";

declare global {
  interface Window {
    __anarchy?: AnarchyHandle;
  }
}

// Dev-only entrypoint flag: `?stub-terrain=1` skips the WebSocket connection
// and renders a hand-built `Terrain` so the terrain renderer can be exercised
// without a server. Production builds normally never pass this flag — see
// `dev/terrain_stub.ts`.
const params = new URLSearchParams(window.location.search);
if (params.get("stub-terrain") === "1") {
  void import("./dev/terrain_stub.js").then(({ runTerrainStub }) => {
    runTerrainStub();
  });
} else {
  window.__anarchy = runMain();
}
