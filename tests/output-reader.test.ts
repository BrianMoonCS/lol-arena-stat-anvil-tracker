// Reads stats back off the user's sample outputs (made with their Resolve template, scaled to
// 1920x1080 here) and compares them with the values shown on them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DELTA_PRESETS } from "../src/core/output-format";
import { readOutputSheet, readOutputValues } from "../src/core/output-reader";
import type { OutputConfig } from "../src/core/render";
import { readPng } from "./support/png";

const config = JSON.parse(
  readFileSync(new URL("../public/config/output-config.json", import.meta.url), "utf8"),
) as OutputConfig;

const load = (sample: number) =>
  readPng(fileURLToPath(new URL(`./fixtures/output-sample-${sample}.png`, import.meta.url)));

const SAMPLES: Array<[number, Record<string, string>]> = [
  [1, { healAndShieldPower: "0%", armorPenetration: "0|0%", magicPenetration: "30|0%", omnivamp: "30%", tenacity: "0%", fortune: "2000", shard: "100%" }],
  [2, { healAndShieldPower: "0%", armorPenetration: "0|0%", magicPenetration: "34|0%", omnivamp: "34%", tenacity: "0%", fortune: "4000", shard: "124%" }],
  [3, { healAndShieldPower: "0%", armorPenetration: "0|0%", magicPenetration: "81|0%", omnivamp: "81%", tenacity: "0%", fortune: "15300", shard: "269%" }],
  [4, { healAndShieldPower: "0%", armorPenetration: "32|23%", magicPenetration: "0|0%", omnivamp: "9%", tenacity: "0%", fortune: "0", shard: "0%" }],
];

it.each(SAMPLES)("reads the top-panel stats, Fortune and Shard off sample output %i", (sample, expected) => {
  expect(readOutputValues(load(sample), config.layout, config.output.cardScale)).toEqual(expected);
});

it("reads every stat on a sample output, not just the top panel", () => {
  const ids = config.layout.map((slot) => slot.id).filter((id) => id !== "anvilCount");
  expect(readOutputValues(load(3), config.layout, config.output.cardScale, ids)).toEqual({
    health: "8338",
    attackDamage: "108",
    abilityPower: "169",
    attackSpeed: "8.97",
    armor: "1448",
    magicResistance: "1365",
    abilityHaste: "500",
    criticalStrikeChance: "100%",
    omnivamp: "81%",
    armorPenetration: "0|0%",
    magicPenetration: "81|0%",
    movementSpeed: "367",
    tenacity: "0%",
    healAndShieldPower: "0%",
    fortune: "15300",
  });
});

// Full sheets: After values, Before values worked back from each delta, and delta colors.
const pair = (before: string, after: string) => ({ before, after });
const SHEETS: Array<[number, Record<string, { before: string; after: string }>]> = [
  [1, {
    health: pair("4405", "5005"), attackDamage: pair("93", "93"), abilityPower: pair("100", "100"),
    attackSpeed: pair("3.14", "3.64"), armor: pair("406", "544"), magicResistance: pair("467", "575"),
    abilityHaste: pair("490", "500"), criticalStrikeChance: pair("0%", "0%"), omnivamp: pair("30%", "30%"),
    armorPenetration: pair("0|0%", "0|0%"), magicPenetration: pair("30|0%", "30|0%"), movementSpeed: pair("367", "367"),
    tenacity: pair("0%", "0%"), healAndShieldPower: pair("0%", "0%"), fortune: pair("0", "2000"),
    shard: pair("100%", "100%"), anvilCount: pair("41", "51"),
  }],
  [2, {
    health: pair("5187", "6297"), attackDamage: pair("97", "97"), abilityPower: pair("100", "112"),
    attackSpeed: pair("3.66", "5.48"), armor: pair("550", "648"), magicResistance: pair("577", "726"),
    abilityHaste: pair("500", "500"), criticalStrikeChance: pair("0%", "84%"), omnivamp: pair("30%", "34%"),
    armorPenetration: pair("0|0%", "0|0%"), magicPenetration: pair("30|0%", "34|0%"), movementSpeed: pair("367", "367"),
    tenacity: pair("0%", "0%"), healAndShieldPower: pair("0%", "0%"), fortune: pair("2000", "4000"),
    shard: pair("100%", "124%"), anvilCount: pair("51", "65"),
  }],
  [3, {
    health: pair("7537", "8338"), attackDamage: pair("108", "108"), abilityPower: pair("124", "169"),
    attackSpeed: pair("7.42", "8.97"), armor: pair("1000", "1448"), magicResistance: pair("990", "1365"),
    abilityHaste: pair("500", "500"), criticalStrikeChance: pair("100%", "100%"), omnivamp: pair("67%", "81%"),
    armorPenetration: pair("0|0%", "0|0%"), magicPenetration: pair("67|0%", "81|0%"), movementSpeed: pair("367", "367"),
    tenacity: pair("0%", "0%"), healAndShieldPower: pair("0%", "0%"), fortune: pair("10720", "15300"),
    shard: pair("224%", "269%"), anvilCount: pair("88", "95"),
  }],
  [4, {
    health: pair("1713", "1713"), attackDamage: pair("107", "72"), abilityPower: pair("20", "0"),
    attackSpeed: pair("0.91", "0.91"), armor: pair("75", "75"), magicResistance: pair("91", "57"),
    abilityHaste: pair("20", "20"), criticalStrikeChance: pair("0%", "0%"), omnivamp: pair("0%", "9%"),
    armorPenetration: pair("0|0%", "32|23%"), magicPenetration: pair("0|0%", "0|0%"), movementSpeed: pair("370", "330"),
    tenacity: pair("0%", "0%"), healAndShieldPower: pair("12%", "0%"), fortune: pair("0", "0"),
    shard: pair("0%", "0%"), anvilCount: pair("1", "1"),
  }],
];

it.each(SHEETS)("reads every value and delta off sample output %i", (sample, expected) => {
  const { values, colors } = readOutputSheet(load(sample), config.layout, config.output.cardScale);
  expect(values).toEqual(expected);
  // Every delta on the samples is the default green, except shard's purple.
  for (const [id, color] of Object.entries(colors)) {
    expect(color, id).toEqual(id === "shard" ? DELTA_PRESETS.purple : DELTA_PRESETS.green);
  }
  if (sample === 2) expect(colors.shard).toEqual(DELTA_PRESETS.purple);
});
