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
  detectStatWindowPair,
  type AnvilCounterDetection,
  type CropDetection,
} from "./core/detect";
import {
  extractPanelStats,
  HEALTH_CHARACTERS,
  parseAnvilCount,
  readHealth,
  readValueRegion,
  type ExtractedStat,
} from "./core/ocr-layout";
import {
  createLocalOcrWorker,
  recognizeOcrPixels,
  type LocalOcrWorker,
} from "./core/ocr-engine";
import { toPixelRect, type PixelImage } from "./core/pixels";
import {
  buildVisionPrompt,
  validateVisionResponse,
  type VisionTask,
  type VisionResult,
} from "./core/vision";
import {
  deleteBackground,
  listStoredBackgrounds,
  loadSelectedBackgroundId,
  saveBackground,
  saveSelectedBackgroundId,
} from "./core/background-store";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("App root is missing");

type Side = "before" | "after";
type CropKind = "stats" | "health" | "anvil";
type StatSource = "panel" | "health" | "anvil" | "manual";

const SIDES: Side[] = ["before", "after"];

/** All 16 output stats, in output-template order. */
const STATS: Array<{ id: string; label: string; source: StatSource }> = [
  { id: "health", label: "Health", source: "health" },
  { id: "attackDamage", label: "Attack Damage", source: "panel" },
  { id: "abilityPower", label: "Ability Power", source: "panel" },
  { id: "attackSpeed", label: "Attack Speed", source: "panel" },
  { id: "armor", label: "Armor", source: "panel" },
  { id: "magicResistance", label: "Magic Resistance", source: "panel" },
  { id: "abilityHaste", label: "Ability Haste", source: "panel" },
  { id: "criticalStrikeChance", label: "Critical Strike Chance", source: "panel" },
  { id: "omnivamp", label: "Omnivamp", source: "panel" },
  { id: "armorPenetration", label: "Armor Pen | Armor Pen %", source: "panel" },
  { id: "magicPenetration", label: "Magic Pen | Magic Pen %", source: "panel" },
  { id: "movementSpeed", label: "Movement Speed", source: "panel" },
  { id: "tenacity", label: "Tenacity", source: "panel" },
  { id: "healAndShieldPower", label: "Heal and Shield Power", source: "panel" },
  { id: "fortune", label: "Fortune", source: "manual" },
  { id: "anvilCount", label: "Anvil Count", source: "anvil" },
];

/** OCR confidence below this is flagged yellow for a second look. */
const LOW_CONFIDENCE = 0.75;

const SAMPLE_VALUES: Record<string, RenderValue> = {
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

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const sideLabel = (side: Side) => (side === "before" ? "Before" : "After");

function dropZoneMarkup(side: Side): string {
  const label = side.toUpperCase();
  return `
    <div class="drop-zone" data-side="${side}" tabindex="0" role="button" aria-label="${label} screenshot: paste, drop or choose an image">
      <div class="drop-zone-head">
        <span class="drop-zone-label">${label}</span>
        <span class="drop-zone-target">PASTE TARGET</span>
      </div>
      <img class="drop-zone-image" alt="${label} screenshot" hidden />
      <div class="drop-zone-empty">
        <span class="drop-zone-key">Ctrl + V</span>
        <span>Paste, drop, or <button class="choose-file" type="button">choose a file</button></span>
      </div>
      <input class="drop-zone-file" type="file" accept="image/*" hidden />
    </div>`;
}

function cropPreviewMarkup(side: Side): string {
  return `
    <figure class="crop-preview" data-side="${side}">
      <figcaption>${side.toUpperCase()} <span class="detection-status" data-side="${side}"></span></figcaption>
      <div class="crop-preview-body">
        <canvas class="crop-canvas" data-kind="stats" data-side="${side}" aria-label="${sideLabel(side)} stat window crop"></canvas>
        <div class="crop-preview-side">
          <span class="crop-caption">HEALTH BAR</span>
          <canvas class="crop-canvas" data-kind="health" data-side="${side}" aria-label="${sideLabel(side)} health bar crop"></canvas>
          <span class="crop-caption">ANVIL COUNT</span>
          <canvas class="crop-canvas" data-kind="anvil" data-side="${side}" aria-label="${sideLabel(side)} anvil count crop"></canvas>
        </div>
      </div>
    </figure>`;
}

function cropEditorMarkup(side: Side): string {
  return `
    <div class="crop-editor-card" data-side="${side}">
      <div class="crop-editor-toolbar">
        <span class="crop-editor-label">${side.toUpperCase()}</span>
        <div class="segmented" data-side="${side}" role="group" aria-label="${sideLabel(side)} crop to adjust">
          <button class="crop-kind-button" type="button" data-kind="stats" aria-pressed="true">Stat window</button>
          <button class="crop-kind-button" type="button" data-kind="health" aria-pressed="false">Health bar</button>
          <button class="crop-kind-button" type="button" data-kind="anvil" aria-pressed="false">Anvil count</button>
        </div>
        <button class="ghost-button reset-crop" type="button" data-side="${side}">Reset</button>
      </div>
      <div class="crop-editor" data-side="${side}">
        <img class="crop-source" alt="${sideLabel(side)} screenshot with crop boxes" />
        <div class="crop-selection" data-kind="stats" aria-hidden="true"></div>
        <div class="crop-selection" data-kind="health" aria-hidden="true"></div>
        <div class="crop-selection" data-kind="anvil" aria-hidden="true"></div>
      </div>
    </div>`;
}

async function initialize(): Promise<void> {
  const app = appElement!;
  const configUrl = `${import.meta.env.BASE_URL}config/background-config.json`;
  const config = await fetch(configUrl).then((response) => {
    if (!response.ok) throw new Error("Could not load background configuration");
    return response.json() as Promise<CanvasConfig>;
  });

  app.innerHTML = `
  <main class="app">
    <header class="topbar">
      <div class="wordmark"><span class="wordmark-mark" aria-hidden="true">SA</span>Stat Anvil Tracker</div>
      <span class="topbar-note">Before → After stat sheet for League of Legends</span>
    </header>

    <section class="step" aria-labelledby="step-input-title">
      <div class="step-head">
        <span class="step-number">1</span>
        <div class="step-titles">
          <h2 id="step-input-title">Screenshots</h2>
          <p>Paste with Ctrl+V into the highlighted slot; the next paste goes to the other one.</p>
        </div>
        <div class="step-actions">
          <button id="load-example-pair" class="ghost-button" type="button">Load example pair</button>
          <button id="clear-screenshots" class="ghost-button" type="button">Clear</button>
        </div>
      </div>
      <div class="drop-grid">
        ${dropZoneMarkup("before")}
        ${dropZoneMarkup("after")}
      </div>
    </section>

    <section id="review" class="step" aria-labelledby="step-review-title" hidden>
      <div class="step-head">
        <span class="step-number">2</span>
        <div class="step-titles">
          <h2 id="step-review-title">Review</h2>
          <p>Check the crops and the values read from them. Edit any value to correct it.</p>
        </div>
        <div class="step-actions">
          <span id="review-status" class="status-pill" role="status">Waiting</span>
        </div>
      </div>
      <progress id="ocr-progress" class="ocr-progress" max="1" value="0" hidden></progress>
      <div class="crop-previews">
        ${cropPreviewMarkup("before")}
        ${cropPreviewMarkup("after")}
      </div>
      <details class="disclosure adjust-crops">
        <summary>Crops look off? Adjust them</summary>
        <p class="disclosure-note">Pick a crop, then drag its box to move it or drag on the image to draw a new one. Values are re-read when you let go.</p>
        <div class="crop-editors">
          ${cropEditorMarkup("before")}
          ${cropEditorMarkup("after")}
        </div>
      </details>
      <div class="stat-table" role="table" aria-label="Detected stats">
        <div class="stat-row stat-header" role="row">
          <span role="columnheader">Stat</span>
          <span role="columnheader">Before</span>
          <span role="columnheader">After</span>
          <span role="columnheader">Change</span>
        </div>
        <div id="stat-rows" role="rowgroup"></div>
      </div>
      <div class="legend">
        <span><i class="legend-swatch is-missing"></i>Missing: enter it</span>
        <span><i class="legend-swatch is-low"></i>Low confidence: double-check</span>
      </div>
    </section>

    <section class="step" aria-labelledby="step-output-title">
      <div class="step-head">
        <span class="step-number">3</span>
        <div class="step-titles">
          <h2 id="step-output-title">Output</h2>
          <p>Pick a background. Uploaded backgrounds are saved in this browser.</p>
        </div>
      </div>
      <div class="background-picker" role="group" aria-label="Background">
        <label class="background-upload">
          <input id="background-upload" type="file" accept="image/*" multiple hidden />
          <span class="background-upload-plus" aria-hidden="true">+</span>
          <span>Upload</span>
        </label>
      </div>
      <div class="canvas-frame">
        <span id="sample-badge" class="sample-badge">SAMPLE DATA</span>
        <canvas id="result-canvas" aria-label="Generated stat image"></canvas>
      </div>
      <div class="output-actions">
        <button id="guides-toggle" class="ghost-button" type="button" aria-pressed="false">Show slot guides</button>
        <button id="download-button" class="primary-button" type="button">Download PNG</button>
      </div>
    </section>

    <details class="disclosure advanced">
      <summary>Advanced: vision fallback</summary>
      <div class="vision-panel">
        <label class="toggle-row">
          <input id="vision-enabled" type="checkbox" />
          <span>Send low-confidence values to a vision proxy (off by default)</span>
        </label>
        <div id="vision-settings" class="vision-fields" hidden>
          <label>Proxy URL
            <input id="vision-proxy-url" type="url" placeholder="https://your-worker.example/extract" autocomplete="url" />
          </label>
          <label>Bring-your-own key (optional)
            <input id="vision-api-key" type="password" autocomplete="off" />
          </label>
          <label>Fallback below confidence <output id="vision-confidence-value">55%</output>
            <input id="vision-confidence" type="range" min="30" max="90" value="55" />
          </label>
          <p class="disclosure-note">The key is stored in this browser and sent only to the configured proxy.</p>
        </div>
        <span id="vision-status" class="disclosure-note" role="status">Disabled</span>
      </div>
    </details>
  </main>`;

  const outputCanvas = query<HTMLCanvasElement>(app, "#result-canvas");
  const backgroundPicker = query<HTMLDivElement>(app, ".background-picker");
  const backgroundUploadInput = query<HTMLInputElement>(app, "#background-upload");
  const guidesToggle = query<HTMLButtonElement>(app, "#guides-toggle");
  const downloadButton = query<HTMLButtonElement>(app, "#download-button");
  const sampleBadge = query<HTMLSpanElement>(app, "#sample-badge");
  const reviewPanel = query<HTMLElement>(app, "#review");
  const reviewStatus = query<HTMLSpanElement>(app, "#review-status");
  const ocrProgress = query<HTMLProgressElement>(app, "#ocr-progress");
  const statRows = query<HTMLDivElement>(app, "#stat-rows");
  const visionEnabledControl = query<HTMLInputElement>(app, "#vision-enabled");
  const visionSettingsPanel = query<HTMLDivElement>(app, "#vision-settings");
  const visionProxyUrlInput = query<HTMLInputElement>(app, "#vision-proxy-url");
  const visionApiKeyInput = query<HTMLInputElement>(app, "#vision-api-key");
  const visionConfidenceControl = query<HTMLInputElement>(app, "#vision-confidence");
  const visionConfidenceOutput = query<HTMLOutputElement>(app, "#vision-confidence-value");
  const visionStatusMessage = query<HTMLSpanElement>(app, "#vision-status");

  type ScreenshotCrops = Record<CropKind, CropRect>;
  type ScreenshotDetections = {
    stats: CropDetection;
    health: CropDetection;
    anvil: AnvilCounterDetection;
  };
  interface StatReading {
    value: string;
    confidence: number;
    /** Passed a strict format check, so a low OCR score isn't a reason to flag it. */
    verified?: boolean;
    edited?: boolean;
  }

  const screenshotUrls: Partial<Record<Side, string>> = {};
  const screenshotImages: Partial<Record<Side, HTMLImageElement>> = {};
  const screenshotPixels: Partial<Record<Side, ImageData>> = {};
  const cropRects: Partial<Record<Side, ScreenshotCrops>> = {};
  const cropDetections: Partial<Record<Side, ScreenshotDetections>> = {};
  const activeCropKinds: Record<Side, CropKind> = { before: "stats", after: "stats" };
  /** Readings per stat and side; empty until the first extraction finishes. */
  const readings = new Map<string, Record<Side, StatReading>>();
  /** Fortune is never read from screenshots, so keep what the user typed across runs. */
  const fortune: Record<Side, string> = { before: "", after: "" };
  let pasteTarget: Side = "before";
  let extractionRun = 0;
  let localOcrWorkerPromise: Promise<LocalOcrWorker> | undefined;
  let showGuides = false;

  // ---------- Output ----------

  let backgrounds: BackgroundConfig[] = [...config.backgrounds];
  let selectedBackground = backgrounds[0]!;
  let selectedImage: HTMLImageElement | undefined;

  const backgroundUrl = (background: BackgroundConfig) =>
    /^(blob:|data:|https?:)/.test(background.image)
      ? background.image
      : `${import.meta.env.BASE_URL}${background.image}`;

  function displayValue(id: string, value: string): string {
    if (!value) return "0";
    if (id === "health" && /^\d+$/.test(value)) return Number(value).toLocaleString("en-US");
    return value.replace(/\s*\|\s*/g, " | ");
  }

  function outputValues(): Record<string, RenderValue> {
    if (readings.size === 0) return SAMPLE_VALUES;
    const values: Record<string, RenderValue> = {};
    for (const { id } of STATS) {
      const reading = readings.get(id);
      if (!reading) continue;
      values[id] = {
        value: displayValue(id, reading.after.value),
        delta: formatStatDiff(reading.before.value, reading.after.value),
      };
    }
    return values;
  }

  function draw(): void {
    sampleBadge.hidden = readings.size > 0;
    renderBackground(outputCanvas, config, selectedBackground, selectedImage, outputValues(), showGuides);
  }

  function chooseBackground(background: BackgroundConfig): void {
    selectedBackground = background;
    selectedImage = undefined;
    saveSelectedBackgroundId(background.id);
    for (const option of backgroundPicker.querySelectorAll<HTMLElement>(".background-option")) {
      option.setAttribute("aria-pressed", String(option.dataset.id === background.id));
    }
    draw();
    const image = new Image();
    image.onload = () => {
      if (selectedBackground.id !== background.id) return;
      selectedImage = image;
      draw();
    };
    image.src = backgroundUrl(background);
  }

  function renderBackgroundPicker(): void {
    for (const option of backgroundPicker.querySelectorAll(".background-option")) option.remove();
    const uploadTile = query<HTMLLabelElement>(backgroundPicker, ".background-upload");
    for (const background of backgrounds) {
      const option = document.createElement("div");
      option.className = "background-option";
      option.dataset.id = background.id;
      option.setAttribute("aria-pressed", String(background.id === selectedBackground.id));

      const select = document.createElement("button");
      select.type = "button";
      select.className = "background-select";
      select.style.backgroundImage = `url("${backgroundUrl(background)}")`;
      select.setAttribute("aria-label", `Use ${background.label}`);
      select.addEventListener("click", () => chooseBackground(background));

      const name = document.createElement("span");
      name.className = "background-name";
      name.textContent = background.label;
      option.append(select, name);

      if (background.id.startsWith("upload-")) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "background-remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove ${background.label}`);
        remove.addEventListener("click", async () => {
          await deleteBackground(background.id);
          URL.revokeObjectURL(background.image);
          backgrounds = backgrounds.filter((candidate) => candidate.id !== background.id);
          if (selectedBackground.id === background.id) chooseBackground(backgrounds[0]!);
          renderBackgroundPicker();
        });
        option.append(remove);
      }
      backgroundPicker.insertBefore(option, uploadTile);
    }
  }

  function uploadedBackgroundConfig(id: string, name: string, blob: Blob): BackgroundConfig {
    // Uploads have no slot layout of their own; the renderer falls back to the first configured one.
    return {
      id,
      label: name,
      image: URL.createObjectURL(blob),
      backgroundColor: "#101312",
      accentColor: "#8a8f86",
      slots: [],
    };
  }

  backgroundUploadInput.addEventListener("change", async () => {
    const files = Array.from(backgroundUploadInput.files ?? []).filter((file) => file.type.startsWith("image/"));
    backgroundUploadInput.value = "";
    let last: BackgroundConfig | undefined;
    for (const file of files) {
      const stored = await saveBackground(file);
      last = uploadedBackgroundConfig(stored.id, stored.name, stored.blob);
      backgrounds.push(last);
    }
    renderBackgroundPicker();
    if (last) chooseBackground(last);
  });

  guidesToggle.addEventListener("click", () => {
    showGuides = !showGuides;
    guidesToggle.setAttribute("aria-pressed", String(showGuides));
    guidesToggle.textContent = showGuides ? "Hide slot guides" : "Show slot guides";
    draw();
  });

  downloadButton.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = "stat-anvil-tracker.png";
    link.href = outputCanvas.toDataURL("image/png");
    link.click();
  });

  // ---------- Screenshot input ----------

  function setPasteTarget(side: Side): void {
    pasteTarget = side;
    for (const zone of app.querySelectorAll<HTMLElement>(".drop-zone")) {
      zone.classList.toggle("is-target", zone.dataset.side === side);
    }
  }

  function setScreenshot(side: Side, file: File): void {
    if (!file.type.startsWith("image/")) return;
    const zone = query<HTMLElement>(app, `.drop-zone[data-side="${side}"]`);
    const preview = query<HTMLImageElement>(zone, ".drop-zone-image");
    const empty = query<HTMLElement>(zone, ".drop-zone-empty");

    const previousUrl = screenshotUrls[side];
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const url = URL.createObjectURL(file);
    screenshotUrls[side] = url;
    preview.src = url;
    preview.hidden = false;
    empty.hidden = true;
    zone.classList.add("has-image");
    setPasteTarget(side === "before" ? "after" : "before");

    const image = new Image();
    image.onload = () => {
      if (screenshotUrls[side] !== url) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0);
      screenshotImages[side] = image;
      screenshotPixels[side] = context.getImageData(0, 0, canvas.width, canvas.height);
      if (screenshotPixels.before && screenshotPixels.after) detectAndRead();
    };
    image.src = url;
  }

  function clearScreenshots(): void {
    extractionRun += 1;
    for (const side of SIDES) {
      const url = screenshotUrls[side];
      if (url) URL.revokeObjectURL(url);
      delete screenshotUrls[side];
      delete screenshotImages[side];
      delete screenshotPixels[side];
      delete cropRects[side];
      delete cropDetections[side];
      const zone = query<HTMLElement>(app, `.drop-zone[data-side="${side}"]`);
      query<HTMLImageElement>(zone, ".drop-zone-image").hidden = true;
      query<HTMLElement>(zone, ".drop-zone-empty").hidden = false;
      zone.classList.remove("has-image");
    }
    readings.clear();
    reviewPanel.hidden = true;
    setPasteTarget("before");
    draw();
  }

  for (const zone of app.querySelectorAll<HTMLElement>(".drop-zone")) {
    const side = zone.dataset.side as Side;
    const input = query<HTMLInputElement>(zone, ".drop-zone-file");
    zone.addEventListener("click", () => setPasteTarget(side));
    zone.addEventListener("focus", () => setPasteTarget(side));
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("is-dragging");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-dragging"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragging");
      const file = event.dataTransfer?.files[0];
      if (file) setScreenshot(side, file);
    });
    query<HTMLButtonElement>(zone, ".choose-file").addEventListener("click", (event) => {
      event.stopPropagation();
      input.click();
    });
    zone.addEventListener("dblclick", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) setScreenshot(side, file);
      input.value = "";
    });
  }

  document.addEventListener("paste", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea")) return;
    const file = Array.from(event.clipboardData?.items ?? [])
      .find((item) => item.type.startsWith("image/"))?.getAsFile();
    if (!file) return;
    event.preventDefault();
    setScreenshot(pasteTarget, file);
  });

  query<HTMLButtonElement>(app, "#clear-screenshots").addEventListener("click", clearScreenshots);
  query<HTMLButtonElement>(app, "#load-example-pair").addEventListener("click", async () => {
    try {
      await Promise.all(SIDES.map(async (side) => {
        const response = await fetch(`${import.meta.env.BASE_URL}screenshots/${side}.png`);
        if (!response.ok) throw new Error("Example screenshot could not be loaded");
        setScreenshot(side, new File([await response.blob()], `${side}.png`, { type: "image/png" }));
      }));
    } catch {
      reviewStatus.textContent = "Example screenshots are unavailable";
    }
  });

  // ---------- Detection and crop previews ----------

  function detectAndRead(): void {
    const before = screenshotPixels.before;
    const after = screenshotPixels.after;
    if (!before || !after) return;
    const statDetections = detectStatWindowPair(before, after);
    for (const side of SIDES) {
      const pixels = screenshotPixels[side]!;
      const stats = statDetections[side];
      const health = detectHealthBar(pixels, stats.rect);
      const anvil = detectAnvilCounter(pixels, stats.rect, health.rect);
      cropDetections[side] = { stats, health, anvil };
      cropRects[side] = { stats: stats.rect, health: health.rect, anvil: anvil.rect };
    }
    reviewPanel.hidden = false;
    updateCropViews();
    void readAllStats();
  }

  function updateCropViews(): void {
    for (const side of SIDES) {
      const image = screenshotImages[side];
      const crops = cropRects[side];
      const detections = cropDetections[side];
      if (!image || !crops || !detections) continue;

      for (const kind of ["stats", "health", "anvil"] as const) {
        const target = query<HTMLCanvasElement>(app, `.crop-canvas[data-kind="${kind}"][data-side="${side}"]`);
        const crop = cropImageToCanvas(image, crops[kind], 3);
        target.width = crop.width;
        target.height = crop.height;
        target.getContext("2d")?.drawImage(crop, 0, 0);
      }

      const status = query<HTMLSpanElement>(app, `.detection-status[data-side="${side}"]`);
      const detection = detections.stats;
      const found = detection.method === "left-panel" || detection.method === "bottom-aligned" ||
        detection.method === "panel-image";
      status.textContent = found ? (detection.method === "bottom-aligned" ? "aligned to After" : "auto") : "not found: adjust";
      status.classList.toggle("is-warning", !found || detection.confidence < 0.5);
      status.title = `Stat window ${detection.method} ${Math.round(detection.confidence * 100)}%, ` +
        `health ${detections.health.method} ${Math.round(detections.health.confidence * 100)}%, ` +
        `anvil ${detections.anvil.method} ${Math.round(detections.anvil.confidence * 100)}%`;

      const editor = query<HTMLElement>(app, `.crop-editor[data-side="${side}"]`);
      const source = query<HTMLImageElement>(editor, ".crop-source");
      if (source.src !== image.src) source.src = image.src;
      for (const kind of ["stats", "health", "anvil"] as const) {
        const rect = crops[kind];
        const selection = query<HTMLDivElement>(editor, `.crop-selection[data-kind="${kind}"]`);
        selection.style.left = `${rect.x * 100}%`;
        selection.style.top = `${rect.y * 100}%`;
        selection.style.width = `${rect.width * 100}%`;
        selection.style.height = `${rect.height * 100}%`;
        selection.classList.toggle("is-active", activeCropKinds[side] === kind);
      }
    }
  }

  // ---------- Reading ----------

  function getLocalOcrWorker(): Promise<LocalOcrWorker> {
    if (!localOcrWorkerPromise) {
      localOcrWorkerPromise = createLocalOcrWorker(
        import.meta.env.BASE_URL,
        ({ progress }) => {
          ocrProgress.value = progress;
        },
      ).catch((error: unknown) => {
        localOcrWorkerPromise = undefined;
        throw error;
      });
    }
    return localOcrWorkerPromise;
  }

  async function readAnvilCount(side: Side, worker: LocalOcrWorker): Promise<StatReading | undefined> {
    const image = screenshotPixels[side];
    const crops = cropRects[side];
    const detection = cropDetections[side]?.anvil;
    if (!image || !crops || !detection || detection.confidence < 0.35) return undefined;

    // The count sits at a fixed spot relative to the icon crop, which the user may have moved.
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
    return count && { value: count.value, confidence: Math.min(count.confidence, detection.confidence) };
  }

  async function readHealthValue(side: Side, worker: LocalOcrWorker): Promise<StatReading | undefined> {
    const image = screenshotPixels[side];
    const crops = cropRects[side];
    if (!image || !crops) return undefined;
    const reading = await readHealth(
      image,
      toPixelRect(crops.health, image.width, image.height),
      (part) => recognizeOcrPixels(worker, part, HEALTH_CHARACTERS),
    );
    // Health is checked by its strict "current / max" format; Tesseract under-scores this text.
    return reading && { ...reading, verified: true };
  }

  async function readAllStats(): Promise<void> {
    const run = ++extractionRun;
    const before = screenshotPixels.before;
    const after = screenshotPixels.after;
    const beforeRects = cropRects.before;
    const afterRects = cropRects.after;
    if (!before || !after || !beforeRects || !afterRects) return;

    reviewStatus.textContent = "Reading…";
    reviewStatus.dataset.state = "busy";
    ocrProgress.hidden = false;
    try {
      const worker = await getLocalOcrWorker();
      if (run !== extractionRun) return;
      const recognize = (part: PixelImage) => recognizeOcrPixels(worker, part);
      const panelStats: Record<Side, ExtractedStat[]> = {
        before: await extractPanelStats(before, toPixelRect(beforeRects.stats, before.width, before.height), recognize),
        after: await extractPanelStats(after, toPixelRect(afterRects.stats, after.width, after.height), recognize),
      };
      const health = { before: await readHealthValue("before", worker), after: await readHealthValue("after", worker) };
      const anvil = { before: await readAnvilCount("before", worker), after: await readAnvilCount("after", worker) };
      if (run !== extractionRun) return;

      const vision = await maybeRequestVision(panelStats);
      if (run !== extractionRun) return;
      if (vision) {
        for (const side of SIDES) panelStats[side] = applyVisionResults(panelStats[side], side, vision);
      }

      readings.clear();
      const missing: StatReading = { value: "", confidence: 0 };
      for (const { id, source } of STATS) {
        const sideReading = (side: Side): StatReading => {
          if (source === "panel") return panelStats[side].find((stat) => stat.id === id) ?? missing;
          if (source === "health") return health[side] ?? missing;
          if (source === "anvil") return anvil[side] ?? missing;
          return { value: fortune[side], confidence: 1, edited: fortune[side] !== "" };
        };
        readings.set(id, { before: sideReading("before"), after: sideReading("after") });
      }
      renderStatRows();
      draw();
    } catch {
      if (run === extractionRun) {
        reviewStatus.textContent = "OCR could not start. Reload and try again.";
        reviewStatus.dataset.state = "error";
      }
    } finally {
      if (run === extractionRun) ocrProgress.hidden = true;
    }
  }

  // ---------- Review table ----------

  function readingState(reading: StatReading): "missing" | "low" | "ok" {
    if (reading.value.trim() === "") return "missing";
    if (reading.edited || reading.verified) return "ok";
    return reading.confidence < LOW_CONFIDENCE ? "low" : "ok";
  }

  function updateReviewStatus(): void {
    let missing = 0;
    let low = 0;
    for (const reading of readings.values()) {
      for (const side of SIDES) {
        const state = readingState(reading[side]);
        if (state === "missing") missing += 1;
        if (state === "low") low += 1;
      }
    }
    const parts: string[] = [];
    if (missing) parts.push(`${missing} missing`);
    if (low) parts.push(`${low} to check`);
    reviewStatus.textContent = parts.length ? parts.join(" · ") : "All values read";
    reviewStatus.dataset.state = missing ? "error" : low ? "warning" : "ok";
  }

  function renderStatRows(): void {
    statRows.replaceChildren();
    for (const { id, label, source } of STATS) {
      const reading = readings.get(id);
      if (!reading) continue;
      const row = document.createElement("div");
      row.className = "stat-row";
      row.setAttribute("role", "row");

      const name = document.createElement("span");
      name.className = "stat-name";
      name.setAttribute("role", "rowheader");
      name.textContent = label;
      if (source === "manual") {
        const tag = document.createElement("span");
        tag.className = "stat-tag";
        tag.textContent = "manual";
        name.append(tag);
      }

      const change = document.createElement("span");
      change.className = "stat-change";
      const updateChange = () => {
        change.textContent = formatStatDiff(reading.before.value, reading.after.value) || "—";
      };

      const inputs = SIDES.map((side) => {
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.className = "stat-input";
        input.value = reading[side].value;
        input.placeholder = source === "manual" ? "enter" : "—";
        input.setAttribute("aria-label", `${label} ${side}`);
        const applyState = () => {
          const state = readingState(reading[side]);
          input.dataset.state = state;
          input.title = reading[side].edited
            ? "Edited by you"
            : state === "missing"
              ? source === "manual" ? "Enter this value" : "Could not read this value; enter it"
              : reading[side].verified
                ? "Read and format-checked"
                : `OCR confidence ${Math.round(reading[side].confidence * 100)}%`;
        };
        applyState();
        input.addEventListener("input", () => {
          reading[side] = { value: input.value.trim(), confidence: 1, edited: true };
          if (source === "manual") fortune[side] = input.value.trim();
          applyState();
          updateChange();
          updateReviewStatus();
          draw();
        });
        return input;
      });

      updateChange();
      row.append(name, ...inputs, change);
      statRows.append(row);
    }
    updateReviewStatus();
  }

  // ---------- Optional vision fallback ----------

  function applyVisionResults(localStats: ExtractedStat[], side: Side, visionResults: VisionResult[]): ExtractedStat[] {
    const overrides = new Map(
      visionResults.filter((result) => result.side === side).map((result) => [result.id, result]),
    );
    return localStats.map((stat) => {
      const override = overrides.get(stat.id);
      return override ? { ...stat, value: override.value, confidence: override.confidence } : stat;
    });
  }

  async function maybeRequestVision(panelStats: Record<Side, ExtractedStat[]>): Promise<VisionResult[] | undefined> {
    if (!visionEnabledControl.checked) return undefined;
    const threshold = Number(visionConfidenceControl.value) / 100;
    const tasks: VisionTask[] = SIDES.flatMap((side) => panelStats[side]
      .filter((stat) => stat.confidence < threshold)
      .map(({ id }) => ({ id, side })));
    if (tasks.length === 0) {
      visionStatusMessage.textContent = "No values below the fallback threshold; no proxy request was made.";
      return undefined;
    }

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

    const images: Partial<Record<Side, string>> = {};
    for (const task of tasks) {
      const image = screenshotImages[task.side];
      const crops = cropRects[task.side];
      if (images[task.side] || !image || !crops) continue;
      images[task.side] = cropImageToCanvas(image, crops.stats, 4).toDataURL("image/png");
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
        body: JSON.stringify({ prompt: buildVisionPrompt(tasks), expectedCount: tasks.length, tasks, images }),
        signal: controller.signal,
      });
      if (!response.ok) {
        visionStatusMessage.textContent = `Proxy returned HTTP ${response.status}.`;
        return undefined;
      }
      const results = validateVisionResponse(await response.json() as unknown, tasks);
      visionStatusMessage.textContent = results
        ? `Proxy returned ${results.length} validated value${results.length === 1 ? "" : "s"}.`
        : "Proxy response did not match the requested JSON values.";
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

  const visionPreferences = loadVisionPreferences();
  visionEnabledControl.checked = visionPreferences.enabled;
  visionProxyUrlInput.value = visionPreferences.proxyUrl;
  visionApiKeyInput.value = visionPreferences.apiKey;
  visionConfidenceControl.value = String(visionPreferences.confidenceThreshold);
  visionConfidenceOutput.value = `${visionPreferences.confidenceThreshold}%`;
  visionSettingsPanel.hidden = !visionPreferences.enabled;
  visionStatusMessage.textContent = visionPreferences.enabled ? "Enabled" : "Disabled";
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

  // ---------- Manual crop adjustment ----------

  function setActiveCropKind(side: Side, kind: CropKind): void {
    activeCropKinds[side] = kind;
    for (const button of app.querySelectorAll<HTMLButtonElement>(`.segmented[data-side="${side}"] .crop-kind-button`)) {
      button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
    }
    updateCropViews();
  }

  for (const editor of app.querySelectorAll<HTMLElement>(".crop-editor")) {
    const side = editor.dataset.side as Side;
    let dragState: {
      mode: "move" | "create";
      kind: CropKind;
      pointerId: number;
      startX: number;
      startY: number;
      initialRect: CropRect;
    } | undefined;

    const pointerPosition = (event: PointerEvent) => {
      const bounds = query<HTMLImageElement>(editor, ".crop-source").getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
        y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
      };
    };

    editor.addEventListener("pointerdown", (event) => {
      const crops = cropRects[side];
      if (!crops) return;
      const clicked = (event.target as HTMLElement).closest<HTMLDivElement>(".crop-selection");
      const kind = (clicked?.dataset.kind as CropKind | undefined) ?? activeCropKinds[side];
      setActiveCropKind(side, kind);
      const { x, y } = pointerPosition(event);
      dragState = {
        mode: clicked ? "move" : "create",
        kind,
        pointerId: event.pointerId,
        startX: x,
        startY: y,
        initialRect: crops[kind],
      };
      editor.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    editor.addEventListener("pointermove", (event) => {
      const crops = cropRects[side];
      if (!dragState || dragState.pointerId !== event.pointerId || !crops) return;
      const { x, y } = pointerPosition(event);
      const deltaX = x - dragState.startX;
      const deltaY = y - dragState.startY;
      crops[dragState.kind] = dragState.mode === "move"
        ? clampCropRect({ ...dragState.initialRect, x: dragState.initialRect.x + deltaX, y: dragState.initialRect.y + deltaY })
        : clampCropRect({
          x: Math.min(dragState.startX, x),
          y: Math.min(dragState.startY, y),
          width: Math.max(0.005, Math.abs(deltaX)),
          height: Math.max(0.005, Math.abs(deltaY)),
        });
      updateCropViews();
    });

    const finishDrag = (event: PointerEvent) => {
      if (dragState?.pointerId !== event.pointerId) return;
      dragState = undefined;
      void readAllStats();
    };
    editor.addEventListener("pointerup", finishDrag);
    editor.addEventListener("pointercancel", finishDrag);
  }

  for (const button of app.querySelectorAll<HTMLButtonElement>(".crop-kind-button")) {
    button.addEventListener("click", () => {
      const side = button.closest<HTMLElement>(".segmented")?.dataset.side as Side;
      setActiveCropKind(side, button.dataset.kind as CropKind);
    });
  }

  for (const button of app.querySelectorAll<HTMLButtonElement>(".reset-crop")) {
    button.addEventListener("click", () => {
      const side = button.dataset.side as Side;
      const crops = cropRects[side];
      const detections = cropDetections[side];
      if (!crops || !detections) return;
      const kind = activeCropKinds[side];
      crops[kind] = detections[kind].rect;
      updateCropViews();
      void readAllStats();
    });
  }

  // ---------- Startup ----------

  for (const stored of await listStoredBackgrounds()) {
    backgrounds.push(uploadedBackgroundConfig(stored.id, stored.name, stored.blob));
  }
  const savedId = loadSelectedBackgroundId();
  selectedBackground = backgrounds.find((background) => background.id === savedId) ?? backgrounds[0]!;
  renderBackgroundPicker();
  chooseBackground(selectedBackground);
  setPasteTarget("before");
}

void initialize();
