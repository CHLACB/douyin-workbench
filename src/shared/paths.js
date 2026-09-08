import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const sharedDir = path.dirname(currentFile);
const srcDir = path.resolve(sharedDir, "..");

export const PROJECT_ROOT = path.resolve(srcDir, "..");
export const RUNTIME_DIR = path.join(PROJECT_ROOT, ".runtime");
