// Turns Before/After stat values into the styled text runs drawn on the output image.
import { parsePart } from "./diff";

export type DeltaColor =
  | { kind: "solid"; color: string }
  | { kind: "gradient"; top: string; bottom: string };

export const DELTA_PRESETS = {
  green: { kind: "solid", color: "#00ff18" },
  red: { kind: "solid", color: "#ff7373" },
  purple: { kind: "gradient", top: "#f7d7ff", bottom: "#b342e4" },
} as const satisfies Record<string, DeltaColor>;

/** A piece of text on one output line; runs without a color are values, drawn white. */
export interface TextRun {
  text: string;
  color?: DeltaColor;
}

export interface StatPair {
  before: string;
  after: string;
}

/** Stats shown as "flat | percent"; each part gets its own delta. */
const COMPOUND_STATS = new Set(["armorPenetration", "magicPenetration"]);
/** Stats that are always percentages; a value typed without "%" gets one. */
const PERCENT_STATS = new Set(["criticalStrikeChance", "omnivamp", "tenacity", "healAndShieldPower", "shard"]);
/** Stats always shown with a fixed number of decimals, delta included ("3.64 (+0.50)"). */
const FIXED_DECIMALS: Record<string, number> = { attackSpeed: 2 };

function formatNumber(value: number, decimals: number, trimZeros: boolean): string {
  const fixed = value.toFixed(decimals);
  return trimZeros && decimals > 0 ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** "2,450" -> "2450", "1.5" -> "1.50" for fixed-decimal stats; unparseable text passes through. */
export function formatValue(raw: string, fixedDecimals?: number): string {
  const parsed = parsePart(raw);
  if (!parsed) return raw.trim();
  const decimals = fixedDecimals ?? parsed.decimals;
  return `${formatNumber(parsed.value, decimals, false)}${parsed.isPercent ? "%" : ""}`;
}

/** "(+600)", "(-12%)", "(+0.50)"; undefined when unchanged or unparseable. */
export function formatDelta(before: string, after: string, fixedDecimals?: number): string | undefined {
  const from = parsePart(before);
  const to = parsePart(after);
  if (!from || !to) return undefined;
  const decimals = fixedDecimals ?? Math.max(from.decimals, to.decimals);
  const difference = Number((to.value - from.value).toFixed(decimals));
  if (difference === 0) return undefined;
  const sign = difference > 0 ? "+" : "-";
  const magnitude = formatNumber(Math.abs(difference), decimals, fixedDecimals === undefined);
  return `(${sign}${magnitude}${from.isPercent || to.isPercent ? "%" : ""})`;
}

function isZero(raw: string): boolean {
  return parsePart(raw)?.value === 0;
}

function withPercent(raw: string): string {
  const trimmed = raw.trim();
  return trimmed === "" || trimmed.endsWith("%") ? trimmed : `${trimmed}%`;
}

/**
 * Adds a missing "%" where a stat requires one: "84" -> "84%" for percent stats, and
 * "32|23" -> "32|23%" for the percent half of compound stats. Blank stays blank.
 */
export function normalizeStatInput(id: string, raw: string): string {
  const trimmed = raw.trim();
  if (PERCENT_STATS.has(id)) return withPercent(trimmed);
  if (COMPOUND_STATS.has(id) && trimmed.includes("|")) {
    const [flat = "", percent = ""] = trimmed.split("|");
    return `${flat.trim()}|${withPercent(percent)}`;
  }
  return trimmed;
}

function normalizePair(id: string, pair: StatPair): StatPair {
  return { before: normalizeStatInput(id, pair.before), after: normalizeStatInput(id, pair.after) };
}

function valueWithDelta(pair: StatPair, color: DeltaColor, fixedDecimals?: number, zero = "0"): TextRun[] {
  const runs: TextRun[] = [{ text: formatValue(pair.after || zero, fixedDecimals) }];
  const delta = formatDelta(pair.before, pair.after, fixedDecimals);
  if (delta) runs.push({ text: " " }, { text: delta, color });
  return runs;
}

const SEPARATOR: TextRun = { text: " | " };

/**
 * Builds the text runs for one output slot.
 * - Compound stats hide their "| %" half when the After % and its delta are both 0.
 * - The anvil slot is "shard | count", with shard hidden while it is 0%.
 */
export function buildSlotRuns(
  id: string,
  values: Record<string, StatPair | undefined>,
  colors: Record<string, DeltaColor | undefined>,
): TextRun[] {
  const pair = normalizePair(id, values[id] ?? { before: "", after: "" });
  const color = colors[id] ?? DELTA_PRESETS.green;

  if (COMPOUND_STATS.has(id)) {
    const [flatBefore = "", percentBefore = ""] = pair.before.split("|");
    const [flatAfter = "", percentAfter = ""] = pair.after.split("|");
    const runs = valueWithDelta({ before: flatBefore, after: flatAfter }, color);
    const percent = { before: withPercent(percentBefore), after: withPercent(percentAfter) };
    if (!(isZero(percent.after) && formatDelta(percent.before, percent.after) === undefined)) {
      runs.push(SEPARATOR, ...valueWithDelta({ before: percent.before, after: percent.after || "0%" }, color));
    }
    return runs;
  }

  if (id === "anvilCount") {
    const runs: TextRun[] = [];
    const shardPair = normalizePair("shard", values.shard ?? { before: "", after: "" });
    if (shardPair.after !== "" && !isZero(shardPair.after)) {
      runs.push(...valueWithDelta(shardPair, colors.shard ?? DELTA_PRESETS.purple), SEPARATOR);
    }
    runs.push(...valueWithDelta(pair, color));
    return runs;
  }

  return valueWithDelta(pair, color, FIXED_DECIMALS[id], PERCENT_STATS.has(id) ? "0%" : "0");
}

/** The delta text alone, for the review table's Change column. */
export function describeDelta(id: string, rawPair: StatPair): string {
  const pair = normalizePair(id, rawPair);
  if (COMPOUND_STATS.has(id)) {
    const before = pair.before.split("|");
    const after = pair.after.split("|");
    const flat = formatDelta(before[0] ?? "", after[0] ?? "");
    const percent = formatDelta(withPercent(before[1] ?? ""), withPercent(after[1] ?? ""));
    return [flat ?? "—", percent ?? "—"].join(" | ").replace(/^— \| —$/, "");
  }
  return formatDelta(pair.before, pair.after, FIXED_DECIMALS[id]) ?? "";
}
