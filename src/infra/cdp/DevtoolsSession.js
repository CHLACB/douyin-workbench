const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export class DevtoolsSession {
  constructor(webSocketUrl, options = {}) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.connectTimeoutMs = readPositiveTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.commandTimeoutMs = readPositiveTimeout(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.connectPromise = null;
  }

  async connect(options = {}) {
    if (typeof this.WebSocketImpl !== "function") {
      throw new Error("当前 Node 环境不支持 WebSocket，请使用 Node 22+。");
    }

    if (this.socket?.readyState === this.openState()) {
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }

    const timeoutMs = readPositiveTimeout(options.timeoutMs, this.connectTimeoutMs);
    const socket = new this.WebSocketImpl(this.webSocketUrl);
    this.socket = socket;

    const handleMessage = (event) => {
      if (socket === this.socket) {
        this.handleMessage(event.data);
      }
    };
    const handleError = () => {
      if (socket === this.socket) {
        this.rejectAll(new Error(`DevTools WebSocket 连接错误（${this.webSocketUrl}）`));
      }
    };
    const handleClose = () => {
      if (socket === this.socket) {
        this.rejectAll(new Error(`DevTools WebSocket 已关闭（${this.webSocketUrl}）`));
        this.socket = null;
      }
    };

    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);

    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeEventListener?.("open", handleOpen);
        socket.removeEventListener?.("error", handleConnectError);
        socket.removeEventListener?.("close", handleConnectClose);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const handleOpen = () => finish(resolve);
      const handleConnectError = () => finish(
        reject,
        new Error(`DevTools WebSocket 连接失败（${this.webSocketUrl}）`),
      );
      const handleConnectClose = () => finish(
        reject,
        new Error(`DevTools WebSocket 在连接完成前关闭（${this.webSocketUrl}）`),
      );
      const timeout = setTimeout(() => {
        finish(
          reject,
          new Error(`DevTools WebSocket 连接超时（${timeoutMs}ms，${this.webSocketUrl}）`),
        );
        if (socket === this.socket) {
          this.socket = null;
        }
        try {
          socket.close();
        } catch {
          // The timed-out socket is already unusable.
        }
      }, timeoutMs);

      socket.addEventListener("open", handleOpen, { once: true });
      socket.addEventListener("error", handleConnectError, { once: true });
      socket.addEventListener("close", handleConnectClose, { once: true });
    });

    try {
      await this.connectPromise;
    } catch (error) {
      if (socket === this.socket) {
        this.socket = null;
        try {
          socket.close();
        } catch {
          // A failed connection cannot be reused.
        }
      }
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  async send(method, params = {}, options = {}) {
    if (!this.socket || this.socket.readyState !== this.openState()) {
      throw new Error(`DevTools WebSocket 未连接，无法执行 ${method}`);
    }

    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    const timeoutMs = readPositiveTimeout(options.timeoutMs, this.commandTimeoutMs);

    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`DevTools 命令超时: ${method}（${timeoutMs}ms，id=${id}）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
    });

    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        const messageText = error instanceof Error ? error.message : String(error);
        pending.reject(new Error(`发送 DevTools 命令失败: ${method}: ${messageText}`));
      }
    }
    return await result;
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) {
      this.eventHandlers.set(method, new Set());
    }
    const handlers = this.eventHandlers.get(method);
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.rejectAll(new Error(`DevTools WebSocket 会话已主动关闭（${this.webSocketUrl}）`));
    try {
      socket?.close();
    } catch {
      // Closing is best effort after all callers have already been rejected.
    }
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.rejectAll(new Error(`DevTools WebSocket 返回了无效 JSON: ${detail}`));
      return;
    }

    if (!message.id) {
      const handlers = this.eventHandlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.params || {});
          } catch {
            // Event handlers are best-effort observers.
          }
        }
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      const detail = message.error.message || "DevTools 命令失败";
      pending.reject(new Error(`${pending.method}: ${detail}`));
      return;
    }
    pending.resolve(message.result);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  openState() {
    return Number.isFinite(this.WebSocketImpl?.OPEN) ? this.WebSocketImpl.OPEN : 1;
  }
}

function readPositiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
