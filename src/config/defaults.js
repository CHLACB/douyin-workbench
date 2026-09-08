import path from "node:path";
import { RUNTIME_DIR } from "../shared/paths.js";

export const DEFAULTS = {
  douyinUrl: "https://www.douyin.com/jingxuan",
  remoteDebuggingHost: "127.0.0.1",
  remoteDebuggingPort: 9222,
  userDataDir: path.join(RUNTIME_DIR, "chrome-profile"),
  sessionFile: path.join(RUNTIME_DIR, "session.json"),
};
