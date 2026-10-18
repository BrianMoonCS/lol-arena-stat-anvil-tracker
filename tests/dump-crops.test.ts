// Writes enlarged crops for visual inspection. Run with DUMP_DIR=<folder> npx vitest run tests/dump-crops.test.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { getPanelValueRegions } from "../src/core/ocr-layout";
import { preprocessValueRegion } from "../src/core/ocr-preprocess";
import { cropPixels, resizeBilinear } from "../src/core/pixels";
import { loadExamplePair } from "./support/fixtures";
import { writePng } from "./support/png";

const dumpDir = process.env.DUMP_DIR;

it.skipIf(!dumpDir)("dumps panel and value crops", () => {
  mkdirSync(dumpDir!, { recursive: true });
  const pair = loadExamplePair();
  for (const side of ["before", "after"] as const) {
    const { image, panel, anvilValue, health } = pair[side];
    const panelPixels = cropPixels(image, panel);
    writePng(join(dumpDir!, `${side}-panel.png`), resizeBilinear(panelPixels, panel.width * 3, panel.height * 3));
    console.log(side, "panel", panel, "health", health, "anvilValue", anvilValue);
    for (const region of getPanelValueRegions(panel.width, panel.height)) {
      const crop = cropPixels(panelPixels, region);
      writePng(join(dumpDir!, `${side}-${region.id}.png`), resizeBilinear(crop, crop.width * 6, crop.height * 6));
    }
    const healthCrop = cropPixels(image, health);
    writePng(join(dumpDir!, `${side}-health.png`), resizeBilinear(healthCrop, healthCrop.width * 3, healthCrop.height * 3));
    const [healthText] = preprocessValueRegion(image, health, { wordGap: 2.5, textSignal: "white" });
    writePng(join(dumpDir!, `${side}-health-preprocessed.png`), healthText!);
    const anvil = cropPixels(image, anvilValue);
    writePng(join(dumpDir!, `${side}-anvil.png`), resizeBilinear(anvil, anvil.width * 6, anvil.height * 6));
  }
});
