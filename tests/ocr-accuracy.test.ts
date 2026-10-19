// Runs the production OCR pipeline on the example screenshots and requires every value to
// match the hand-verified ground truth. Set OCR_REPORT=<file> to write a per-value report.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorker, OEM, PSM } from "tesseract.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { STAT_CHARACTERS } from "../src/core/ocr-engine";
import {
  extractPanelStats,
  HEALTH_CHARACTERS,
  parseAnvilCount,
  readHealth,
  readValueRegion,
  type PixelRecognizer,
} from "../src/core/ocr-layout";
import { EXAMPLE_PAIRS, loadScreenshot, type Side } from "./support/fixtures";
import { encodePng } from "./support/png";

let worker: Awaited<ReturnType<typeof createWorker>>;

// Mirrors createLocalOcrWorker's settings, with Node-local language data.
beforeAll(async () => {
  worker = await createWorker("eng", OEM.LSTM_ONLY, {
    langPath: fileURLToPath(new URL("../node_modules/@tesseract.js-data/eng/4.0.0_best_int", import.meta.url)),
    gzip: true,
    cacheMethod: "none",
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: "0123456789.%|",
    preserve_interword_spaces: "1",
  });
}, 60_000);

afterAll(async () => {
  await worker?.terminate();
});

// Reads in this test are sequential, so switching the character set per call is safe.
const recognizeWith = (characters: string): PixelRecognizer => async (image) => {
  await worker.setParameters({ tessedit_char_whitelist: characters });
  const { data } = await worker.recognize(encodePng(image), {}, { text: true, blocks: true });
  return { value: data.text, confidence: data.confidence / 100 };
};
const recognize = recognizeWith(STAT_CHARACTERS);

it.each(EXAMPLE_PAIRS)("reads every visible value in the $name pair exactly", async ({ name, files, truth }) => {
  const lines: string[] = [];
  const misses: string[] = [];
  for (const side of ["before", "after"] as Side[]) {
    const { image, panel, anvilValue, health: healthRect } = loadScreenshot(files[side]);
    const stats = await extractPanelStats(image, panel, recognize);
    const anvil = await readValueRegion(image, anvilValue, recognize);
    const health = await readHealth(image, healthRect, recognizeWith(HEALTH_CHARACTERS))
      ?? { value: "(unparsed)", confidence: 0 };
    const readings = [
      ...stats.map((stat) => ({ id: stat.id, ...stat, expected: truth[side].stats[stat.id]! })),
      { id: "anvilCount", ...anvil, expected: truth[side].anvilCount },
      { id: "health", ...health, expected: truth[side].health },
    ];
    for (const { id, value, confidence, expected } of readings) {
      const ok = value === expected;
      const line = `${name} | ${side.padEnd(6)} ${id.padEnd(21)} want ${expected.padEnd(7)} got ${value.padEnd(9)} ${Math.round(confidence * 100)}%`;
      lines.push(ok ? line : `${line}  <-- MISS`);
      if (!ok) misses.push(line);
    }
    expect(parseAnvilCount(anvil)?.value).toBe(truth[side].anvilCount);
  }
  if (process.env.OCR_REPORT) writeFileSync(process.env.OCR_REPORT, `${lines.join("\n")}\n`, { flag: "a" });
  expect(misses).toEqual([]);
}, 120_000);
