import { describe, expect, it } from "vitest";
import { formatStatDiff } from "./diff";

describe("formatStatDiff", () => {
  it("formats positive and negative integer changes", () => {
    expect(formatStatDiff("10", "12")).toBe("(+2)");
    expect(formatStatDiff("12", "10")).toBe("(-2)");
  });

  it("preserves percent units", () => {
    expect(formatStatDiff("32%", "40%")).toBe("(+8%)");
  });

  it("formats decimal differences without floating-point noise", () => {
    expect(formatStatDiff("2.83", "3.01")).toBe("(+0.18)");
    expect(formatStatDiff("0.3", "0.2")).toBe("(-0.1)");
  });

  it("accepts comma-grouped values", () => {
    expect(formatStatDiff("1,300", "1,450")).toBe("(+150)");
  });

  it("diffs each part of compound values", () => {
    expect(formatStatDiff("514 | 40%", "634 | 50%")).toBe(
      "(+120 | +10%)",
    );
    expect(formatStatDiff("514 | 40%", "634 | 40%")).toBe("(+120)");
  });

  it("treats blank strings as zero", () => {
    expect(formatStatDiff("", "5")).toBe("(+5)");
    expect(formatStatDiff("5", "")).toBe("(-5)");
    expect(formatStatDiff("", "")).toBeUndefined();
  });

  it("returns no delta for absent, unchanged, or invalid values", () => {
    expect(formatStatDiff(undefined, "5")).toBeUndefined();
    expect(formatStatDiff("5", null)).toBeUndefined();
    expect(formatStatDiff("5", "5")).toBeUndefined();
    expect(formatStatDiff("unknown", "5")).toBeUndefined();
  });

  it("rejects conflicting units", () => {
    expect(formatStatDiff("12", "14%")).toBeUndefined();
  });
});