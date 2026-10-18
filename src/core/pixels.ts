import type { CropRect } from "./crop";

/** Structural subset of ImageData so pixel code runs in the browser and in Node tests. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createPixelImage(width: number, height: number): PixelImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Converts a normalized crop to source pixels with the same rounding as cropImageToCanvas. */
export function toPixelRect(rect: CropRect, imageWidth: number, imageHeight: number): PixelRect {
  return {
    x: Math.round(rect.x * imageWidth),
    y: Math.round(rect.y * imageHeight),
    width: Math.max(1, Math.round(rect.width * imageWidth)),
    height: Math.max(1, Math.round(rect.height * imageHeight)),
  };
}

export function cropPixels(image: PixelImage, rect: PixelRect): PixelImage {
  const left = Math.max(0, Math.min(image.width - 1, Math.round(rect.x)));
  const top = Math.max(0, Math.min(image.height - 1, Math.round(rect.y)));
  const width = Math.max(1, Math.min(image.width - left, Math.round(rect.width)));
  const height = Math.max(1, Math.min(image.height - top, Math.round(rect.height)));
  const output = createPixelImage(width, height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((top + y) * image.width + left) * 4;
    output.data.set(image.data.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
  }
  return output;
}

export function resizeBilinear(image: PixelImage, width: number, height: number): PixelImage {
  const output = createPixelImage(width, height);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(0, Math.min(image.height - 1, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(image.width - 1, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sourceX - x0;
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = image.data[(y0 * image.width + x0) * 4 + channel]!;
        const topRight = image.data[(y0 * image.width + x1) * 4 + channel]!;
        const bottomLeft = image.data[(y1 * image.width + x0) * 4 + channel]!;
        const bottomRight = image.data[(y1 * image.width + x1) * 4 + channel]!;
        output.data[(y * width + x) * 4 + channel] =
          (topLeft * (1 - fx) + topRight * fx) * (1 - fy) +
          (bottomLeft * (1 - fx) + bottomRight * fx) * fy;
      }
    }
  }
  return output;
}

export function pixelLuminance(image: PixelImage, x: number, y: number): number {
  const index = (y * image.width + x) * 4;
  return image.data[index]! * 0.299 + image.data[index + 1]! * 0.587 + image.data[index + 2]! * 0.114;
}
