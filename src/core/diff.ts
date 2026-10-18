type StatInput = string | null | undefined;

interface ParsedPart {
  value: number;
  decimals: number;
  isPercent: boolean;
}

const MAX_DECIMAL_PLACES = 6;

function parsePart(input: string): ParsedPart | undefined {
  const value = input.trim().replaceAll(",", "");
  if (!value) return { value: 0, decimals: 0, isPercent: false };

  const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(%)?$/);
  if (!match) return undefined;

  const numericText = match[1];
  if (!numericText) return undefined;

  const numericValue = Number(numericText);
  if (!Number.isFinite(numericValue)) return undefined;

  const decimalText = numericText.split(".")[1] ?? "";
  return {
    value: numericValue,
    decimals: Math.min(decimalText.length, MAX_DECIMAL_PLACES),
    isPercent: Boolean(match[2]),
  };
}

function formatPart(before: ParsedPart, after: ParsedPart): string | undefined {
  if (before.isPercent && after.isPercent === false && after.value !== 0) {
    return undefined;
  }
  if (after.isPercent && before.isPercent === false && before.value !== 0) {
    return undefined;
  }

  const decimals = Math.max(before.decimals, after.decimals);
  const difference = Number((after.value - before.value).toFixed(decimals));
  if (difference === 0) return "";

  const fixedValue = Math.abs(difference).toFixed(decimals);
  const formatted = decimals > 0
    ? fixedValue.replace(/0+$/, "").replace(/\.$/, "")
    : fixedValue;
  const sign = difference > 0 ? "+" : "-";
  const isPercent = before.isPercent || after.isPercent;
  return `${sign}${formatted}${isPercent ? "%" : ""}`;
}

export function formatStatDiff(
  before: StatInput,
  after: StatInput,
): string | undefined {
  if (before == null || after == null) return undefined;

  const beforeParts = before.split("|");
  const afterParts = after.split("|");
  const partCount = Math.max(beforeParts.length, afterParts.length);
  const differences: string[] = [];

  for (let index = 0; index < partCount; index += 1) {
    const beforePart = parsePart(beforeParts[index] ?? "");
    const afterPart = parsePart(afterParts[index] ?? "");
    if (!beforePart || !afterPart) return undefined;

    const difference = formatPart(beforePart, afterPart);
    if (difference === undefined) return undefined;
    differences.push(difference);
  }

  if (differences.every((difference) => difference === "")) return undefined;
  return `(${differences.filter(Boolean).join(" | ")})`;
}