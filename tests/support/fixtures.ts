import { fileURLToPath } from "node:url";
import { detectAnvilCounter, detectHealthBar, detectStatPanel } from "../../src/core/detect";
import { toPixelRect, type PixelImage, type PixelRect } from "../../src/core/pixels";
import { readPng } from "./png";

export type Side = "before" | "after";

interface SideTruth {
  /** Normalized OCR form (no spaces); "" for a stat the screenshot doesn't show. */
  stats: Record<string, string>;
  anvilCount: string;
  health: string;
}

export interface ExamplePair {
  name: string;
  files: Record<Side, string>;
  truth: Record<Side, SideTruth>;
}

const HIDDEN_TOP_HALF = {
  healAndShieldPower: "",
  armorPenetration: "",
  magicPenetration: "",
  omnivamp: "",
  tenacity: "",
};

/** Screenshot pairs in public/screenshots with hand-verified values. */
export const EXAMPLE_PAIRS: ExamplePair[] = [
  {
    name: "tight crop, full panels",
    files: { before: "before.png", after: "after.png" },
    truth: {
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
    },
  },
  {
    // The user's sample output 4 was made from this pair.
    name: "collapsed Before panel",
    files: { before: "collapsed-before.png", after: "collapsed-after.png" },
    truth: {
      after: {
        stats: {
          healAndShieldPower: "0%",
          armorPenetration: "32|23%",
          magicPenetration: "0|0%",
          omnivamp: "9%",
          tenacity: "0%",
          attackDamage: "72",
          abilityPower: "0",
          armor: "75",
          magicResistance: "57",
          attackSpeed: "0.91",
          abilityHaste: "20",
          criticalStrikeChance: "0%",
          movementSpeed: "330",
        },
        anvilCount: "1",
        health: "1713",
      },
      before: {
        stats: {
          ...HIDDEN_TOP_HALF,
          attackDamage: "107",
          abilityPower: "20",
          armor: "75",
          magicResistance: "91",
          attackSpeed: "0.91",
          abilityHaste: "20",
          criticalStrikeChance: "0%",
          movementSpeed: "370",
        },
        anvilCount: "1",
        health: "1713",
      },
    },
  },
  {
    // AP "0" was read as "4" and MR came back with low confidence on these.
    name: "AP 0 and MR",
    files: { before: "ap-mr-before.png", after: "ap-mr-after.png" },
    truth: {
      after: {
        stats: {
          healAndShieldPower: "0%",
          armorPenetration: "15|0%",
          magicPenetration: "0|0%",
          omnivamp: "0%",
          tenacity: "0%",
          attackDamage: "84",
          abilityPower: "0",
          armor: "135",
          magicResistance: "116",
          attackSpeed: "1.08",
          abilityHaste: "158",
          criticalStrikeChance: "0%",
          movementSpeed: "577",
        },
        anvilCount: "10",
        health: "2775",
      },
      before: {
        stats: {
          ...HIDDEN_TOP_HALF,
          attackDamage: "84",
          abilityPower: "0",
          armor: "145",
          magicResistance: "126",
          attackSpeed: "1.08",
          abilityHaste: "158",
          criticalStrikeChance: "0%",
          movementSpeed: "536",
        },
        anvilCount: "10",
        health: "2775",
      },
    },
  },
  {
    // The After's MR "213" touches the portrait frame and read as "21".
    name: "MR touching the portrait",
    files: { before: "mr-overlap-before.png", after: "mr-overlap-after.png" },
    truth: {
      after: {
        stats: {
          healAndShieldPower: "0%",
          armorPenetration: "58|0%",
          magicPenetration: "0|0%",
          omnivamp: "0%",
          tenacity: "0%",
          attackDamage: "86",
          abilityPower: "0",
          armor: "221",
          magicResistance: "213",
          attackSpeed: "1.32",
          abilityHaste: "275",
          criticalStrikeChance: "0%",
          movementSpeed: "581",
        },
        anvilCount: "12",
        health: "2965",
      },
      before: {
        stats: {
          ...HIDDEN_TOP_HALF,
          attackDamage: "86",
          abilityPower: "0",
          armor: "141",
          magicResistance: "119",
          attackSpeed: "1.10",
          abilityHaste: "174",
          criticalStrikeChance: "0%",
          movementSpeed: "581",
        },
        anvilCount: "10",
        health: "2965",
      },
    },
  },
];

export interface LoadedScreenshot {
  image: PixelImage;
  panel: PixelRect;
  collapsed: boolean;
  health: PixelRect;
  anvilValue: PixelRect;
}

/** Loads one screenshot and runs the same detection the app does. */
export function loadScreenshot(file: string): LoadedScreenshot {
  const image = readPng(fileURLToPath(new URL(`../../public/screenshots/${file}`, import.meta.url)));
  const stats = detectStatPanel(image as ImageData);
  const healthRect = detectHealthBar(image as ImageData, stats.rect).rect;
  const anvil = detectAnvilCounter(image as ImageData, stats.rect, healthRect);
  return {
    image,
    panel: toPixelRect(stats.rect, image.width, image.height),
    collapsed: stats.method === "collapsed-panel",
    health: toPixelRect(healthRect, image.width, image.height),
    anvilValue: toPixelRect(anvil.valueRect, image.width, image.height),
  };
}
