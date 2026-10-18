import { preprocessValueRegion } from "./ocr-preprocess";
import { cropPixels, pixelLuminance, type PixelImage, type PixelRect } from "./pixels";

export interface RecognizedText {
  value: string;
  confidence: number;
}

export interface ExtractedStat extends RecognizedText {
  id: string;
}

export interface PanelValueRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const VALUE_BOXES: Record<string, Omit<PanelValueRegion, "id" | "width" | "height"> & {
  width: number;
  height: number;
}> = {
  healAndShieldPower: { x: 0.64, y: 0.012, width: 0.35, height: 0.095 },
  armorPenetration: { x: 0.18, y: 0.125, width: 0.35, height: 0.095 },
  magicPenetration: { x: 0.64, y: 0.125, width: 0.35, height: 0.095 },
  omnivamp: { x: 0.64, y: 0.238, width: 0.35, height: 0.095 },
  tenacity: { x: 0.64, y: 0.352, width: 0.35, height: 0.095 },
  attackDamage: { x: 0.18, y: 0.526, width: 0.35, height: 0.095 },
  abilityPower: { x: 0.64, y: 0.526, width: 0.35, height: 0.095 },
  armor: { x: 0.18, y: 0.636, width: 0.35, height: 0.095 },
  magicResistance: { x: 0.64, y: 0.636, width: 0.35, height: 0.095 },
  attackSpeed: { x: 0.18, y: 0.752, width: 0.35, height: 0.095 },
  abilityHaste: { x: 0.64, y: 0.752, width: 0.35, height: 0.095 },
  criticalStrikeChance: { x: 0.18, y: 0.868, width: 0.35, height: 0.095 },
  movementSpeed: { x: 0.64, y: 0.868, width: 0.35, height: 0.095 },
};

export const PANEL_STAT_CELLS = [
  { id: "healAndShieldPower", row: 0, column: 1 },
  { id: "armorPenetration", row: 1, column: 0 },
  { id: "magicPenetration", row: 1, column: 1 },
  { id: "omnivamp", row: 2, column: 1 },
  { id: "tenacity", row: 3, column: 1 },
  { id: "attackDamage", row: 4, column: 0 },
  { id: "abilityPower", row: 4, column: 1 },
  { id: "armor", row: 5, column: 0 },
  { id: "magicResistance", row: 5, column: 1 },
  { id: "attackSpeed", row: 6, column: 0 },
  { id: "abilityHaste", row: 6, column: 1 },
  { id: "criticalStrikeChance", row: 7, column: 0 },
  { id: "movementSpeed", row: 7, column: 1 },
] as const;

/** Stats shown as "flat | percent"; each half is read separately and rejoined with "|". */
export const COMPOUND_STATS: ReadonlySet<string> = new Set(["armorPenetration", "magicPenetration"]);

export function getPanelValueRegions(width: number, height: number): PanelValueRegion[] {
  return PANEL_STAT_CELLS.map(({ id }) => {
    const box = VALUE_BOXES[id];
    return {
      id,
      x: Math.round(width * box.x),
      y: Math.round(height * box.y),
      width: Math.max(1, Math.round(width * box.width)),
      height: Math.max(1, Math.round(height * box.height)),
    };
  });
}

// Horizontal slice of each column where a value's first digit always sits, used to find row bands.
const ROW_PROBE_X: Record<0 | 1, { start: number; end: number }> = {
  0: { start: 0.19, end: 0.3 },
  1: { start: 0.65, end: 0.76 },
};
const PANEL_ROWS = 8;
const TEXT_LUMINANCE = 140;

interface Band {
  top: number;
  bottom: number;
}

/** Finds the vertical extent of each of the 8 stat rows in one panel column from bright text pixels. */
export function findRowBands(panel: PixelImage, column: 0 | 1): Band[] | undefined {
  const probe = ROW_PROBE_X[column];
  const left = Math.round(panel.width * probe.start);
  const right = Math.round(panel.width * probe.end);
  const isText: boolean[] = [];
  for (let y = 0; y < panel.height; y += 1) {
    let bright = 0;
    for (let x = left; x < right; x += 1) {
      if (pixelLuminance(panel, x, y) > TEXT_LUMINANCE) bright += 1;
    }
    isText.push(bright >= 2);
  }

  const bands: Band[] = [];
  for (let y = 0; y < panel.height; y += 1) {
    if (!isText[y]) continue;
    const previous = bands[bands.length - 1];
    if (previous && y - previous.bottom <= 2) previous.bottom = y;
    else bands.push({ top: y, bottom: y });
  }
  // Dividers and borders are a pixel or two tall; text rows are several percent of the panel.
  const minimumHeight = panel.height * 0.025;
  const textBands = bands.filter((band) => band.bottom - band.top + 1 >= minimumHeight);
  return textBands.length === PANEL_ROWS ? textBands : undefined;
}

/**
 * Value regions with X from the annotated boxes and Y snapped to the detected text rows,
 * so small shifts in the panel crop don't clip the digits. Falls back to the fixed boxes.
 */
export function locatePanelValueRegions(panel: PixelImage): PanelValueRegion[] {
  const fixed = getPanelValueRegions(panel.width, panel.height);
  const bandsByColumn = { 0: findRowBands(panel, 0), 1: findRowBands(panel, 1) } as const;
  return PANEL_STAT_CELLS.map(({ id, row, column }, index) => {
    const region = fixed[index]!;
    const band = bandsByColumn[column]?.[row];
    if (!band) return region;
    const bandHeight = band.bottom - band.top + 1;
    const padding = Math.max(2, Math.round(bandHeight * 0.3));
    const top = Math.max(0, band.top - padding);
    const bottom = Math.min(panel.height - 1, band.bottom + padding);
    return { id, x: region.x, width: region.width, y: top, height: bottom - top + 1 };
  });
}

export function normalizeOcrText(value: string): string {
  return value
    .replace(/[\s,]/g, "")
    .replace(/[^\d.%|+-]/g, "");
}

export function parseAnvilCount(
  reading: RecognizedText,
  minimumConfidence = 0.55,
): RecognizedText | undefined {
  const value = reading.value.replace(/\s/g, "");
  if (!/^\d{1,3}$/.test(value) || reading.confidence < minimumConfidence) {
    return undefined;
  }
  return { value, confidence: reading.confidence };
}

/** Characters in the health bar text, e.g. "2870 / 3160". */
export const HEALTH_CHARACTERS = "0123456789/";

/**
 * Parses health bar text into max health, the stat being tracked (current health drops
 * with damage). Rejects anything that isn't exactly "current / max" with current <= max.
 */
export function parseHealth(reading: RecognizedText): RecognizedText | undefined {
  const match = /^(\d{1,5})\/(\d{1,5})$/.exec(reading.value.replace(/\s/g, ""));
  if (!match || Number(match[1]) > Number(match[2])) return undefined;
  return { value: match[2]!, confidence: reading.confidence };
}

export type PixelRecognizer = (image: PixelImage) => Promise<RecognizedText>;

/** Reads max health from the health bar crop. `recognize` must allow HEALTH_CHARACTERS. */
export async function readHealth(
  source: PixelImage,
  region: PixelRect,
  recognize: PixelRecognizer,
): Promise<RecognizedText | undefined> {
  const [text] = preprocessValueRegion(source, region, { wordGap: 2.5, textSignal: "white" });
  return parseHealth(await recognize(text!));
}

/** Reads one value box: isolates its text, reads each part, and rejoins compound halves with "|". */
export async function readValueRegion(
  source: PixelImage,
  region: PixelRect,
  recognize: PixelRecognizer,
  compound = false,
): Promise<RecognizedText> {
  const parts = preprocessValueRegion(source, region, { compound });
  const readings: RecognizedText[] = [];
  // One Tesseract worker handles one image at a time, so read the parts in order.
  for (const part of parts) readings.push(await recognize(part));
  return {
    value: readings.map((reading) => normalizeOcrText(reading.value)).join("|"),
    confidence: Math.max(0, Math.min(1, ...readings.map((reading) => reading.confidence))),
  };
}

/** Reads all 13 tracked stats from a screenshot, given the stat panel's pixel rectangle. */
export async function extractPanelStats(
  image: PixelImage,
  panelRect: PixelRect,
  recognize: PixelRecognizer,
): Promise<ExtractedStat[]> {
  const panel = cropPixels(image, panelRect);
  const results: ExtractedStat[] = [];
  for (const region of locatePanelValueRegions(panel)) {
    const reading = await readValueRegion(panel, region, recognize, COMPOUND_STATS.has(region.id));
    results.push({ id: region.id, ...reading });
  }
  return results;
}
