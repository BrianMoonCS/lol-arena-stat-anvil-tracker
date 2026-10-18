export interface SlotConfig {
  id: string;
  x: number;
  y: number;
  width: number;
  fontFamily: string;
  fontSize: number;
  color: string;
  align: CanvasTextAlign;
  deltaColor: string;
  deltaOffsetX: number;
}

export interface BackgroundConfig {
  id: string;
  label: string;
  image: string;
  backgroundColor: string;
  accentColor: string;
  slots: SlotConfig[];
}

export interface CanvasConfig {
  width: number;
  height: number;
  backgrounds: BackgroundConfig[];
}

export interface RenderValue {
  value: string;
  delta?: string;
}

export function renderBackground(
  canvas: HTMLCanvasElement,
  config: CanvasConfig,
  background: BackgroundConfig,
  backgroundImage: HTMLImageElement | undefined,
  values: Record<string, RenderValue>,
  debug: boolean,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;

  canvas.width = config.width;
  canvas.height = config.height;
  context.fillStyle = background.backgroundColor;
  context.fillRect(0, 0, config.width, config.height);

  if (backgroundImage) {
    context.drawImage(backgroundImage, 0, 0, config.width, config.height);
  } else {
    context.fillStyle = background.accentColor;
    context.fillRect(0, 0, 14, config.height);
    context.fillRect(0, 0, config.width, 5);
  }

  context.fillStyle = background.accentColor;
  if (!backgroundImage) {
    context.strokeStyle = "rgba(239, 231, 211, 0.16)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(config.width / 2, 70);
    context.lineTo(config.width / 2, config.height - 45);
    context.moveTo(48, config.height / 2);
    context.lineTo(config.width - 48, config.height / 2);
    context.stroke();
  }

  if (!backgroundImage) {
    context.fillStyle = "rgba(239, 231, 211, 0.66)";
    context.font = "12px ui-monospace, monospace";
    context.textAlign = "left";
    context.fillText(
      `${background.label.toUpperCase()} / BACKGROUND PREVIEW`,
      48,
      43,
    );
  }

  const slots =
    background.slots.length > 0
      ? background.slots
      : (config.backgrounds.find((candidate) => candidate.slots.length > 0)
          ?.slots ?? []);

  for (const slot of slots) {
    const renderValue = values[slot.id];
    if (!renderValue) continue;

    context.font = `${slot.fontSize}px ${slot.fontFamily}`;
    context.textAlign = slot.align;
    context.textBaseline = "middle";
    context.fillStyle = slot.color;
    context.fillText(renderValue.value, slot.x, slot.y);

    if (renderValue.delta) {
      const valueWidth = context.measureText(renderValue.value).width;
      const deltaX =
        slot.align === "right"
          ? slot.x - valueWidth - slot.deltaOffsetX
          : slot.x + valueWidth + slot.deltaOffsetX;
      context.fillStyle = slot.deltaColor;
      context.fillText(renderValue.delta, deltaX, slot.y);
    }

    if (debug) {
      context.save();
      context.strokeStyle = "#f5c451";
      context.lineWidth = 1;
      context.setLineDash([5, 4]);
      context.strokeRect(
        slot.x,
        slot.y - slot.fontSize,
        slot.width,
        slot.fontSize * 1.8,
      );
      context.setLineDash([]);
      context.fillStyle = "#f5c451";
      context.font = "10px ui-monospace, monospace";
      context.textAlign = "left";
      context.textBaseline = "alphabetic";
      context.fillText(slot.id, slot.x + 4, slot.y - slot.fontSize - 4);
      context.restore();
    }
  }
}
