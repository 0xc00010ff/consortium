import { describe, expect, it } from "vitest";
import { parseSpeakRequest } from "./validate";

const body = { modelId: "cli/claude-code", instructions: "Be brief.", messages: [{ role: "user", text: "Hi" }], browsing: false };

function parsed(extra: Record<string, unknown>) {
  const result = parseSpeakRequest({ ...body, ...extra });
  if (!result.ok) throw new Error(result.error);
  return result.request;
}

describe("the tool model in a speak request", () => {
  it("keeps a tool model that is safe as a command line argument", () => {
    expect(parsed({ toolModel: "opus" }).toolModel).toBe("opus");
    expect(parsed({ toolModel: "gpt-6.1-sol" }).toolModel).toBe("gpt-6.1-sol");
  });

  it("drops anything else", () => {
    for (const toolModel of ["", " opus", "-m", "--model=opus", "opus; rm", 'a"b', "x".repeat(65), 42, null, ["opus"]]) {
      expect(parsed({ toolModel })).not.toHaveProperty("toolModel");
    }
    expect(parsed({})).not.toHaveProperty("toolModel");
  });
});

describe("the thinking level in a speak request", () => {
  it("keeps a short lowercase level", () => {
    for (const thinking of ["low", "xhigh", "max", "ultra", "none", "minimal"]) {
      expect(parsed({ thinking }).thinking).toBe(thinking);
    }
  });

  it("drops anything that is unsafe on a command line or in a TOML string", () => {
    for (const thinking of ["", "High", " high", "-high", "--effort", 'high"', "high low", "high;rm", "x".repeat(17), 3, null, ["high"]]) {
      expect(parsed({ thinking })).not.toHaveProperty("thinking");
    }
    expect(parsed({})).not.toHaveProperty("thinking");
  });
});
