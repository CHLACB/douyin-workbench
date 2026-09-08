import test from "node:test";
import assert from "node:assert/strict";

import { DevtoolsSession } from "../src/infra/cdp/DevtoolsSession.js";

class FakeWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type, data = {}) {
    for (const handler of [...(this.listeners.get(type) || [])]) handler(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
FakeWebSocket.instances = [];

async function connectedSession(options = {}) {
  FakeWebSocket.instances.length = 0;
  const session = new DevtoolsSession("ws://devtools/page/1", {
    WebSocketImpl: FakeWebSocket,
    commandTimeoutMs: 20,
    ...options,
  });
  const connecting = session.connect();
  FakeWebSocket.instances[0].open();
  await connecting;
  return { session, socket: FakeWebSocket.instances[0] };
}

test("DevtoolsSession times out each pending CDP command", async () => {
  const { session } = await connectedSession({ commandTimeoutMs: 15 });
  await assert.rejects(session.send("Runtime.evaluate"), /DevTools 命令超时: Runtime\.evaluate（15ms/);
  assert.equal(session.pending.size, 0);
  session.close();
});

test("DevtoolsSession rejects pending commands on socket close and error", async () => {
  const first = await connectedSession();
  const closed = first.session.send("Page.enable");
  first.socket.close();
  await assert.rejects(closed, /WebSocket 已关闭/);
  assert.equal(first.session.pending.size, 0);

  const second = await connectedSession();
  const errored = second.session.send("Network.enable");
  second.socket.emit("error");
  await assert.rejects(errored, /WebSocket 连接错误/);
  assert.equal(second.session.pending.size, 0);
  second.session.close();
});

test("DevtoolsSession closes and forgets a timed-out connection", async () => {
  FakeWebSocket.instances.length = 0;
  const session = new DevtoolsSession("ws://devtools/stalled", {
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 15,
  });

  await assert.rejects(session.connect(), /连接超时（15ms/);
  assert.equal(FakeWebSocket.instances[0].readyState, 3);
  assert.equal(session.socket, null);
});

test("DevtoolsSession clears a command timeout after receiving a result", async () => {
  const { session, socket } = await connectedSession();
  const result = session.send("Runtime.evaluate", { expression: "1+1" });
  const request = JSON.parse(socket.sent[0]);
  socket.emit("message", { data: JSON.stringify({ id: request.id, result: { value: 2 } }) });
  assert.deepEqual(await result, { value: 2 });
  assert.equal(session.pending.size, 0);
  session.close();
});
