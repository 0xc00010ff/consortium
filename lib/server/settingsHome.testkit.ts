// Test helper: points the settings file at a new temporary folder and clears
// every API key variable, so a test never reads or writes the host's real
// ~/.consortium and never picks up a key from the shell.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KEY_ENV } from "./settings";

const made: string[] = [];

export function isolateSettings(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "consortium-settings-test-"));
  made.push(dir);
  process.env.CONSORTIUM_HOME = dir;
  for (const names of Object.values(KEY_ENV)) for (const name of names) delete process.env[name];
  return dir;
}

export function removeSettingsDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
