// Server settings read from the environment. API keys are resolved in
// lib/server/settings.ts, which also reads the settings file.

// CONSORTIUM_MOCK=1 makes every reply a sample reply, even with a key set.
export function isForcedMock(): boolean {
  return process.env.CONSORTIUM_MOCK?.trim() === "1";
}

// Pace of sample replies. 1 is the normal pace, 0 removes the delays (used by tests).
export function mockDelayScale(): number {
  const raw = process.env.CONSORTIUM_MOCK_DELAY?.trim();
  if (!raw) return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}
