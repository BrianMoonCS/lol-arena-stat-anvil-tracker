// Reads stat values back off a previously generated stat sheet (this app's or the Resolve
// template's: same layout, Navine text with a black outline, deltas in color). Text is read by
// matching glyph shapes against templates of the output font, which OCR engines misread (the
// font's slashed zero reads as "8").
import { GLYPH_GRID, NAVINE_GLYPHS } from "./navine-glyphs";
import { normalizeStatInput } from "./output-format";
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

interface Mask {
  mask: Uint8Array;
  width: number;
  height: number;
}

/** White fill of the value text in `region`; deltas are colored and the outline is black. */
function fillMask(image: PixelImage, region: PixelRect): Mask {
  const left = Math.max(0, Math.round(region.x));
  const top = Math.max(0, Math.round(region.y));
  const width = Math.max(0, Math.min(image.width, Math.round(region.x + region.width)) - left);
  const height = Math.max(0, Math.min(image.height, Math.round(region.y + region.height)) - top);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = ((top + y) * image.width + left + x) * 4;
      const white = image.data[index + 3]! >= 200 &&
        Math.min(image.data[index]!, image.data[index + 1]!, image.data[index + 2]!) >= 170;
      mask[y * width + x] = white ? 1 : 0;
    }
  }
  return { mask, width, height };
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

/** Joins pieces of one character, such as the two circles and the slash of "%". */
function mergeOverlapping(glyphs: Glyph[]): Glyph[] {
  const merged: Glyph[] = [];
  for (const glyph of [...glyphs].sort((a, b) => a.minX - b.minX)) {
    const previous = merged[merged.length - 1];
    if (previous) {
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

/** Reads the white value text in `region` glyph by glyph. */
function readValueText(image: PixelImage, region: PixelRect): string {
  const mask = fillMask(image, region);
  const glyphs = mergeOverlapping(findGlyphs(mask).filter((glyph) => glyph.pixels.length >= 6));
  if (glyphs.length === 0) return "";
  const heights = glyphs.map((glyph) => glyph.maxY - glyph.minY + 1);
  const tallest = Math.max(...heights);
  // In the output font, digits and "%" are ~0.71 em tall, "." is tiny, and "|" is 0.95 em:
  // a third taller than the digits. (Its italic lean makes it nearly as wide as "1".)
  const digitHeight = Math.min(...heights.filter((h) => h >= tallest * 0.6));
  return glyphs.map((glyph) => {
    const glyphHeight = glyph.maxY - glyph.minY + 1;
    if (glyphHeight < digitHeight * 0.4) return ".";
    if (glyphHeight > digitHeight * 1.15) return "|";
    return matchTemplate(glyph, mask.width);
  }).join("");
}

/**
 * Reads the After values shown for `ids` on a stat sheet. Values come back in the review
 * table's form: a compound stat whose "| %" half was hidden reads as "<flat>|0%".
 */
export function readOutputValues(
  image: PixelImage,
  layout: SlotLayout[],
  cardScale: number,
  ids: readonly string[] = TOP_PANEL_STATS,
): Record<string, string> {
  const card = findOutputCard(image, cardScale);
  const values: Record<string, string> = {};
  for (const id of ids) {
    const slot = layout.find((candidate) => candidate.id === id);
    if (!slot) continue;
    const size = slot.size * card.height;
    let value = readValueText(image, {
      x: card.x + slot.x * card.width,
      y: card.y + slot.y * card.height - size * 0.6,
      width: slot.maxWidth * card.width,
      height: size * 1.2,
    });
    if (value === "") continue;
    if (COMPOUND_STATS.has(id) && !value.includes("|")) value = `${value}|0%`;
    values[id] = normalizeStatInput(id, value);
  }
  return values;
}
