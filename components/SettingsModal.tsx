"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { KEY_NAMES, type KeyName, type ModelsResponse, type SettingsResponse, type SettingsUpdate, type ToolStatus } from "@/lib/types";
import { builtinPresets, usePresets } from "@/lib/ui/presets";
import {
  fetchSettings,
  readDefaultPreset,
  readTheme,
  saveSettings,
  setDefaultPreset,
  setTheme,
  type Theme,
} from "@/lib/ui/settings";
import { defaultSetupChanged } from "@/lib/ui/tables";
import { Icon } from "./Icon";
import { IconButton, Toggle } from "./ui";

const KEY_LABELS: Record<KeyName, string> = {
  gateway: "Vercel AI Gateway",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
};

// The environment variable each key can also come from, shown in a tooltip.
const KEY_ENV: Record<KeyName, string> = {
  gateway: "AI_GATEWAY_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY",
  xai: "XAI_API_KEY",
};

const PROVIDER_KEYS = KEY_NAMES.filter((k) => k !== "gateway");
const GATEWAY_URL = "https://vercel.com/ai-gateway";

const TOOL_KEYS: Record<ToolStatus["id"], "claude" | "codex"> = {
  "cli/claude-code": "claude",
  "cli/codex": "codex",
};

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function without<T extends object>(record: T, key: keyof T): T {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// The Settings dialog. Escape, the close button and a press on the backdrop
// close it. Focus starts on the dialog, Tab stays inside it, and focus goes
// back to whatever opened it when it closes.
export function SettingsModal({ data, onClose }: { data: ModelsResponse | null; onClose: () => void }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => opener?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && at <= 0) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === -1 || at === items.length - 1)) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="modal-back"
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
        pressedBackdrop.current = false;
      }}
    >
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <h2 id={titleId}>Settings</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">
          <ServerSettings />
          <section className="psec">
            <h3 className="lbl">Appearance</h3>
            <ThemeRow />
          </section>
          <section className="psec">
            <h3 className="lbl">New tables</h3>
            <DefaultSetupRow data={data} />
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------- API keys and coding agents, which the server keeps ----------

function ServerSettings() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Partial<Record<KeyName, string>>>({});
  // null until the person opens or closes the provider keys themselves; then
  // the section starts open when a provider key is set.
  const [showProviders, setShowProviders] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((res) => {
        if (cancelled) return;
        setSettings(res);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Sends a change and shows the server's answer. Returns true when it was saved.
  async function save(update: SettingsUpdate): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      setSettings(await saveSettings(update));
      return true;
    } catch (err) {
      const detail = err instanceof Error && err.message ? ` ${err.message}` : "";
      setError(`Could not save the change.${detail}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveKey(name: KeyName, value: string | null): Promise<boolean> {
    const ok = await save({ keys: { [name]: value } });
    // A revealed value is out of date once the key changes.
    if (ok) setRevealed((r) => without(r, name));
    return ok;
  }

  async function reveal(name: KeyName) {
    setError(null);
    try {
      const value = (await fetchSettings(true)).keys[name]?.value;
      if (value) setRevealed((r) => ({ ...r, [name]: value }));
    } catch {
      setError("Could not load the key.");
    }
  }

  if (!settings) {
    return (
      <section className="psec">
        <h3 className="lbl">API keys</h3>
        {loadFailed ? (
          <div className="set-line">
            <span className="set-note">Could not load the settings.</span>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                setLoadFailed(false);
                setAttempt((a) => a + 1);
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <p className="set-note">Loading the settings.</p>
        )}
      </section>
    );
  }

  const anyKey = KEY_NAMES.some((k) => settings.keys[k]?.set);
  const providersOpen = showProviders ?? PROVIDER_KEYS.some((k) => settings.keys[k]?.set);
  const keyRow = (name: KeyName) => (
    <KeyRow
      key={name}
      label={KEY_LABELS[name]}
      env={KEY_ENV[name]}
      status={settings.keys[name] ?? { set: false }}
      revealed={revealed[name]}
      saving={saving}
      onShow={() => reveal(name)}
      onHide={() => setRevealed((r) => without(r, name))}
      onSave={(value) => saveKey(name, value)}
      onClear={() => saveKey(name, null)}
    />
  );

  return (
    <>
      <section className="psec">
        <h3 className="lbl">API keys</h3>
        {!settings.webSearch && anyKey ? <p className="set-note">Web search is off without a gateway key.</p> : null}
        {error ? (
          <p className="set-error" role="alert">
            {error}
          </p>
        ) : null}
        <ul className="set-list">
          {keyRow("gateway")}
          <li className="set-sub">
            Recommended. One key covers every model and web search. Get one at{" "}
            <a href={GATEWAY_URL} target="_blank" rel="noreferrer">
              vercel.com/ai-gateway
            </a>
            .
          </li>
        </ul>
        <button
          type="button"
          className="text-btn set-collapse"
          aria-expanded={providersOpen}
          onClick={() => setShowProviders(!providersOpen)}
        >
          <Icon name={providersOpen ? "chevronDown" : "chevronRight"} size={14} />
          Use individual provider keys
        </button>
        {providersOpen ? <ul className="set-list">{PROVIDER_KEYS.map(keyRow)}</ul> : null}
      </section>
      {settings.tools.length ? (
        <section className="psec">
          <h3 className="lbl">Coding agents</h3>
          <ul className="set-list">
            {settings.tools.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                saving={saving}
                onSave={(value) => save({ toolPaths: { [TOOL_KEYS[tool.id]]: value } })}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function KeyRow({
  label,
  env,
  status,
  revealed,
  saving,
  onShow,
  onHide,
  onSave,
  onClear,
}: {
  label: string;
  env: string; // the environment variable the key can also come from
  status: SettingsResponse["keys"][KeyName];
  revealed?: string;
  saving: boolean;
  onShow: () => void;
  onHide: () => void;
  onSave: (value: string) => Promise<boolean>;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = draft.trim();
    if (!value) return;
    if (await onSave(value)) setDraft("");
  }

  let state: ReactNode = <span className="set-dim">Not set</span>;
  if (status.set) {
    state = (
      <>
        {revealed ? <span className="mono set-value">{revealed}</span> : <span className="mono">••••{status.last4 ?? ""}</span>}
        {status.source === "env" ? <span className="set-dim">from .env</span> : null}
      </>
    );
  }

  return (
    <li className="set-row">
      <div className="set-line">
        <span className="set-name">
          {label}
          <span className="set-info" role="img" aria-label={`Environment variable ${env}`} title={`Environment variable: ${env}`}>
            <Icon name="info" size={14} />
          </span>
        </span>
        <span className="set-state">{state}</span>
        {status.set ? (
          <button
            type="button"
            className="text-btn"
            aria-label={`${revealed ? "Hide" : "Show"} the ${label} key`}
            onClick={revealed ? onHide : onShow}
          >
            {revealed ? "Hide" : "Show"}
          </button>
        ) : null}
        {status.set && status.source !== "env" ? (
          <button type="button" className="text-btn" aria-label={`Clear the ${label} key`} disabled={saving} onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      <form className="set-field" onSubmit={submit}>
        <input
          className="input"
          type="password"
          value={draft}
          placeholder="Paste a key"
          aria-label={`${label} key`}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn" disabled={saving || !draft.trim()}>
          Save
        </button>
      </form>
    </li>
  );
}

function ToolRow({
  tool,
  saving,
  onSave,
}: {
  tool: ToolStatus;
  saving: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const fieldId = useId();
  const [path, setPath] = useState(tool.configuredPath ?? "");

  // The saved path changed on the server, so show it.
  const [shown, setShown] = useState(tool.configuredPath);
  if (shown !== tool.configuredPath) {
    setShown(tool.configuredPath);
    setPath(tool.configuredPath ?? "");
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = path.trim();
    if (value) void onSave(value);
  }

  return (
    <li className="set-row">
      <div className="set-line">
        <span className="set-name">{tool.name}</span>
        <span className="set-state">{tool.installed ? `Installed${tool.version ? ` ${tool.version}` : ""}` : "Not found"}</span>
      </div>
      {tool.installed && tool.path ? <div className="mono set-dim set-path">{tool.path}</div> : null}
      {tool.defaultModel ? <div className="set-dim">Default model: {tool.defaultModel}</div> : null}
      <form className="set-field" onSubmit={submit}>
        <label className="set-label" htmlFor={fieldId}>
          Path
        </label>
        <input
          id={fieldId}
          className="input mono"
          value={path}
          placeholder={tool.path ?? "Not found"}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="submit" className="btn" disabled={saving || !path.trim() || path.trim() === tool.configuredPath}>
          Save
        </button>
        {tool.configuredPath ? (
          <button type="button" className="btn ghost" disabled={saving} onClick={() => void onSave(null)}>
            Clear
          </button>
        ) : null}
      </form>
    </li>
  );
}

// ---------- settings this browser keeps ----------

function ThemeRow() {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  return (
    <div className="set-line">
      <span className="set-name">Theme</span>
      <Toggle
        label="Theme"
        options={THEMES}
        value={theme}
        onChange={(next) => {
          setTheme(next);
          setThemeState(next);
        }}
      />
    </div>
  );
}

function DefaultSetupRow({ data }: { data: ModelsResponse | null }) {
  const fieldId = useId();
  const saved = usePresets();
  const presets = [...(data ? builtinPresets(data) : []), ...saved];
  const [chosen, setChosen] = useState(readDefaultPreset);
  const value = presets.some((p) => p.id === chosen) ? chosen : "";

  return (
    <div className="set-line">
      <label className="set-name" htmlFor={fieldId}>
        Default setup
      </label>
      <span className="select set-select">
        <select
          id={fieldId}
          value={value}
          onChange={(e) => {
            setDefaultPreset(e.target.value);
            setChosen(e.target.value);
            defaultSetupChanged();
          }}
        >
          <option value="">Claude Code and Codex</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={14} />
      </span>
    </div>
  );
}
