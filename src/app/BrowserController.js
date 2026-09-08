import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { DEFAULTS } from "../config/defaults.js";
import { RUNTIME_DIR } from "../shared/paths.js";
import { Logger } from "../core/logger.js";
import { sleep } from "../core/time.js";
import { ChromePathResolver } from "../infra/chrome/ChromePathResolver.js";
import { ChromeLauncher } from "../infra/chrome/ChromeLauncher.js";
import { DevtoolsClient } from "../infra/cdp/DevtoolsClient.js";
import { DevtoolsSession } from "../infra/cdp/DevtoolsSession.js";
import { clickAt } from "../infra/cdp/InputActions.js";
import { deriveSendConfirmation } from "./douyin/reliability.js";
import { publicTarget, selectDouyinTarget } from "./douyin/targetSelection.js";

export class BrowserController {
  constructor(options = {}) {
    this.logger = new Logger();
    this.pathResolver = new ChromePathResolver();
    this.launcher = new ChromeLauncher();
    this.closeRuntime = options.closeRuntime || createCloseRuntime();
  }

  async open(options = {}) {
    const config = {
      url: options.url || DEFAULTS.douyinUrl,
      chromePath: this.pathResolver.resolve(options.chromePath),
      remoteDebuggingHost: options.host || DEFAULTS.remoteDebuggingHost,
      remoteDebuggingPort: Number(options.port || DEFAULTS.remoteDebuggingPort),
      userDataDir: options.userDataDir || DEFAULTS.userDataDir,
    };

    this.logger.info(`Chrome: ${config.chromePath}`);
    this.logger.info(`打开地址: ${config.url}`);
    this.logger.info(`调试端口: ${config.remoteDebuggingHost}:${config.remoteDebuggingPort}`);

    const previousStatus = await this.status({
      host: config.remoteDebuggingHost,
      port: config.remoteDebuggingPort,
    });
    const existing = await this.tryReadExistingDevtools(config);
    if (existing) {
      this.logger.warn("调试端口已经可用，将复用当前 Chrome 调试会话。");
      const client = new DevtoolsClient(config.remoteDebuggingHost, config.remoteDebuggingPort);
      const target = await client.openUrl(config.url);
      if (target?.id) {
        await client.activateTarget(target.id).catch(() => undefined);
      }
      this.writeSession({
        ...config,
        pid: null,
        devtools: existing,
        target: publicTarget(target),
        reused: true,
        openedAt: new Date().toISOString(),
        recoveredFromStaleSession: previousStatus.hasSession && previousStatus.health?.stale === true,
      });
      return {
        reused: true,
        sessionFile: DEFAULTS.sessionFile,
        devtools: existing,
        target: publicTarget(target),
        recoveredFromStaleSession: previousStatus.hasSession && previousStatus.health?.stale === true,
        ...config,
      };
    }

    const processInfo = this.launcher.open(config);
    const client = new DevtoolsClient(config.remoteDebuggingHost, config.remoteDebuggingPort);
    const devtools = await client.waitUntilReady();
    const target = await waitForBestTarget(client, {
      preferredTargetId: null,
      timeoutMs: 5_000,
    }).catch(() => null);

    const session = {
      ...config,
      pid: processInfo.pid,
      devtools,
      target: publicTarget(target),
      reused: false,
      openedAt: new Date().toISOString(),
    };
    this.writeSession(session);

    return {
      ...session,
      sessionFile: DEFAULTS.sessionFile,
    };
  }

  async openUserWindowAndWait(options = {}) {
    const session = this.readSession();
    if (!session) {
      throw new Error("没有找到 session.json，请先执行 browser open。");
    }

    const url = String(options.url || "").trim();
    if (!url) {
      throw new Error("缺少 --url 参数。");
    }

    const host = options.host || session.remoteDebuggingHost || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || session.remoteDebuggingPort || DEFAULTS.remoteDebuggingPort);
    const pollMs = readPositiveNumber(options.pollMs, 1_000);
    const timeoutMs = readDurationMs(options.timeoutMs, options.timeoutSec, 0);
    const openedAt = Date.now();
    const client = new DevtoolsClient(host, port);
    const devtools = await client.readVersion();
    if (!devtools.webSocketDebuggerUrl) {
      throw new Error("当前 Chrome DevTools 未提供浏览器级 WebSocket，无法创建新窗口。");
    }

    const browserSession = new DevtoolsSession(devtools.webSocketDebuggerUrl);
    await browserSession.connect();
    let targetId = "";
    try {
      const created = await browserSession.send("Target.createTarget", {
        url,
        newWindow: true,
      });
      targetId = created.targetId;
      if (!targetId) {
        throw new Error("Chrome 未返回新窗口 targetId。");
      }

      await client.activateTarget(targetId).catch(() => undefined);

      for (;;) {
        const targets = await client.listTargets();
        const stillOpen = targets.some((target) => target.id === targetId);
        if (!stillOpen) {
          break;
        }

        if (timeoutMs > 0 && Date.now() - openedAt > timeoutMs) {
          throw new Error(`等待用户窗口关闭超时: ${Math.round(timeoutMs / 1000)} 秒`);
        }

        await sleep(pollMs);
      }

      return {
        ok: true,
        url,
        targetId,
        closed: true,
        waitedMs: Date.now() - openedAt,
      };
    } finally {
      browserSession.close();
    }
  }

  async sendPrivateMessage(options = {}) {
    const session = this.readSession();
    if (!session) {
      throw new Error("没有找到 session.json，请先执行 browser open。");
    }

    const url = String(options.url || "").trim();
    if (!url) {
      throw new Error("缺少 --url 参数。");
    }

    const text = String(options.text || "").trim();
    if (!text) {
      throw new Error("私信内容为空。");
    }

    const host = options.host || session.remoteDebuggingHost || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || session.remoteDebuggingPort || DEFAULTS.remoteDebuggingPort);
    const actionTimeoutMs = readDurationMs(options.timeoutMs, options.timeoutSec, 45_000) || 45_000;
    const afterPrivateClickMs = readPositiveNumber(options.afterPrivateClickMs, 900);
    const afterSendWaitMs = readDurationMs(options.afterSendWaitMs, options.afterSendWaitSec, 1_500);
    const openedAt = Date.now();
    const client = new DevtoolsClient(host, port);
    const devtools = await client.readVersion();
    if (!devtools.webSocketDebuggerUrl) {
      throw new Error("当前 Chrome DevTools 未提供浏览器级 WebSocket，无法创建新窗口。");
    }

    const browserSession = new DevtoolsSession(devtools.webSocketDebuggerUrl);
    await browserSession.connect();
    let pageSession = null;
    let targetId = "";
    let target = null;
    let output = null;
    try {
      const created = await browserSession.send("Target.createTarget", {
        url,
        newWindow: true,
      });
      targetId = created.targetId;
      if (!targetId) {
        throw new Error("Chrome 未返回新窗口 targetId。");
      }

      await client.activateTarget(targetId).catch(() => undefined);
      target = await waitForTargetWebSocket(client, targetId, 10_000);
      pageSession = new DevtoolsSession(target.webSocketDebuggerUrl);
      await pageSession.connect();
      await pageSession.send("Page.enable").catch(() => undefined);
      await pageSession.send("Runtime.enable");
      await pageSession.send("Page.bringToFront").catch(() => undefined);
      await waitForPageReady(pageSession, Math.min(actionTimeoutMs, 15_000));

      const beforeUrl = await readPageHref(pageSession);
      const privateButton = await waitForPrivateMessageButton(pageSession, actionTimeoutMs);
      if (!privateButton?.ok) {
        throw new Error(privateButton?.reason || "未找到用户主页上的私信按钮。");
      }

      await clickAt(pageSession, privateButton.click.x, privateButton.click.y);
      await sleep(afterPrivateClickMs);

      let composer = await waitForPrivateMessageComposer(pageSession, actionTimeoutMs);
      if (!composer?.ok) {
        throw new Error(composer?.reason || "未找到私信输入框。");
      }

      let filled = await fillPrivateMessageComposer(pageSession, text);
      if (!filled?.ok || !filled.valueMatches) {
        await clearFocusedEditable(pageSession);
        await pageSession.send("Input.insertText", { text });
        await sleep(250);
        filled = await readPrivateMessageComposerValue(pageSession, text);
      }
      if (!filled?.ok || !filled.valueMatches) {
        throw new Error(filled?.reason || "私信输入失败。");
      }

      composer = filled.composer || composer;
      const sendButton = await waitForPrivateMessageSendButton(pageSession, actionTimeoutMs);
      if (!sendButton?.ok) {
        throw new Error(sendButton?.reason || "未找到私信发送按钮。");
      }

      const outcomeBefore = await readPrivateMessageOutcome(pageSession, text);
      await clickAt(pageSession, sendButton.click.x, sendButton.click.y);
      const observed = await waitForPrivateMessageOutcome(
        pageSession,
        text,
        outcomeBefore,
        afterSendWaitMs,
      );
      const { outcome, confirmation } = observed;
      output = {
        ok: confirmation.confirmed,
        sent: confirmation.sent,
        confirmed: confirmation.confirmed,
        blocked: Boolean(outcome?.blocked),
        refused: Boolean(outcome?.refused),
        url,
        beforeUrl,
        afterUrl: await readPageHref(pageSession).catch(() => ""),
        target: {
          id: target.id,
          type: target.type,
          title: target.title,
          url: target.url,
        },
        targetId,
        textLength: text.length,
        privateButton,
        composer,
        sendButton,
        outcomeBefore,
        outcome,
        confirmation,
        reason: confirmation.reason,
        finishSignal: {
          type: "private-message",
          status: outcome?.blocked ? "blocked" : confirmation.confirmed ? "sent" : "unconfirmed",
          text: outcome?.blocked
            ? "结束标志：私信发送受限或被对方拒收"
            : confirmation.confirmed
              ? "结束标志：私信发送已确认"
              : "结束标志：已点击发送，但页面未提供足够的成功证据",
          at: new Date().toISOString(),
        },
        elapsedMs: Date.now() - openedAt,
        closed: false,
      };
      return output;
    } finally {
      pageSession?.close();
      if (targetId) {
        const closeResult = await browserSession.send("Target.closeTarget", { targetId }).catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
        if (output) {
          output.closed = closeResult?.success === true;
          output.closeResult = closeResult;
        }
      }
      browserSession.close();
    }
  }

  async status(options = {}) {
    let session;
    try {
      session = this.readSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        hasSession: true,
        connected: false,
        healthy: false,
        error: message,
        health: {
          ok: false,
          stale: true,
          reasons: ["invalid-session"],
          pid: { configured: false, alive: null, pid: null },
          endpoint: { reachable: false },
          target: { found: false },
          cdp: { connected: false },
        },
      };
    }
    if (!session) {
      return {
        hasSession: false,
        connected: false,
        healthy: false,
        health: {
          ok: false,
          stale: false,
          reasons: ["missing-session"],
          pid: { configured: false, alive: false },
          endpoint: { reachable: false },
          target: { found: false },
          cdp: { connected: false },
        },
        message: "没有找到 session.json，请先执行 browser open。",
      };
    }

    const host = options.host || session.remoteDebuggingHost || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || session.remoteDebuggingPort || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port, { requestTimeoutMs: 2_000 });
    const pidHealth = inspectPid(session.pid);
    const expectedEndpoint = `${session.remoteDebuggingHost || ""}:${session.remoteDebuggingPort || ""}`;
    const actualEndpoint = `${host}:${port}`;
    const endpointMatches = expectedEndpoint === actualEndpoint;

    let devtools = null;
    try {
      devtools = await client.readVersion();
      const targets = await client.listTargets();
      if (!Array.isArray(targets)) {
        throw new Error("DevTools target 列表格式无效");
      }
      const storedTargetId = session.target?.id || session.targetId || "";
      const configuredTarget = storedTargetId ? targets.find((target) => target.id === storedTargetId) : null;
      const exactTarget = configuredTarget
        ? selectDouyinTarget([configuredTarget], { preferredTargetId: storedTargetId })
        : null;
      const target = exactTarget || selectDouyinTarget(targets, { preferredTargetId: storedTargetId });
      const cdp = await probeTargetCdp(target);
      const reasons = [];
      if (session.pid && !pidHealth.alive) reasons.push("pid-not-alive");
      if (!endpointMatches) reasons.push("endpoint-mismatch");
      if (storedTargetId && !configuredTarget) reasons.push("target-missing");
      if (configuredTarget && !exactTarget) reasons.push("target-unsafe");
      if (!target) reasons.push("no-safe-douyin-target");
      if (!cdp.connected) reasons.push("target-cdp-unavailable");
      const stale = reasons.length > 0;
      return {
        hasSession: true,
        connected: cdp.connected,
        healthy: !stale,
        session,
        devtools,
        health: {
          ok: !stale,
          stale,
          reasons,
          pid: pidHealth,
          endpoint: {
            host,
            port,
            reachable: true,
            matchesSession: endpointMatches,
          },
          target: {
            configuredId: storedTargetId,
            found: Boolean(configuredTarget),
            safe: Boolean(exactTarget),
            selected: publicTarget(target),
          },
          cdp,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reasons = [];
      if (session.pid && !pidHealth.alive) reasons.push("pid-not-alive");
      if (!endpointMatches) reasons.push("endpoint-mismatch");
      reasons.push(devtools ? "target-list-unavailable" : "devtools-unreachable");
      return {
        hasSession: true,
        connected: false,
        healthy: false,
        session,
        devtools,
        error: message,
        health: {
          ok: false,
          stale: true,
          reasons,
          pid: pidHealth,
          endpoint: { host, port, reachable: Boolean(devtools), matchesSession: endpointMatches, error: message },
          target: { configuredId: session.target?.id || session.targetId || "", found: false },
          cdp: { connected: false, error: message },
        },
      };
    }
  }

  async close(options = {}) {
    const session = this.readSession();
    if (!session) {
      return {
        ok: true,
        closed: false,
        message: "没有 session.json，不需要关闭。",
      };
    }

    if (session.reused && !options.force) {
      return {
        ok: false,
        closed: false,
        method: null,
        removedSessionFile: false,
        reason: "reused-session-requires-force",
        message: "当前 session 标记为复用已有调试会话。为避免误关你的日常 Chrome，请使用 --force 明确关闭。",
      };
    }

    const sessionHost = session.remoteDebuggingHost || DEFAULTS.remoteDebuggingHost;
    const sessionPort = Number(session.remoteDebuggingPort || DEFAULTS.remoteDebuggingPort);
    const host = options.host || sessionHost;
    const port = Number(options.port || sessionPort);
    if (host !== sessionHost || port !== sessionPort) {
      return closeRefused("endpoint-mismatch", "请求关闭的调试端点与 session 记录不一致；已拒绝关闭并保留 session。", {
        requestedEndpoint: `${host}:${port}`,
        sessionEndpoint: `${sessionHost}:${sessionPort}`,
      });
    }

    const runtime = this.closeRuntime;
    const client = runtime.createClient(host, port);
    let endpointProof = null;
    let endpointError = null;
    try {
      const liveDevtools = await client.readVersion();
      endpointProof = proveBrowserEndpointOwnership(session, liveDevtools);
      if (!endpointProof.ok) {
        return closeRefused(endpointProof.reason, endpointProof.message, { endpointProof });
      }

      const devtoolsSession = runtime.createSession(liveDevtools.webSocketDebuggerUrl);
      try {
        await devtoolsSession.connect();
        await devtoolsSession.send("Browser.close");
      } finally {
        devtoolsSession.close();
      }

      if (await waitForEndpointDown(client, runtime)) {
        runtime.removeSessionFile();
        return {
          ok: true,
          closed: true,
          method: "devtools",
          removedSessionFile: true,
          ownership: { endpoint: endpointProof },
        };
      }
      endpointError = "Browser.close 已发送，但调试端点在等待期内仍可访问。";
    } catch (closeError) {
      endpointError = closeError instanceof Error ? closeError.message : String(closeError);
    }

    const pidProof = await runtime.inspectProcessOwnership(session);
    if (!pidProof.ok) {
      return closeRefused(pidProof.reason || "pid-ownership-unproven", "无法证明 session PID 属于本工具的专用 Chrome；已拒绝终止进程并保留 session。", {
        endpointProof,
        endpointError,
        pidProof,
      });
    }

    try {
      runtime.killProcess(Number(session.pid));
    } catch (killError) {
      return closeRefused("pid-kill-failed", "已证明进程归属，但终止进程失败；session 已保留。", {
        endpointProof,
        endpointError,
        pidProof,
        error: killError instanceof Error ? killError.message : String(killError),
      });
    }

    if (!(await waitForEndpointDown(client, runtime))) {
      return closeRefused("endpoint-still-reachable", "终止专用 Chrome 后调试端点仍可访问，不能确认关闭成功；session 已保留。", {
        endpointProof,
        endpointError,
        pidProof,
      });
    }

    runtime.removeSessionFile();
    return {
      ok: true,
      closed: true,
      method: "pid",
      removedSessionFile: true,
      ownership: { endpoint: endpointProof, pid: pidProof },
    };
  }

  async monitor(session, options = {}) {
    const intervalMs = options.intervalMs || 2_000;
    const client = new DevtoolsClient(
      session.remoteDebuggingHost,
      session.remoteDebuggingPort,
    );

    this.logger.info("控制器保持运行中，按 Ctrl+C 停止。");
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      try {
        await client.readVersion();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Chrome DevTools 连接断开: ${message}`);
      }
    }
  }

  async doctor(options = {}) {
    const checks = {};
    checks.node = {
      ok: Number(process.versions.node.split(".")[0]) >= 22 && typeof fetch === "function" && typeof WebSocket !== "undefined",
      version: process.versions.node,
      fetch: typeof fetch === "function",
      webSocket: typeof WebSocket !== "undefined",
    };
    try {
      const chromePath = this.pathResolver.resolve(options.chromePath);
      checks.chrome = probeChromeExecutable(chromePath);
    } catch (error) {
      checks.chrome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const status = await this.status({ host: options.host, port: options.port });
    checks.session = {
      ok: status.hasSession,
      present: status.hasSession,
      stale: status.health?.stale ?? false,
    };
    checks.devtools = status.health?.endpoint || { reachable: false };
    checks.target = status.health?.target || { found: false };
    checks.cdp = status.health?.cdp || { connected: false };
    return {
      ok: checks.node.ok && checks.chrome.ok && checks.session.ok && checks.devtools.reachable && checks.cdp.connected,
      chromePath: checks.chrome.path || null,
      defaults: DEFAULTS,
      checks,
      status,
    };
  }

  async tryReadExistingDevtools(config) {
    const client = new DevtoolsClient(config.remoteDebuggingHost, config.remoteDebuggingPort);
    try {
      return await client.readVersion();
    } catch {
      return null;
    }
  }

  writeSession(session) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(DEFAULTS.sessionFile, JSON.stringify(session, null, 2), "utf8");
  }

  readSession() {
    if (!fs.existsSync(DEFAULTS.sessionFile)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(DEFAULTS.sessionFile, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`session.json 无法读取或格式无效: ${message}`);
    }
  }
}

function inspectPid(pid) {
  if (!pid) {
    return { configured: false, alive: null, pid: null };
  }
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { configured: true, alive: false, pid, error: "invalid-pid" };
  }
  try {
    process.kill(numericPid, 0);
    return { configured: true, alive: true, pid: numericPid };
  } catch (error) {
    if (error?.code === "EPERM") {
      return { configured: true, alive: true, pid: numericPid, warning: "permission-denied" };
    }
    return {
      configured: true,
      alive: false,
      pid: numericPid,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function probeChromeExecutable(chromePath) {
  if (!chromePath || !fs.existsSync(chromePath)) {
    return { ok: false, path: chromePath || null, error: "chrome-executable-missing" };
  }
  try {
    const stat = fs.statSync(chromePath);
    if (!stat.isFile()) {
      return { ok: false, path: chromePath, error: "chrome-path-is-not-a-file" };
    }
    if (process.platform === "win32") {
      const handle = fs.openSync(chromePath, "r");
      const header = Buffer.alloc(2);
      try {
        fs.readSync(handle, header, 0, header.length, 0);
      } finally {
        fs.closeSync(handle);
      }
      const executableFormat = header.toString("ascii") === "MZ" ? "PE" : "unknown";
      return {
        ok: executableFormat === "PE",
        path: chromePath,
        executableFormat,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        error: executableFormat === "PE" ? null : "chrome-executable-has-invalid-header",
      };
    }

    const probe = spawnSync(chromePath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
    });
    const version = String(probe.stdout || probe.stderr || "").trim();
    if (probe.error) {
      return { ok: false, path: chromePath, version, error: probe.error.message };
    }
    return {
      ok: probe.status === 0,
      path: chromePath,
      version,
      exitCode: probe.status,
      error: probe.status === 0 ? null : `Chrome --version 退出码 ${probe.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      path: chromePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeTargetCdp(target) {
  if (!target?.webSocketDebuggerUrl) {
    return { connected: false, error: "target-websocket-missing" };
  }
  const session = new DevtoolsSession(target.webSocketDebuggerUrl, {
    connectTimeoutMs: 2_000,
    commandTimeoutMs: 2_000,
  });
  try {
    await session.connect();
    const result = await session.send("Runtime.evaluate", {
      expression: "({ href: location.href, readyState: document.readyState })",
      returnByValue: true,
    });
    return {
      connected: true,
      value: result.result?.value || null,
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    session.close();
  }
}

function createCloseRuntime() {
  return {
    createClient: (host, port) => new DevtoolsClient(host, port),
    createSession: (webSocketUrl) => new DevtoolsSession(webSocketUrl),
    inspectProcessOwnership,
    killProcess: (pid) => process.kill(pid),
    removeSessionFile: () => {
      if (fs.existsSync(DEFAULTS.sessionFile)) fs.unlinkSync(DEFAULTS.sessionFile);
    },
    sleep,
    endpointPollAttempts: 12,
    endpointPollIntervalMs: 250,
  };
}

function proveBrowserEndpointOwnership(session, liveDevtools) {
  const expectedUrl = session.devtools?.webSocketDebuggerUrl;
  const actualUrl = liveDevtools?.webSocketDebuggerUrl;
  const expectedBrowserId = browserIdFromWebSocketUrl(expectedUrl);
  const actualBrowserId = browserIdFromWebSocketUrl(actualUrl);
  if (!expectedBrowserId || !actualBrowserId) {
    return {
      ok: false,
      reason: "browser-identity-missing",
      message: "session 或当前端点缺少可验证的浏览器 WebSocket 身份；已拒绝关闭并保留 session。",
      expectedBrowserId: expectedBrowserId || null,
      actualBrowserId: actualBrowserId || null,
    };
  }
  if (expectedBrowserId !== actualBrowserId) {
    return {
      ok: false,
      reason: "browser-identity-mismatch",
      message: "当前调试端点属于另一个浏览器实例；已拒绝关闭并保留 session。",
      expectedBrowserId,
      actualBrowserId,
    };
  }
  return { ok: true, browserId: actualBrowserId };
}

function browserIdFromWebSocketUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const browserIndex = parts.lastIndexOf("browser");
    return browserIndex >= 0 && parts[browserIndex + 1] ? parts[browserIndex + 1] : null;
  } catch {
    return null;
  }
}

async function waitForEndpointDown(client, runtime) {
  const attempts = Math.max(1, Number(runtime.endpointPollAttempts) || 1);
  const intervalMs = Math.max(0, Number(runtime.endpointPollIntervalMs) || 0);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && intervalMs > 0) await runtime.sleep(intervalMs);
    try {
      await client.readVersion();
    } catch {
      return true;
    }
  }
  return false;
}

function closeRefused(reason, message, details = {}) {
  return {
    ok: false,
    closed: false,
    method: null,
    removedSessionFile: false,
    reason,
    message,
    ...details,
  };
}

async function inspectProcessOwnership(session) {
  const pid = Number(session.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "pid-missing-or-invalid" };
  }
  if (!session.chromePath || !session.userDataDir || !session.remoteDebuggingPort) {
    return { ok: false, reason: "session-process-identity-incomplete" };
  }

  let processInfo;
  if (process.platform === "win32") {
    processInfo = readWindowsProcessInfo(pid);
  } else if (process.platform === "linux") {
    processInfo = readLinuxProcessInfo(pid);
  } else {
    return { ok: false, reason: "process-ownership-proof-unsupported-platform", platform: process.platform };
  }
  if (!processInfo.ok) return processInfo;

  const expectedExecutable = normalizeComparablePath(session.chromePath);
  const actualExecutable = normalizeComparablePath(processInfo.executablePath);
  const expectedProfile = normalizeComparablePath(session.userDataDir);
  const actualProfile = extractChromeArgument(processInfo.commandLine, "user-data-dir");
  const actualPort = extractChromeArgument(processInfo.commandLine, "remote-debugging-port");
  const checks = {
    executable: Boolean(expectedExecutable && actualExecutable && expectedExecutable === actualExecutable),
    port: String(actualPort || "") === String(Number(session.remoteDebuggingPort)),
    userDataDir: Boolean(expectedProfile && normalizeComparablePath(actualProfile) === expectedProfile),
  };
  return {
    ok: checks.executable && checks.port && checks.userDataDir,
    reason: checks.executable && checks.port && checks.userDataDir ? null : "pid-identity-mismatch",
    pid,
    checks,
  };
}

function readWindowsProcessInfo(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop`,
    "if ($null -eq $p) { exit 3 }",
    "$p | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      reason: "windows-process-query-failed",
      error: result.error?.message || String(result.stderr || "").trim() || `exit-${result.status}`,
    };
  }
  try {
    const value = JSON.parse(result.stdout);
    return { ok: true, executablePath: value.ExecutablePath, commandLine: value.CommandLine };
  } catch (error) {
    return { ok: false, reason: "windows-process-query-invalid-json", error: error.message };
  }
}

function readLinuxProcessInfo(pid) {
  try {
    return {
      ok: true,
      executablePath: fs.readlinkSync(`/proc/${pid}/exe`),
      commandLine: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "),
    };
  } catch (error) {
    return { ok: false, reason: "linux-process-query-failed", error: error.message };
  }
}

function extractChromeArgument(commandLine, name) {
  if (typeof commandLine !== "string") return null;
  const pattern = new RegExp(`(?:^|\\s)["']?--${name}=(?:"([^"]*)"|'([^']*)'|([^"'\\s]+))`, "i");
  const match = commandLine.match(pattern);
  return match ? match[1] ?? match[2] ?? match[3] ?? null : null;
}

function normalizeComparablePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const normalized = fs.realpathSync.native(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  } catch {
    const normalized = value.trim().replace(/^['"]|['"]$/g, "").replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }
}

async function waitForBestTarget(client, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
  for (;;) {
    const targets = await client.listTargets();
    const target = selectDouyinTarget(targets, { preferredTargetId: options.preferredTargetId });
    if (target) return target;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("等待可控制的抖音 target 超时。");
    }
    await sleep(200);
  }
}

async function waitForTargetWebSocket(client, targetId, timeoutMs) {
  const startedAt = Date.now();
  let lastTarget = null;
  for (;;) {
    const targets = await client.listTargets();
    lastTarget = targets.find((target) => target.id === targetId) || null;
    if (lastTarget?.webSocketDebuggerUrl) {
      return lastTarget;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("等待新用户窗口 DevTools target 超时。");
    }

    await sleep(200);
  }
}

async function waitForPageReady(session, timeoutMs) {
  const ready = await waitForPageValue(
    session,
    "(() => ({ ok: true, ready: document.readyState !== 'loading', readyState: document.readyState, url: location.href }))()",
    timeoutMs,
    250,
    (value) => Boolean(value?.ready),
  );
  if (!ready?.ready) {
    throw new Error("等待用户主页加载超时。");
  }
  return ready;
}

async function readPageHref(session) {
  const value = await evaluatePage(session, "location.href");
  return typeof value === "string" ? value : "";
}

async function waitForPrivateMessageButton(session, timeoutMs) {
  return await waitForPageValue(
    session,
    buildPrivateMessageButtonExpression,
    timeoutMs,
    350,
    (value) => Boolean(value?.ok),
  );
}

async function waitForPrivateMessageComposer(session, timeoutMs) {
  return await waitForPageValue(
    session,
    buildPrivateMessageComposerExpression,
    timeoutMs,
    350,
    (value) => Boolean(value?.ok),
  );
}

async function waitForPrivateMessageSendButton(session, timeoutMs) {
  return await waitForPageValue(
    session,
    buildPrivateMessageSendButtonExpression,
    timeoutMs,
    250,
    (value) => Boolean(value?.ok),
  );
}

async function fillPrivateMessageComposer(session, text) {
  return await evaluatePage(session, buildFillPrivateMessageComposerExpression(text), {
    awaitPromise: true,
  });
}

async function readPrivateMessageComposerValue(session, expectedText) {
  return await evaluatePage(session, buildReadPrivateMessageComposerValueExpression(expectedText), {
    awaitPromise: true,
  });
}

async function readPrivateMessageOutcome(session, expectedText = "") {
  return await evaluatePage(session, buildPrivateMessageOutcomeExpression(expectedText), {
    awaitPromise: true,
  }).catch((error) => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
}

async function waitForPrivateMessageOutcome(session, text, baseline, timeoutMs) {
  const startedAt = Date.now();
  const boundedTimeoutMs = Math.max(0, Number(timeoutMs || 0));
  let outcome = await readPrivateMessageOutcome(session, text);
  let confirmation = derivePrivateMessageConfirmation(text, baseline, outcome);
  while (!confirmation.confirmed && !confirmation.blocked && Date.now() - startedAt < boundedTimeoutMs) {
    await sleep(Math.min(180, Math.max(0, boundedTimeoutMs - (Date.now() - startedAt))));
    outcome = await readPrivateMessageOutcome(session, text);
    confirmation = derivePrivateMessageConfirmation(text, baseline, outcome);
  }
  return {
    outcome: {
      ...outcome,
      waitedMs: Date.now() - startedAt,
    },
    confirmation,
  };
}

function derivePrivateMessageConfirmation(text, baseline, outcome) {
  return deriveSendConfirmation({
    inputWasPresent: true,
    inputBefore: text,
    inputAfter: outcome?.composerValue || "",
    matchCountBefore: baseline?.matchingCount || 0,
    matchCountAfter: outcome?.matchingCount || 0,
    blocked: outcome?.blocked,
    refused: outcome?.refused,
  });
}

async function clearFocusedEditable(session) {
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 2,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
}

async function waitForPageValue(session, expressionOrFactory, timeoutMs, intervalMs, isReady) {
  const startedAt = Date.now();
  let lastValue = null;
  for (;;) {
    const expression = typeof expressionOrFactory === "function"
      ? expressionOrFactory()
      : expressionOrFactory;
    try {
      lastValue = await evaluatePage(session, expression, { awaitPromise: true });
    } catch (error) {
      lastValue = {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (isReady(lastValue)) {
      return lastValue;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      return {
        ...(lastValue && typeof lastValue === "object" ? lastValue : {}),
        ok: false,
        reason: lastValue?.reason || "等待页面元素超时。",
        timedOut: true,
      };
    }

    await sleep(intervalMs);
  }
}

async function evaluatePage(session, expression, options = {}) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: Boolean(options.awaitPromise),
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "页面脚本执行失败。");
  }

  return result.result?.value;
}

function buildPrivateMessageButtonExpression() {
  return `(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const toRect = (rect) => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    const visibleRect = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width < 28 || rect.height < 22) return null;
      if (rect.bottom < 80 || rect.top > viewport.height - 20) return null;
      if (rect.right < 0 || rect.left > viewport.width) return null;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.1) return null;
      return toRect(rect);
    };
    const textOf = (element) => (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
      .map((element, index) => {
        const rect = visibleRect(element);
        if (!rect) return null;
        const text = textOf(element);
        const aria = element.getAttribute('aria-label') || '';
        const title = element.getAttribute('title') || '';
        const role = element.getAttribute('role') || '';
        const className = String(element.className || '');
        const combined = [text, aria, title, role, className].join(' ');
        let score = 0;
        if (/^私信$/.test(text)) score += 70;
        if (/私信|发私信|message|chat/i.test(combined)) score += 35;
        if (rect.right > viewport.width * 0.70 && rect.top < viewport.height * 0.48) score += 10;
        if (/button/i.test(element.tagName) || role === 'button') score += 6;
        if (/关注|分享主页|更多|作品|推荐|喜欢|粉丝|获赞|搜索/.test(text) && !/私信/.test(text)) score -= 50;
        if (element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled')) score -= 80;
        if (score <= 0) return null;
        return {
          ok: true,
          source: 'private-button:' + index,
          score,
          text: text.slice(0, 80),
          rect,
          click: {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.rect.y - b.rect.y);
    const target = candidates[0];
    if (!target) {
      return {
        ok: false,
        reason: '未找到用户主页上的私信按钮',
        pageText: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 240),
      };
    }
    return target;
  })()`;
}

function buildPrivateMessageComposerExpression() {
  return `(() => {
    ${buildPrivateMessageComposerFinderSource()}
    const composer = findPrivateMessageComposer();
    if (!composer) {
      return {
        ok: false,
        reason: '未找到私信输入框',
        pageText: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 240),
      };
    }
    composer.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    composer.element.focus();
    composer.element.click();
    return publicComposer(composer);
  })()`;
}

function buildFillPrivateMessageComposerExpression(text) {
  const safeText = JSON.stringify(text);
  return `(() => {
    ${buildPrivateMessageComposerFinderSource()}
    const expected = ${safeText};
    const composer = findPrivateMessageComposer();
    if (!composer) {
      return { ok: false, reason: '未找到私信输入框' };
    }
    const element = composer.element;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    element.focus();
    element.click();
    if (element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false);
      const inserted = document.execCommand('insertText', false, expected);
      if (!inserted || !currentText(element).includes(expected)) {
        element.textContent = expected;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: expected }));
      }
    } else {
      const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(element, '');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(element, expected);
      } else {
        element.value = expected;
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: expected }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const value = currentText(element);
    return {
      ok: true,
      value,
      valueMatches: value.includes(expected),
      composer: publicComposer(composer),
    };
  })()`;
}

function buildReadPrivateMessageComposerValueExpression(expectedText) {
  const safeText = JSON.stringify(expectedText);
  return `(() => {
    ${buildPrivateMessageComposerFinderSource()}
    const expected = ${safeText};
    const composer = findPrivateMessageComposer();
    if (!composer) {
      return { ok: false, reason: '未找到私信输入框' };
    }
    const value = currentText(composer.element);
    return {
      ok: true,
      value,
      valueMatches: value.includes(expected),
      composer: publicComposer(composer),
    };
  })()`;
}

function buildPrivateMessageSendButtonExpression() {
  return `(() => {
    ${buildPrivateMessageComposerFinderSource()}
    const composer = findPrivateMessageComposer();
    const composerRect = composer?.rect || null;
    const visibleRect = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width < 18 || rect.height < 18 || rect.width > 120 || rect.height > 120) return null;
      if (rect.bottom < viewport.height * 0.58 || rect.top > viewport.height - 4) return null;
      if (rect.right < viewport.width * 0.55 || rect.left > viewport.width) return null;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.1) return null;
      return toRect(rect);
    };
    const colorScore = (value) => {
      const match = String(value || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
      if (!match) return 0;
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      return r >= 180 && g <= 120 && b <= 160 ? 35 : 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span, svg'))
      .map((element, index) => {
        const rect = visibleRect(element);
        if (!rect) return null;
        const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
        const aria = element.getAttribute('aria-label') || '';
        const title = element.getAttribute('title') || '';
        const className = String(element.className || '');
        const style = getComputedStyle(element);
        const combined = [text, aria, title, className].join(' ');
        let score = 0;
        if (/^发送$/.test(text)) score += 60;
        if (/发送|send/i.test(combined)) score += 45;
        score += Math.max(
          colorScore(style.color),
          colorScore(style.backgroundColor),
          colorScore(style.borderColor),
          colorScore(style.fill),
        );
        if (composerRect) {
          const centerY = rect.y + rect.height / 2;
          const composerCenterY = composerRect.y + composerRect.height / 2;
          if (Math.abs(centerY - composerCenterY) < 70 && rect.x > composerRect.x + composerRect.width * 0.72) score += 35;
        }
        if (rect.right > viewport.width * 0.86) score += 12;
        if (rect.bottom > viewport.height - 110) score += 10;
        if (/图片|文件|表情|emoji|关闭|搜索|更多|关注/.test(combined) && !/发送|send/i.test(combined)) score -= 35;
        if (element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled')) score -= 60;
        if (score <= 0) return null;
        return {
          ok: true,
          source: 'private-send-button:' + index,
          score,
          text: text.slice(0, 80),
          rect,
          click: {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.rect.x - a.rect.x);
    const target = candidates[0];
    if (!target) {
      return { ok: false, reason: '未找到私信发送按钮', composer: composer ? publicComposer(composer) : null };
    }
    return target;
  })()`;
}

function buildPrivateMessageOutcomeExpression(expectedText) {
  const expected = JSON.stringify(String(expectedText || ""));
  return `(() => {
    ${buildPrivateMessageComposerFinderSource()}
    const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
    const expected = normalize(${expected});
    const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    const refused = /拒收|对方拒收|被对方拒收/.test(bodyText);
    const privacy = /隐私设置|需要对方修改权限|不能发送|无法发送/.test(bodyText);
    const sentHint = /消息已发出|刚刚|已发送/.test(bodyText);
    const composer = findPrivateMessageComposer();
    const composerValue = composer
      ? (composer.element.isContentEditable
          ? (composer.element.innerText || composer.element.textContent || '')
          : String(composer.element.value || ''))
      : '';
    const matchingCount = Array.from(document.querySelectorAll('[class*="message" i], [class*="chat" i], [data-e2e*="message"]'))
      .filter((element) => expected && normalize(element.innerText || element.textContent).includes(expected))
      .length;
    return {
      ok: true,
      refused,
      blocked: refused || privacy,
      sentHint,
      composerValue,
      matchingCount,
      statusText: bodyText.match(/消息已发出[^。\\n]*|由于对方的隐私设置[^。\\n]*|需要对方修改权限后可发消息[^。\\n]*/)?.[0] || '',
      sample: bodyText.slice(0, 300),
    };
  })()`;
}

function buildPrivateMessageComposerFinderSource() {
  return `
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const toRect = (rect) => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    const visibleRect = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width < 110 || rect.height < 22) return null;
      if (rect.bottom < viewport.height * 0.55 || rect.top > viewport.height - 4) return null;
      if (rect.left < viewport.width * 0.48 || rect.right > viewport.width + 4) return null;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.1) return null;
      return toRect(rect);
    };
    const currentText = (element) => {
      if (element.isContentEditable) return (element.innerText || element.textContent || '').trim();
      return String(element.value || '').trim();
    };
    const describe = (element, source, index) => {
      const rect = visibleRect(element);
      if (!rect) return null;
      const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
      const placeholder = element.getAttribute('placeholder') || '';
      const aria = element.getAttribute('aria-label') || '';
      const role = element.getAttribute('role') || '';
      const className = String(element.className || '');
      const combined = [text, placeholder, aria, role, className].join(' ');
      let score = 0;
      if (/发送消息|发消息|私信|message|chat/i.test(combined)) score += 55;
      if (element.isContentEditable) score += 18;
      if (/TEXTAREA|INPUT/.test(element.tagName)) score += 18;
      if (role === 'textbox') score += 12;
      if (rect.bottom > viewport.height - 120) score += 12;
      if (rect.left > viewport.width * 0.58) score += 8;
      if (/搜索|评论|弹幕|留下|验证码|密码|手机号/.test(combined)) score -= 60;
      if (score <= 0) return null;
      return {
        element,
        ok: true,
        source: source + ':' + index,
        score,
        tagName: element.tagName.toLowerCase(),
        contentEditable: element.isContentEditable,
        text: text.slice(0, 80),
        placeholder,
        rect,
        click: {
          x: Math.round(rect.x + Math.min(rect.width * 0.28, rect.width - 20)),
          y: Math.round(rect.y + rect.height / 2),
        },
      };
    };
    const publicComposer = (candidate) => ({
      ok: true,
      source: candidate.source,
      score: candidate.score,
      tagName: candidate.tagName,
      contentEditable: candidate.contentEditable,
      text: candidate.text,
      placeholder: candidate.placeholder,
      rect: candidate.rect,
      click: candidate.click,
    });
    const findPrivateMessageComposer = () => {
      const selectors = [
        'textarea',
        'input[type="text"]',
        'input:not([type])',
        '[contenteditable="true"]',
        '[role="textbox"]'
      ];
      return selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((element, index) => describe(element, selector, index)))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || b.rect.y - a.rect.y)[0] || null;
    };
  `;
}

function readDurationMs(msValue, secValue, fallback) {
  const seconds = Number(secValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const milliseconds = Number(msValue);
  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    return milliseconds;
  }

  return fallback;
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
