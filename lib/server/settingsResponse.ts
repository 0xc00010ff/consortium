// Builds the body of GET and PUT /api/settings: the status of each key, with
// only its last four characters unless the host asked to reveal it, and the
// status of Claude Code and Codex.

import { KEY_NAMES, type KeyName, type KeyStatus, type SettingsResponse } from "@/lib/types";
import { clearModelsCache } from "./models";
import { readSettingsFile, resolveKeys, type Env, type SettingsFile } from "./settings";
import { clearToolVersionCache, getToolStatuses, type ToolStatusOptions } from "./toolStatus";

export interface SettingsResponseOptions extends ToolStatusOptions {
  reveal?: boolean;
  env?: Env;
}

export async function getSettingsResponse({
  reveal = false,
  env = process.env,
  settings,
  ...toolOptions
}: SettingsResponseOptions = {}): Promise<SettingsResponse> {
  const file: SettingsFile = settings ?? readSettingsFile();
  const resolved = resolveKeys(file, env);
  const keys = {} as Record<KeyName, KeyStatus>;
  for (const name of KEY_NAMES) {
    const key = resolved[name];
    if (!key) {
      keys[name] = { set: false };
      continue;
    }
    keys[name] = { set: true, last4: key.value.slice(-4), source: key.source };
    if (reveal) keys[name].value = key.value;
  }
  const tools = await getToolStatuses({ ...toolOptions, settings: file });
  return { keys, tools, webSearch: resolved.gateway !== null };
}

// After a change, the next model list, tool search and version reflect it.
export function clearSettingsCaches(): void {
  clearModelsCache();
  clearToolVersionCache();
}
