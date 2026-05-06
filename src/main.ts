import { runApp, type AnarchyHandle } from "./bootstrap.js";
import { isValidColorIndex, validateUsername } from "./game/index.js";
import type { LobbyIdentity } from "./net/index.js";

declare global {
  interface Window {
    __anarchy?: AnarchyHandle;
  }
}

// Dev-only entrypoint flag: `?stub-terrain=1` skips the WebSocket connection
// and renders a hand-built `Terrain` so the terrain renderer can be exercised
// without a server. Production builds normally never pass this flag — see
// `dev/terrain_stub.ts`.
//
// Lobby bypass via `?username=Foo&color=2` — when both query params validate,
// skip the lobby UI and connect immediately. Used by the browser-driven e2e
// spec (`client-app.spec.ts`) so it can drive the live app without scripting
// keystrokes through the lobby form. After a Disconnect the lifecycle loop
// returns to the lobby (the bypass only seeds the *first* session).
//
// `?server-port=NNNN` redirects the WebSocket connection to a different
// port on `localhost`. Used by the player-accounts e2e spec
// (`accounts.spec.ts`) which spawns its own server on a non-default port +
// custom world so the per-spec accounts file stays isolated from the
// Playwright-managed default on `:8080`.
const params = new URLSearchParams(window.location.search);

if (params.get("stub-terrain") === "1") {
  void import("./dev/terrain_stub.js").then(({ runTerrainStub }) => {
    runTerrainStub();
  });
} else {
  void runApp(lobbyBypassFromQuery(params), wsUrlFromQuery(params));
}

function lobbyBypassFromQuery(query: URLSearchParams): LobbyIdentity | null {
  const rawName = query.get("username");
  const rawColor = query.get("color");
  if (rawName === null && rawColor === null) return null;
  const username = rawName === null ? null : validateUsername(rawName);
  const colorIndex = rawColor === null ? 0 : Number.parseInt(rawColor, 10);
  if (username === null) return null;
  if (!isValidColorIndex(colorIndex)) return null;
  return { username, colorIndex };
}

function wsUrlFromQuery(query: URLSearchParams): string | undefined {
  const rawPort = query.get("server-port");
  if (rawPort === null) return undefined;
  if (!/^\d+$/.test(rawPort)) return undefined;
  const port = Number.parseInt(rawPort, 10);
  if (port < 1 || port > 65535) return undefined;
  return `ws://localhost:${port}/ws`;
}
