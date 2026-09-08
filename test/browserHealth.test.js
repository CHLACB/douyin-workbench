import test from "node:test";
import assert from "node:assert/strict";

import { BrowserController } from "../src/app/BrowserController.js";

class ProbeWebSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    queueMicrotask(() => {
      this.readyState = ProbeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type, event) {
    for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
  }

  send(rawMessage) {
    const message = JSON.parse(rawMessage);
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({
        id: message.id,
        result: { result: { value: { href: "https://www.douyin.com/jingxuan", readyState: "complete" } } },
      }),
    }));
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
}

function makeTarget(id, url = "https://www.douyin.com/jingxuan") {
  return {
    id,
    type: "page",
    title: "抖音",
    url,
    webSocketDebuggerUrl: `ws://page/${id}`,
  };
}

async function withFakeDevtools(t, targets) {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).endsWith("/json/version")
      ? { Browser: "Chrome/Test", webSocketDebuggerUrl: "ws://browser" }
      : targets,
  });
  globalThis.WebSocket = ProbeWebSocket;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });
}

test("browser status reports a healthy endpoint, target, and real CDP probe", async (t) => {
  await withFakeDevtools(t, [makeTarget("stored")]);
  const controller = new BrowserController();
  controller.readSession = () => ({
    remoteDebuggingHost: "127.0.0.1",
    remoteDebuggingPort: 9222,
    pid: null,
    target: { id: "stored" },
  });

  const status = await controller.status();
  assert.equal(status.connected, true);
  assert.equal(status.healthy, true);
  assert.equal(status.health.endpoint.reachable, true);
  assert.equal(status.health.target.selected.id, "stored");
  assert.equal(status.health.cdp.connected, true);
});

test("browser status marks a missing stored target stale while exposing a safe replacement", async (t) => {
  await withFakeDevtools(t, [makeTarget("replacement", "https://www.douyin.com/search/cat")]);
  const controller = new BrowserController();
  controller.readSession = () => ({
    remoteDebuggingHost: "127.0.0.1",
    remoteDebuggingPort: 9222,
    pid: null,
    target: { id: "gone" },
  });

  const status = await controller.status();
  assert.equal(status.connected, true);
  assert.equal(status.healthy, false);
  assert.equal(status.health.stale, true);
  assert.ok(status.health.reasons.includes("target-missing"));
  assert.equal(status.health.target.selected.id, "replacement");
});

test("browser status treats a stored user-profile target as unsafe", async (t) => {
  await withFakeDevtools(t, [
    makeTarget("stored", "https://www.douyin.com/user/sec"),
    makeTarget("safe", "https://www.douyin.com/jingxuan"),
  ]);
  const controller = new BrowserController();
  controller.readSession = () => ({
    remoteDebuggingHost: "127.0.0.1",
    remoteDebuggingPort: 9222,
    pid: null,
    target: { id: "stored" },
  });

  const status = await controller.status();
  assert.ok(status.health.reasons.includes("target-unsafe"));
  assert.equal(status.health.target.selected.id, "safe");
});

test("browser status reports an invalid session as stale instead of throwing", async () => {
  const controller = new BrowserController();
  controller.readSession = () => { throw new Error("bad json"); };
  const status = await controller.status();
  assert.equal(status.health.stale, true);
  assert.deepEqual(status.health.reasons, ["invalid-session"]);
});

test("browser open overwrites a stale session when reusing a live endpoint", async (t) => {
  const target = makeTarget("fresh");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/json/new?")) {
      return { ok: true, json: async () => target };
    }
    return { ok: true, text: async () => "Target activated" };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const controller = new BrowserController();
  controller.pathResolver.resolve = () => process.execPath;
  controller.status = async () => ({ hasSession: true, health: { stale: true } });
  controller.tryReadExistingDevtools = async () => ({ Browser: "Chrome/Test" });
  let persisted = null;
  controller.writeSession = (session) => { persisted = session; };

  const opened = await controller.open({ url: "https://www.douyin.com/jingxuan" });
  assert.equal(opened.reused, true);
  assert.equal(opened.recoveredFromStaleSession, true);
  assert.equal(opened.target.id, "fresh");
  assert.equal("webSocketDebuggerUrl" in opened.target, false);
  assert.equal(persisted.target.id, "fresh");
});

test("browser status reports both a dead PID and an unreachable DevTools port", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new BrowserController();
  controller.readSession = () => ({
    remoteDebuggingHost: "127.0.0.1",
    remoteDebuggingPort: 9222,
    pid: 2_147_483_647,
  });

  const status = await controller.status();
  assert.equal(status.health.stale, true);
  assert.ok(status.health.reasons.includes("pid-not-alive"));
  assert.ok(status.health.reasons.includes("devtools-unreachable"));
});

test("browser status distinguishes a reachable version endpoint from a broken target list", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/json/version")) {
      return { ok: true, json: async () => ({ Browser: "Chrome/Test" }) };
    }
    throw new TypeError("list failed");
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new BrowserController();
  controller.readSession = () => ({
    remoteDebuggingHost: "127.0.0.1",
    remoteDebuggingPort: 9222,
    pid: null,
  });

  const status = await controller.status();
  assert.equal(status.health.endpoint.reachable, true);
  assert.ok(status.health.reasons.includes("target-list-unavailable"));
  assert.equal(status.health.reasons.includes("devtools-unreachable"), false);
});

function ownedSession(overrides = {}) {
  return {
    remoteDebuggingHost: "127.0.0.1",
    remoteDebuggingPort: 9222,
    pid: 43210,
    chromePath: "C:\\Chrome\\chrome.exe",
    userDataDir: "C:\\Product\\.runtime\\chrome-profile",
    devtools: { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/owned-id" },
    reused: false,
    ...overrides,
  };
}

function closeHarness(options = {}) {
  const calls = { read: 0, connect: 0, send: 0, close: 0, kill: 0, remove: 0 };
  const versions = [...(options.versions || [])];
  const runtime = {
    createClient: () => ({
      readVersion: async () => {
        calls.read += 1;
        const next = versions.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    }),
    createSession: () => ({
      connect: async () => { calls.connect += 1; },
      send: async (method) => {
        calls.send += 1;
        assert.equal(method, "Browser.close");
        if (options.sendError) throw options.sendError;
      },
      close: () => { calls.close += 1; },
    }),
    inspectProcessOwnership: async () => options.pidProof || { ok: false, reason: "test-unproven" },
    killProcess: () => { calls.kill += 1; },
    removeSessionFile: () => { calls.remove += 1; },
    sleep: async () => {},
    endpointPollAttempts: options.pollAttempts || 2,
    endpointPollIntervalMs: 0,
  };
  return { runtime, calls };
}

test("browser close refuses a reused session without force before touching the endpoint", async () => {
  const { runtime, calls } = closeHarness();
  const controller = new BrowserController({ closeRuntime: runtime });
  controller.readSession = () => ownedSession({ reused: true });

  const result = await controller.close();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reused-session-requires-force");
  assert.equal(result.removedSessionFile, false);
  assert.deepEqual(calls, { read: 0, connect: 0, send: 0, close: 0, kill: 0, remove: 0 });
});

test("browser close force cannot bypass browser websocket identity proof", async () => {
  const { runtime, calls } = closeHarness({
    versions: [{ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/other-id" }],
  });
  const controller = new BrowserController({ closeRuntime: runtime });
  controller.readSession = () => ownedSession({ reused: true });

  const result = await controller.close({ force: true });
  assert.equal(result.reason, "browser-identity-mismatch");
  assert.equal(result.removedSessionFile, false);
  assert.equal(calls.send, 0);
  assert.equal(calls.kill, 0);
  assert.equal(calls.remove, 0);
});

test("browser close removes session only after the proven endpoint goes down", async () => {
  const { runtime, calls } = closeHarness({
    versions: [
      { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/owned-id" },
      new Error("connection refused"),
    ],
  });
  const controller = new BrowserController({ closeRuntime: runtime });
  controller.readSession = () => ownedSession();

  const result = await controller.close();
  assert.equal(result.ok, true);
  assert.equal(result.method, "devtools");
  assert.equal(calls.send, 1);
  assert.equal(calls.kill, 0);
  assert.equal(calls.remove, 1);
});

test("browser close retains session when Browser.close does not take endpoint down and PID is unproven", async () => {
  const live = { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/owned-id" };
  const { runtime, calls } = closeHarness({ versions: [live, live, live] });
  const controller = new BrowserController({ closeRuntime: runtime });
  controller.readSession = () => ownedSession();

  const result = await controller.close();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "test-unproven");
  assert.equal(result.removedSessionFile, false);
  assert.equal(calls.kill, 0);
  assert.equal(calls.remove, 0);
});

test("browser close uses PID fallback only with a positive process ownership proof", async () => {
  const { runtime, calls } = closeHarness({
    versions: [new Error("endpoint unavailable"), new Error("endpoint unavailable")],
    pidProof: { ok: true, checks: { executable: true, port: true, userDataDir: true } },
  });
  const controller = new BrowserController({ closeRuntime: runtime });
  controller.readSession = () => ownedSession();

  const result = await controller.close();
  assert.equal(result.ok, true);
  assert.equal(result.method, "pid");
  assert.equal(calls.send, 0);
  assert.equal(calls.kill, 1);
  assert.equal(calls.remove, 1);
});

test("browser close refuses an endpoint override that differs from the session", async () => {
  const { runtime, calls } = closeHarness();
  const controller = new BrowserController({ closeRuntime: runtime });
  controller.readSession = () => ownedSession();

  const result = await controller.close({ port: 9333 });
  assert.equal(result.reason, "endpoint-mismatch");
  assert.equal(result.removedSessionFile, false);
  assert.equal(calls.read, 0);
  assert.equal(calls.kill, 0);
});
