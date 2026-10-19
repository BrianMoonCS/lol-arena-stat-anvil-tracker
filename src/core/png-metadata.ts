// Stores the stat sheet's data inside the PNG it was downloaded as (a standard tEXt chunk, which
// image viewers ignore), so the sheet can later be re-rendered exactly, e.g. on a new background.
import type { DeltaColor, StatPair } from "./output-format";

export interface SheetMetadata {
  version: 1;
  values: Record<string, StatPair>;
  colors: Record<string, DeltaColor>;
}

const KEYWORD = "stat-anvil-tracker";
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
  return SIGNATURE.every((value, index) => bytes[index] === value);
}

const readUint32 = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

/** tEXt holds Latin-1; keep it to ASCII by escaping anything else the JSON way. */
function toAscii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Returns a copy of `png` with the sheet data inserted right after the IHDR chunk. */
export function embedSheetMetadata(png: Uint8Array, metadata: SheetMetadata): Uint8Array {
  if (!isPng(png)) return png;
  const text = toAscii(JSON.stringify(metadata));
  const data = new Uint8Array(KEYWORD.length + 1 + text.length);
  for (let i = 0; i < KEYWORD.length; i += 1) data[i] = KEYWORD.charCodeAt(i);
  for (let i = 0; i < text.length; i += 1) data[KEYWORD.length + 1 + i] = text.charCodeAt(i);

  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  chunk.set([116, 69, 88, 116], 4); // "tEXt"
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));

  const afterHeader = 8 + 12 + readUint32(png, 8); // signature + IHDR chunk
  const output = new Uint8Array(png.length + chunk.length);
  output.set(png.subarray(0, afterHeader), 0);
  output.set(chunk, afterHeader);
  output.set(png.subarray(afterHeader), afterHeader + chunk.length);
  return output;
}

/** The sheet data embedded by embedSheetMetadata, if this PNG has it. */
export function readSheetMetadata(png: Uint8Array): SheetMetadata | undefined {
  if (!isPng(png)) return undefined;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = readUint32(png, offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === "IEND") break;
    if (type === "tEXt") {
      const data = png.subarray(offset + 8, offset + 8 + length);
      const separator = data.indexOf(0);
      const keyword = String.fromCharCode(...data.subarray(0, separator));
      if (keyword === KEYWORD) {
        let text = "";
        for (const byte of data.subarray(separator + 1)) text += String.fromCharCode(byte);
        try {
          const parsed = JSON.parse(text) as Partial<SheetMetadata>;
          if (parsed.version === 1 && parsed.values && parsed.colors) return parsed as SheetMetadata;
        } catch {
          return undefined;
        }
      }
    }
    offset += 12 + length;
  }
  return undefined;
}
