export interface VisionTask {
  id: string;
  side: "before" | "after";
}

export interface VisionResult extends VisionTask {
  value: string;
  confidence: number;
}

export function buildVisionPrompt(tasks: VisionTask[]): string {
  return [
    `Read exactly ${tasks.length} requested stat value${tasks.length === 1 ? "" : "s"} from the supplied League of Legends stat-window crops.`,
    "Return only one valid JSON object with this shape: {\"results\":[{\"id\":\"stat id\",\"side\":\"before or after\",\"value\":\"raw value\",\"confidence\":0.0}] }.",
    "Return exactly one result for every requested (id, side) pair, no other results, no markdown, and no prose.",
    "Preserve decimals, percent signs, and compound values separated by |. Do not infer a value that is not legible; use an empty string and confidence 0 when unreadable.",
    `Requested pairs (${tasks.length} total): ${JSON.stringify(tasks)}.`,
  ].join("\n");
}

export function validateVisionResponse(
  response: unknown,
  tasks: VisionTask[],
): VisionResult[] | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  if (Object.keys(response).length !== 1 || !Object.hasOwn(response, "results")) {
    return undefined;
  }
  const results = (response as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length !== tasks.length) return undefined;

  const expected = new Set(tasks.map((task) => `${task.side}:${task.id}`));
  const seen = new Set<string>();
  const validated: VisionResult[] = [];

  for (const result of results) {
    if (typeof result !== "object" || result === null) return undefined;
    const fields = Object.keys(result).sort();
    if (fields.join(",") !== "confidence,id,side,value") return undefined;
    const candidate = result as Partial<VisionResult>;
    if (
      typeof candidate.id !== "string" ||
      (candidate.side !== "before" && candidate.side !== "after") ||
      typeof candidate.value !== "string" ||
      typeof candidate.confidence !== "number" ||
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    ) {
      return undefined;
    }

    const key = `${candidate.side}:${candidate.id}`;
    if (!expected.has(key) || seen.has(key)) return undefined;
    seen.add(key);
    validated.push({
      id: candidate.id,
      side: candidate.side,
      value: candidate.value,
      confidence: candidate.confidence,
    });
  }

  return seen.size === expected.size ? validated : undefined;
}