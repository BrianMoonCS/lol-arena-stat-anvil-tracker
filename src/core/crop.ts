export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FULL_IMAGE_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };
const BOTTOM_HUD_CROP: CropRect = {
  x: 0.285,
  y: 0.83,
  width: 0.08,
  height: 0.17,
};
const HEALTH_BAR_CROP: CropRect = {
  x: 0.36,
  y: 0.965,
  width: 0.17,
  height: 0.035,
};

export function clampCropRect(rect: CropRect): CropRect {
  const width = Math.min(1, Math.max(0, rect.width));
  const height = Math.min(1, Math.max(0, rect.height));
  const x = Math.min(1 - width, Math.max(0, rect.x));
  const y = Math.min(1 - height, Math.max(0, rect.y));
  return { x, y, width, height };
}

export function initialCropRect(imageWidth: number, imageHeight: number): CropRect {
  if (imageWidth <= 0 || imageHeight <= 0) return FULL_IMAGE_CROP;
  return imageWidth / imageHeight < 1.1
    ? FULL_IMAGE_CROP
    : BOTTOM_HUD_CROP;
}

export function cropImageToCanvas(
  image: CanvasImageSource & { width: number; height: number },
  rect: CropRect,
  scale = 4,
): HTMLCanvasElement {
  const crop = clampCropRect(rect);
  const sourceX = Math.round(crop.x * image.width);
  const sourceY = Math.round(crop.y * image.height);
  const sourceWidth = Math.max(1, Math.round(crop.width * image.width));
  const sourceHeight = Math.max(1, Math.round(crop.height * image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.imageSmoothingEnabled = false;
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

export function initialHealthCropRect(
  imageWidth: number,
  imageHeight: number,
): CropRect {
  if (imageWidth <= 0 || imageHeight <= 0) return FULL_IMAGE_CROP;
  return imageWidth / imageHeight < 1.1
    ? FULL_IMAGE_CROP
    : HEALTH_BAR_CROP;
}