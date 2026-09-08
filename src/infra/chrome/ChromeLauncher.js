import fs from "node:fs";
import { spawn } from "node:child_process";

export class ChromeLauncher {
  open(options) {
    fs.mkdirSync(options.userDataDir, { recursive: true });

    const args = [
      `--remote-debugging-address=${options.remoteDebuggingHost}`,
      `--remote-debugging-port=${options.remoteDebuggingPort}`,
      `--user-data-dir=${options.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      options.url,
    ];

    const child = spawn(options.chromePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    child.unref();

    return {
      pid: child.pid,
      chromePath: options.chromePath,
      args,
    };
  }
}
