import test from "node:test";
import assert from "node:assert/strict";

import { DevtoolsClient } from "../src/infra/cdp/DevtoolsClient.js";

test("DevtoolsClient aborts a stalled request with endpoint context", async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  const client = new DevtoolsClient("127.0.0.1", 9222, {
    requestTimeoutMs: 15,
    fetchImpl,
  });

  await assert.rejects(
    client.listTargets(),
    /读取 DevTools target 列表超时（15ms，http:\/\/127\.0\.0\.1:9222\/json\/list）/,
  );
});

test("DevtoolsClient reports HTTP and malformed JSON failures clearly", async () => {
  const httpClient = new DevtoolsClient("host", 1, {
    fetchImpl: async () => ({ ok: false, status: 503, statusText: "Unavailable" }),
  });
  await assert.rejects(httpClient.readVersion(), /读取 DevTools 版本返回 HTTP 503 Unavailable/);

  const jsonClient = new DevtoolsClient("host", 1, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => { throw new SyntaxError("bad json"); },
    }),
  });
  await assert.rejects(jsonClient.readVersion(), /读取 DevTools 版本返回了无效 JSON: bad json/);
});

test("DevtoolsClient timeout also covers a stalled response body", async () => {
  const client = new DevtoolsClient("host", 1, {
    requestTimeoutMs: 15,
    fetchImpl: async () => ({
      ok: true,
      json: async () => await new Promise(() => {}),
    }),
  });
  await assert.rejects(client.readVersion(), /读取 DevTools 版本超时（15ms/);
});
