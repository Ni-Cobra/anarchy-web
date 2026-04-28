import { anarchy } from "./gen/anarchy.js";

const { ClientMessage, ServerMessage } = anarchy.v1;

export type ServerHandler = (msg: anarchy.v1.ServerMessage) => void;

export interface Connection {
  send(payload: anarchy.v1.IClientMessage): void;
  close(): void;
}

export function connect(url: string, onMessage: ServerHandler): Connection {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let seq = 0;
  const nextSeq = () => ++seq;

  ws.addEventListener("open", () => {
    console.log("[net] open", url);
    sendInternal({
      seq: nextSeq(),
      hello: { clientVersion: "anarchy-web/0.1.0" },
    });
  });

  ws.addEventListener("close", (ev) => {
    console.log("[net] close", ev.code, ev.reason);
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
      ws.close();
    },
  };
}
