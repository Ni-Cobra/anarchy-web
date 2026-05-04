import { PING_INTERVAL_MS, RECV_TIMEOUT_MS } from "../config.js";
import { anarchy } from "../gen/anarchy.js";

const { ClientMessage, ServerMessage } = anarchy.v1;

export type ServerHandler = (msg: anarchy.v1.ServerMessage) => void;

export interface Connection {
  send(payload: anarchy.v1.IClientMessage): void;
  close(): void;
}

/**
 * Lobby-collected identity shipped as the first frame on every
 * connection. `username` must be non-empty after trim and within the
 * server's allow-list charset; `colorIndex` must address an entry of
 * `PALETTE`. The client validates these in the lobby submit handler so a
 * legitimate run never sees a mid-session disconnect for malformed Hello.
 *
 * `reconnect` opts the session into reconnect-admission: the server tries
 * to restore a dormant character with the same `username` rather than
 * spawning a fresh one. Failures (no record, or a live session under that
 * name) come back as a `LobbyReject` and the lobby renders the reason.
 * Documented as a temporary identity mechanism pending real auth.
 */
export interface LobbyIdentity {
  readonly username: string;
  readonly colorIndex: number;
  readonly reconnect?: boolean;
}

/**
 * Reasons the server can ship in a `LobbyReject` reply. Mirrors the
 * `lobby_reject.Reason` proto enum but reflected as a string-tagged
 * discriminator so the lobby UI can switch on it cleanly. New variants
 * land here when the proto enum grows.
 */
export type LobbyRejectReason = "reconnect-live-session" | "reconnect-no-record";

/**
 * Lifecycle hooks for the lobby UI. `onLobbyReject` fires when the server
 * replies to the Hello with a `LobbyReject`; the connection closes
 * immediately afterward, so the caller doesn't need to call `close()` to
 * tear down. The reason lets the lobby render a specific message and
 * keep the player on the lobby screen instead of routing into the game.
 */
export interface ConnectHooks {
  onLobbyReject?: (reason: LobbyRejectReason) => void;
}

export function connect(
  url: string,
  identity: LobbyIdentity,
  onMessage: ServerHandler,
  hooks: ConnectHooks = {},
): Connection {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let seq = 0;
  const nextSeq = () => ++seq;

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let lastRecvAt = 0;

  const stopHeartbeat = () => {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  ws.addEventListener("open", () => {
    console.log("[net] open", url);
    sendInternal({
      seq: nextSeq(),
      hello: {
        clientVersion: "anarchy-client/0.1.0",
        username: identity.username,
        colorIndex: identity.colorIndex,
        reconnect: identity.reconnect ?? false,
      },
    });

    lastRecvAt = Date.now();
    pingTimer = setInterval(() => {
      if (Date.now() - lastRecvAt > RECV_TIMEOUT_MS) {
        console.warn("[net] server silent, closing");
        stopHeartbeat();
        ws.close();
        return;
      }
      sendInternal({ seq: nextSeq(), ping: { clientTimeMs: Date.now() } });
    }, PING_INTERVAL_MS);
  });

  ws.addEventListener("close", (ev) => {
    console.log("[net] close", ev.code, ev.reason);
    stopHeartbeat();
  });

  ws.addEventListener("error", (ev) => {
    console.error("[net] error", ev);
  });

  ws.addEventListener("message", (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) {
      console.warn("[net] non-binary frame ignored");
      return;
    }
    try {
      const msg = ServerMessage.decode(new Uint8Array(ev.data));
      lastRecvAt = Date.now();
      if (msg.lobbyReject) {
        const reason = lobbyRejectReasonFromWire(msg.lobbyReject.reason);
        if (reason !== null) hooks.onLobbyReject?.(reason);
        return;
      }
      onMessage(msg);
    } catch (err) {
      console.error("[net] decode failed", err);
    }
  });

  function sendInternal(payload: anarchy.v1.IClientMessage) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const msg = ClientMessage.create(payload);
    const bytes = ClientMessage.encode(msg).finish();
    ws.send(bytes);
  }

  return {
    send(payload) {
      sendInternal({ ...payload, seq: nextSeq() });
    },
    close() {
      stopHeartbeat();
      ws.close();
    },
  };
}

function lobbyRejectReasonFromWire(
  reason: anarchy.v1.LobbyReject.Reason | null | undefined,
): LobbyRejectReason | null {
  switch (reason) {
    case anarchy.v1.LobbyReject.Reason.LOBBY_REJECT_REASON_RECONNECT_LIVE_SESSION:
      return "reconnect-live-session";
    case anarchy.v1.LobbyReject.Reason.LOBBY_REJECT_REASON_RECONNECT_NO_RECORD:
      return "reconnect-no-record";
    default:
      return null;
  }
}
