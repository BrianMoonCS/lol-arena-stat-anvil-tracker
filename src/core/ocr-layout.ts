import { preprocessValueRegion } from "./ocr-preprocess";
import { cropPixels, pixelLuminance, type PixelImage, type PixelRect } from "./pixels";

export interface RecognizedText {
  value: string;
  confidence: number;
}

export interface ExtractedStat extends RecognizedText {
  id: string;
  /** False when the screenshot doesn't show this stat (the panel's top half is collapsed). */
  visible: boolean;
}

export interface PanelValueRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Right-column boxes stop at 94% of the panel width so the panel's light right border stays out.
const VALUE_BOXES: Record<string, Omit<PanelValueRegion, "id" | "width" | "height"> & {
  width: number;
  height: number;
}> = {
  healAndShieldPower: { x: 0.64, y: 0.012, width: 0.3, height: 0.095 },
  armorPenetration: { x: 0.18, y: 0.125, width: 0.35, height: 0.095 },
  magicPenetration: { x: 0.64, y: 0.125, width: 0.3, height: 0.095 },
  omnivamp: { x: 0.64, y: 0.238, width: 0.3, height: 0.095 },
  tenacity: { x: 0.64, y: 0.352, width: 0.3, height: 0.095 },
  attackDamage: { x: 0.18, y: 0.526, width: 0.35, height: 0.095 },
  abilityPower: { x: 0.64, y: 0.526, width: 0.3, height: 0.095 },
  armor: { x: 0.18, y: 0.636, width: 0.35, height: 0.095 },
  magicResistance: { x: 0.64, y: 0.636, width: 0.3, height: 0.095 },
  attackSpeed: { x: 0.18, y: 0.752, width: 0.35, height: 0.095 },
  abilityHaste: { x: 0.64, y: 0.752, width: 0.3, height: 0.095 },
  criticalStrikeChance: { x: 0.18, y: 0.868, width: 0.35, height: 0.095 },
  movementSpeed: { x: 0.64, y: 0.868, width: 0.3, height: 0.095 },
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

// Horizontal slice of each column where a row's value starts, used to find text rows.
const ROW_PROBE_X = { start: 0.19, end: 0.3 };
const RIGHT_ROW_PROBE_X = { start: 0.65, end: 0.76 };
const TEXT_LUMINANCE = 140;
/**
 * Row centers above the bottom row, in row pitches. The bottom block (rows 4-7) is always on
 * screen; the top block (rows 0-3) sits above a divider 1.5 pitches tall and can be collapsed.
 */
const ROW_OFFSETS_IN_PITCH = [7.47, 6.47, 5.47, 4.47, 3, 2, 1, 0];
/** Panel width (left border to right edge) in row pitches, measured on the example screenshots. */
const PANEL_WIDTH_IN_PITCH = 6.75;
/** Bottom border below the bottom row's center, and border-to-border panel heights, in pitches. */
const BOTTOM_BORDER_IN_PITCH = 0.81;
const FULL_HEIGHT_IN_PITCH = 9.07;
const COLLAPSED_HEIGHT_IN_PITCH = 4.52;

interface Band {
  top: number;
  bottom: number;
}

export interface PanelRow {
  center: number;
  height: number;
}

export interface PanelLocation {
  left: number;
  width: number;
  pitch: number;
  /** Rows 0-7 per column (left, right); the top four are undefined when the panel is collapsed. */
  rows: [Array<PanelRow | undefined>, Array<PanelRow | undefined>];
  /** The panel from its top border to its bottom border, clipped to the image. */
  rect: PixelRect;
  collapsed: boolean;
}

function textBands(image: PixelImage, left: number, right: number, top: number, bottom: number): Band[] {
  const bands: Band[] = [];
  for (let y = Math.max(0, top); y < Math.min(image.height, bottom); y += 1) {
    let bright = 0;
    for (let x = Math.max(0, left); x < Math.min(image.width, right); x += 1) {
      if (pixelLuminance(image, x, y) > TEXT_LUMINANCE) bright += 1;
    }
    if (bright < 2) continue;
    const previous = bands[bands.length - 1];
    if (previous && y - previous.bottom <= 2) previous.bottom = y;
    else bands.push({ top: y, bottom: y });
  }
  // Borders and dividers are a pixel or two tall; text rows are several pixels.
  return bands.filter((band) => band.bottom - band.top >= 3);
}

const centerOf = (band: Band) => (band.top + band.bottom) / 2;

/** The lowest run of four evenly spaced text rows: the panel's always-visible bottom block. */
function findBottomBlock(bands: Band[]): { rows: Band[]; pitch: number } | undefined {
  for (let start = bands.length - 4; start >= 0; start -= 1) {
    const rows = bands.slice(start, start + 4);
    const gaps = rows.slice(1).map((band, index) => centerOf(band) - centerOf(rows[index]!));
    const pitch = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const tallest = Math.max(...rows.map((band) => band.bottom - band.top + 1));
    if (gaps.every((gap) => Math.abs(gap - pitch) <= pitch * 0.15) && pitch > tallest * 1.5) {
      return { rows, pitch };
    }
  }
  return undefined;
}

/** Strongest light/dark change between rows, scanned from `from` toward `to`, across the panel. */
function findBorder(image: PixelImage, left: number, right: number, from: number, to: number): number | undefined {
  const step = from <= to ? 1 : -1;
  let best: { y: number; strength: number } | undefined;
  for (let y = from; step > 0 ? y <= to : y >= to; y += step) {
    if (y < 1 || y >= image.height) continue;
    let difference = 0;
    let sampled = 0;
    for (let x = Math.max(0, left); x < Math.min(image.width, right); x += 2) {
      difference += Math.abs(pixelLuminance(image, x, y) - pixelLuminance(image, x, y - 1));
      sampled += 1;
    }
    const strength = sampled > 0 ? difference / sampled : 0;
    if (!best || strength > best.strength) best = { y, strength };
  }
  // A weak "edge" is just texture; a real border stands out clearly.
  return best && best.strength >= 12 ? best.y : undefined;
}

/**
 * Finds the stat panel's rows inside `region` from the text itself, so it works when the panel's
 * borders are cut off by the screenshot or the top half of the panel is collapsed. The region's
 * left edge is taken as the panel's left border; scale comes from the row spacing.
 */
export function locatePanel(image: PixelImage, region: PixelRect): PanelLocation | undefined {
  const top = region.y;
  const bottom = region.y + region.height;
  let width = region.width;
  let block: { rows: Band[]; pitch: number } | undefined;
  let bands: Band[] = [];
  // The region's width may be off (the panel's right edge touches the portrait ring), so locate
  // once with it, derive the width from the row spacing, then locate again with that width.
  for (let pass = 0; pass < 2; pass += 1) {
    bands = textBands(
      image,
      Math.round(region.x + width * ROW_PROBE_X.start),
      Math.round(region.x + width * ROW_PROBE_X.end),
      top,
      bottom,
    );
    block = findBottomBlock(bands);
    if (!block) return undefined;
    width = block.pitch * PANEL_WIDTH_IN_PITCH;
  }
  const { rows: bottomRows, pitch } = block!;
  const toRow = (band: Band): PanelRow => ({ center: centerOf(band), height: band.bottom - band.top + 1 });
  const bottomCenter = centerOf(bottomRows[3]!);

  // The top block counts as shown when at least three of its rows sit where the layout puts them.
  const topRows = [0, 1, 2, 3].map((row) => {
    const expected = bottomCenter - ROW_OFFSETS_IN_PITCH[row]! * pitch;
    return bands.find((band) => Math.abs(centerOf(band) - expected) <= pitch * 0.25);
  });
  const collapsed = topRows.filter(Boolean).length < 3;
  const typicalHeight = bottomRows[0]!.bottom - bottomRows[0]!.top + 1;
  const rows: Array<PanelRow | undefined> = [
    ...topRows.map((band, row) => {
      if (collapsed) return undefined;
      // A shown block with one faint row still gets that row, at its layout position.
      return band
        ? toRow(band)
        : { center: bottomCenter - ROW_OFFSETS_IN_PITCH[row]! * pitch, height: typicalHeight };
    }),
    ...bottomRows.map(toRow),
  ];

  // The right column's text can sit a pixel off the left column's, so snap it separately.
  const left = region.x;
  const right = Math.round(region.x + width);
  const rightBands = textBands(
    image,
    Math.round(left + width * RIGHT_ROW_PROBE_X.start),
    Math.round(left + width * RIGHT_ROW_PROBE_X.end),
    top,
    bottom,
  );
  const rightRows = rows.map((row) => {
    if (!row) return undefined;
    const band = rightBands.find((candidate) => Math.abs(centerOf(candidate) - row.center) <= pitch * 0.3);
    return band ? toRow(band) : row;
  });

  // Anchor at the bottom-left corner: the bottom border is found near where the layout puts it
  // (or computed when the screenshot cuts it off), and the top follows from the panel's known
  // height. Searching for the top edge instead is easily fooled by scene or overlapping windows.
  const expectedBottom = bottomCenter + pitch * BOTTOM_BORDER_IN_PITCH;
  const foundBottom = findBorder(image, left, right, Math.round(bottomCenter + pitch * 0.45), Math.round(bottomCenter + pitch * 1.1));
  const bottomBorder = foundBottom !== undefined && Math.abs(foundBottom - expectedBottom) <= pitch * 0.25
    ? foundBottom
    : expectedBottom;
  const panelHeight = pitch * (collapsed ? COLLAPSED_HEIGHT_IN_PITCH : FULL_HEIGHT_IN_PITCH);
  const rectTop = Math.max(0, Math.round(bottomBorder - panelHeight));
  const rectBottom = Math.min(image.height, Math.round(bottomBorder));
  return {
    left,
    width,
    pitch,
    rows: [rows, rightRows],
    rect: { x: left, y: rectTop, width: Math.min(image.width - left, right - left), height: rectBottom - rectTop },
    collapsed,
  };
}

/** Value boxes in image pixels, for the rows the screenshot shows. */
export function panelValueRegions(location: PanelLocation): PanelValueRegion[] {
  const regions: PanelValueRegion[] = [];
  for (const { id, row, column } of PANEL_STAT_CELLS) {
    const panelRow = location.rows[column][row];
    if (!panelRow) continue;
    const box = VALUE_BOXES[id]!;
    const padding = Math.max(2, Math.round(panelRow.height * 0.3));
    const top = Math.round(panelRow.center - panelRow.height / 2) - padding;
    regions.push({
      id,
      x: Math.round(location.left + box.x * location.width),
      y: top,
      width: Math.max(1, Math.round(box.width * location.width)),
      height: panelRow.height + padding * 2,
    });
  }
  return regions;
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

/**
 * Reads all 13 tracked stats from a screenshot. `region` is where to look for the stat panel
 * (the detected or user-adjusted crop). Stats the screenshot doesn't show come back empty
 * with visible: false. If no panel rows are found, falls back to the fixed annotated boxes.
 */
export async function extractPanelStats(
  image: PixelImage,
  region: PixelRect,
  recognize: PixelRecognizer,
): Promise<ExtractedStat[]> {
  const location = locatePanel(image, region);
  const regions = location
    ? panelValueRegions(location)
    : getPanelValueRegions(region.width, region.height)
      .map((box) => ({ ...box, x: box.x + region.x, y: box.y + region.y }));
  const results: ExtractedStat[] = [];
  for (const { id } of PANEL_STAT_CELLS) {
    const box = regions.find((candidate) => candidate.id === id);
    if (!box) {
      results.push({ id, value: "", confidence: 0, visible: false });
      continue;
    }
    const reading = await readValueRegion(image, box, recognize, COMPOUND_STATS.has(id));
    results.push({ id, ...reading, visible: true });
  }
  return results;
}
