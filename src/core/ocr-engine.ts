import { createWorker, OEM, PSM } from "tesseract.js";

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
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: "0123456789.%|",
    preserve_interword_spaces: "1",
  });
  return worker;
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