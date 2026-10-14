"use client";

import { Fragment, useRef, useState, type ReactNode } from "react";
import { KEY_NAMES, type SettingsResponse, type ToolStatus } from "@/lib/types";
import { saveSettings } from "@/lib/ui/settings";
import { GATEWAY_URL, KEY_ENV, KEY_LABELS, KeyRow, Modal, SettingsLoading, TOOL_KEYS, ToolRow, useServerSettings } from "./SettingsModal";

// The command that installs each coding agent.
const INSTALL: Record<ToolStatus["id"], string> = {
  "cli/claude-code": "npm install -g @anthropic-ai/claude-code",
  "cli/codex": "npm install -g @openai/codex",
};

const STEPS = ["Coding agents", "API key", "Ready"];

// The dialog that opens on a fresh install. It finds Claude Code and Codex,
// asks for a gateway key, then says what is in place. Closing it by any route
// marks the setup as done, so it does not open again.
export function SetupWizard({ onDone }: { onDone: () => void }) {
  const server = useServerSettings();
  const { settings, saving, error } = server;
  const [step, setStep] = useState(0);
  // A key pasted on the API key step and not yet saved. Continue saves it.
  const [keyDraft, setKeyDraft] = useState("");
  const closing = useRef(false);

  async function next() {
    const pending = keyDraft.trim();
    if (step === 1 && pending && !(await server.saveKey("gateway", pending))) return;
    setStep(step + 1);
  }

  async function finish() {
    if (closing.current) return;
    closing.current = true;
    try {
      await saveSettings({ setupDone: true });
    } catch {
      // The setup was not marked as done, so the dialog opens again next time.
    }
    onDone();
  }

  const errorLine = error ? (
    <p className="set-error" role="alert">
      {error}
    </p>
  ) : null;

  let body: ReactNode;
  if (!settings) {
    body = <SettingsLoading failed={server.loadFailed} onRetry={server.retryLoad} />;
  } else if (step === 0) {
    body = (
      <>
        {errorLine}
        <ul className="set-list">
          {settings.tools.map((tool) => (
            <Fragment key={tool.id}>
              <ToolRow tool={tool} saving={saving} onSave={(value) => server.save({ toolPaths: { [TOOL_KEYS[tool.id]]: value } })} />
              {!tool.installed ? (
                <li className="wiz-hint">
                  Install it with <code>{INSTALL[tool.id]}</code>. Then run it once in a terminal to sign in.
                </li>
              ) : null}
            </Fragment>
          ))}
        </ul>
        <div>
          <button type="button" className="text-btn" disabled={server.checking} onClick={() => void server.checkTools()}>
            Check again
          </button>
        </div>
      </>
    );
  } else if (step === 1) {
    body = (
      <>
        <a className="btn wiz-link" href={GATEWAY_URL} target="_blank" rel="noreferrer">
          Get a key at vercel.com/ai-gateway
        </a>
        {errorLine}
        <ul className="set-list">
          <KeyRow
            label={KEY_LABELS.gateway}
            env={KEY_ENV.gateway}
            status={settings.keys.gateway ?? { set: false }}
            revealed={server.revealed.gateway}
            saving={saving}
            onShow={() => server.reveal("gateway")}
            onHide={() => server.hide("gateway")}
            onSave={(value) => server.saveKey("gateway", value)}
            onClear={() => server.saveKey("gateway", null)}
            onDraft={setKeyDraft}
          />
        </ul>
        <p className="wiz-hint">Keys from Anthropic, OpenAI, Google or xAI also work. Add them in Settings.</p>
      </>
    );
  } else {
    body = <Summary settings={settings} />;
  }

  const intro = [
    "Consortium can run agents on your Claude and ChatGPT subscriptions through Claude Code and Codex. No API key is needed for that.",
    "A Vercel AI Gateway key runs every model in the list and gives agents web search. It is the simplest setup, and the only key you need.",
    null,
  ][step];

  const footer = (
    <div className="wiz-foot">
      {step === 0 ? (
        <button type="button" className="btn ghost" onClick={() => setStep(1)}>
          Skip
        </button>
      ) : (
        <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>
          Back
        </button>
      )}
      {step < STEPS.length - 1 ? (
        <button type="button" className="btn primary" disabled={saving} onClick={() => void next()}>
          Continue
        </button>
      ) : (
        <button type="button" className="btn primary" onClick={() => void finish()}>
          Start
        </button>
      )}
    </div>
  );

  return (
    <Modal title={STEPS[step]} step={`Step ${step + 1} of ${STEPS.length}`} footer={footer} onClose={() => void finish()}>
      <section className="psec">
        {intro ? <p className="wiz-intro">{intro}</p> : null}
        {body}
      </section>
    </Modal>
  );
}

// What is in place, from the latest settings the server sent.
function Summary({ settings }: { settings: SettingsResponse }) {
  const agents = settings.tools.filter((t) => t.installed).map((t) => t.name);
  const gateway = Boolean(settings.keys.gateway?.set);
  const provider = KEY_NAMES.some((k) => k !== "gateway" && settings.keys[k]?.set);

  const lines: string[] = [];
  if (agents.length) lines.push(`Agents can run on ${listOf(agents)}.`);
  if (gateway) lines.push("Models and web search run through the AI Gateway.");
  else if (provider) lines.push("Provider keys are set.");

  if (!lines.length) {
    return (
      <p className="wiz-intro">
        Nothing is set yet, so the app writes sample replies itself. Add a key or a coding agent in Settings whenever you are ready.
      </p>
    );
  }
  return (
    <ul className="wiz-list">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

// "A", "A and B", "A, B and C".
function listOf(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
