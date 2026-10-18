import { createPixelImage, cropPixels, pixelLuminance, resizeBilinear, type PixelImage, type PixelRect } from "./pixels";

export interface PreprocessOptions {
  /** Target cap height of the text after scaling, in pixels. Tesseract reads best around 30-40px. */
  targetTextHeight?: number;
  padding?: number;
  /** Split a "514 | 40%" value into its two halves. */
  compound?: boolean;
}

function otsuThreshold(values: Float32Array): number {
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[Math.max(0, Math.min(255, Math.round(value)))]! += 1;
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += i * histogram[i]!;
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let best = { threshold: 128, variance: -1 };
  for (let t = 0; t < 256; t += 1) {
    backgroundWeight += histogram[t]!;
    if (backgroundWeight === 0) continue;
    const foregroundWeight = values.length - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += t * histogram[t]!;
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (total - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > best.variance) best = { threshold: t, variance };
  }
  return best.threshold;
}

interface Component {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  pixels: number[];
}

function connectedComponents(mask: Uint8Array, width: number, height: number): Component[] {
  const visited = new Uint8Array(mask.length);
  const components: Component[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    const component: Component = { minX: width, maxX: -1, minY: height, maxY: -1, pixels: [] };
    while (stack.length > 0) {
      const current = stack.pop()!;
      const x = current % width;
      const y = (current - x) / width;
      component.pixels.push(current);
      component.minX = Math.min(component.minX, x);
      component.maxX = Math.max(component.maxX, x);
      component.minY = Math.min(component.minY, y);
      component.maxY = Math.max(component.maxY, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
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
    components.push(component);
  }
  return components;
}

const center = (component: Component) => ({
  x: (component.minX + component.maxX) / 2,
  y: (component.minY + component.maxY) / 2,
});

/**
 * Isolates the bright stat text in a value box: thresholds luminance, keeps the
 * leftmost run of text-sized components (dropping borders and the portrait ring),
 * and returns dark text on a white, padded canvas scaled for OCR.
 *
 * Compound values ("514 | 40%") come back as two images, split at the "|" (or the
 * widest gap when the dim separator doesn't survive thresholding), so OCR never has
 * to read the separator itself.
 */
export function preprocessValueRegion(
  source: PixelImage,
  region: PixelRect,
  options: PreprocessOptions = {},
): PixelImage[] {
  const { targetTextHeight = 36, padding = 12, compound = false } = options;
  const crop = cropPixels(source, region);
  const { width, height } = crop;
  const luminance = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) luminance[y * width + x] = pixelLuminance(crop, x, y);
  }
  const threshold = Math.max(110, otsuThreshold(luminance));
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) {
    // Stat text is white, grey or gold, never green; this keeps the anvil icon out of its count.
    const red = crop.data[i * 4]!;
    const green = crop.data[i * 4 + 1]!;
    const blue = crop.data[i * 4 + 2]!;
    const isGreen = green > red * 1.15 && green > blue * 1.15;
    mask[i] = luminance[i]! > threshold && !isGreen ? 1 : 0;
  }

  const allComponents = connectedComponents(mask, width, height);
  const heightOf = (component: Component) => component.maxY - component.minY + 1;
  const widthOf = (component: Component) => component.maxX - component.minX + 1;
  const components = allComponents.filter((component) =>
    heightOf(component) >= height * 0.3 && component.pixels.length >= 4);
  const empty = () => compound ? [blankCanvas(padding), blankCanvas(padding)] : [blankCanvas(padding)];
  if (components.length === 0) return empty();

  // Digits share one cap height; "|" runs a little taller, while the portrait ring and
  // panel borders are much taller (or flatter) than the text, so they drop out here.
  const heights = components.map(heightOf).sort((a, b) => a - b);
  const textHeight = heights[Math.floor((heights.length - 1) / 2)]!;
  const glyphs = components
    .filter((component) => heightOf(component) >= textHeight * 0.6 && heightOf(component) <= textHeight * 1.45)
    .sort((a, b) => a.minX - b.minX);
  if (glyphs.length === 0) return empty();

  // Keep the leftmost horizontal run; a wide gap means we've left the number.
  // Compound values have a wider gap around the separator, so allow more there.
  const maxGap = textHeight * (compound ? 2.2 : 0.9);
  const run: Component[] = [glyphs[0]!];
  for (const glyph of glyphs.slice(1)) {
    if (glyph.minX - Math.max(...run.map((component) => component.maxX)) > maxGap) break;
    run.push(glyph);
  }

  const render = (group: Component[]) => renderComponents(
    group, allComponents, luminance, threshold, width, height, textHeight, targetTextHeight, padding,
  );
  if (!compound) return [render(run)];

  const isSeparator = (component: Component) =>
    widthOf(component) <= textHeight * 0.2 && heightOf(component) >= textHeight * 0.9;
  const separator = run.find((component, index) => index > 0 && isSeparator(component));
  let splitX: number;
  if (separator) {
    splitX = center(separator).x;
  } else {
    let widest = { gap: -1, x: Infinity };
    for (let i = 1; i < run.length; i += 1) {
      const gap = run[i]!.minX - run[i - 1]!.maxX;
      if (gap > widest.gap) widest = { gap, x: (run[i]!.minX + run[i - 1]!.maxX) / 2 };
    }
    splitX = widest.x;
  }
  const digits = run.filter((component) => component !== separator);
  const left = digits.filter((component) => center(component).x < splitX);
  const right = digits.filter((component) => center(component).x >= splitX);
  return [
    left.length > 0 ? render(left) : blankCanvas(padding),
    right.length > 0 ? render(right) : blankCanvas(padding),
  ];
}

function renderComponents(
  group: Component[],
  allComponents: Component[],
  luminance: Float32Array,
  threshold: number,
  width: number,
  height: number,
  textHeight: number,
  targetTextHeight: number,
  padding: number,
): PixelImage {
  // Pull in small marks inside the group: the decimal point and the dots of "%".
  const kept = [...group];
  const runLeft = Math.min(...group.map((c) => c.minX));
  const runRight = Math.max(...group.map((c) => c.maxX));
  const runTop = Math.min(...group.map((c) => c.minY));
  const runBottom = Math.max(...group.map((c) => c.maxY));
  for (const component of allComponents) {
    if (kept.includes(component)) continue;
    const { x, y } = center(component);
    if (x >= runLeft && x <= runRight && y >= runTop && y <= runBottom + 1) kept.push(component);
  }
  // A dim "%" can break into fragments shorter than a digit; chain on pieces that
  // sit right after the run on the same text line.
  let extendedRight = runRight;
  const trailing = allComponents
    .filter((component) => !kept.includes(component) && component.minX > runRight)
    .sort((a, b) => a.minX - b.minX);
  for (const component of trailing) {
    const { y } = center(component);
    if (component.minX - extendedRight > textHeight * 0.35) break;
    if (y < runTop || y > runBottom + 1 || component.maxY - component.minY + 1 > textHeight * 1.2) continue;
    kept.push(component);
    extendedRight = Math.max(extendedRight, component.maxX);
  }

  const keptMask = new Uint8Array(width * height);
  for (const component of kept) for (const pixel of component.pixels) keptMask[pixel] = 1;
  const left = Math.max(0, Math.min(...kept.map((c) => c.minX)) - 1);
  const right = Math.min(width - 1, Math.max(...kept.map((c) => c.maxX)) + 1);
  const top = Math.max(0, Math.min(...kept.map((c) => c.minY)) - 1);
  const bottom = Math.min(height - 1, Math.max(...kept.map((c) => c.maxY)) + 1);

  const isolated = createPixelImage(right - left + 1, bottom - top + 1);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      // Grow the kept mask by a pixel so anti-aliased edges survive the clean-up.
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy += 1) {
        for (let dx = -1; dx <= 1 && !near; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && keptMask[ny * width + nx]) near = true;
        }
      }
      // Map text luminance to darkness: background -> white, solid text -> black.
      const strength = near
        ? Math.max(0, Math.min(1, (luminance[y * width + x]! - threshold * 0.6) / (255 - threshold * 0.6)))
        : 0;
      const value = Math.round(255 * (1 - strength));
      const index = ((y - top) * isolated.width + (x - left)) * 4;
      isolated.data[index] = value;
      isolated.data[index + 1] = value;
      isolated.data[index + 2] = value;
      isolated.data[index + 3] = 255;
    }
  }

  const scale = targetTextHeight / Math.max(1, textHeight);
  const scaled = resizeBilinear(
    isolated,
    Math.max(1, Math.round(isolated.width * scale)),
    Math.max(1, Math.round(isolated.height * scale)),
  );
  const output = blankCanvas(padding, scaled.width, scaled.height);
  for (let y = 0; y < scaled.height; y += 1) {
    const start = y * scaled.width * 4;
    output.data.set(scaled.data.subarray(start, start + scaled.width * 4), ((y + padding) * output.width + padding) * 4);
  }
  return output;
}

function blankCanvas(padding: number, innerWidth = 1, innerHeight = 1): PixelImage {
  const image = createPixelImage(innerWidth + padding * 2, innerHeight + padding * 2);
  image.data.fill(255);
  return image;
}
