import { describe, expect, it } from "vitest";
import {
  clampCropRect,
  initialCropRect,
  initialHealthCropRect,
} from "./crop";

describe("initialCropRect", () => {
  it("starts full screenshots at the lower HUD stat window", () => {
    expect(initialCropRect(947, 533)).toEqual({
      x: 0.285,
      y: 0.83,
      width: 0.08,
      height: 0.17,
    });
  });

  it("uses the whole image when it is already panel-shaped", () => {
    expect(initialCropRect(80, 150)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe("clampCropRect", () => {
  it("keeps crops within image bounds", () => {
    expect(clampCropRect({ x: 0.9, y: -0.2, width: 0.4, height: 0.5 })).toEqual({
      x: 0.6,
      y: 0,
      width: 0.4,
      height: 0.5,
    });
  });
});

describe("initialHealthCropRect", () => {
  it("starts a separate crop over the lower-right Health bar", () => {
    expect(initialHealthCropRect(947, 533)).toEqual({
      x: 0.36,
      y: 0.965,
      width: 0.17,
      height: 0.035,
    });
  });
});