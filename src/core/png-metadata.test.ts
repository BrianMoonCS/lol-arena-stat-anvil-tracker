import { describe, expect, it } from "vitest";
import { DELTA_PRESETS } from "./output-format";
import { embedSheetMetadata, readSheetMetadata, type SheetMetadata } from "./png-metadata";

// A valid 1x1 PNG.
const TINY_PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
), (character) => character.charCodeAt(0));

const METADATA: SheetMetadata = {
  version: 1,
  values: { health: { before: "4405", after: "5005" }, armorPenetration: { before: "0|0%", after: "32|23%" } },
  colors: { health: DELTA_PRESETS.red, shard: DELTA_PRESETS.purple },
};

describe("sheet data in PNGs", () => {
  it("round-trips the data and keeps the PNG valid", () => {
    const embedded = embedSheetMetadata(TINY_PNG, METADATA);
    expect(readSheetMetadata(embedded)).toEqual(METADATA);
    expect(embedded.length).toBeGreaterThan(TINY_PNG.length);
    // The original chunks are all still there, in order, after the inserted one.
    expect(embedded.subarray(embedded.length - TINY_PNG.length + 33)).toEqual(TINY_PNG.subarray(33));
  });

  it("finds nothing in PNGs without the data, or in other files", () => {
    expect(readSheetMetadata(TINY_PNG)).toBeUndefined();
    expect(readSheetMetadata(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("escapes non-ASCII text so it survives the Latin-1 chunk", () => {
    const withAccent: SheetMetadata = { ...METADATA, values: { fortune: { before: "é", after: "1" } } };
    expect(readSheetMetadata(embedSheetMetadata(TINY_PNG, withAccent))).toEqual(withAccent);
  });
});
