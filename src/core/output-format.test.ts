import { describe, expect, it } from "vitest";
import { buildSlotRuns, describeDelta, DELTA_PRESETS, normalizeStatInput, type StatPair, type TextRun } from "./output-format";

const text = (runs: TextRun[]) => runs.map((run) => run.text).join("");
const line = (id: string, values: Record<string, StatPair>, colors = {}) => text(buildSlotRuns(id, values, colors));

// Expected strings come from the user's sample outputs.
describe("output formatting", () => {
  it("shows the After value, then the delta in parentheses, without thousands separators", () => {
    expect(line("health", { health: { before: "4405", after: "5005" } })).toBe("5005 (+600)");
    expect(line("health", { health: { before: "2,450", after: "2,450" } })).toBe("2450");
    expect(line("fortune", { fortune: { before: "10720", after: "15300" } })).toBe("15300 (+4580)");
    expect(line("movementSpeed", { movementSpeed: { before: "370", after: "330" } })).toBe("330 (-40)");
  });

  it("keeps two decimals on Attack Speed, including its delta", () => {
    expect(line("attackSpeed", { attackSpeed: { before: "3.14", after: "3.64" } })).toBe("3.64 (+0.50)");
    expect(line("attackSpeed", { attackSpeed: { before: "0.91", after: "0.91" } })).toBe("0.91");
    expect(line("attackSpeed", { attackSpeed: { before: "1.5", after: "1.5" } })).toBe("1.50");
  });

  it("carries % on percent values and their deltas", () => {
    expect(line("criticalStrikeChance", { criticalStrikeChance: { before: "0%", after: "84%" } })).toBe("84% (+84%)");
    expect(line("healAndShieldPower", { healAndShieldPower: { before: "12%", after: "0%" } })).toBe("0% (-12%)");
  });

  it("gives each compound part its own delta and hides a % half that is 0% and unchanged", () => {
    expect(line("armorPenetration", { armorPenetration: { before: "0|0%", after: "32|23%" } }))
      .toBe("32 (+32) | 23% (+23%)");
    expect(line("magicPenetration", { magicPenetration: { before: "30|0%", after: "34|0%" } })).toBe("34 (+4)");
    expect(line("armorPenetration", { armorPenetration: { before: "0|0%", after: "0|0%" } })).toBe("0");
    expect(line("magicPenetration", { magicPenetration: { before: "32|10%", after: "32|0%" } }))
      .toBe("32 | 0% (-10%)");
  });

  it("shows shard before the anvil count only when shard isn't 0%", () => {
    const values = (shardBefore: string, shardAfter: string) => ({
      shard: { before: shardBefore, after: shardAfter },
      anvilCount: { before: "51", after: "65" },
    });
    expect(line("anvilCount", values("100%", "124%"))).toBe("124% (+24%) | 65 (+14)");
    expect(line("anvilCount", values("100", "100"))).toBe("100% | 65 (+14)");
    expect(line("anvilCount", values("0%", "0%"))).toBe("65 (+14)");
    expect(line("anvilCount", values("", ""))).toBe("65 (+14)");
    // A shard that dropped to 0% is hidden along with its delta.
    expect(line("anvilCount", values("24%", "0%"))).toBe("65 (+14)");
  });

  it("drops a zero, unchanged anvil count next to a shard, but always shows it alone", () => {
    const values = (countBefore: string, countAfter: string, shard = "100%") => ({
      shard: { before: shard, after: shard },
      anvilCount: { before: countBefore, after: countAfter },
    });
    expect(line("anvilCount", values("0", "0"))).toBe("100%");
    expect(line("anvilCount", values("3", "0"))).toBe("100% | 0 (-3)");
    expect(line("anvilCount", values("0", "0", "0%"))).toBe("0");
  });

  it("colors shard's delta purple and other deltas green unless overridden", () => {
    const runs = buildSlotRuns("anvilCount", {
      shard: { before: "100%", after: "124%" },
      anvilCount: { before: "51", after: "65" },
    }, {});
    expect(runs.find((run) => run.text === "(+24%)")?.color).toEqual(DELTA_PRESETS.purple);
    expect(runs.find((run) => run.text === "(+14)")?.color).toEqual(DELTA_PRESETS.green);
    const red = buildSlotRuns("armor", { armor: { before: "1", after: "2" } }, { armor: DELTA_PRESETS.red });
    expect(red.find((run) => run.text === "(+1)")?.color).toEqual(DELTA_PRESETS.red);
    expect(red[0]?.color).toBeUndefined();
  });

  it("adds a missing % to percent stats, shard and the % half of compound stats", () => {
    expect(normalizeStatInput("criticalStrikeChance", "84")).toBe("84%");
    expect(normalizeStatInput("tenacity", "20%")).toBe("20%");
    expect(normalizeStatInput("shard", "124")).toBe("124%");
    expect(normalizeStatInput("armorPenetration", "32 | 23")).toBe("32|23%");
    expect(normalizeStatInput("armorPenetration", "32")).toBe("32");
    expect(normalizeStatInput("armor", "84")).toBe("84");
    expect(normalizeStatInput("omnivamp", "")).toBe("");
    expect(line("criticalStrikeChance", { criticalStrikeChance: { before: "0", after: "84" } })).toBe("84% (+84%)");
    expect(line("omnivamp", { omnivamp: { before: "", after: "" } })).toBe("0%");
    expect(line("armorPenetration", { armorPenetration: { before: "0|0", after: "32|23" } }))
      .toBe("32 (+32) | 23% (+23%)");
    expect(describeDelta("healAndShieldPower", { before: "12", after: "0" })).toBe("(-12%)");
  });

  it("describes deltas for the review table", () => {
    expect(describeDelta("attackSpeed", { before: "3.14", after: "3.64" })).toBe("(+0.50)");
    expect(describeDelta("armorPenetration", { before: "0|0%", after: "32|0%" })).toBe("(+32) | —");
    expect(describeDelta("armorPenetration", { before: "1|0%", after: "1|0%" })).toBe("");
    expect(describeDelta("shard", { before: "100", after: "124" })).toBe("(+24%)");
  });
});
