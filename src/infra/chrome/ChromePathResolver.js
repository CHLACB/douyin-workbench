import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export class ChromePathResolver {
  resolve(explicitPath) {
    const candidates = [
      explicitPath,
      process.env.CHROME_PATH,
      ...this.commonPaths(),
      ...this.pathCandidates(),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return path.resolve(candidate);
      }
    }

    throw new Error(
      "没有找到 Chrome。请设置 CHROME_PATH，或使用 --chrome-path 指定 chrome.exe。",
    );
  }

  commonPaths() {
    if (os.platform() !== "win32") {
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
    }

    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env["PROGRAMFILES(X86)"];

    return [
      localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      programFiles && path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      programFilesX86 && path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  }

  pathCandidates() {
    const command = os.platform() === "win32" ? "where.exe" : "which";
    const names = os.platform() === "win32"
      ? ["chrome.exe", "chrome"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

    const found = [];
    for (const name of names) {
      try {
        const output = execFileSync(command, [name], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        found.push(...output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
      } catch {
        // PATH lookup is optional.
      }
    }
    return found;
  }
}
