import { fileURLToPath } from "node:url";
import { detectAnvilCounter, detectHealthBar, detectStatWindowPair } from "../../src/core/detect";
import { toPixelRect, type PixelImage, type PixelRect } from "../../src/core/pixels";
import { readPng } from "./png";

export type Side = "before" | "after";

/** Hand-verified values from public/screenshots, in normalized OCR form (no spaces). */
export const GROUND_TRUTH: Record<Side, { stats: Record<string, string>; anvilCount: string; health: string }> = {
  after: {
    stats: {
      healAndShieldPower: "0%",
      armorPenetration: "101|0%",
      magicPenetration: "0|0%",
      omnivamp: "0%",
      tenacity: "0%",
      attackDamage: "139",
      abilityPower: "30",
      armor: "233",
      magicResistance: "223",
      attackSpeed: "1.49",
      abilityHaste: "290",
      criticalStrikeChance: "0%",
      movementSpeed: "577",
    },
    anvilCount: "16",
    health: "3160",
  },
  before: {
    stats: {
      healAndShieldPower: "0%",
      armorPenetration: "96|0%",
      magicPenetration: "0|0%",
      omnivamp: "0%",
      tenacity: "0%",
      attackDamage: "89",
      abilityPower: "0",
      armor: "227",
      magicResistance: "216",
      attackSpeed: "1.34",
      abilityHaste: "259",
      criticalStrikeChance: "0%",
      movementSpeed: "577",
    },
    anvilCount: "13",
    health: "3160",
  },
};

export interface LoadedScreenshot {
  image: PixelImage;
  panel: PixelRect;
  health: PixelRect;
  anvilValue: PixelRect;
}

export function loadExamplePair(): Record<Side, LoadedScreenshot> {
  const path = (name: string) => fileURLToPath(new URL(`../../public/screenshots/${name}`, import.meta.url));
  const images = { before: readPng(path("before.png")), after: readPng(path("after.png")) };
  const pair = detectStatWindowPair(images.before as ImageData, images.after as ImageData);
  const load = (side: Side): LoadedScreenshot => {
    const image = images[side];
    const statRect = pair[side].rect;
    const healthRect = detectHealthBar(image as ImageData, statRect).rect;
    const anvil = detectAnvilCounter(image as ImageData, statRect, healthRect);
    return {
      image,
      panel: toPixelRect(statRect, image.width, image.height),
      health: toPixelRect(healthRect, image.width, image.height),
      anvilValue: toPixelRect(anvil.valueRect, image.width, image.height),
    };
  };
  return { before: load("before"), after: load("after") };
}
