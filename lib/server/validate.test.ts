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
