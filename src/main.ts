import "./styles.css";
import {
  cardRect,
  loadOutputFont,
  renderOutput,
  type BackgroundEntry,
  type OutputConfig,
  type SlotLayout,
} from "./core/render";
import {
  buildSlotRuns,
  DELTA_PRESETS,
  describeDelta,
  normalizeStatInput,
  type DeltaColor,
  type StatPair,
  type TextRun,
} from "./core/output-format";
import {
  clampCropRect,
  cropImageToCanvas,
  type CropRect,
} from "./core/crop";
import {
  detectAnvilCounter,
  detectHealthBar,
  detectStatPanel,
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
import { readOutputValues, TOP_PANEL_STATS } from "./core/output-reader";
import {
  deleteBackground,
  listStoredBackgrounds,
  loadImage,
  saveImage,
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

/** Review rows in output order. Shard shares the anvil slot ("shard | count") and is optional. */
const STATS: Array<{ id: string; label: string; source: StatSource; optional?: boolean }> = [
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
  { id: "shard", label: "Shard", source: "manual", optional: true },
  { id: "anvilCount", label: "Anvil Count", source: "anvil" },
];

/** OCR confidence below this is flagged yellow for a second look. */
const LOW_CONFIDENCE = 0.75;

/** Shown on the output preview until real values have been read. */
const SAMPLE_PAIRS: Record<string, StatPair> = {
  health: { before: "5187", after: "6297" },
  attackDamage: { before: "97", after: "97" },
  abilityPower: { before: "100", after: "112" },
  attackSpeed: { before: "3.66", after: "5.48" },
  armor: { before: "550", after: "648" },
  magicResistance: { before: "577", after: "726" },
  abilityHaste: { before: "500", after: "500" },
  criticalStrikeChance: { before: "0%", after: "84%" },
  omnivamp: { before: "30%", after: "34%" },
  armorPenetration: { before: "0|0%", after: "0|0%" },
  magicPenetration: { before: "30|0%", after: "34|0%" },
  movementSpeed: { before: "367", after: "367" },
  tenacity: { before: "0%", after: "0%" },
  healAndShieldPower: { before: "0%", after: "0%" },
  fortune: { before: "2000", after: "4000" },
  shard: { before: "100%", after: "124%" },
  anvilCount: { before: "51", after: "65" },
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

/** Manual fields and their defaults; their last values are remembered between visits. */
const MANUAL_DEFAULTS: Record<string, string> = { fortune: "", shard: "0%" };

function manualStorageKey(id: string): string {
  return `stat-anvil-${id}-v1`;
}

function loadManualValue(id: string): Record<Side, string> {
  const fallback = MANUAL_DEFAULTS[id] ?? "";
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(manualStorageKey(id)) ?? "null");
    if (typeof parsed === "object" && parsed !== null) {
      const { before, after } = parsed as Partial<Record<Side, unknown>>;
      return {
        before: typeof before === "string" ? before : fallback,
        after: typeof after === "string" ? after : fallback,
      };
    }
  } catch {
    // Fall through to defaults when storage is blocked or holds something unexpected.
  }
  return { before: fallback, after: fallback };
}

function saveManualValue(id: string, values: Record<Side, string>): void {
  try {
    localStorage.setItem(manualStorageKey(id), JSON.stringify(values));
  } catch {
    // Remembering manual values is a convenience; the review step still shows them.
  }
}

const LAYOUT_STORAGE_KEY = "stat-anvil-layout-v1";

/** Per-background slot layouts the user adjusted, keyed by background id. */
function loadLayoutOverrides(): Record<string, SlotLayout[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, SlotLayout[]> : {};
  } catch {
    return {};
  }
}

function saveLayoutOverrides(overrides: Record<string, SlotLayout[]>): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Without storage, layout tweaks last until the page is closed.
  }
}

const PREVIOUS_OUTPUT_KEY = "stat-anvil-previous-output-v1";
/** IndexedDB key of the previous output's image, shown as a preview. */
const PREVIOUS_IMAGE_KEY = "previous-output";

/** The After values of the last output, used for Before stats a collapsed panel hides. */
interface PreviousOutput {
  savedAt: number;
  source: "download" | "clear" | "upload";
  values: Record<string, string>;
}

function loadPreviousOutput(): PreviousOutput | undefined {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREVIOUS_OUTPUT_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Partial<PreviousOutput>;
    if (typeof candidate.savedAt !== "number" || typeof candidate.values !== "object" || candidate.values === null) {
      return undefined;
    }
    return candidate as PreviousOutput;
  } catch {
    return undefined;
  }
}

function savePreviousOutput(previous: PreviousOutput): void {
  try {
    localStorage.setItem(PREVIOUS_OUTPUT_KEY, JSON.stringify(previous));
  } catch {
    // Without storage the previous output lasts until the page is closed.
  }
}

function colorCss(color: DeltaColor): string {
  return color.kind === "solid" ? color.color : `linear-gradient(${color.top}, ${color.bottom})`;
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
  const configUrl = `${import.meta.env.BASE_URL}config/output-config.json`;
  const config = await fetch(configUrl).then((response) => {
    if (!response.ok) throw new Error("Could not load background configuration");
    return response.json() as Promise<OutputConfig>;
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
      <div id="previous-output" class="previous-output" hidden>
        <button id="previous-output-preview" class="previous-output-thumb" type="button" hidden aria-label="View the previous output">
          <img alt="" />
        </button>
        <span id="previous-output-message"></span>
        <label class="ghost-button previous-output-upload">
          <input id="previous-output-file" type="file" accept="image/*" hidden />
          <span id="previous-output-button">Upload previous PNG</span>
        </label>
      </div>
      <div class="stat-table" role="table" aria-label="Detected stats">
        <div class="stat-row stat-header" role="row">
          <span role="columnheader">Stat</span>
          <span role="columnheader">Before</span>
          <span role="columnheader">After</span>
          <span role="columnheader">Change</span>
          <span role="columnheader" class="visually-hidden">Color</span>
        </div>
        <div id="stat-rows" role="rowgroup"></div>
      </div>
      <div class="legend">
        <span><i class="legend-swatch is-missing"></i>Missing: enter it</span>
        <span><i class="legend-swatch is-low"></i>Double-check: low confidence or remembered from last time</span>
        <span><i class="legend-swatch is-previous"></i>From your previous output</span>
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
        <div id="layout-overlay" class="layout-overlay" hidden></div>
      </div>
      <div class="output-actions">
        <button id="layout-reset" class="ghost-button" type="button" hidden>Reset layout</button>
        <button id="layout-toggle" class="ghost-button" type="button" aria-pressed="false">Adjust layout</button>
        <button id="download-button" class="primary-button" type="button">Download PNG</button>
      </div>
      <p id="layout-hint" class="disclosure-note" hidden>Drag a box to move a line; drag its corner to resize. Changes are saved for this background.</p>
    </section>

    <dialog id="previous-output-dialog" class="image-dialog" aria-label="Previous output">
      <form method="dialog" class="image-dialog-bar">
        <span>Previous output</span>
        <button class="ghost-button" type="submit">Close</button>
      </form>
      <img alt="The previous stat sheet these values came from" />
    </dialog>

    <div id="delta-color-popover" class="color-popover" popover>
      <span class="color-popover-title">Change color</span>
      <div class="color-presets">
        <button class="color-chip" type="button" data-preset="green"><i style="background:${colorCss(DELTA_PRESETS.green)}"></i>Green</button>
        <button class="color-chip" type="button" data-preset="red"><i style="background:${colorCss(DELTA_PRESETS.red)}"></i>Red</button>
        <button class="color-chip" type="button" data-preset="purple"><i style="background:${colorCss(DELTA_PRESETS.purple)}"></i>Purple</button>
      </div>
      <label class="color-custom">Custom <input id="delta-color-custom" type="color" value="#00ff18" /></label>
    </div>

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
  const layoutToggle = query<HTMLButtonElement>(app, "#layout-toggle");
  const layoutReset = query<HTMLButtonElement>(app, "#layout-reset");
  const layoutHint = query<HTMLParagraphElement>(app, "#layout-hint");
  const layoutOverlay = query<HTMLDivElement>(app, "#layout-overlay");
  // Slot positions are relative to the card, so the layout boxes cover just the card.
  {
    const card = cardRect(config);
    const { width, height } = config.output;
    layoutOverlay.style.inset = [
      card.y / height,
      (width - card.x - card.width) / width,
      (height - card.y - card.height) / height,
      card.x / width,
    ].map((fraction) => `${fraction * 100}%`).join(" ");
  }
  const colorPopover = query<HTMLDivElement>(app, "#delta-color-popover");
  const colorCustomInput = query<HTMLInputElement>(app, "#delta-color-custom");
  const downloadButton = query<HTMLButtonElement>(app, "#download-button");
  const sampleBadge = query<HTMLSpanElement>(app, "#sample-badge");
  const reviewPanel = query<HTMLElement>(app, "#review");
  const reviewStatus = query<HTMLSpanElement>(app, "#review-status");
  const ocrProgress = query<HTMLProgressElement>(app, "#ocr-progress");
  const statRows = query<HTMLDivElement>(app, "#stat-rows");
  const previousOutputBar = query<HTMLDivElement>(app, "#previous-output");
  const previousOutputMessage = query<HTMLSpanElement>(app, "#previous-output-message");
  const previousOutputButton = query<HTMLSpanElement>(app, "#previous-output-button");
  const previousOutputFile = query<HTMLInputElement>(app, "#previous-output-file");
  const previousOutputPreview = query<HTMLButtonElement>(app, "#previous-output-preview");
  const previousOutputDialog = query<HTMLDialogElement>(app, "#previous-output-dialog");
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
    /** Carried over from an earlier visit (Fortune), so worth a glance. */
    remembered?: boolean;
    /** Not in this screenshot (the stat panel's top half is collapsed), so it has to be entered. */
    hidden?: boolean;
    /** Filled in from the previous output because the screenshot doesn't show it. */
    fromPrevious?: boolean;
  }

  const screenshotUrls: Partial<Record<Side, string>> = {};
  const screenshotImages: Partial<Record<Side, HTMLImageElement>> = {};
  const screenshotPixels: Partial<Record<Side, ImageData>> = {};
  const cropRects: Partial<Record<Side, ScreenshotCrops>> = {};
  const cropDetections: Partial<Record<Side, ScreenshotDetections>> = {};
  const activeCropKinds: Record<Side, CropKind> = { before: "stats", after: "stats" };
  /** Readings per stat and side; empty until the first extraction finishes. */
  const readings = new Map<string, Record<Side, StatReading>>();
  /** Manual fields aren't in the screenshots, so keep what the user typed across runs and visits. */
  const manualValues: Record<string, Record<Side, string>> = {};
  /** Whether a manual field was typed this session; until then a saved value is only a suggestion. */
  const manualConfirmed: Record<string, Record<Side, boolean>> = {};
  for (const id of Object.keys(MANUAL_DEFAULTS)) {
    manualValues[id] = loadManualValue(id);
    manualConfirmed[id] = { before: false, after: false };
  }
  /**
   * The previous output this pair fills hidden Before stats from. Taken when a new Before
   * screenshot arrives, so saving this pair's own output (on download) can't feed back into it.
   */
  let previousForPair = loadPreviousOutput();
  /** Object URL of the image that goes with previousForPair, when one was saved. */
  let previousImageUrl: string | undefined;

  function setPreviousImage(blob: Blob | undefined): void {
    if (previousImageUrl) URL.revokeObjectURL(previousImageUrl);
    previousImageUrl = blob ? URL.createObjectURL(blob) : undefined;
    for (const image of [query<HTMLImageElement>(previousOutputPreview, "img"), query<HTMLImageElement>(previousOutputDialog, "img")]) {
      if (previousImageUrl) image.src = previousImageUrl;
      else image.removeAttribute("src");
    }
    if (readings.size > 0) updatePreviousOutputBar();
  }

  /** Takes the saved previous output (values and image) as the one this pair uses. */
  function takePreviousForPair(): void {
    previousForPair = loadPreviousOutput();
    void loadImage(PREVIOUS_IMAGE_KEY).then((blob) => setPreviousImage(previousForPair ? blob : undefined));
  }
  /** Delta colors chosen for this pair; reset when the screenshots are cleared. */
  let deltaColors: Record<string, DeltaColor> = {};
  const layoutOverrides = loadLayoutOverrides();
  let editingLayout = false;
  let pasteTarget: Side = "before";
  let extractionRun = 0;
  let localOcrWorkerPromise: Promise<LocalOcrWorker> | undefined;

  // ---------- Output ----------

  let backgrounds: BackgroundEntry[] = [...config.backgrounds];
  let selectedBackground = backgrounds[0]!;
  let selectedImage: HTMLImageElement | undefined;

  const backgroundUrl = (background: BackgroundEntry) =>
    /^(blob:|data:|https?:)/.test(background.image)
      ? background.image
      : `${import.meta.env.BASE_URL}${background.image}`;

  const deltaColorFor = (id: string): DeltaColor =>
    deltaColors[id] ?? (id === "shard" ? DELTA_PRESETS.purple : DELTA_PRESETS.green);

  function currentLayout(): SlotLayout[] {
    return layoutOverrides[selectedBackground.id] ?? config.layout;
  }

  function outputLines(): Record<string, TextRun[]> {
    const values: Record<string, StatPair> = {};
    if (readings.size === 0) {
      Object.assign(values, SAMPLE_PAIRS);
    } else {
      for (const [id, reading] of readings) values[id] = { before: reading.before.value, after: reading.after.value };
    }
    const colors = Object.fromEntries(STATS.map(({ id }) => [id, deltaColorFor(id)]));
    return Object.fromEntries(currentLayout().map((slot) => [slot.id, buildSlotRuns(slot.id, values, colors)]));
  }

  function draw(): void {
    sampleBadge.hidden = readings.size > 0;
    renderOutput(outputCanvas, config, selectedImage, currentLayout(), outputLines());
  }

  function chooseBackground(background: BackgroundEntry): void {
    selectedBackground = background;
    selectedImage = undefined;
    saveSelectedBackgroundId(background.id);
    for (const option of backgroundPicker.querySelectorAll<HTMLElement>(".background-option")) {
      option.setAttribute("aria-pressed", String(option.dataset.id === background.id));
    }
    draw();
    renderLayoutBoxes();
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

  function uploadedBackgroundConfig(id: string, name: string, blob: Blob): BackgroundEntry {
    // Uploads start from the default layout; "Adjust layout" can tune it per background.
    return { id, label: name, image: URL.createObjectURL(blob) };
  }

  backgroundUploadInput.addEventListener("change", async () => {
    const files = Array.from(backgroundUploadInput.files ?? []).filter((file) => file.type.startsWith("image/"));
    backgroundUploadInput.value = "";
    let last: BackgroundEntry | undefined;
    for (const file of files) {
      const stored = await saveBackground(file);
      last = uploadedBackgroundConfig(stored.id, stored.name, stored.blob);
      backgrounds.push(last);
    }
    renderBackgroundPicker();
    if (last) chooseBackground(last);
  });

  // Each slot is a box: its top-left is the text start, its height tracks the font size and its
  // width is the space the line may use before it shrinks to fit.
  const BOX_HEIGHT_PER_SIZE = 1;
  const STAT_LABELS = Object.fromEntries(STATS.map(({ id, label }) => [id, label]));

  function renderLayoutBoxes(): void {
    layoutOverlay.hidden = !editingLayout;
    layoutReset.hidden = !editingLayout;
    layoutHint.hidden = !editingLayout;
    if (!editingLayout) return;
    layoutOverlay.replaceChildren(...currentLayout().map((slot) => {
      const box = document.createElement("div");
      box.className = "layout-box";
      box.dataset.id = slot.id;
      box.style.left = `${slot.x * 100}%`;
      box.style.top = `${(slot.y - (slot.size * BOX_HEIGHT_PER_SIZE) / 2) * 100}%`;
      box.style.width = `${slot.maxWidth * 100}%`;
      box.style.height = `${slot.size * BOX_HEIGHT_PER_SIZE * 100}%`;
      const label = document.createElement("span");
      label.className = "layout-label";
      label.textContent = slot.id === "anvilCount" ? "Shard | Anvil Count" : STAT_LABELS[slot.id] ?? slot.id;
      const handle = document.createElement("span");
      handle.className = "layout-handle";
      box.append(label, handle);
      return box;
    }));
  }

  let layoutDrag: {
    id: string;
    mode: "move" | "resize";
    pointerId: number;
    startX: number;
    startY: number;
    initial: SlotLayout;
  } | undefined;

  layoutOverlay.addEventListener("pointerdown", (event) => {
    const box = (event.target as HTMLElement).closest<HTMLElement>(".layout-box");
    const slot = currentLayout().find((candidate) => candidate.id === box?.dataset.id);
    if (!box || !slot) return;
    const bounds = layoutOverlay.getBoundingClientRect();
    layoutDrag = {
      id: slot.id,
      mode: (event.target as HTMLElement).classList.contains("layout-handle") ? "resize" : "move",
      pointerId: event.pointerId,
      startX: (event.clientX - bounds.left) / bounds.width,
      startY: (event.clientY - bounds.top) / bounds.height,
      initial: { ...slot },
    };
    layoutOverlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  layoutOverlay.addEventListener("pointermove", (event) => {
    if (!layoutDrag || layoutDrag.pointerId !== event.pointerId) return;
    const bounds = layoutOverlay.getBoundingClientRect();
    const deltaX = (event.clientX - bounds.left) / bounds.width - layoutDrag.startX;
    const deltaY = (event.clientY - bounds.top) / bounds.height - layoutDrag.startY;
    const { initial } = layoutDrag;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    let next: SlotLayout;
    if (layoutDrag.mode === "move") {
      next = { ...initial, x: clamp(initial.x + deltaX, 0, 0.98), y: clamp(initial.y + deltaY, 0.01, 0.99) };
    } else {
      // Resizing keeps the box's top edge fixed, so the line grows downward like a text box.
      const top = initial.y - (initial.size * BOX_HEIGHT_PER_SIZE) / 2;
      const size = clamp(initial.size + deltaY / BOX_HEIGHT_PER_SIZE, 0.02, 0.25);
      next = {
        ...initial,
        size,
        y: top + (size * BOX_HEIGHT_PER_SIZE) / 2,
        maxWidth: clamp(initial.maxWidth + deltaX, 0.03, 1 - initial.x),
      };
    }
    layoutOverrides[selectedBackground.id] = currentLayout().map((slot) => (slot.id === next.id ? next : slot));
    draw();
    renderLayoutBoxes();
  });

  const finishLayoutDrag = (event: PointerEvent) => {
    if (layoutDrag?.pointerId !== event.pointerId) return;
    layoutDrag = undefined;
    saveLayoutOverrides(layoutOverrides);
  };
  layoutOverlay.addEventListener("pointerup", finishLayoutDrag);
  layoutOverlay.addEventListener("pointercancel", finishLayoutDrag);

  layoutToggle.addEventListener("click", () => {
    editingLayout = !editingLayout;
    layoutToggle.setAttribute("aria-pressed", String(editingLayout));
    layoutToggle.textContent = editingLayout ? "Done adjusting" : "Adjust layout";
    renderLayoutBoxes();
  });

  layoutReset.addEventListener("click", () => {
    delete layoutOverrides[selectedBackground.id];
    saveLayoutOverrides(layoutOverrides);
    draw();
    renderLayoutBoxes();
  });

  // One shared popover edits whichever row's color button opened it.
  let colorTarget: { id: string; apply: () => void } | undefined;

  function setDeltaColor(color: DeltaColor): void {
    if (!colorTarget) return;
    deltaColors[colorTarget.id] = color;
    colorTarget.apply();
    draw();
  }

  for (const chip of colorPopover.querySelectorAll<HTMLButtonElement>(".color-chip")) {
    chip.addEventListener("click", () => {
      setDeltaColor(DELTA_PRESETS[chip.dataset.preset as keyof typeof DELTA_PRESETS]);
      colorPopover.hidePopover();
    });
  }
  colorCustomInput.addEventListener("input", () => {
    setDeltaColor({ kind: "solid", color: colorCustomInput.value });
  });

  function openColorPopover(anchor: HTMLElement, id: string, apply: () => void): void {
    colorTarget = { id, apply };
    const current = deltaColorFor(id);
    colorCustomInput.value = current.kind === "solid" ? current.color : current.bottom;
    colorPopover.showPopover();
    const rect = anchor.getBoundingClientRect();
    const width = colorPopover.offsetWidth;
    colorPopover.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    colorPopover.style.top = `${rect.bottom + 6}px`;
  }

  /** Remembers this pair's After values as the previous output for the next pair. */
  function rememberOutput(source: PreviousOutput["source"]): void {
    if (readings.size === 0) return;
    const values: Record<string, string> = {};
    for (const [id, reading] of readings) values[id] = reading.after.value;
    savePreviousOutput({ savedAt: Date.now(), source, values });
    // toBlob snapshots the canvas now, before a clear redraws it.
    outputCanvas.toBlob((blob) => {
      if (blob) void saveImage(PREVIOUS_IMAGE_KEY, blob);
    }, "image/png");
  }

  downloadButton.addEventListener("click", () => {
    rememberOutput("download");
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
    if (side === "before") takePreviousForPair();

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
    rememberOutput("clear");
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
    deltaColors = {};
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
    for (const side of SIDES) {
      const pixels = screenshotPixels[side]!;
      const stats = detectStatPanel(pixels);
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
      const found = detection.method === "left-panel" || detection.method === "collapsed-panel" ||
        detection.method === "panel-image";
      status.textContent = !found
        ? "not found: adjust"
        : detection.method === "collapsed-panel" ? "collapsed panel: top stats not shown" : "auto";
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
          if (source === "panel") {
            const stat = panelStats[side].find((candidate) => candidate.id === id);
            if (!stat) return missing;
            return { ...stat, hidden: !stat.visible };
          }
          if (source === "health") return health[side] ?? missing;
          if (source === "anvil") return anvil[side] ?? missing;
          const value = manualValues[id]![side];
          return manualConfirmed[id]![side]
            ? { value, confidence: 1, edited: true }
            : { value, confidence: 1, remembered: value !== "" && value !== MANUAL_DEFAULTS[id] };
        };
        readings.set(id, { before: sideReading("before"), after: sideReading("after") });
      }
      fillFromPrevious();
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

  /**
   * When the Before panel is collapsed, puts the previous output's values into the Before
   * stats the screenshot doesn't show, and into Before Fortune and Shard (the previous sheet's
   * After values), unless those were typed this session.
   */
  function fillFromPrevious(): void {
    let collapsed = false;
    for (const id of TOP_PANEL_STATS) {
      const reading = readings.get(id);
      if (!reading?.before.hidden) continue;
      collapsed = true;
      if (reading.before.edited) continue;
      const value = previousForPair?.values[id] ?? "";
      reading.before = value
        ? { value, confidence: 1, hidden: true, fromPrevious: true }
        : { value: "", confidence: 0, hidden: true };
    }
    if (collapsed) {
      for (const id of ["fortune", "shard"]) {
        const reading = readings.get(id);
        const value = previousForPair?.values[id];
        if (!reading || manualConfirmed[id]?.before || !value) continue;
        reading.before = { value, confidence: 1, fromPrevious: true };
      }
    }
    updatePreviousOutputBar();
  }

  /** "A", "A and B", "A, B and C". */
  const listOf = (items: string[]) =>
    items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

  function updatePreviousOutputBar(): void {
    const hidden = TOP_PANEL_STATS.filter((id) => readings.get(id)?.before.hidden);
    previousOutputBar.hidden = hidden.length === 0;
    if (hidden.length === 0) return;
    const filled = hidden.filter((id) => readings.get(id)?.before.fromPrevious).length;
    const filledManual = ["Fortune", "Shard"].filter((label) => readings.get(label.toLowerCase())?.before.fromPrevious);
    previousOutputPreview.hidden = !(previousImageUrl && filled > 0);
    if (previousForPair && filled > 0) {
      const when = new Date(previousForPair.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const how = previousForPair.source === "upload" ? "uploaded PNG" : "last output";
      previousOutputMessage.textContent =
        `The Before stat panel is collapsed. ${listOf(["Its top stats", ...filledManual])} ` +
        `are filled in blue from your ${how} (${when}).`;
      previousOutputButton.textContent = "Use a different PNG";
    } else {
      previousOutputMessage.textContent =
        "The Before stat panel is collapsed. Upload your previous stat sheet PNG to fill in its top stats, or type them.";
      previousOutputButton.textContent = "Upload previous PNG";
    }
  }

  previousOutputPreview.addEventListener("click", () => previousOutputDialog.showModal());
  // Clicking the dimmed area around the image closes the viewer.
  previousOutputDialog.addEventListener("click", (event) => {
    if (event.target === previousOutputDialog) previousOutputDialog.close();
  });

  previousOutputFile.addEventListener("change", () => {
    const file = previousOutputFile.files?.[0];
    previousOutputFile.value = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const values = readOutputValues(pixels, config.layout, config.output.cardScale);
      if (Object.keys(values).length === 0) {
        previousOutputMessage.textContent = "Couldn't find stat values in that image. Is it a stat sheet from this tool?";
        return;
      }
      previousForPair = { savedAt: Date.now(), source: "upload", values };
      savePreviousOutput(previousForPair);
      void saveImage(PREVIOUS_IMAGE_KEY, file);
      setPreviousImage(file);
      fillFromPrevious();
      renderStatRows();
      draw();
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      previousOutputMessage.textContent = "That file couldn't be opened as an image.";
    };
    image.src = url;
  });

  function readingState(reading: StatReading, optional = false): "missing" | "low" | "ok" | "previous" {
    if (reading.value.trim() === "") return optional ? "ok" : "missing";
    if (reading.fromPrevious) return "previous";
    if (reading.remembered) return "low";
    if (reading.edited || reading.verified) return "ok";
    return reading.confidence < LOW_CONFIDENCE ? "low" : "ok";
  }

  function updateReviewStatus(): void {
    let missing = 0;
    let low = 0;
    for (const [id, reading] of readings) {
      const optional = STATS.find((stat) => stat.id === id)?.optional;
      for (const side of SIDES) {
        const state = readingState(reading[side], optional);
        if (state === "missing") missing += 1;
        if (state === "low") low += 1;
      }
    }
    const parts: string[] = [];
    const fromPrevious = [...readings.values()].filter((reading) => reading.before.fromPrevious).length;
    if (missing) parts.push(`${missing} missing`);
    if (fromPrevious) parts.push(`${fromPrevious} from previous`);
    if (low) parts.push(`${low} to check`);
    reviewStatus.textContent = parts.length ? parts.join(" · ") : "All values read";
    reviewStatus.dataset.state = missing ? "error" : low ? "warning" : "ok";
  }

  function renderStatRows(): void {
    statRows.replaceChildren();
    for (const { id, label, source, optional } of STATS) {
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
        change.textContent = describeDelta(id, { before: reading.before.value, after: reading.after.value }) || "—";
        const color = deltaColorFor(id);
        change.style.color = color.kind === "solid" ? color.color : "";
        change.style.backgroundImage = color.kind === "gradient" ? colorCss(color) : "";
        change.classList.toggle("is-gradient", color.kind === "gradient");
      };

      const colorButton = document.createElement("button");
      colorButton.type = "button";
      colorButton.className = "delta-color";
      colorButton.setAttribute("aria-label", `${label} change color`);
      const applyColor = () => {
        colorButton.style.background = colorCss(deltaColorFor(id));
        updateChange();
      };
      colorButton.addEventListener("click", () => openColorPopover(colorButton, id, applyColor));

      const inputs = SIDES.map((side) => {
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.className = "stat-input";
        input.value = reading[side].value;
        input.placeholder = optional ? "0%" : source === "manual" ? "enter" : "—";
        input.setAttribute("aria-label", `${label} ${side}`);
        const applyState = () => {
          const state = readingState(reading[side], optional);
          input.dataset.state = state;
          input.title = reading[side].edited
            ? "Edited by you"
            : reading[side].fromPrevious
              ? reading[side].hidden
                ? `Not in the ${side} screenshot (stat panel collapsed); filled from your previous output`
                : "Filled from your previous output (its After value)"
            : reading[side].remembered
              ? "Remembered from last time; check it's still right"
            : state === "missing"
              ? reading[side].hidden
                ? `Not shown in the ${side} screenshot (stat panel collapsed); enter it`
                : source === "manual" ? "Enter this value" : "Could not read this value; enter it"
              : reading[side].verified
                ? "Read and format-checked"
                : `OCR confidence ${Math.round(reading[side].confidence * 100)}%`;
        };
        applyState();
        input.addEventListener("input", () => {
          reading[side] = { value: input.value.trim(), confidence: 1, edited: true };
          if (source === "manual") {
            manualValues[id]![side] = input.value.trim();
            manualConfirmed[id]![side] = true;
            saveManualValue(id, manualValues[id]!);
          }
          applyState();
          updateChange();
          updateReviewStatus();
          draw();
        });
        // On leaving the field, show the "%" the output will add ("84" -> "84%").
        input.addEventListener("change", () => {
          const normalized = normalizeStatInput(id, input.value);
          if (normalized === input.value.trim()) return;
          input.value = normalized;
          input.dispatchEvent(new Event("input"));
        });
        return input;
      });

      applyColor();
      row.append(name, ...inputs, change, colorButton);
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

  await loadOutputFont(`${import.meta.env.BASE_URL}fonts/NavineDemo-SemiCondensedItalic.ttf`);
  takePreviousForPair();
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
