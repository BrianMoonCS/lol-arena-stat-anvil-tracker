export interface RecognizedText {
  value: string;
  confidence: number;
}

export interface ExtractedStat extends RecognizedText {
  id: string;
}

export interface PanelValueRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const VALUE_BOXES: Record<string, Omit<PanelValueRegion, "id" | "width" | "height"> & {
  width: number;
  height: number;
}> = {
  healAndShieldPower: { x: 0.64, y: 0.012, width: 0.35, height: 0.095 },
  armorPenetration: { x: 0.18, y: 0.125, width: 0.35, height: 0.095 },
  magicPenetration: { x: 0.64, y: 0.125, width: 0.35, height: 0.095 },
  omnivamp: { x: 0.64, y: 0.238, width: 0.35, height: 0.095 },
  tenacity: { x: 0.64, y: 0.352, width: 0.35, height: 0.095 },
  attackDamage: { x: 0.18, y: 0.526, width: 0.35, height: 0.095 },
  abilityPower: { x: 0.64, y: 0.526, width: 0.35, height: 0.095 },
  armor: { x: 0.18, y: 0.636, width: 0.35, height: 0.095 },
  magicResistance: { x: 0.64, y: 0.636, width: 0.35, height: 0.095 },
  attackSpeed: { x: 0.18, y: 0.752, width: 0.35, height: 0.095 },
  abilityHaste: { x: 0.64, y: 0.752, width: 0.35, height: 0.095 },
  criticalStrikeChance: { x: 0.18, y: 0.868, width: 0.35, height: 0.095 },
  movementSpeed: { x: 0.64, y: 0.868, width: 0.35, height: 0.095 },
};

export const PANEL_STAT_CELLS = [
  { id: "healAndShieldPower", row: 0, column: 1 },
  { id: "armorPenetration", row: 1, column: 0 },
  { id: "magicPenetration", row: 1, column: 1 },
  { id: "omnivamp", row: 2, column: 1 },
  { id: "tenacity", row: 3, column: 1 },
  { id: "attackDamage", row: 4, column: 0 },
  { id: "abilityPower", row: 4, column: 1 },
  { id: "armor", row: 5, column: 0 },
  { id: "magicResistance", row: 5, column: 1 },
  { id: "attackSpeed", row: 6, column: 0 },
  { id: "abilityHaste", row: 6, column: 1 },
  { id: "criticalStrikeChance", row: 7, column: 0 },
  { id: "movementSpeed", row: 7, column: 1 },
] as const;

export function getPanelValueRegions(width: number, height: number): PanelValueRegion[] {
  return PANEL_STAT_CELLS.map(({ id }) => {
    const box = VALUE_BOXES[id];
    return {
      id,
      x: Math.round(width * box.x),
      y: Math.round(height * box.y),
      width: Math.max(1, Math.round(width * box.width)),
      height: Math.max(1, Math.round(height * box.height)),
    };
  });
}

export function normalizeOcrText(value: string): string {
  return value
    .replace(/[\s,]/g, "")
    .replace(/[^\d.%|+-]/g, "");
}

export function parseAnvilCount(
  reading: RecognizedText,
  minimumConfidence = 0.55,
): RecognizedText | undefined {
  const value = reading.value.replace(/\s/g, "");
  if (!/^\d{1,3}$/.test(value) || reading.confidence < minimumConfidence) {
    return undefined;
  }
  return { value, confidence: reading.confidence };
}

export async function extractPanelStats(
  canvas: HTMLCanvasElement,
  recognize: (image: HTMLCanvasElement) => Promise<RecognizedText>,
): Promise<ExtractedStat[]> {
  const regions = getPanelValueRegions(canvas.width, canvas.height);
  const results = await Promise.all(regions.map(async (region) => {
    const valueCanvas = document.createElement("canvas");
    valueCanvas.width = region.width;
    valueCanvas.height = region.height;
    const context = valueCanvas.getContext("2d");
    if (!context) return { id: region.id, value: "", confidence: 0 };
    context.drawImage(
      canvas,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      region.width,
      region.height,
    );
    const reading = await recognize(valueCanvas);
    return {
      id: region.id,
      value: normalizeOcrText(reading.value),
      confidence: Math.max(0, Math.min(1, reading.confidence)),
    };
  }));
  return results;
}