// Reads stat values back off a previously generated stat sheet (this app's or the Resolve
// template's: same layout, Navine text with a black outline, deltas in color). Text is read by
// matching glyph shapes against templates of the output font, which OCR engines misread (the
// font's slashed zero reads as "8").
import { GLYPH_GRID, NAVINE_GLYPHS } from "./navine-glyphs";
import { parsePart } from "./diff";
import { DELTA_PRESETS, normalizeStatInput, type DeltaColor } from "./output-format";
import type { PixelImage, PixelRect } from "./pixels";
import type { SlotLayout } from "./render";

/** The stats a collapsed panel hides: the top half of the in-game stat panel. */
export const TOP_PANEL_STATS = [
  "healAndShieldPower",
  "armorPenetration",
  "magicPenetration",
  "omnivamp",
  "tenacity",
] as const;

/** What a collapsed Before takes from the previous output: the hidden stats, Fortune and Shard. */
export const PREVIOUS_OUTPUT_STATS = [...TOP_PANEL_STATS, "fortune", "shard"] as const;

const COMPOUND_STATS = new Set(["armorPenetration", "magicPenetration"]);

/**
 * Where the background card sits in an output image: centered at cardScale when the margin
 * around it is empty (transparent or black), otherwise the whole image.
 */
export function findOutputCard(image: PixelImage, cardScale: number): PixelRect {
  const cardWidth = Math.round(image.width * cardScale);
  const cardHeight = Math.round(image.height * cardScale);
  const marginX = Math.round((image.width - cardWidth) / 2);
  const marginY = Math.round((image.height - cardHeight) / 2);
  let empty = 0;
  let sampled = 0;
  for (let y = 0; y < image.height; y += 4) {
    for (let x = 0; x < image.width; x += 4) {
      const inMargin = x < marginX - 2 || x >= image.width - marginX + 2 || y < marginY - 2 || y >= image.height - marginY + 2;
      if (!inMargin) continue;
      const index = (y * image.width + x) * 4;
      const alpha = image.data[index + 3]!;
      const brightest = Math.max(image.data[index]!, image.data[index + 1]!, image.data[index + 2]!);
      if (alpha < 16 || brightest < 24) empty += 1;
      sampled += 1;
    }
  }
  return sampled > 0 && empty / sampled > 0.95
    ? { x: marginX, y: marginY, width: cardWidth, height: cardHeight }
    : { x: 0, y: 0, width: image.width, height: image.height };
}

interface Glyph {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  pixels: number[];
}

/** What a pixel of an output sheet's text is: a white value, a delta in one of the presets, or neither. */
type InkClass = "white" | "green" | "red" | "purple";
const INK_CLASSES: InkClass[] = ["white", "green", "red", "purple"];

function inkClassOf(red: number, green: number, blue: number, alpha: number): InkClass | undefined {
  if (alpha < 200) return undefined;
  const low = Math.min(red, green, blue);
  const high = Math.max(red, green, blue);
  // Only neutral white is value text: the top of shard's purple gradient is nearly white too.
  if (low >= 170 && high - low <= 30) return "white";
  if (green >= 170 && red <= 120 && blue <= 150 && green - red >= 80) return "green";
  if (red >= 200 && green >= 70 && green <= 170 && blue >= 70 && blue <= 170 && red - green >= 70 && Math.abs(green - blue) <= 40) {
    return "red";
  }
  if (blue >= 170 && red >= 120 && green <= red - 20 && green <= blue - 30) return "purple";
  return undefined;
}

interface Mask {
  mask: Uint8Array;
  width: number;
  height: number;
}

/** One mask per ink class over `region`. */
function inkMasks(image: PixelImage, region: PixelRect): Record<InkClass, Mask> {
  const left = Math.max(0, Math.round(region.x));
  const top = Math.max(0, Math.round(region.y));
  const width = Math.max(0, Math.min(image.width, Math.round(region.x + region.width)) - left);
  const height = Math.max(0, Math.min(image.height, Math.round(region.y + region.height)) - top);
  const masks = Object.fromEntries(
    INK_CLASSES.map((ink) => [ink, { mask: new Uint8Array(width * height), width, height }]),
  ) as Record<InkClass, Mask>;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = ((top + y) * image.width + left + x) * 4;
      const ink = inkClassOf(image.data[index]!, image.data[index + 1]!, image.data[index + 2]!, image.data[index + 3]!);
      if (ink) masks[ink].mask[y * width + x] = 1;
    }
  }
  return masks;
}

function findGlyphs({ mask, width, height }: Mask): Glyph[] {
  const visited = new Uint8Array(mask.length);
  const found: Glyph[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    const glyph: Glyph = { minX: width, maxX: -1, minY: height, maxY: -1, pixels: [] };
    while (stack.length > 0) {
      const current = stack.pop()!;
      const x = current % width;
      const y = (current - x) / width;
      glyph.pixels.push(current);
      glyph.minX = Math.min(glyph.minX, x);
      glyph.maxX = Math.max(glyph.maxX, x);
      glyph.minY = Math.min(glyph.minY, y);
      glyph.maxY = Math.max(glyph.maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    found.push(glyph);
  }
  return found;
}

/**
 * Joins pieces of one character, such as the two circles and the slash of "%". Tall glyphs
 * (brackets and "|") are never joined: a "+" leaning under an italic "(" stays separate.
 */
function mergeOverlapping(glyphs: Glyph[], tallHeight: number): Glyph[] {
  const isTall = (glyph: Glyph) => glyph.maxY - glyph.minY + 1 > tallHeight;
  const merged: Glyph[] = [];
  for (const glyph of [...glyphs].sort((a, b) => a.minX - b.minX)) {
    const previous = merged[merged.length - 1];
    if (previous && !isTall(previous) && !isTall(glyph)) {
      const overlap = Math.min(previous.maxX, glyph.maxX) - Math.max(previous.minX, glyph.minX) + 1;
      const narrower = Math.min(previous.maxX - previous.minX, glyph.maxX - glyph.minX) + 1;
      if (overlap > narrower * 0.5) {
        previous.minX = Math.min(previous.minX, glyph.minX);
        previous.maxX = Math.max(previous.maxX, glyph.maxX);
        previous.minY = Math.min(previous.minY, glyph.minY);
        previous.maxY = Math.max(previous.maxY, glyph.maxY);
        previous.pixels.push(...glyph.pixels);
        continue;
      }
    }
    merged.push({ ...glyph, pixels: [...glyph.pixels] });
  }
  return merged;
}

/**
 * Glyphs of one ink, found on the mask shrunk by a pixel so neighbours touching through their
 * soft edges (like "(" and "+") separate; each glyph then gets its edge pixels back.
 */
function separatedGlyphs({ mask, width, height }: Mask): Glyph[] {
  const eroded = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (mask[index] && mask[index - 1] && mask[index + 1] && mask[index - width] && mask[index + width]) eroded[index] = 1;
    }
  }
  const cores = findGlyphs({ mask: eroded, width, height });
  const label = new Int32Array(mask.length).fill(-1);
  cores.forEach((glyph, index) => { for (const pixel of glyph.pixels) label[pixel] = index; });
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || label[index] >= 0) continue;
    const x = index % width;
    const y = (index - x) / width;
    search: for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const owner = label[ny * width + nx]!;
        if (owner < 0 || eroded[ny * width + nx] === 0) continue;
        const glyph = cores[owner]!;
        glyph.pixels.push(index);
        glyph.minX = Math.min(glyph.minX, x);
        glyph.maxX = Math.max(glyph.maxX, x);
        glyph.minY = Math.min(glyph.minY, y);
        glyph.maxY = Math.max(glyph.maxY, y);
        break search;
      }
    }
  }
  return cores;
}

/** The template character whose shape best matches `glyph`, compared on a common grid. */
function matchTemplate(glyph: Glyph, maskWidth: number): string {
  const width = glyph.maxX - glyph.minX + 1;
  const height = glyph.maxY - glyph.minY + 1;
  const ink = new Set(glyph.pixels);
  let best = { character: "", score: -Infinity };
  for (const [character, template] of Object.entries(NAVINE_GLYPHS)) {
    let both = 0;
    let either = 0;
    for (let gy = 0; gy < GLYPH_GRID.height; gy += 1) {
      for (let gx = 0; gx < GLYPH_GRID.width; gx += 1) {
        const x = glyph.minX + Math.min(width - 1, Math.floor(((gx + 0.5) / GLYPH_GRID.width) * width));
        const y = glyph.minY + Math.min(height - 1, Math.floor(((gy + 0.5) / GLYPH_GRID.height) * height));
        const sample = ink.has(y * maskWidth + x);
        const expected = template.rows[gy]![gx] === "#";
        if (sample && expected) both += 1;
        if (sample || expected) either += 1;
      }
    }
    // Shape overlap, minus a penalty when the proportions differ (e.g. "%" is much wider).
    const score = (either > 0 ? both / either : 0) - 0.5 * Math.abs(Math.log(width / height / template.aspect));
    if (score > best.score) best = { character, score };
  }
  return best.character;
}

/** A run of same-colored text on one output line, e.g. a value or a delta. */
interface TextPiece {
  ink: InkClass;
  text: string;
  /** Deltas are drawn in parentheses; a colored run without one is a stray speck, not text. */
  parenthesized?: boolean;
}

/**
 * Reads one output line as colored pieces, left to right: white values ("5005", "| 23%") and
 * colored deltas ("(+600)"). Characters are told apart by size first (in the output font,
 * digits and "%" are ~0.71 em tall, "+" ~0.41, "-" and "." are tiny, and "(", ")" and "|" are
 * ~1.3x the digits), then digits and "%" by shape.
 */
function readLinePieces(image: PixelImage, region: PixelRect): TextPiece[] {
  const masks = inkMasks(image, region);
  const raw = INK_CLASSES.map((ink) => ({
    ink,
    glyphs: separatedGlyphs(masks[ink]).filter((glyph) => glyph.pixels.length >= 6),
  }));
  const rawHeights = raw.flatMap(({ glyphs }) => glyphs.map((glyph) => glyph.maxY - glyph.minY + 1));
  if (rawHeights.length === 0) return [];
  // Digits (and the slash of "%") set the scale; brackets and "|" are ~1.3x taller.
  const digitHeight = Math.min(...rawHeights.filter((h) => h >= Math.max(...rawHeights) * 0.6));
  const glyphs = raw.flatMap(({ ink, glyphs }) =>
    mergeOverlapping(glyphs, digitHeight * 1.15).map((glyph) => ({ ink, glyph })),
  ).sort((a, b) => a.glyph.minX - b.glyph.minX);
  const width = masks.white.width;

  const pieces: TextPiece[] = [];
  for (const { ink, glyph } of glyphs) {
    const glyphWidth = glyph.maxX - glyph.minX + 1;
    const glyphHeight = glyph.maxY - glyph.minY + 1;
    let character: string;
    const tall = glyphHeight > digitHeight * 1.15;
    if (tall) character = ink === "white" ? "|" : "";
    else if (glyphHeight < digitHeight * 0.3) character = glyphWidth / glyphHeight > 2 ? "-" : ".";
    else if (glyphHeight < digitHeight * 0.8) character = "+";
    else character = matchTemplate(glyph, width);
    const last = pieces[pieces.length - 1];
    // A "|" starts a new value piece; otherwise a change of color starts a new piece.
    if (last && last.ink === ink && character !== "|") {
      last.text += character;
      if (tall) last.parenthesized = true;
    } else {
      pieces.push({ ink, text: character, parenthesized: tall });
    }
  }
  // Drop stray colored specks, then rejoin value text they had split.
  const kept: TextPiece[] = [];
  for (const piece of pieces) {
    if (piece.ink !== "white" && !piece.parenthesized) continue;
    const last = kept[kept.length - 1];
    if (last && last.ink === "white" && piece.ink === "white" && !piece.text.startsWith("|")) last.text += piece.text;
    else kept.push(piece);
  }
  return kept;
}

const PRESET_BY_INK: Record<Exclude<InkClass, "white">, DeltaColor> = {
  green: DELTA_PRESETS.green,
  red: DELTA_PRESETS.red,
  purple: DELTA_PRESETS.purple,
};

/** Before value from an After value and its delta text ("+600", "-0.50", "+23%"). */
function beforeFrom(after: string, delta: string | undefined): string {
  if (!delta) return after;
  const parsedAfter = parsePart(after);
  const parsedDelta = parsePart(delta.replace(/^\+/, ""));
  if (!parsedAfter || !parsedDelta) return after;
  const decimals = Math.max(parsedAfter.decimals, parsedDelta.decimals);
  const value = Number((parsedAfter.value - parsedDelta.value).toFixed(decimals));
  return `${value.toFixed(decimals)}${parsedAfter.isPercent || parsedDelta.isPercent ? "%" : ""}`;
}

/** One value part of a line and the delta drawn after it. */
interface LinePart {
  after: string;
  delta?: string;
  ink?: InkClass;
}

function lineParts(pieces: TextPiece[]): LinePart[] {
  const parts: LinePart[] = [];
  for (const piece of pieces) {
    if (piece.ink === "white") {
      parts.push({ after: piece.text.replace(/^\|/, "") });
    } else if (parts.length > 0) {
      const part = parts[parts.length - 1]!;
      part.delta = piece.text;
      part.ink = piece.ink;
    }
  }
  return parts.filter((part) => part.after !== "");
}

export interface SheetData {
  /** Before/After per stat, in the review table's form. */
  values: Record<string, { before: string; after: string }>;
  /** Delta colors that were found (stats without a delta keep the default). */
  colors: Record<string, DeltaColor>;
}

/**
 * Reads a whole stat sheet: each line's After value, its delta (giving the Before value) and
 * the delta's color. Compound stats come back as "<flat>|<percent>%" (a hidden "| %" half was
 * 0%), and the anvil line gives both Shard and Anvil Count.
 */
export function readOutputSheet(image: PixelImage, layout: SlotLayout[], cardScale: number): SheetData {
  const card = findOutputCard(image, cardScale);
  const values: SheetData["values"] = {};
  const colors: SheetData["colors"] = {};
  const record = (id: string, part: LinePart | undefined, fallback: string) => {
    const after = normalizeStatInput(id, part?.after ?? fallback);
    values[id] = { after, before: normalizeStatInput(id, beforeFrom(after, part?.delta)) };
    if (part?.ink && part.ink !== "white") colors[id] = PRESET_BY_INK[part.ink];
  };

  for (const slot of layout) {
    const size = slot.size * card.height;
    const parts = lineParts(readLinePieces(image, {
      x: card.x + slot.x * card.width,
      y: card.y + slot.y * card.height - size * 0.6,
      width: slot.maxWidth * card.width,
      height: size * 1.2,
    }));
    if (parts.length === 0) continue;

    if (slot.id === "anvilCount") {
      // "<shard>% | <count>", or just "<count>" while shard is 0%.
      const hasShard = parts.length > 1;
      record("shard", hasShard ? parts[0] : undefined, "0%");
      record("anvilCount", parts[hasShard ? 1 : 0], "0");
    } else if (COMPOUND_STATS.has(slot.id)) {
      const [flat, percent] = parts;
      const flatAfter = flat!.after;
      const percentAfter = percent?.after ?? "0%";
      const before = `${beforeFrom(flatAfter, flat!.delta)}|${beforeFrom(percentAfter, percent?.delta)}`;
      values[slot.id] = {
        after: normalizeStatInput(slot.id, `${flatAfter}|${percentAfter}`),
        before: normalizeStatInput(slot.id, before),
      };
      const ink = flat!.ink ?? percent?.ink;
      if (ink && ink !== "white") colors[slot.id] = PRESET_BY_INK[ink];
    } else {
      record(slot.id, parts[0], "");
    }
  }
  return { values, colors };
}

/**
 * Reads the After values shown for `ids` on a stat sheet. Values come back in the review
 * table's form: a compound stat whose "| %" half was hidden reads as "<flat>|0%".
 */
export function readOutputValues(
  image: PixelImage,
  layout: SlotLayout[],
  cardScale: number,
  ids: readonly string[] = PREVIOUS_OUTPUT_STATS,
): Record<string, string> {
  const { values } = readOutputSheet(image, layout, cardScale);
  return Object.fromEntries(ids.filter((id) => values[id]?.after).map((id) => [id, values[id]!.after]));
}
