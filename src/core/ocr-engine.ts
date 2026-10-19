import { createWorker, OEM, PSM } from "tesseract.js";
import type { PixelImage } from "./pixels";

export type LocalOcrWorker = Awaited<ReturnType<typeof createWorker>>;

export interface OcrProgress {
  status: string;
  progress: number;
}

export interface OcrReading {
  value: string;
  confidence: number;
}

export async function createLocalOcrWorker(
  baseUrl: string,
  onProgress: (progress: OcrProgress) => void,
): Promise<LocalOcrWorker> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: `${base}ocr/worker.min.js`,
    corePath: `${base}ocr/tesseract-core-lstm.wasm.js`,
    langPath: `${base}ocr`,
    gzip: true,
    legacyCore: false,
    legacyLang: false,
    workerBlobURL: false,
    logger: ({ status, progress }) => onProgress({ status, progress }),
  });

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: STAT_CHARACTERS,
    preserve_interword_spaces: "1",
  });
  workerCharacters.set(worker, STAT_CHARACTERS);
  return worker;
}

/** Characters that can appear in stat panel values. */
export const STAT_CHARACTERS = "0123456789.%|";

const workerCharacters = new WeakMap<LocalOcrWorker, string>();
const workerQueues = new WeakMap<LocalOcrWorker, Promise<unknown>>();

/**
 * Reads an image restricted to `characters`. Reads on one worker run strictly in turn so a
 * character-set change for one read can never apply to another read already in flight.
 */
export function recognizeOcrPixels(
  worker: LocalOcrWorker,
  image: PixelImage,
  characters = STAT_CHARACTERS,
): Promise<OcrReading> {
  const run = async () => {
    if (workerCharacters.get(worker) !== characters) {
      await worker.setParameters({ tessedit_char_whitelist: characters });
      workerCharacters.set(worker, characters);
    }
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    return recognizeOcrCanvas(worker, canvas);
  };
  const result = (workerQueues.get(worker) ?? Promise.resolve()).then(run, run);
  workerQueues.set(worker, result.catch(() => undefined));
  return result;
}

export async function recognizeOcrCanvas(
  worker: LocalOcrWorker,
  image: HTMLCanvasElement,
): Promise<OcrReading> {
  const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
  return {
    value: data.text,
    confidence: Number.isFinite(data.confidence)
      ? Math.max(0, Math.min(1, data.confidence / 100))
      : 0,
  };
}