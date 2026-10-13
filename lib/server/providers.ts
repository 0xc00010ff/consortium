// Chooses how a gateway model id runs. With a gateway key, every model runs
// through the Vercel AI Gateway. Without one, a model runs directly on its
// maker's API when the host has saved that maker's key.
//
// The model list always uses gateway ids, such as "anthropic/claude-sonnet-5.5".
// Each provider names the same model a little differently, so the id is
// mapped before the call:
//   anthropic/claude-sonnet-4.5     -> claude-sonnet-4-5        (dots become dashes)
//   openai/gpt-6.1-sol              -> gpt-6.1-sol              (unchanged)
//   google/gemini-3.1-pro-preview   -> gemini-3.1-pro-preview   (unchanged)
//   xai/grok-4.7                    -> grok-4.7                 (unchanged)
//   xai/grok-4.1-fast-reasoning     -> grok-4-1-fast-reasoning  (xAI writes its fast models with dashes)
//   spacexai/grok-4.7               -> grok-4.7

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { MAKER_LABELS, type Maker } from "@/lib/types";
import { gatewayProvider } from "./gatewayClient";
import { makerOf } from "./models";
import type { ResolvedKeys } from "./settings";

// ---------- Provider ids ----------

export function providerModelId(gatewayId: string): { maker: Maker; id: string } | null {
  const maker = makerOf(gatewayId);
  if (!maker) return null;
  const bare = gatewayId.slice(gatewayId.indexOf("/") + 1);
  switch (maker) {
    case "anthropic":
      return { maker, id: bare.replace(/\./g, "-") };
    case "xai":
      return { maker, id: bare.replace(/^(grok-\d+)\.(\d+)(-fast\b)/, "$1-$2$3") };
    default:
      return { maker, id: bare };
  }
}

export function providerModel(maker: Maker, id: string, apiKey: string): LanguageModel {
  switch (maker) {
    case "anthropic":
      return createAnthropic({ apiKey })(id);
    case "openai":
      return createOpenAI({ apiKey })(id);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(id);
    case "xai":
      return createXai({ apiKey })(id);
  }
}

// ---------- Choosing the route ----------

export type ModelRoute =
  | { kind: "gateway"; model: LanguageModel; gatewayKey: string; service: string }
  | { kind: "provider"; model: LanguageModel; maker: Maker; service: string }
  | { kind: "missing-key"; message: string };

// The gateway key covers every model. Otherwise the model's maker needs a key.
export function routeModel(
  modelId: string,
  keys: ResolvedKeys,
  make: typeof providerModel = providerModel,
): ModelRoute {
  const gateway = keys.gateway?.value;
  if (gateway) {
    return { kind: "gateway", model: gatewayProvider(gateway)(modelId), gatewayKey: gateway, service: "The AI Gateway" };
  }
  const mapped = providerModelId(modelId);
  if (!mapped) return { kind: "missing-key", message: `No key for ${modelId}. Add a gateway key in Settings.` };
  const label = MAKER_LABELS[mapped.maker];
  const key = keys[mapped.maker]?.value;
  if (!key) return { kind: "missing-key", message: missingKeyMessage(mapped.maker) };
  return { kind: "provider", model: make(mapped.maker, mapped.id, key), maker: mapped.maker, service: label };
}

export function missingKeyMessage(maker: Maker): string {
  const label = MAKER_LABELS[maker];
  const article = maker === "google" ? "a" : "an"; // "an OpenAI key", "an xAI key", "a Google key"
  return `No key for ${label}. Add a gateway key or ${article} ${label} key in Settings.`;
}
