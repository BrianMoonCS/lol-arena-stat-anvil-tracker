import { describe, expect, it } from "vitest";
import {
  detectAnvilCounter,
  detectHealthBar,
  detectStatWindow,
  detectStatWindowPair,
} from "./detect";
import type { CropRect } from "./crop";

function makeImage(width: number, height: number, fill: [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data[offset] = fill[0];
    data[offset + 1] = fill[1];
    data[offset + 2] = fill[2];
    data[offset + 3] = 255;
  }
  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

function paintRect(
  image: ImageData,
  left: number,
  top: number,
  right: number,
  bottom: number,
  color: [number, number, number],
): void {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * image.width + x) * 4;
      image.data[index] = color[0];
      image.data[index + 1] = color[1];
      image.data[index + 2] = color[2];
    }
  }
}

describe("automatic screenshot crop detection", () => {
  it("finds a tall dark panel at the left edge of a zoomed HUD image", () => {
    const image = makeImage(300, 120, [150, 145, 125]);
    paintRect(image, 0, 6, 80, 114, [9, 25, 23]);
    paintRect(image, 79, 6, 81, 114, [176, 139, 69]);
    paintRect(image, 0, 5, 81, 7, [176, 139, 69]);
    paintRect(image, 0, 113, 81, 115, [176, 139, 69]);

    const detection = detectStatWindow(image);
    expect(detection.method).toBe("left-panel");
    expect(detection.confidence).toBeGreaterThan(0.35);
    expect(detection.rect.x).toBe(0);
    expect(detection.rect.width).toBeGreaterThan(0.25);
    expect(detection.rect.width).toBeLessThan(0.32);
    expect(detection.rect.height).toBeGreaterThan(0.85);
  });

  it("anchors the crop to the gold left border when the panel shifts", () => {
    for (const borderX of [5, 25]) {
      const image = makeImage(500, 200, [90, 90, 90]);
      paintRect(image, borderX + 3, 10, 122, 190, [15, 32, 27]);
      paintRect(image, borderX, 10, borderX + 3, 190, [176, 139, 69]);
      paintRect(image, 122, 10, 125, 190, [122, 116, 91]);
      paintRect(image, borderX, 8, 125, 11, [122, 116, 91]);
      paintRect(image, borderX, 189, 125, 192, [122, 116, 91]);

      const detection = detectStatWindow(image);
      expect(detection.method).toBe("left-panel");
      expect(Math.round(detection.rect.x * image.width)).toBe(borderX - 1);
    }
  });

  it("aligns Before to the visible bottom border using After's panel aspect", () => {
    const after = makeImage(500, 200, [90, 90, 90]);
    paintRect(after, 28, 20, 137, 180, [15, 32, 27]);
    paintRect(after, 25, 20, 28, 180, [176, 139, 69]);
    paintRect(after, 137, 20, 140, 180, [122, 116, 91]);
    paintRect(after, 25, 18, 140, 21, [122, 116, 91]);
    paintRect(after, 25, 179, 140, 182, [176, 139, 69]);

    const before = makeImage(500, 200, [90, 90, 90]);
    paintRect(before, 38, 20, 147, 170, [15, 32, 27]);
    paintRect(before, 35, 20, 38, 170, [176, 139, 69]);
    paintRect(before, 147, 20, 150, 170, [122, 116, 91]);
    paintRect(before, 35, 18, 150, 21, [122, 116, 91]);
    paintRect(before, 35, 169, 150, 172, [176, 139, 69]);
    paintRect(before, 100, 12, 160, 80, [115, 112, 105]);

    const detections = detectStatWindowPair(before, after);
    expect(detections.before.method).toBe("bottom-aligned");
    const beforeWidth = detections.before.edges!.right - detections.before.edges!.left;
    const beforeHeight = detections.before.rect.height * before.height;
    const afterWidth = detections.after.edges!.right - detections.after.edges!.left;
    const afterHeight = detections.after.edges!.bottom - detections.after.edges!.top;
    expect(beforeHeight / beforeWidth).toBeCloseTo(afterHeight / afterWidth, 4);
    expect(detections.before.rect.y * before.height + beforeHeight).toBeCloseTo(
      detections.before.edges!.bottom,
      1,
    );
  });

  it("finds the long green Health bar to the right of the stat panel", () => {
    const image = makeImage(300, 120, [25, 32, 38]);
    paintRect(image, 100, 84, 286, 96, [0, 192, 12]);
    paintRect(image, 180, 84, 205, 96, [230, 230, 230]);
    const statWindow: CropRect = { x: 0, y: 0.04, width: 0.28, height: 0.92 };

    const detection = detectHealthBar(image, statWindow);
    expect(detection.method).toBe("health-bar");
    expect(detection.confidence).toBeGreaterThan(0.5);
    expect(detection.rect.x).toBeGreaterThan(0.28);
    expect(detection.rect.x).toBeLessThan(0.4);
    expect(detection.rect.width).toBeGreaterThan(0.5);
    expect(detection.rect.y).toBeGreaterThan(0.6);
  });

  it("keeps a lower-HUD preset for full-screen screenshots", () => {
    const image = makeImage(947, 533, [80, 85, 90]);
    expect(detectStatWindow(image).method).toBe("bottom-default");
  });

  it("follows the green Anvil icon when its screen position changes", () => {
    const image = makeImage(320, 200, [35, 42, 48]);
    paintRect(image, 180, 40, 208, 72, [10, 205, 25]);
    paintRect(image, 120, 108, 148, 140, [10, 205, 25]);
    const panel: CropRect = { x: 0, y: 0, width: 0.25, height: 1 };
    const health: CropRect = { x: 0.4, y: 0.85, width: 0.55, height: 0.08 };

    const detection = detectAnvilCounter(image, panel, health);
    expect(detection.method).toBe("anvil-counter");
    expect(detection.confidence).toBeGreaterThan(0.5);
    expect(detection.rect.x * image.width).toBeLessThan(180);
    expect(detection.rect.x * image.width + detection.rect.width * image.width).toBeGreaterThan(208);
    expect(detection.rect.y * image.height).toBeLessThan(40);
  });

  it("returns a low-confidence review crop if no Anvil icon is found", () => {
    const image = makeImage(320, 200, [35, 42, 48]);
    const detection = detectAnvilCounter(
      image,
      { x: 0, y: 0, width: 0.25, height: 1 },
      { x: 0.4, y: 0.85, width: 0.55, height: 0.08 },
    );
    expect(detection.method).toBe("anvil-default");
    expect(detection.confidence).toBeLessThan(0.3);
  });
});