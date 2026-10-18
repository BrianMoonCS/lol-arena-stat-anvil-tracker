import "./styles.css";
import {
  renderBackground,
  type BackgroundConfig,
  type CanvasConfig,
  type RenderValue,
} from "./core/render";
import { formatStatDiff } from "./core/diff";
import {
  clampCropRect,
  cropImageToCanvas,
  type CropRect,
} from "./core/crop";
import {
  detectAnvilCounter,
  detectHealthBar,
  detectStatWindow,
  detectStatWindowPair,
  type AnvilCounterDetection,
  type CropDetection,
} from "./core/detect";
import {
  extractPanelStats,
  PANEL_STAT_CELLS,
  parseAnvilCount,
  readValueRegion,
  type ExtractedStat,
} from "./core/ocr-layout";
import {
  createLocalOcrWorker,
  recognizeOcrPixels,
  type LocalOcrWorker,
} from "./core/ocr-engine";
import { toPixelRect } from "./core/pixels";
import {
  buildVisionPrompt,
  validateVisionResponse,
  type VisionTask,
  type VisionResult,
} from "./core/vision";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("App root is missing");

interface VisionPreferences {
  enabled: boolean;
  proxyUrl: string;
  apiKey: string;
  confidenceThreshold: number;
}

const VISION_STORAGE_KEY = "stat-anvil-vision-settings-v1";

function loadVisionPreferences(): VisionPreferences {
  const defaults: VisionPreferences = {
    enabled: false,
    proxyUrl: "",
    apiKey: "",
    confidenceThreshold: 55,
  };
  try {
    const saved = localStorage.getItem(VISION_STORAGE_KEY);
    if (!saved) return defaults;
    const parsed: unknown = JSON.parse(saved);
    if (typeof parsed !== "object" || parsed === null) return defaults;
    const candidate = parsed as Partial<VisionPreferences>;
    return {
      enabled: candidate.enabled === true,
      proxyUrl: typeof candidate.proxyUrl === "string" ? candidate.proxyUrl : "",
      apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
      confidenceThreshold: typeof candidate.confidenceThreshold === "number" &&
          candidate.confidenceThreshold >= 30 && candidate.confidenceThreshold <= 90
        ? candidate.confidenceThreshold
        : 55,
    };
  } catch {
    return defaults;
  }
}

async function initialize(): Promise<void> {
  const app = appElement!;
  const configUrl = `${import.meta.env.BASE_URL}config/background-config.json`;
  const config = await fetch(configUrl).then((response) => {
    if (!response.ok)
      throw new Error("Could not load background configuration");
    return response.json() as Promise<CanvasConfig>;
  });

  const sampleValues: Record<string, RenderValue> = {
    health: { value: "2,450", delta: "(+320)" },
    attackDamage: { value: "184", delta: "(+46)" },
    abilityPower: { value: "320", delta: "(+120)" },
    attackSpeed: { value: "1.42", delta: "(+0.18)" },
    armor: { value: "112", delta: "(+24)" },
    magicResistance: { value: "68", delta: "(+8)" },
    abilityHaste: { value: "45", delta: "(+15)" },
    criticalStrikeChance: { value: "35%", delta: "(+15%)" },
    omnivamp: { value: "8%", delta: "(+3%)" },
    armorPenetration: { value: "24 | 18%", delta: "(+8 | +6%)" },
    magicPenetration: { value: "28 | 12%", delta: "(+10 | +4%)" },
    movementSpeed: { value: "385", delta: "(+45)" },
    tenacity: { value: "20%", delta: "(+10%)" },
    healAndShieldPower: { value: "15%", delta: "(+5%)" },
    fortune: { value: "6", delta: "(+2)" },
    anvilCount: { value: "4", delta: "(+1)" },
  };

  app.innerHTML = `
  <main class="workspace">
    <header class="topbar">
      <a class="wordmark" href="./" aria-label="Stat Anvil Tracker home">
        <span class="wordmark-mark">SA</span>
        <span>Stat Anvil Tracker</span>
      </a>
      <span class="topbar-note">LEAGUE OF LEGENDS / IMAGE BUILDER</span>
    </header>
    <section class="builder" aria-labelledby="page-title">
      <div class="builder-heading">
        <div>
          <p class="eyebrow">ANVIL RECORD / 001</p>
          <h1 id="page-title">Stat sheet preview</h1>
        </div>
        <p class="stage-label"><span class="stage-dot"></span> LOCAL OCR / FIXED LAYOUT</p>
      </div>
      <div class="builder-grid">
        <section class="preview-panel" aria-label="Canvas preview">
          <div class="preview-toolbar">
            <span>OUTPUT CANVAS <span class="dimensions">1200 × 675</span></span>
            <span class="preview-status">LIVE PREVIEW</span>
          </div>
          <div class="canvas-frame">
            <canvas id="result-canvas" aria-label="Generated stat image"></canvas>
          </div>
          <div class="preview-footer">
            <span>16 CONFIGURED SLOTS</span>
            <span>PNG / 1200 × 675</span>
          </div>
        </section>
        <aside class="controls-panel" aria-label="Preview settings">
          <div class="control-section">
            <h2>Background</h2>
            <div class="background-picker" role="group" aria-label="Choose a background"></div>
          </div>
          <section class="control-section screenshot-section" aria-labelledby="screenshots-title">
            <div class="section-heading">
              <h2 id="screenshots-title">Screenshots</h2>
              <span class="demo-badge">INPUT STAGE</span>
            </div>
            <div class="screenshot-grid">
              <article class="screenshot-card is-active" data-side="after" tabindex="0" aria-label="After screenshot input">
                <div class="screenshot-card-heading"><span>AFTER</span><span class="screenshot-status">NO IMAGE</span></div>
                <div class="screenshot-empty">No screenshot</div>
                <img class="screenshot-thumbnail" alt="After screenshot preview" hidden />
                <div class="screenshot-actions">
                  <button class="paste-target" type="button" data-side="after">Paste</button>
                  <button class="choose-target" type="button" data-side="after">Choose</button>
                  <input class="screenshot-file" type="file" accept="image/*" data-side="after" hidden />
                </div>
              </article>
              <article class="screenshot-card" data-side="before" tabindex="0" aria-label="Before screenshot input">
                <div class="screenshot-card-heading"><span>BEFORE</span><span class="screenshot-status">NO IMAGE</span></div>
                <div class="screenshot-empty">No screenshot</div>
                <img class="screenshot-thumbnail" alt="Before screenshot preview" hidden />
                <div class="screenshot-actions">
                  <button class="paste-target" type="button" data-side="before">Paste</button>
                  <button class="choose-target" type="button" data-side="before">Choose</button>
                  <input class="screenshot-file" type="file" accept="image/*" data-side="before" hidden />
                </div>
              </article>
            </div>
            <div class="screenshot-footer">
              <button id="load-example-pair" class="text-button" type="button">Load example pair</button>
              <span id="screenshot-message" role="status"></span>
            </div>
          </section>
          <section class="control-section manual-section" aria-labelledby="manual-title">
            <div class="section-heading">
              <h2 id="manual-title">Manual stats</h2>
              <span id="anvil-count-detection" class="demo-badge">COUNT / MANUAL</span>
            </div>
            <div class="manual-table">
              <div class="manual-row manual-header"><span>STAT</span><span>BEFORE</span><span>AFTER</span></div>
              <div class="manual-row">
                <label for="health-before">Health</label>
                <input id="health-before" type="number" min="0" step="1" value="2130" />
                <input id="health-after" type="number" min="0" step="1" value="2450" aria-label="Health after" />
              </div>
              <div class="manual-row">
                <label for="fortune-before">Fortune</label>
                <input id="fortune-before" type="number" min="0" step="1" value="4" />
                <input id="fortune-after" type="number" min="0" step="1" value="6" aria-label="Fortune after" />
              </div>
              <div class="manual-row">
                <label for="anvil-before">Anvil Count</label>
                <input id="anvil-before" type="number" min="0" step="1" value="3" />
                <input id="anvil-after" type="number" min="0" step="1" value="4" aria-label="Anvil count after" />
              </div>
            </div>
          </div>
          <div class="control-section debug-control">
            <div>
              <h2>Slot guides</h2>
              <p>Show configured text bounds</p>
            </div>
            <label class="switch">
              <input id="debug-toggle" type="checkbox" />
              <span class="switch-track" aria-hidden="true"></span>
              <span class="visually-hidden">Show slot guides</span>
            </label>
          </div>
          <div class="sample-note">
            <span class="note-index">A</span>
            <p>Readings stay sample data until extraction. Health and Fortune remain manual; Anvil Count reads from its detected marker.</p>
          </div>
          <button id="download-button" class="download-button" type="button">
            <span aria-hidden="true">↓</span>
            Download PNG
          </button>
        </aside>
      </div>
      <section id="crop-review" class="crop-review" aria-labelledby="crop-review-title" hidden>
        <div class="section-heading crop-review-heading">
          <div>
            <p class="eyebrow">SCREENSHOT REVIEW</p>
            <h2 id="crop-review-title">Stat-window crop review</h2>
          </div>
          <span class="demo-badge">DRAG TO ADJUST</span>
        </div>
        <div class="crop-review-grid">
          <article class="crop-review-card" data-side="after">
            <div class="crop-review-label"><span>AFTER</span><span class="detection-status" data-side="after"></span><button class="reset-crop" type="button" data-side="after">Reset</button></div>
            <div class="crop-kind-switch" data-side="after" role="group" aria-label="Active after crop">
              <button class="crop-kind-button" type="button" data-kind="stats" aria-pressed="true">Stat window</button>
              <button class="crop-kind-button" type="button" data-kind="health" aria-pressed="false">Health bar</button>
              <button class="crop-kind-button" type="button" data-kind="anvil" aria-pressed="false">Anvil count</button>
            </div>
            <div class="crop-editor" data-side="after">
              <img class="crop-source" alt="After screenshot crop selection" />
              <div class="crop-selection crop-selection-stats" data-kind="stats" aria-hidden="true"></div>
              <div class="crop-selection crop-selection-health" data-kind="health" aria-hidden="true"></div>
              <div class="crop-selection crop-selection-anvil" data-kind="anvil" aria-hidden="true"></div>
            </div>
            <div class="crop-final-label">ANVIL COUNT</div>
            <canvas class="anvil-crop-result" data-side="after" aria-label="Final after Anvil-count crop"></canvas>
            <div class="crop-final-label">HEALTH BAR</div>
            <canvas class="health-crop-result" data-side="after" aria-label="Final after Health-bar crop"></canvas>
            <div class="crop-final-label">STAT WINDOW</div>
            <canvas class="crop-result" data-side="after" aria-label="Final after stat-window crop"></canvas>
          </article>
          <article class="crop-review-card" data-side="before">
            <div class="crop-review-label"><span>BEFORE</span><span class="detection-status" data-side="before"></span><button class="reset-crop" type="button" data-side="before">Reset</button></div>
            <div class="crop-kind-switch" data-side="before" role="group" aria-label="Active before crop">
              <button class="crop-kind-button" type="button" data-kind="stats" aria-pressed="true">Stat window</button>
              <button class="crop-kind-button" type="button" data-kind="health" aria-pressed="false">Health bar</button>
              <button class="crop-kind-button" type="button" data-kind="anvil" aria-pressed="false">Anvil count</button>
            </div>
            <div class="crop-editor" data-side="before">
              <img class="crop-source" alt="Before screenshot crop selection" />
              <div class="crop-selection crop-selection-stats" data-kind="stats" aria-hidden="true"></div>
              <div class="crop-selection crop-selection-health" data-kind="health" aria-hidden="true"></div>
              <div class="crop-selection crop-selection-anvil" data-kind="anvil" aria-hidden="true"></div>
            </div>
            <div class="crop-final-label">ANVIL COUNT</div>
            <canvas class="anvil-crop-result" data-side="before" aria-label="Final before Anvil-count crop"></canvas>
            <div class="crop-final-label">HEALTH BAR</div>
            <canvas class="health-crop-result" data-side="before" aria-label="Final before Health-bar crop"></canvas>
            <div class="crop-final-label">STAT WINDOW</div>
            <canvas class="crop-result" data-side="before" aria-label="Final before stat-window crop"></canvas>
          </article>
        </div>
        <section class="local-ocr-panel" aria-labelledby="local-ocr-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">FIXED STAT LAYOUT</p>
              <h2 id="local-ocr-title">On-device OCR</h2>
            </div>
            <span class="demo-badge">NO MANUAL SETUP</span>
          </div>
          <div class="ocr-footer">
            <span id="ocr-status" role="status">Reads values by their fixed row and column positions.</span>
            <progress id="ocr-progress" max="1" value="0" hidden></progress>
            <button id="extract-stats" class="extract-button" type="button">Extract stats</button>
          </div>
        </section>
      </section>
      <section id="extraction-review" class="extraction-review" aria-labelledby="extraction-title" hidden>
        <div class="section-heading">
          <div>
            <p class="eyebrow">EDIT BEFORE RENDER</p>
            <h2 id="extraction-title">Detected stats</h2>
          </div>
          <span class="demo-badge">CONFIDENCE PER SIDE</span>
        </div>
        <div class="extracted-table">
          <div class="extracted-row extracted-header"><span>STAT</span><span>BEFORE</span><span>AFTER</span><span>CONFIDENCE B / A</span></div>
          <div id="extracted-rows"></div>
        </div>
      </section>
      <section class="vision-fallback" aria-labelledby="vision-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">OPTIONAL / PROXY ONLY</p>
            <h2 id="vision-title">Vision fallback</h2>
          </div>
          <label class="switch">
            <input id="vision-enabled" type="checkbox" />
            <span class="switch-track" aria-hidden="true"></span>
            <span class="visually-hidden">Enable vision fallback</span>
          </label>
        </div>
        <div id="vision-settings" hidden>
          <div class="vision-fields">
            <label>Proxy URL
              <input id="vision-proxy-url" type="url" placeholder="https://your-worker.example/extract" autocomplete="url" />
            </label>
            <label>Bring-your-own key (optional)
              <input id="vision-api-key" type="password" autocomplete="off" />
            </label>
            <label class="vision-threshold">Fallback below confidence
              <input id="vision-confidence" type="range" min="30" max="90" value="55" />
              <output id="vision-confidence-value">55%</output>
            </label>
          </div>
          <p class="vision-note">Configure the proxy to use Claude Sonnet 5. The key is stored in this browser and sent only to the configured proxy.</p>
        </div>
        <span id="vision-status" class="vision-status" role="status">Disabled</span>
      </section>
      </section>
    </section>
    <footer class="page-footer"><span>STAT ANVIL TRACKER</span><span>BUILD 01 / CANVAS ENGINE</span></footer>
  </main>
`;

  const canvas = app.querySelector<HTMLCanvasElement>("#result-canvas");
  const backgroundPicker =
    app.querySelector<HTMLDivElement>(".background-picker");
  const debugToggle = app.querySelector<HTMLInputElement>("#debug-toggle");
  const downloadButton =
    app.querySelector<HTMLButtonElement>("#download-button");
  const screenshotMessage =
    app.querySelector<HTMLSpanElement>("#screenshot-message");
  const examplePairButton =
    app.querySelector<HTMLButtonElement>("#load-example-pair");
  const cropReview = app.querySelector<HTMLElement>("#crop-review");
  const ocrStatus = app.querySelector<HTMLSpanElement>("#ocr-status");
  const ocrProgress = app.querySelector<HTMLProgressElement>("#ocr-progress");
  const extractStatsButton = app.querySelector<HTMLButtonElement>("#extract-stats");
  const extractionReview = app.querySelector<HTMLElement>("#extraction-review");
  const extractedRows = app.querySelector<HTMLDivElement>("#extracted-rows");
  const anvilCountDetection = app.querySelector<HTMLSpanElement>("#anvil-count-detection");
  const visionEnabled = app.querySelector<HTMLInputElement>("#vision-enabled");
  const visionSettings = app.querySelector<HTMLDivElement>("#vision-settings");
  const visionProxyUrl = app.querySelector<HTMLInputElement>("#vision-proxy-url");
  const visionApiKey = app.querySelector<HTMLInputElement>("#vision-api-key");
  const visionConfidence = app.querySelector<HTMLInputElement>("#vision-confidence");
  const visionConfidenceValue = app.querySelector<HTMLOutputElement>("#vision-confidence-value");
  const visionStatus = app.querySelector<HTMLSpanElement>("#vision-status");
  if (
    !canvas || !backgroundPicker || !debugToggle || !downloadButton ||
    !screenshotMessage || !examplePairButton || !cropReview ||
    !ocrStatus || !ocrProgress || !extractStatsButton ||
    !extractionReview || !extractedRows || !anvilCountDetection || !visionEnabled || !visionSettings ||
    !visionProxyUrl || !visionApiKey || !visionConfidence ||
    !visionConfidenceValue || !visionStatus
  ) {
    throw new Error("Preview controls are missing");
  }
  const screenshotStatus = screenshotMessage;
  const cropReviewPanel = cropReview;
  const ocrStatusMessage = ocrStatus;
  const ocrProgressBar = ocrProgress;
  const extractionReviewPanel = extractionReview;
  const extractedRowsPanel = extractedRows;
  const anvilCountStatus = anvilCountDetection;
  const statsExtractButton = extractStatsButton;
  const visionEnabledControl = visionEnabled;
  const visionSettingsPanel = visionSettings;
  const visionProxyUrlInput = visionProxyUrl;
  const visionApiKeyInput = visionApiKey;
  const visionConfidenceControl = visionConfidence;
  const visionConfidenceOutput = visionConfidenceValue;
  const visionStatusMessage = visionStatus;
  const outputCanvas = canvas;
  const guideToggle = debugToggle;

  let selectedBackground = config.backgrounds[0];
  let selectedImage: HTMLImageElement | undefined;
  if (!selectedBackground) throw new Error("No background configuration found");

  type ScreenshotSide = "after" | "before";
  type CropKind = "stats" | "health" | "anvil";
  type ScreenshotCrops = Record<CropKind, CropRect>;
  type ScreenshotDetections = {
    stats: CropDetection;
    health: CropDetection;
    anvil: AnvilCounterDetection;
  };
  const screenshotInputs: Partial<Record<ScreenshotSide, { file: File; url: string }>> = {};
  const cropImages: Partial<Record<ScreenshotSide, HTMLImageElement>> = {};
  const screenshotImageData: Partial<Record<ScreenshotSide, ImageData>> = {};
  const cropRects: Partial<Record<ScreenshotSide, ScreenshotCrops>> = {};
  const cropDetections: Partial<Record<ScreenshotSide, ScreenshotDetections>> = {};
  const activeCropKinds: Record<ScreenshotSide, CropKind> = {
    after: "stats",
    before: "stats",
  };
  const visionPreferences = loadVisionPreferences();
  visionEnabledControl.checked = visionPreferences.enabled;
  visionProxyUrlInput.value = visionPreferences.proxyUrl;
  visionApiKeyInput.value = visionPreferences.apiKey;
  visionConfidenceControl.value = String(visionPreferences.confidenceThreshold);
  visionConfidenceOutput.value = `${visionPreferences.confidenceThreshold}%`;
  visionSettingsPanel.hidden = !visionPreferences.enabled;
  visionStatusMessage.textContent = visionPreferences.enabled ? "Enabled" : "Disabled";
  const extractedValues = new Map<string, { before: string; after: string; beforeConfidence: number; afterConfidence: number }>();
  let localOcrWorkerPromise: Promise<LocalOcrWorker> | undefined;
  let activeScreenshotSide: ScreenshotSide = "after";

  function updateManualValues(): void {
    const manualStats = [
      { id: "health", beforeId: "health-before", afterId: "health-after", grouped: true },
      { id: "fortune", beforeId: "fortune-before", afterId: "fortune-after", grouped: false },
      { id: "anvilCount", beforeId: "anvil-before", afterId: "anvil-after", grouped: false },
    ];

    for (const stat of manualStats) {
      const beforeInput = app.querySelector<HTMLInputElement>(`#${stat.beforeId}`);
      const afterInput = app.querySelector<HTMLInputElement>(`#${stat.afterId}`);
      if (!beforeInput || !afterInput) continue;

      const beforeValue = beforeInput.value || "0";
      const afterValue = afterInput.value || "0";
      const displayValue = stat.grouped && afterValue !== ""
        ? Number(afterValue).toLocaleString("en-US")
        : afterValue;
      sampleValues[stat.id] = {
        value: displayValue,
        delta: formatStatDiff(beforeValue, afterValue),
      };
    }
    draw();
  }

  function draw(): void {
    renderBackground(
      outputCanvas,
      config,
      selectedBackground,
      selectedImage,
      sampleValues,
      guideToggle.checked,
    );
  }

  function chooseBackground(background: BackgroundConfig): void {
    selectedBackground = background;
    selectedImage = undefined;
    draw();

    const image = new Image();
    image.onload = () => {
      if (selectedBackground.id !== background.id) return;
      selectedImage = image;
      draw();
    };
    image.onerror = () => {
      if (selectedBackground.id === background.id) draw();
    };
    image.src = `${import.meta.env.BASE_URL}${background.image}`;
  }

  function setScreenshot(side: ScreenshotSide, file: File): void {
    if (!file.type.startsWith("image/")) {
      screenshotStatus.textContent = "Choose an image file";
      return;
    }

    const card = app.querySelector<HTMLElement>(`.screenshot-card[data-side="${side}"]`);
    const preview = card?.querySelector<HTMLImageElement>(".screenshot-thumbnail");
    const emptyState = card?.querySelector<HTMLDivElement>(".screenshot-empty");
    const status = card?.querySelector<HTMLSpanElement>(".screenshot-status");
    if (!card || !preview || !emptyState || !status) return;

    const existingScreenshot = screenshotInputs[side];
    if (existingScreenshot) URL.revokeObjectURL(existingScreenshot.url);
    const url = URL.createObjectURL(file);
    screenshotInputs[side] = { file, url };
    preview.src = url;
    preview.hidden = false;
    emptyState.hidden = true;
    status.textContent = "READY";
    screenshotStatus.textContent = `${side === "after" ? "After" : "Before"} image loaded`;
    setActiveScreenshotSide(side);

    const cropImage = new Image();
    cropImage.onload = () => {
      cropImages[side] = cropImage;
      const analysisCanvas = document.createElement("canvas");
      analysisCanvas.width = cropImage.naturalWidth;
      analysisCanvas.height = cropImage.naturalHeight;
      const analysisContext = analysisCanvas.getContext("2d");
      if (!analysisContext) return;
      analysisContext.drawImage(cropImage, 0, 0);
      const imageData = analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
      screenshotImageData[side] = imageData;
      const beforeImageData = screenshotImageData.before;
      const afterImageData = screenshotImageData.after;
      if (!beforeImageData || !afterImageData) return;

      const statDetections = detectStatWindowPair(beforeImageData, afterImageData);
      for (const screenshotSide of ["before", "after"] as const) {
        const sourceData = screenshotImageData[screenshotSide];
        if (!sourceData) continue;
        const statsDetection = statDetections[screenshotSide];
        const healthDetection = detectHealthBar(sourceData, statsDetection.rect);
        const anvilDetection = detectAnvilCounter(sourceData, statsDetection.rect, healthDetection.rect);
        cropDetections[screenshotSide] = {
          stats: statsDetection,
          health: healthDetection,
          anvil: anvilDetection,
        };
        cropRects[screenshotSide] = {
          stats: statsDetection.rect,
          health: healthDetection.rect,
          anvil: anvilDetection.rect,
        };
        if (screenshotSide === "after") {
          anvilCountStatus.textContent = anvilDetection.method === "anvil-counter"
            ? `ICON DETECTED / ${Math.round(anvilDetection.confidence * 100)}% / CHECK COUNT`
            : "COUNT / MANUAL";
        }
      }
      updateCropReview();
    };
    cropImage.src = url;
  }

  function updateCropReview(): void {
    cropReviewPanel.hidden = !(cropImages.after && cropImages.before);
    if (cropReviewPanel.hidden) return;

    for (const side of ["after", "before"] as const) {
      const image = cropImages[side];
      const crops = cropRects[side];
      const editor = app.querySelector<HTMLElement>(`.crop-editor[data-side="${side}"]`);
      const source = editor?.querySelector<HTMLImageElement>(".crop-source");
      const statResult = app.querySelector<HTMLCanvasElement>(`.crop-result[data-side="${side}"]`);
      const healthResult = app.querySelector<HTMLCanvasElement>(`.health-crop-result[data-side="${side}"]`);
      const anvilResult = app.querySelector<HTMLCanvasElement>(`.anvil-crop-result[data-side="${side}"]`);
      const detectionStatus = app.querySelector<HTMLSpanElement>(`.detection-status[data-side="${side}"]`);
      if (!image || !crops || !editor || !source || !statResult || !healthResult || !anvilResult) continue;

      const detections = cropDetections[side];
      if (detections && detectionStatus) {
        const statDetection = detections.stats;
        detectionStatus.textContent = statDetection.method === "bottom-aligned"
          ? `ALIGNED TO AFTER ${Math.round(statDetection.confidence * 100)}%`
          : statDetection.method === "left-panel"
          ? `AUTO ${Math.round(statDetection.confidence * 100)}%`
          : statDetection.method === "panel-image"
            ? "PANEL IMAGE"
            : "PRESET / CHECK";
        detectionStatus.title = `Stat window: ${statDetection.method}, ${Math.round(statDetection.confidence * 100)}%. Health bar: ${detections.health.method}, ${Math.round(detections.health.confidence * 100)}%. Anvil icon: ${detections.anvil.method}, ${Math.round(detections.anvil.confidence * 100)}%.`;
        detectionStatus.classList.toggle("is-low", statDetection.confidence < 0.5);
      }

      if (source.src !== image.src) source.src = image.src;
      for (const kind of ["stats", "health", "anvil"] as const) {
        const rect = crops[kind];
        const selection = editor.querySelector<HTMLDivElement>(`.crop-selection[data-kind="${kind}"]`);
        if (!selection) continue;
        selection.style.left = `${rect.x * 100}%`;
        selection.style.top = `${rect.y * 100}%`;
        selection.style.width = `${rect.width * 100}%`;
        selection.style.height = `${rect.height * 100}%`;
      }

      const statCrop = cropImageToCanvas(image, crops.stats, 4);
      statResult.width = statCrop.width;
      statResult.height = statCrop.height;
      statResult.getContext("2d")?.drawImage(statCrop, 0, 0);

      const healthCrop = cropImageToCanvas(image, crops.health, 4);
      healthResult.width = healthCrop.width;
      healthResult.height = healthCrop.height;
      healthResult.getContext("2d")?.drawImage(healthCrop, 0, 0);

      const anvilCrop = cropImageToCanvas(image, crops.anvil, 4);
      anvilResult.width = anvilCrop.width;
      anvilResult.height = anvilCrop.height;
      anvilResult.getContext("2d")?.drawImage(anvilCrop, 0, 0);
    }
  }

  function createReviewRows(
    beforeStats: ExtractedStat[],
    afterStats: ExtractedStat[],
  ): void {
    const beforeById = new Map(beforeStats.map((stat) => [stat.id, stat]));
    const afterById = new Map(afterStats.map((stat) => [stat.id, stat]));
    const labels: Record<string, string> = {
      healAndShieldPower: "Heal and Shield Power",
      armorPenetration: "Armor Penetration",
      magicPenetration: "Magic Penetration",
      omnivamp: "Omnivamp",
      tenacity: "Tenacity",
      attackDamage: "Attack Damage",
      abilityPower: "Ability Power",
      armor: "Armor",
      magicResistance: "Magic Resistance",
      attackSpeed: "Attack Speed",
      abilityHaste: "Ability Haste",
      criticalStrikeChance: "Critical Strike Chance",
      movementSpeed: "Movement Speed",
    };

    extractedRowsPanel.replaceChildren();
    extractedValues.clear();
    for (const { id } of PANEL_STAT_CELLS) {
      const before = beforeById.get(id) ?? { id, value: "", confidence: 0 };
      const after = afterById.get(id) ?? { id, value: "", confidence: 0 };
      extractedValues.set(id, {
        before: before.value,
        after: after.value,
        beforeConfidence: before.confidence,
        afterConfidence: after.confidence,
      });

      const row = document.createElement("div");
      row.className = "extracted-row";
      const name = document.createElement("span");
      name.className = "extracted-name";
      name.textContent = labels[id] ?? id;

      const beforeInput = document.createElement("input");
      beforeInput.type = "text";
      beforeInput.inputMode = "decimal";
      beforeInput.setAttribute("aria-label", `${labels[id] ?? id} before`);
      beforeInput.value = before.value;
      const afterInput = document.createElement("input");
      afterInput.type = "text";
      afterInput.inputMode = "decimal";
      afterInput.setAttribute("aria-label", `${labels[id] ?? id} after`);
      afterInput.value = after.value;

      const confidence = document.createElement("span");
      confidence.className = "extracted-confidence";
      confidence.textContent = `${Math.round(before.confidence * 100)}% / ${Math.round(after.confidence * 100)}%`;
      if (Math.min(before.confidence, after.confidence) < 0.55) {
        confidence.classList.add("is-low");
      }

      const updateValue = () => {
        extractedValues.set(id, {
          before: beforeInput.value,
          after: afterInput.value,
          beforeConfidence: before.confidence,
          afterConfidence: after.confidence,
        });
        sampleValues[id] = {
          value: afterInput.value || "0",
          delta: formatStatDiff(beforeInput.value, afterInput.value),
        };
        draw();
      };
      beforeInput.addEventListener("input", updateValue);
      afterInput.addEventListener("input", updateValue);

      row.append(name, beforeInput, afterInput, confidence);
      extractedRowsPanel.append(row);
    }
    extractionReviewPanel.hidden = false;
  }

  function getLocalOcrWorker(): Promise<LocalOcrWorker> {
    if (!localOcrWorkerPromise) {
      ocrProgressBar.hidden = false;
      ocrProgressBar.value = 0;
      ocrStatusMessage.textContent = "Starting local OCR…";
      localOcrWorkerPromise = createLocalOcrWorker(
        import.meta.env.BASE_URL,
        ({ status, progress }) => {
          ocrStatusMessage.textContent = status;
          ocrProgressBar.value = progress;
        },
      ).then((worker) => {
        ocrStatusMessage.textContent = "Local OCR ready.";
        ocrProgressBar.value = 1;
        return worker;
      }).catch((error: unknown) => {
        localOcrWorkerPromise = undefined;
        ocrProgressBar.hidden = true;
        throw error;
      });
    }
    return localOcrWorkerPromise;
  }

  function saveVisionPreferences(): void {
    const preferences: VisionPreferences = {
      enabled: visionEnabledControl.checked,
      proxyUrl: visionProxyUrlInput.value.trim(),
      apiKey: visionApiKeyInput.value,
      confidenceThreshold: Number(visionConfidenceControl.value),
    };
    try {
      localStorage.setItem(VISION_STORAGE_KEY, JSON.stringify(preferences));
      visionStatusMessage.textContent = preferences.enabled ? "Enabled" : "Disabled";
    } catch {
      visionStatusMessage.textContent = "Could not save settings in this browser";
    }
  }

  visionEnabledControl.addEventListener("change", () => {
    visionSettingsPanel.hidden = !visionEnabledControl.checked;
    saveVisionPreferences();
  });
  visionProxyUrlInput.addEventListener("input", saveVisionPreferences);
  visionApiKeyInput.addEventListener("input", saveVisionPreferences);
  visionConfidenceControl.addEventListener("input", () => {
    visionConfidenceOutput.value = `${visionConfidenceControl.value}%`;
    saveVisionPreferences();
  });

  async function readAnvilCount(
    side: ScreenshotSide,
    worker: LocalOcrWorker,
  ): Promise<{ value: string; confidence: number } | undefined> {
    const image = screenshotImageData[side];
    const crops = cropRects[side];
    const detection = cropDetections[side]?.anvil;
    if (!image || !crops || !detection || detection.confidence < 0.35) return undefined;

    const autoRect = detection.rect;
    const currentRect = crops.anvil;
    const valueRect = clampCropRect({
      x: currentRect.x + ((detection.valueRect.x - autoRect.x) / autoRect.width) * currentRect.width,
      y: currentRect.y + ((detection.valueRect.y - autoRect.y) / autoRect.height) * currentRect.height,
      width: (detection.valueRect.width / autoRect.width) * currentRect.width,
      height: (detection.valueRect.height / autoRect.height) * currentRect.height,
    });
    const reading = await readValueRegion(
      image,
      toPixelRect(valueRect, image.width, image.height),
      (part) => recognizeOcrPixels(worker, part),
    );
    const count = parseAnvilCount(reading);
    if (!count) return undefined;
    return { value: count.value, confidence: Math.min(count.confidence, detection.confidence) };
  }

  async function updateAnvilCountFromScreenshots(worker: LocalOcrWorker): Promise<void> {
    const [beforeReading, afterReading] = await Promise.all([
      readAnvilCount("before", worker),
      readAnvilCount("after", worker),
    ]);
    const beforeInput = app.querySelector<HTMLInputElement>("#anvil-before");
    const afterInput = app.querySelector<HTMLInputElement>("#anvil-after");
    if (!beforeInput || !afterInput) return;

    if (beforeReading && beforeReading.confidence >= 0.4) beforeInput.value = beforeReading.value;
    if (afterReading && afterReading.confidence >= 0.4) afterInput.value = afterReading.value;

    if (beforeReading || afterReading) {
      const beforeText = beforeReading
        ? `${beforeReading.value} (${Math.round(beforeReading.confidence * 100)}%)`
        : "manual";
      const afterText = afterReading
        ? `${afterReading.value} (${Math.round(afterReading.confidence * 100)}%)`
        : "manual";
      anvilCountStatus.textContent = `AUTO B ${beforeText} / A ${afterText}`;
    } else {
      const iconDetected = Boolean(
        cropDetections.before?.anvil.method === "anvil-counter" ||
        cropDetections.after?.anvil.method === "anvil-counter",
      );
      anvilCountStatus.textContent = iconDetected
        ? "ICON FOUND / CHECK COUNT"
        : "COUNT / MANUAL";
    }
    updateManualValues();
  }

  function applyVisionResults(
    localStats: ExtractedStat[],
    side: ScreenshotSide,
    visionResults: VisionResult[],
  ): ExtractedStat[] {
    const overrides = new Map(
      visionResults.filter((result) => result.side === side).map((result) => [result.id, result]),
    );
    return localStats.map((stat) => {
      const override = overrides.get(stat.id);
      return override
        ? { ...stat, value: override.value, confidence: override.confidence }
        : stat;
    });
  }

  async function requestVisionFallback(
    tasks: VisionTask[],
    beforeCrop: HTMLCanvasElement,
    afterCrop: HTMLCanvasElement,
  ): Promise<VisionResult[] | undefined> {
    let endpoint: URL;
    try {
      endpoint = new URL(visionProxyUrlInput.value.trim());
    } catch {
      visionStatusMessage.textContent = "Enter a valid proxy URL.";
      return undefined;
    }
    const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (
      endpoint.username || endpoint.password ||
      (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLocalhost))
    ) {
      visionStatusMessage.textContent = "Use an HTTPS proxy URL (HTTP is allowed only on localhost).";
      return undefined;
    }

    const images: Partial<Record<ScreenshotSide, string>> = {};
    for (const task of tasks) {
      if (images[task.side]) continue;
      images[task.side] = (task.side === "before" ? beforeCrop : afterCrop)
        .toDataURL("image/png");
    }

    visionStatusMessage.textContent = `Sending ${tasks.length} low-confidence value${tasks.length === 1 ? "" : "s"} to proxy…`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = visionApiKeyInput.value.trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(endpoint.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: buildVisionPrompt(tasks),
          expectedCount: tasks.length,
          tasks,
          images,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        visionStatusMessage.textContent = `Proxy returned HTTP ${response.status}.`;
        return undefined;
      }
      const payload: unknown = await response.json();
      const results = validateVisionResponse(payload, tasks);
      if (!results) {
        visionStatusMessage.textContent = "Proxy response did not match the requested JSON values.";
        return undefined;
      }
      visionStatusMessage.textContent = `Proxy returned ${results.length} validated value${results.length === 1 ? "" : "s"}.`;
      return results;
    } catch (error) {
      visionStatusMessage.textContent = error instanceof DOMException && error.name === "AbortError"
        ? "Proxy request timed out."
        : "Proxy request failed. Check the URL and CORS settings.";
      return undefined;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  statsExtractButton.addEventListener("click", async () => {
    const afterCrop = app.querySelector<HTMLCanvasElement>('.crop-result[data-side="after"]');
    const beforeCrop = app.querySelector<HTMLCanvasElement>('.crop-result[data-side="before"]');
    if (!afterCrop || !beforeCrop) return;

    statsExtractButton.disabled = true;
    ocrProgressBar.hidden = false;
    ocrProgressBar.value = 0;
    try {
      const worker = await getLocalOcrWorker();
      ocrStatusMessage.textContent = "Reading stat values by fixed panel cell…";
      const beforeImage = screenshotImageData.before;
      const afterImage = screenshotImageData.after;
      const beforeRects = cropRects.before;
      const afterRects = cropRects.after;
      if (!beforeImage || !afterImage || !beforeRects || !afterRects) return;
      const recognize = (part: Parameters<typeof recognizeOcrPixels>[1]) => recognizeOcrPixels(worker, part);
      const beforeStats = await extractPanelStats(
        beforeImage,
        toPixelRect(beforeRects.stats, beforeImage.width, beforeImage.height),
        recognize,
      );
      const afterStats = await extractPanelStats(
        afterImage,
        toPixelRect(afterRects.stats, afterImage.width, afterImage.height),
        recognize,
      );
      await updateAnvilCountFromScreenshots(worker);

      const fallbackThreshold = Number(visionConfidenceControl.value) / 100;
      const tasks: VisionTask[] = [
        ...beforeStats.filter((stat) => stat.confidence < fallbackThreshold)
          .map(({ id }) => ({ id, side: "before" as const })),
        ...afterStats.filter((stat) => stat.confidence < fallbackThreshold)
          .map(({ id }) => ({ id, side: "after" as const })),
      ];

      let visionResults: VisionResult[] | undefined;
      if (visionEnabledControl.checked && tasks.length > 0) {
        visionResults = await requestVisionFallback(tasks, beforeCrop, afterCrop);
      } else if (visionEnabledControl.checked) {
        visionStatusMessage.textContent = "No values are below the fallback threshold; no proxy request was made.";
      }
      if (visionResults) {
        createReviewRows(
          applyVisionResults(beforeStats, "before", visionResults),
          applyVisionResults(afterStats, "after", visionResults),
        );
      } else {
        createReviewRows(beforeStats, afterStats);
      }
      ocrStatusMessage.textContent = "Extraction complete. Review and edit the values below.";
    } catch {
      ocrStatusMessage.textContent = "Local OCR could not start. Try again or use the manual fields.";
    } finally {
      statsExtractButton.disabled = false;
      ocrProgressBar.hidden = true;
    }
  });

  for (const editor of app.querySelectorAll<HTMLElement>(".crop-editor")) {
    const side = editor.dataset.side as ScreenshotSide;
    let dragState: {
      mode: "move" | "create";
      kind: CropKind;
      pointerId: number;
      startX: number;
      startY: number;
      initialRect: CropRect;
    } | undefined;

    editor.addEventListener("pointerdown", (event) => {
      const crops = cropRects[side];
      const image = cropImages[side];
      const source = editor.querySelector<HTMLImageElement>(".crop-source");
      if (!crops || !image || !source) return;

      const bounds = source.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return;
      const pointerX = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
      const pointerY = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
      const clickedSelection = (event.target as HTMLElement).closest<HTMLDivElement>(".crop-selection");
      const kind = (clickedSelection?.dataset.kind as CropKind | undefined) ?? activeCropKinds[side];
      activeCropKinds[side] = kind;
      const selection = editor.querySelector<HTMLDivElement>(`.crop-selection[data-kind="${kind}"]`);
      const cropKindButtons = app.querySelectorAll<HTMLButtonElement>(`.crop-kind-switch[data-side="${side}"] .crop-kind-button`);
      for (const button of cropKindButtons) {
        button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
      }
      dragState = {
        mode: selection?.contains(event.target as Node) ? "move" : "create",
        kind,
        pointerId: event.pointerId,
        startX: pointerX,
        startY: pointerY,
        initialRect: crops[kind],
      };
      editor.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    editor.addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const source = editor.querySelector<HTMLImageElement>(".crop-source");
      if (!source) return;
      const bounds = source.getBoundingClientRect();
      const pointerX = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
      const pointerY = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
      const deltaX = pointerX - dragState.startX;
      const deltaY = pointerY - dragState.startY;

      const rect = dragState.mode === "move"
        ? clampCropRect({
          ...dragState.initialRect,
          x: dragState.initialRect.x + deltaX,
          y: dragState.initialRect.y + deltaY,
        })
        : clampCropRect({
          x: Math.min(dragState.startX, pointerX),
          y: Math.min(dragState.startY, pointerY),
          width: Math.max(0.005, Math.abs(deltaX)),
          height: Math.max(0.005, Math.abs(deltaY)),
        });
      const crops = cropRects[side];
      if (!crops) return;
      crops[dragState.kind] = rect;
      updateCropReview();
    });

    const finishCropDrag = (event: PointerEvent) => {
      if (dragState?.pointerId === event.pointerId) dragState = undefined;
    };
    editor.addEventListener("pointerup", finishCropDrag);
    editor.addEventListener("pointercancel", finishCropDrag);
  }

  for (const button of app.querySelectorAll<HTMLButtonElement>(".reset-crop")) {
    button.addEventListener("click", () => {
      const side = button.dataset.side as ScreenshotSide;
      const crops = cropRects[side];
      const detections = cropDetections[side];
      if (!crops || !detections) return;
      const kind = activeCropKinds[side];
      crops[kind] = detections[kind].rect;
      updateCropReview();
    });
  }

  for (const button of app.querySelectorAll<HTMLButtonElement>(".crop-kind-button")) {
    button.addEventListener("click", () => {
      const side = button.closest<HTMLElement>(".crop-kind-switch")?.dataset.side as ScreenshotSide;
      const kind = button.dataset.kind as CropKind;
      activeCropKinds[side] = kind;
      for (const option of app.querySelectorAll<HTMLButtonElement>(`.crop-kind-switch[data-side="${side}"] .crop-kind-button`)) {
        option.setAttribute("aria-pressed", String(option === button));
      }
    });
  }

  function setActiveScreenshotSide(side: ScreenshotSide): void {
    activeScreenshotSide = side;
    for (const card of app.querySelectorAll<HTMLElement>(".screenshot-card")) {
      card.classList.toggle("is-active", card.dataset.side === side);
    }
  }

  for (const card of app.querySelectorAll<HTMLElement>(".screenshot-card")) {
    const side = card.dataset.side as ScreenshotSide;
    const input = card.querySelector<HTMLInputElement>(".screenshot-file");
    if (!input) continue;

    card.addEventListener("focusin", () => setActiveScreenshotSide(side));
    card.addEventListener("click", () => setActiveScreenshotSide(side));
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      setActiveScreenshotSide(side);
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragleave", () => card.classList.remove("is-dragging"));
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("is-dragging");
      const file = event.dataTransfer?.files[0];
      if (file) setScreenshot(side, file);
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) setScreenshot(side, file);
      input.value = "";
    });

    card.querySelector<HTMLButtonElement>(".choose-target")?.addEventListener(
      "click",
      () => {
        setActiveScreenshotSide(side);
        input.click();
      },
    );
    card.querySelector<HTMLButtonElement>(".paste-target")?.addEventListener(
      "click",
      () => {
        setActiveScreenshotSide(side);
        card.focus();
        screenshotStatus.textContent = `Paste an image for ${side}`;
      },
    );
  }

  document.addEventListener("paste", (event) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    const file = imageItem?.getAsFile();
    if (!file) return;
    event.preventDefault();
    setScreenshot(activeScreenshotSide, file);
  });

  examplePairButton.addEventListener("click", async () => {
    try {
      const examples: Array<[ScreenshotSide, string]> = [
        ["after", "screenshots/after.png"],
        ["before", "screenshots/before.png"],
      ];
      await Promise.all(examples.map(async ([side, path]) => {
        const response = await fetch(`${import.meta.env.BASE_URL}${path}`);
        if (!response.ok) throw new Error("Example screenshot could not be loaded");
        const file = new File([await response.blob()], path.split("/").at(-1) ?? path, {
          type: "image/png",
        });
        setScreenshot(side, file);
      }));
      screenshotStatus.textContent = "Example pair loaded";
    } catch {
      screenshotStatus.textContent = "Example screenshots are unavailable";
    }
  });

  for (const input of app.querySelectorAll<HTMLInputElement>(".manual-table input")) {
    input.addEventListener("input", updateManualValues);
  }

  for (const background of config.backgrounds) {
    const button = document.createElement("button");
    button.className = "background-option";
    button.type = "button";
    button.setAttribute(
      "aria-pressed",
      String(background.id === selectedBackground.id),
    );
    button.innerHTML = `<span class="background-swatch" style="--swatch:${background.accentColor};--base:${background.backgroundColor}"></span><span>${background.label}</span>`;
    button.addEventListener("click", () => {
      chooseBackground(background);
      for (const option of backgroundPicker.querySelectorAll(
        ".background-option",
      )) {
        option.setAttribute("aria-pressed", String(option === button));
      }
    });
    backgroundPicker.append(button);
  }

  guideToggle.addEventListener("change", draw);
  downloadButton.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = "stat-anvil-tracker.png";
    link.href = outputCanvas.toDataURL("image/png");
    link.click();
  });

  updateManualValues();
  chooseBackground(selectedBackground);
}

void initialize();
