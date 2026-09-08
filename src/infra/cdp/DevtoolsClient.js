import { retryUntil } from "../../core/time.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export class DevtoolsClient {
  constructor(host, port, options = {}) {
    this.host = host;
    this.port = port;
    this.requestTimeoutMs = readPositiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  versionUrl() {
    return `http://${this.host}:${this.port}/json/version`;
  }

  async readVersion(options = {}) {
    return await this.requestJson(this.versionUrl(), {
      label: "读取 DevTools 版本",
      timeoutMs: options.timeoutMs,
    });
  }

  async listTargets(options = {}) {
    return await this.requestJson(`http://${this.host}:${this.port}/json/list`, {
      label: "读取 DevTools target 列表",
      timeoutMs: options.timeoutMs,
    });
  }

  async openUrl(url, options = {}) {
    const endpoint = `http://${this.host}:${this.port}/json/new?${encodeURIComponent(url)}`;
    return await this.requestJson(endpoint, {
      method: "PUT",
      label: "通过 DevTools 打开页面",
      timeoutMs: options.timeoutMs,
    });
  }

  async activateTarget(targetId, options = {}) {
    return await this.requestText(`http://${this.host}:${this.port}/json/activate/${encodeURIComponent(targetId)}`, {
      label: "激活 DevTools 页面",
      timeoutMs: options.timeoutMs,
    });
  }

  async waitUntilReady(timeoutMs = 10_000) {
    const boundedTimeoutMs = readPositiveTimeout(timeoutMs, 10_000);
    return retryUntil(
      () => this.readVersion({ timeoutMs: Math.min(this.requestTimeoutMs, boundedTimeoutMs) }),
      {
        timeoutMs: boundedTimeoutMs,
        intervalMs: 250,
      },
    );
  }

  async requestJson(url, options = {}) {
    return await this.request(url, options, async (response) => {
      try {
        return await response.json();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${options.label || "DevTools 请求"}返回了无效 JSON: ${message}`);
      }
    });
  }

  async requestText(url, options = {}) {
    return await this.request(url, options, (response) => response.text());
  }

  async request(url, options = {}, consume = (response) => response) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("当前 Node 环境不支持 fetch，请使用 Node 22+。");
    }

    const label = options.label || "DevTools 请求";
    const timeoutMs = readPositiveTimeout(options.timeoutMs, this.requestTimeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const timeoutError = new Error(`${label}超时`);
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });

    try {
      const operation = (async () => {
        const response = await this.fetchImpl(url, {
          method: options.method || "GET",
          signal: controller.signal,
        });
        if (!response?.ok) {
          const status = response?.status ?? "unknown";
          const statusText = response?.statusText ? ` ${response.statusText}` : "";
          throw new Error(`${label}返回 HTTP ${status}${statusText}`);
        }
        return await consume(response);
      })();
      return await Promise.race([operation, timeoutPromise]);
    } catch (error) {
      if (timedOut || error === timeoutError || controller.signal.aborted && error?.name === "AbortError") {
        throw new Error(`${label}超时（${timeoutMs}ms，${url}）`);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(label)) {
        throw error;
      }
      throw new Error(`${label}失败（${url}）: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function readPositiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
