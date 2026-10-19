import { clampCropRect, initialCropRect, initialHealthCropRect, type CropRect } from "./crop";
import { locatePanel } from "./ocr-layout";

export interface CropDetection {
  rect: CropRect;
  confidence: number;
  method: "left-panel" | "collapsed-panel" | "bottom-default" | "panel-image" | "health-bar" | "health-default" | "anvil-counter" | "anvil-default";
  edges?: StatWindowEdges;
}

export interface StatWindowEdges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface AnvilCounterDetection extends CropDetection {
  valueRect: CropRect;
}

function luminance(image: ImageData, x: number, y: number): number {
  const index = (y * image.width + x) * 4;
  return image.data[index]! * 0.299 +
    image.data[index + 1]! * 0.587 +
    image.data[index + 2]! * 0.114;
}

function averageDarkness(image: ImageData, x: number, top: number, bottom: number): number {
  let darkPixels = 0;
  let sampled = 0;
  const step = Math.max(1, Math.floor(image.height / 240));
  for (let y = top; y < bottom; y += step) {
    if (luminance(image, x, y) < 68) darkPixels += 1;
    sampled += 1;
  }
  return sampled > 0 ? darkPixels / sampled : 0;
}

function verticalEdgeStrength(image: ImageData, x: number, top: number, bottom: number): number {
  let difference = 0;
  let sampled = 0;
  const step = Math.max(1, Math.floor(image.height / 240));
  for (let y = top; y < bottom; y += step) {
    difference += Math.abs(luminance(image, x, y) - luminance(image, x - 1, y));
    sampled += 1;
  }
  return sampled > 0 ? difference / sampled : 0;
}

function horizontalEdgeStrength(image: ImageData, y: number, left: number, right: number): number {
  let difference = 0;
  let sampled = 0;
  const step = Math.max(1, Math.floor(right / 240));
  for (let x = Math.max(1, left); x < right; x += step) {
    difference += Math.abs(luminance(image, x, y, ) - luminance(image, x, y - 1));
    sampled += 1;
  }
  return sampled > 0 ? difference / sampled : 0;
}

function findHorizontalBoundary(
  image: ImageData,
  left: number,
  right: number,
  fromY: number,
  toY: number,
): { y: number; strength: number } {
  let best = { y: fromY, strength: 0 };
  for (let y = Math.max(1, fromY); y < Math.min(image.height, toY); y += 1) {
    const strength = horizontalEdgeStrength(image, y, left, right);
    if (strength > best.strength) best = { y, strength };
  }
  return best;
}

function findFirstHorizontalEdge(
  image: ImageData,
  left: number,
  right: number,
  fromY: number,
  toY: number,
): number {
  for (let y = Math.max(1, fromY); y < Math.min(image.height, toY); y += 1) {
    if (horizontalEdgeStrength(image, y, left, right) >= 8) return y;
  }
  return findHorizontalBoundary(image, left, right, fromY, toY).y;
}

function findLastGoldBorderRow(
  image: ImageData,
  left: number,
  right: number,
  fromY: number,
  toY: number,
): number | undefined {
  let lastBorderRow = -1;
  for (let y = Math.max(0, fromY); y < Math.min(image.height, toY); y += 1) {
    let borderPixels = 0;
    let sampled = 0;
    for (let x = Math.max(0, left); x < Math.min(image.width, right); x += 1) {
      const index = (y * image.width + x) * 4;
      const red = image.data[index]!;
      const green = image.data[index + 1]!;
      const blue = image.data[index + 2]!;
      const isGold = red > 85 && green > 60 && red > green * 1.02 && green > blue * 1.04;
      const isWhite = red > 165 && green > 155 && blue > 135;
      if (isGold || isWhite) borderPixels += 1;
      sampled += 1;
    }
    if (sampled > 0 && borderPixels / sampled >= 0.3) lastBorderRow = y;
  }
  return lastBorderRow < 0 ? undefined : lastBorderRow + 1;
}

function findLeftGoldBorder(
  image: ImageData,
  top: number,
  bottom: number,
  maxX: number,
): { x: number; strength: number } | undefined {
  const step = Math.max(1, Math.floor(image.height / 240));
  const columnStrengths: number[] = [];

  for (let x = 0; x < maxX; x += 1) {
    let goldPixels = 0;
    let sampled = 0;
    for (let y = top; y < bottom; y += step) {
      const index = (y * image.width + x) * 4;
      const red = image.data[index]!;
      const green = image.data[index + 1]!;
      const blue = image.data[index + 2]!;
      const isGold = red > 85 && green > 60 && red > green * 1.02 && green > blue * 1.04;
      const isWhite = red > 165 && green > 155 && blue > 135;
      if (isGold || isWhite) goldPixels += 1;
      sampled += 1;
    }
    columnStrengths.push(sampled > 0 ? goldPixels / sampled : 0);
  }

  let bestStart = -1;
  let bestStrength = 0;
  for (let x = 0; x < columnStrengths.length; x += 1) {
    if (columnStrengths[x]! < 0.3) continue;
    const strength = Math.max(columnStrengths[x]!, columnStrengths[x + 1] ?? 0);
    if (strength > bestStrength) {
      bestStart = x;
      bestStrength = strength;
    }
  }

  return bestStart < 0 ? undefined : { x: bestStart, strength: bestStrength };
}

function detectLeftStatPanel(image: ImageData): CropDetection | undefined {
  const { width, height } = image;
  const topScan = Math.floor(height * 0.03);
  const bottomScan = Math.floor(height * 0.98);
  const minX = Math.floor(width * 0.12);
  const maxX = Math.floor(width * 0.43);
  let best: { x: number; score: number; contrast: number; edge: number } | undefined;

  for (let x = minX; x <= maxX; x += 1) {
    const leftDarkness = averageDarkness(image, Math.max(1, x - 5), topScan, bottomScan);
    const rightDarkness = averageDarkness(image, Math.min(width - 1, x + 5), topScan, bottomScan);
    const contrast = leftDarkness - rightDarkness;
    const edge = verticalEdgeStrength(image, x, topScan, bottomScan);
    const score = Math.max(0, contrast) * 0.75 + Math.min(1, edge / 55) * 0.25;
    if (!best || score > best.score) best = { x, score, contrast, edge };
  }

  if (!best || best.contrast < 0.17 || best.score < 0.28) {
    return undefined;
  }

  const right = Math.min(width - 1, best.x + 2);
  const leftBorder = findLeftGoldBorder(
    image,
    topScan,
    bottomScan,
    Math.min(right, Math.floor(width * 0.1)),
  );
  const left = leftBorder ? Math.max(0, leftBorder.x - 1) : 0;
  const bottomBorder = findLastGoldBorderRow(
    image,
    left,
    right,
    Math.floor(height * 0.76),
    Math.floor(height * 0.995),
  );
  const bottomEdge = bottomBorder ?? findHorizontalBoundary(
    image,
    left,
    right,
    Math.floor(height * 0.76),
    Math.floor(height * 0.995),
  ).y;
  if (right - left < width * 0.12) return undefined;

  const expectedHeight = Math.min(height * 0.99, height * 0.685 * 1.35);
  const topSearchStart = Math.max(1, Math.floor(bottomEdge - height * 0.99));
  const topSearchEnd = Math.max(topSearchStart + 1, Math.floor(bottomEdge - height * 0.8));
  let topEdge = findFirstHorizontalEdge(image, left, right, topSearchStart, topSearchEnd);
  if (
    bottomEdge <= topEdge ||
    (bottomEdge - topEdge) / (right - left + 1) < 1.1 ||
    (bottomEdge - topEdge) / (right - left + 1) > 1.7
  ) {
    topEdge = Math.max(0, Math.round(bottomEdge - expectedHeight));
  }
  if (bottomEdge <= topEdge) return undefined;

  const topY = Math.max(0, topEdge - 1);
  const rect = clampCropRect({
    x: left / width,
    y: topY / height,
    width: Math.min(1, (right + 2 - left) / width),
    height: Math.min(1, (bottomEdge - topY) / height),
  });
  const borderConfidence = leftBorder ? Math.min(0.18, leftBorder.strength * 0.2) : 0;
  const confidence = Math.min(0.99, Math.max(0.35, best.score * 1.15 + borderConfidence));
  return {
    rect,
    confidence,
    method: "left-panel",
    edges: { left, right: right + 2, top: topY, bottom: bottomEdge },
  };
}

export function detectStatWindow(image: ImageData): CropDetection {
  const aspectRatio = image.width / image.height;
  if (aspectRatio < 1.1) {
    return {
      rect: { x: 0, y: 0, width: 1, height: 1 },
      confidence: 0.98,
      method: "panel-image",
    };
  }

  if (aspectRatio >= 2) {
    const detected = detectLeftStatPanel(image);
    if (detected) return detected;
  }

  return {
    rect: initialCropRect(image.width, image.height),
    confidence: 0.2,
    method: "bottom-default",
  };
}

export function detectHealthBar(
  image: ImageData,
  statWindow: CropRect,
): CropDetection {
  const { width, height } = image;
  const startX = Math.min(width - 1, Math.floor((statWindow.x + statWindow.width + 0.035) * width));
  const startY = Math.floor(height * 0.5);
  const rowThreshold = Math.max(20, Math.floor(width * 0.16));
  const greenRows: Array<{ y: number; count: number }> = [];

  for (let y = startY; y < Math.floor(height * 0.99); y += 1) {
    let count = 0;
    for (let x = startX; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const red = image.data[index]!;
      const green = image.data[index + 1]!;
      const blue = image.data[index + 2]!;
      if (green > 105 && green > red * 1.22 && green > blue * 1.12) count += 1;
    }
    if (count >= rowThreshold) greenRows.push({ y, count });
  }

  let bestRows: Array<{ y: number; count: number }> = [];
  let group: Array<{ y: number; count: number }> = [];
  for (const row of greenRows) {
    if (group.length > 0 && row.y > group[group.length - 1]!.y + 2) {
      if (group.reduce((sum, entry) => sum + entry.count, 0) > bestRows.reduce((sum, entry) => sum + entry.count, 0)) {
        bestRows = group;
      }
      group = [];
    }
    group.push(row);
  }
  if (group.reduce((sum, entry) => sum + entry.count, 0) > bestRows.reduce((sum, entry) => sum + entry.count, 0)) {
    bestRows = group;
  }

  if (bestRows.length < 3) {
    return {
      rect: initialHealthCropRect(width, height),
      confidence: 0.2,
      method: "health-default",
    };
  }

  const top = bestRows[0]!.y;
  const bottom = bestRows[bestRows.length - 1]!.y;
  const columnCounts = new Uint16Array(width);
  for (const row of bestRows) {
    for (let x = startX; x < width; x += 1) {
      const index = (row.y * width + x) * 4;
      const red = image.data[index]!;
      const green = image.data[index + 1]!;
      const blue = image.data[index + 2]!;
      if (green > 105 && green > red * 1.22 && green > blue * 1.12) columnCounts[x] += 1;
    }
  }

  const columnThreshold = Math.max(2, Math.floor(bestRows.length * 0.2));
  const segments: Array<{ left: number; right: number }> = [];
  let runStart = -1;
  for (let x = startX; x <= width; x += 1) {
    const active = x < width && columnCounts[x]! >= columnThreshold;
    if (active && runStart < 0) runStart = x;
    if (!active && runStart >= 0) {
      segments.push({ left: runStart, right: x - 1 });
      runStart = -1;
    }
  }

  const mergedSegments: Array<{ left: number; right: number }> = [];
  const maxTextGap = Math.floor(width * 0.12);
  for (const segment of segments) {
    const previous = mergedSegments[mergedSegments.length - 1];
    if (previous && segment.left - previous.right - 1 <= maxTextGap) {
      previous.right = segment.right;
    } else {
      mergedSegments.push({ ...segment });
    }
  }
  const bestSegment = mergedSegments.reduce<{ left: number; right: number } | undefined>(
    (best, segment) => !best || segment.right - segment.left > best.right - best.left
      ? segment
      : best,
    undefined,
  );

  if (!bestSegment || bestSegment.right - bestSegment.left < width * 0.2) {
    return {
      rect: initialHealthCropRect(width, height),
      confidence: 0.2,
      method: "health-default",
    };
  }

  const left = bestSegment.left;
  const right = bestSegment.right;
  const paddingX = Math.max(3, Math.round(width * 0.008));
  const paddingY = Math.max(2, Math.round(height * 0.012));
  const rect = clampCropRect({
    x: Math.max(0, left - paddingX) / width,
    y: Math.max(0, top - paddingY) / height,
    width: Math.min(width, right + paddingX) / width - Math.max(0, left - paddingX) / width,
    height: Math.min(height, bottom + paddingY) / height - Math.max(0, top - paddingY) / height,
  });
  const confidence = Math.min(0.99, Math.max(0.35, (right - left) / (width * 0.55)));
  return { rect, confidence, method: "health-bar" };
}

export function detectAnvilCounter(
  image: ImageData,
  statWindow: CropRect,
  healthBar: CropRect,
): AnvilCounterDetection {
  const { width, height } = image;
  const left = Math.min(width - 1, Math.floor((statWindow.x + statWindow.width + 0.025) * width));
  const right = Math.max(left + 1, Math.min(width, Math.floor((healthBar.x + healthBar.width + 0.02) * width)));
  const top = Math.floor(height * 0.025);
  const bottom = Math.max(top + 1, Math.min(height, Math.floor((healthBar.y - 0.035) * height)));
  const regionWidth = right - left;
  const regionHeight = bottom - top;
  const mask = new Uint8Array(regionWidth * regionHeight);

  for (let y = 0; y < regionHeight; y += 1) {
    for (let x = 0; x < regionWidth; x += 1) {
      const index = ((top + y) * width + left + x) * 4;
      const red = image.data[index]!;
      const green = image.data[index + 1]!;
      const blue = image.data[index + 2]!;
      if (green > 90 && green > red * 1.18 && green > blue * 1.15) {
        mask[y * regionWidth + x] = 1;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  let best: { x: number; y: number; width: number; height: number; count: number; score: number } | undefined;
  const minPixels = Math.max(24, Math.floor(width * height * 0.00012));

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    let minX = regionWidth;
    let minY = regionHeight;
    let maxX = -1;
    let maxY = -1;
    let count = 0;

    while (stack.length > 0) {
      const current = stack.pop()!;
      const x = current % regionWidth;
      const y = Math.floor(current / regionWidth);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextX >= regionWidth || nextY < 0 || nextY >= regionHeight) continue;
          const next = nextY * regionWidth + nextX;
          if (!mask[next] || visited[next]) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const aspect = componentWidth / componentHeight;
    const normalizedWidth = componentWidth / width;
    const normalizedHeight = componentHeight / height;
    if (
      count < minPixels || aspect < 0.48 || aspect > 1.2 ||
      normalizedWidth < 0.02 || normalizedWidth > 0.1 ||
      normalizedHeight < 0.05 || normalizedHeight > 0.2
    ) continue;

    const relativeY = (top + minY) / height;
    const shapeScore = Math.max(0, 1 - Math.abs(aspect - 0.8) / 0.8);
    const score = count * (0.65 + shapeScore * 0.35) * (1.15 - relativeY * 0.5);
    if (!best || score > best.score) {
      best = {
        x: left + minX,
        y: top + minY,
        width: componentWidth,
        height: componentHeight,
        count,
        score,
      };
    }
  }

  if (!best) {
    const fallback = clampCropRect({
      x: statWindow.x + statWindow.width + 0.12,
      y: Math.max(0, healthBar.y - 0.24),
      width: 0.1,
      height: 0.16,
    });
    return { rect: fallback, valueRect: fallback, confidence: 0.15, method: "anvil-default" };
  }

  const iconRight = best.x + best.width;
  const iconBottom = best.y + best.height;
  const reviewRect = clampCropRect({
    x: Math.max(0, best.x - best.width * 0.12) / width,
    y: Math.max(0, best.y - best.height * 0.12) / height,
    width: Math.min(width, iconRight + best.width * 1.05) / width - Math.max(0, best.x - best.width * 0.12) / width,
    height: Math.min(height, iconBottom + best.height * 0.55) / height - Math.max(0, best.y - best.height * 0.12) / height,
  });
  const valueRect = clampCropRect({
    x: (best.x + best.width * 0.48) / width,
    y: (best.y + best.height * 0.48) / height,
    width: Math.min(width, best.width * 1.15) / width,
    height: Math.min(height, best.height * 0.62) / height,
  });
  const areaRatio = best.count / (width * height);
  const confidence = Math.min(0.96, 0.48 + Math.min(0.28, areaRatio * 140) +
    Math.max(0, 0.18 - Math.abs(best.width / best.height - 0.8) * 0.2));
  return { rect: reviewRect, valueRect, confidence, method: "anvil-counter" };
}

/**
 * Finds the stat panel: its left border from the gold frame, then its rows and top/bottom
 * borders from the text (see locatePanel). Handles borders cut off by the screenshot and a
 * collapsed top half; falls back to the border-only detection when no rows are found.
 */
export function detectStatPanel(image: ImageData): CropDetection {
  const window = detectStatWindow(image);
  if (!window.edges) return window;
  const location = locatePanel(image, {
    x: window.edges.left,
    y: 0,
    width: window.edges.right - window.edges.left,
    height: image.height,
  });
  if (!location) return window;
  const { rect } = location;
  return {
    rect: clampCropRect({
      x: rect.x / image.width,
      y: rect.y / image.height,
      width: rect.width / image.width,
      height: rect.height / image.height,
    }),
    // Four evenly spaced text rows at the panel's scale are strong evidence on their own.
    confidence: Math.max(window.confidence, 0.85),
    method: location.collapsed ? "collapsed-panel" : "left-panel",
    edges: { left: rect.x, right: rect.x + rect.width, top: rect.y, bottom: rect.y + rect.height },
  };
}
