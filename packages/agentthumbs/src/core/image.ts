import sharp from "sharp";
import type { UiElement } from "./types.js";

export interface RenderOptions {
  /** Longest edge of the image handed to the model. Vision models are most accurate around 1–1.5k px. */
  maxEdge: number;
  format: "png" | "jpeg";
  /** Draw numbered boxes over elements (set-of-mark). */
  marks: boolean;
}

export interface RenderedImage {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** Multiply image coordinates by this to get native device pixels. */
  scale: number;
}

const MARK_COLORS = ["#e5484d", "#0090ff", "#30a46c", "#f76b15", "#8e4ec6", "#d6409f"];

export async function renderObservation(
  png: Buffer,
  elements: readonly UiElement[],
  options: RenderOptions,
): Promise<RenderedImage> {
  const meta = await sharp(png).metadata();
  const nativeWidth = meta.width ?? 0;
  const nativeHeight = meta.height ?? 0;
  const factor = Math.min(1, options.maxEdge / Math.max(nativeWidth, nativeHeight));
  const width = Math.round(nativeWidth * factor);
  const height = Math.round(nativeHeight * factor);

  let pipeline = sharp(png).resize(width, height);
  if (options.marks && elements.length > 0) {
    const resized = await pipeline.png().toBuffer();
    pipeline = sharp(resized).composite([
      { input: Buffer.from(marksSvg(elements, factor, width, height)), top: 0, left: 0 },
    ]);
  }

  const data =
    options.format === "jpeg"
      ? await pipeline.jpeg({ quality: 82 }).toBuffer()
      : await pipeline.png().toBuffer();

  return {
    data,
    mimeType: options.format === "jpeg" ? "image/jpeg" : "image/png",
    width,
    height,
    scale: 1 / factor,
  };
}

function marksSvg(elements: readonly UiElement[], factor: number, width: number, height: number): string {
  const parts: string[] = [];
  elements.forEach((element, index) => {
    const color = MARK_COLORS[index % MARK_COLORS.length]!;
    const x = element.rect.x * factor;
    const y = element.rect.y * factor;
    const w = element.rect.width * factor;
    const h = element.rect.height * factor;
    const id = String(index + 1);
    const tagWidth = 7 + id.length * 7;
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="1.5"/>`,
      `<rect x="${x}" y="${y}" width="${tagWidth}" height="14" fill="${color}"/>`,
      `<text x="${x + 3.5}" y="${y + 11}" font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="700" fill="#fff">${id}</text>`,
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

const SIGNATURE_WIDTH = 36;
const SIGNATURE_HEIGHT = 72;

/** Tiny grayscale thumbnail used to tell whether the screen stopped moving. */
export async function screenSignature(png: Buffer): Promise<Buffer> {
  return sharp(png)
    .resize(SIGNATURE_WIDTH, SIGNATURE_HEIGHT, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
}

/** Mean absolute difference between two signatures, 0 (identical) to 255. */
export function signatureDistance(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 255;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!);
  return total / a.length;
}
