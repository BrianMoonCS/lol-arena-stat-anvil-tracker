import { describe, expect, it } from "vitest";
import {
  getPanelValueRegions,
  normalizeOcrText,
  parseAnvilCount,
  PANEL_STAT_CELLS,
} from "./ocr-layout";

describe("fixed stat panel layout", () => {
  it("maps the 13 visible stats while excluding Health Regen, Lifesteal, and Attack Range", () => {
    expect(PANEL_STAT_CELLS).toHaveLength(13);
    expect(PANEL_STAT_CELLS.map(({ id }) => id)).toEqual([
      "healAndShieldPower",
      "armorPenetration",
      "magicPenetration",
      "omnivamp",
      "tenacity",
      "attackDamage",
      "abilityPower",
      "armor",
      "magicResistance",
      "attackSpeed",
      "abilityHaste",
      "criticalStrikeChance",
      "movementSpeed",
    ]);
  });

  it("uses the individually annotated value boxes for the detected panel", () => {
    const regions = getPanelValueRegions(764, 1024);
    expect(regions).toHaveLength(13);
    expect(regions.find(({ id }) => id === "healAndShieldPower")).toEqual({
      id: "healAndShieldPower",
      x: 489,
      y: 12,
      width: 267,
      height: 97,
    });
    expect(regions.find(({ id }) => id === "attackDamage")).toEqual({
      id: "attackDamage",
      x: 138,
      y: 539,
      width: 267,
      height: 97,
    });
  });
});

describe("OCR value normalization", () => {
  it("preserves decimals, percentages, and compound separators", () => {
    expect(normalizeOcrText(" 1,234 | 40% ")).toBe("1234|40%");
    expect(normalizeOcrText("1.42")).toBe("1.42");
  });

  it("accepts only confident integer Anvil Counts", () => {
    expect(parseAnvilCount({ value: "16", confidence: 0.8 })).toEqual({
      value: "16",
      confidence: 0.8,
    });
    expect(parseAnvilCount({ value: "1?", confidence: 0.9 })).toBeUndefined();
    expect(parseAnvilCount({ value: "16", confidence: 0.4 })).toBeUndefined();
  });
});