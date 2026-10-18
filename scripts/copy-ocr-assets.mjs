import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outputDirectory = new URL("../public/ocr/", import.meta.url);
mkdirSync(fileURLToPath(outputDirectory), { recursive: true });

const assets = [
  [
    "../node_modules/tesseract.js/dist/worker.min.js",
    "worker.min.js",
  ],
  [
    "../node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js",
    "tesseract-core-lstm.wasm.js",
  ],
  [
    "../node_modules/tesseract.js-core/tesseract-core-lstm.wasm",
    "tesseract-core-lstm.wasm",
  ],
  [
    "../node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
    "eng.traineddata.gz",
  ],
];

for (const [source, destination] of assets) {
  copyFileSync(
    new URL(source, import.meta.url),
    new URL(destination, outputDirectory),
  );
}