// Reads stats back off the user's sample outputs (made with their Resolve template, scaled to
// 1920x1080 here) and compares them with the values shown on them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readOutputValues } from "../src/core/output-reader";
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
