// Writes enlarged crops for visual inspection. Run with DUMP_DIR=<folder> npx vitest run tests/dump-crops.test.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { locatePanel, panelValueRegions } from "../src/core/ocr-layout";
import { preprocessValueRegion } from "../src/core/ocr-preprocess";
import { cropPixels, resizeBilinear } from "../src/core/pixels";
import { EXAMPLE_PAIRS, loadScreenshot } from "./support/fixtures";
import { writePng } from "./support/png";

const dumpDir = process.env.DUMP_DIR;

it.skipIf(!dumpDir)("dumps panel, value, health and anvil crops", () => {
  mkdirSync(dumpDir!, { recursive: true });
  for (const pair of EXAMPLE_PAIRS) {
    for (const [side, file] of Object.entries(pair.files)) {
      const prefix = `${file.replace(/\.png$/, "")}`;
      const { image, panel, health, anvilValue } = loadScreenshot(file);
      const panelPixels = cropPixels(image, panel);
      writePng(join(dumpDir!, `${prefix}-panel.png`), resizeBilinear(panelPixels, panel.width * 3, panel.height * 3));
      const location = locatePanel(image, panel);
      for (const region of location ? panelValueRegions(location) : []) {
        const crop = cropPixels(image, region);
        writePng(join(dumpDir!, `${prefix}-${region.id}.png`), resizeBilinear(crop, crop.width * 6, crop.height * 6));
      }
      const [healthText] = preprocessValueRegion(image, health, { wordGap: 2.5, textSignal: "white" });
      writePng(join(dumpDir!, `${prefix}-health.png`), healthText!);
      const anvil = cropPixels(image, anvilValue);
      writePng(join(dumpDir!, `${prefix}-anvil.png`), resizeBilinear(anvil, anvil.width * 6, anvil.height * 6));
      void side;
    }
  }
});
