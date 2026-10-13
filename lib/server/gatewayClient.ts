// The gateway provider for a key. The default `gateway` export from "ai"
// reads only AI_GATEWAY_API_KEY, so a key saved in the settings needs its own
// instance. One instance is kept for the key in use.

import { createGateway } from "ai";

export type GatewayClient = ReturnType<typeof createGateway>;

let client: { key: string; provider: GatewayClient } | null = null;

export function gatewayProvider(apiKey: string): GatewayClient {
  if (client?.key !== apiKey) client = { key: apiKey, provider: createGateway({ apiKey }) };
  return client.provider;
}
