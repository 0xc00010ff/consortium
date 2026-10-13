// Saves a screenshot of the demo conversation to docs/screenshot.png, for the README.
//
// Usage:
//   npm run dev:mock          (in another terminal, if no server is running)
//   npm run screenshot
//
// It opens http://localhost:3100/?screenshot=1#/preview/demo in headless
// Google Chrome at 1440 by 900 CSS pixels, at a device scale factor of 2, in
// the light color scheme. The preview renders from fixtures, so no model is
// called. Set CHROME to use another Chrome binary, and BASE_URL to use a
// server on another port.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const base = (process.env.BASE_URL || "http://localhost:3100").replace(/\/$/, "");
const url = `${base}/?screenshot=1#/preview/demo`;
const out = join(root, "docs", "screenshot.png");

// A throwaway profile, so the capture never touches a running Chrome.
const profile = mkdtempSync(join(tmpdir(), "consortium-screenshot-"));

const args = [
  "--headless=new",
  `--user-data-dir=${profile}`,
  `--screenshot=${out}`,
  "--window-size=1440,900",
  "--force-device-scale-factor=2",
  "--hide-scrollbars",
  "--virtual-time-budget=8000",
  // Blink's preferred color scheme: 0 is dark, 1 is light.
  "--blink-settings=preferredColorScheme=1",
  "--no-first-run",
  "--no-default-browser-check",
  url,
];

const before = Date.now();
const result = spawnSync(chrome, args, { encoding: "utf8", timeout: 60_000 });
rmSync(profile, { recursive: true, force: true });

if (result.error) {
  console.error(`Chrome could not be started at ${chrome}. Set CHROME to its path. ${result.error.message}`);
  process.exit(1);
}

let size = 0;
try {
  const stat = statSync(out);
  if (stat.mtimeMs >= before - 1000) size = stat.size;
} catch {
  // No file, reported below.
}
if (!size) {
  console.error(`Chrome did not write ${out}. Check that the app is running at ${base}.`);
  console.error(result.stderr);
  process.exit(1);
}
console.log(`Saved ${out} (${Math.round(size / 1024)} KB).`);
