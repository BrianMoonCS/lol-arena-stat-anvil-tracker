import { describe, expect, it } from "vitest";
import { buildVisionPrompt, validateVisionResponse, type VisionTask } from "./vision";

const tasks: VisionTask[] = [
  { id: "attackSpeed", side: "before" },
  { id: "armorPenetration", side: "after" },
];

describe("vision fallback contract", () => {
  it("states the exact number of JSON-only results requested", () => {
    const prompt = buildVisionPrompt(tasks);
    expect(prompt).toContain("exactly 2 requested stat values");
    expect(prompt).toContain("no markdown");
    expect(prompt).toContain("attackSpeed");
  });

  it("accepts exactly the requested values and preserves compounds", () => {
    expect(validateVisionResponse({
      results: [
        { id: "attackSpeed", side: "before", value: "1.42", confidence: 0.96 },
        { id: "armorPenetration", side: "after", value: "514 | 40%", confidence: 0.91 },
      ],
    }, tasks)).toEqual([
      { id: "attackSpeed", side: "before", value: "1.42", confidence: 0.96 },
      { id: "armorPenetration", side: "after", value: "514 | 40%", confidence: 0.91 },
    ]);
  });

  it("rejects missing, extra, duplicate, or unrequested values", () => {
    expect(validateVisionResponse({ results: [] }, tasks)).toBeUndefined();
    expect(validateVisionResponse({ results: [
      { id: "attackSpeed", side: "before", value: "1.42", confidence: 0.9 },
      { id: "armorPenetration", side: "after", value: "514", confidence: 0.9 },
      { id: "armor", side: "after", value: "100", confidence: 0.9 },
    ] }, tasks)).toBeUndefined();
    expect(validateVisionResponse({ results: [
      { id: "attackSpeed", side: "before", value: "1.42", confidence: 0.9 },
      { id: "attackSpeed", side: "before", value: "1.42", confidence: 0.9 },
    ] }, tasks)).toBeUndefined();
  });

  it("rejects invalid confidence values and non-JSON shapes", () => {
    expect(validateVisionResponse({ results: [
      { id: "attackSpeed", side: "before", value: "1.42", confidence: 2 },
      { id: "armorPenetration", side: "after", value: "514", confidence: 0.9 },
    ] }, tasks)).toBeUndefined();
    expect(validateVisionResponse("{}", tasks)).toBeUndefined();
    expect(validateVisionResponse({ extra: true, results: [] }, tasks)).toBeUndefined();
  });
});