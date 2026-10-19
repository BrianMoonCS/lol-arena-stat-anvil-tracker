import type { DeltaColor, TextRun } from "./output-format";

/** One output line. x and maxWidth are fractions of image width; y and size of image height. */
export interface SlotLayout {
  id: string;
  /** Left edge of the text. */
  x: number;
  /** Vertical center of the digits. */
  y: number;
  /** Font size. */
  size: number;
  /** Lines wider than this shrink to fit. */
  maxWidth: number;
}

export interface BackgroundEntry {
  id: string;
  label: string;
  /** Path under the site root, or a blob:/data: URL for uploads. */
  image: string;
}

export interface OutputConfig {
  defaultSize: { width: number; height: number };
  layout: SlotLayout[];
  backgrounds: BackgroundEntry[];
}

export const OUTPUT_FONT_FAMILY = "Navine Output";

// Measured from the sample outputs: digits are 0.712 em tall with their center 0.356 em above the
// baseline, the black outline extends about 0.073 em past the glyph on every side, and
// neighbouring pieces sit a constant 0.265 em apart, edge to edge.
const DIGIT_CENTER_EM = 0.356;
const DIGIT_TOP_EM = 0.712;
const OUTLINE_EM = 0.147;
/** Visible gap between a value, its delta and a "|" separator. */
const PIECE_GAP_EM = 0.265;

export async function loadOutputFont(url: string): Promise<void> {
  try {
    const font = new FontFace(OUTPUT_FONT_FAMILY, `url("${url}")`, { style: "italic" });
    document.fonts.add(await font.load());
  } catch {
    // Fall back to the browser's italic sans-serif; the layout still works, the look won't match.
  }
}

function fontAt(size: number): string {
  return `italic ${size}px "${OUTPUT_FONT_FAMILY}", sans-serif`;
}

interface PlacedPiece {
  text: string;
  color?: DeltaColor;
  /** Text origin, relative to the slot's left edge. */
  offset: number;
}

/**
 * Places each piece of a line (value, delta, "|") so the visible gap between neighbouring
 * pieces is constant, matching the reference outputs; spacing by the space character instead
 * would vary with glyph shapes. Whitespace-only runs just mark where those gaps go.
 */
function placePieces(
  context: CanvasRenderingContext2D,
  runs: TextRun[],
  size: number,
): { pieces: PlacedPiece[]; width: number } {
  context.font = fontAt(size);
  const pieces: PlacedPiece[] = [];
  let inkRight: number | undefined;
  for (const run of runs) {
    const text = run.text.trim();
    if (!text) continue;
    const metrics = context.measureText(text);
    const offset = inkRight === undefined
      ? 0
      : inkRight + size * PIECE_GAP_EM + metrics.actualBoundingBoxLeft;
    pieces.push({ text, color: run.color, offset });
    inkRight = offset + metrics.actualBoundingBoxRight;
  }
  return { pieces, width: inkRight ?? 0 };
}

/** Font size in pixels after shrinking a line to fit its slot's maximum width. */
export function fittedFontSize(
  context: CanvasRenderingContext2D,
  runs: TextRun[],
  size: number,
  maxWidth: number,
): number {
  // Widths scale linearly with font size, so one measurement gives the fitted size.
  const { width } = placePieces(context, runs, size);
  return width > maxWidth ? size * (maxWidth / width) : size;
}

function deltaFill(
  context: CanvasRenderingContext2D,
  color: DeltaColor,
  baseline: number,
  size: number,
): string | CanvasGradient {
  if (color.kind === "solid") return color.color;
  const gradient = context.createLinearGradient(0, baseline - size * DIGIT_TOP_EM, 0, baseline);
  gradient.addColorStop(0, color.top);
  gradient.addColorStop(1, color.bottom);
  return gradient;
}

/** Draws the background at its own resolution, then every slot's text runs over it. */
export function renderOutput(
  canvas: HTMLCanvasElement,
  config: OutputConfig,
  backgroundImage: HTMLImageElement | undefined,
  layout: SlotLayout[],
  lines: Record<string, TextRun[]>,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;

  const width = backgroundImage?.naturalWidth || config.defaultSize.width;
  const height = backgroundImage?.naturalHeight || config.defaultSize.height;
  canvas.width = width;
  canvas.height = height;
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  if (backgroundImage) context.drawImage(backgroundImage, 0, 0, width, height);

  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.lineJoin = "round";
  for (const slot of layout) {
    const runs = lines[slot.id];
    if (!runs || runs.length === 0) continue;
    const size = fittedFontSize(context, runs, slot.size * height, slot.maxWidth * width);
    const { pieces } = placePieces(context, runs, size);
    const baseline = slot.y * height + size * DIGIT_CENTER_EM;
    const left = slot.x * width;

    // Outline every piece first so no outline paints over a neighbouring piece's fill.
    context.lineWidth = size * OUTLINE_EM;
    context.strokeStyle = "#000";
    for (const piece of pieces) context.strokeText(piece.text, left + piece.offset, baseline);
    for (const piece of pieces) {
      context.fillStyle = piece.color ? deltaFill(context, piece.color, baseline, size) : "#fff";
      context.fillText(piece.text, left + piece.offset, baseline);
    }
  }
}
