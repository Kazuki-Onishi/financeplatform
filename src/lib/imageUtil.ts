"use client";

import type { ReceiptMetaJson } from "../types/receipt";

const ORIENTATION_VALUES = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
const P_HASH_SIZE = 32;
const P_HASH_CLUSTER = 8;

export interface ToWebpOptions {
  maxSide: number;
  quality?: number;
  orientation?: number | null;
}

export interface ThumbOptions {
  orientation?: number | null;
}

export async function sha256Of(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function pHash(blob: Blob, options: { orientation?: number | null } = {}): Promise<string> {
  const orientation = normaliseOrientation(options.orientation);
  const image = await loadImage(blob);
  const base = renderOriented(image, P_HASH_SIZE, P_HASH_SIZE, orientation);
  const ctx = base.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }
  const imageData = ctx.getImageData(0, 0, P_HASH_SIZE, P_HASH_SIZE);
  const greyscale = new Float64Array(P_HASH_SIZE * P_HASH_SIZE);
  for (let i = 0; i < greyscale.length; i += 1) {
    const offset = i * 4;
    const r = imageData.data[offset];
    const g = imageData.data[offset + 1];
    const b = imageData.data[offset + 2];
    greyscale[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const dct = dct2(greyscale, P_HASH_SIZE);
  const coefficients: number[] = [];
  for (let y = 0; y < P_HASH_CLUSTER; y += 1) {
    for (let x = 0; x < P_HASH_CLUSTER; x += 1) {
      coefficients.push(dct[y * P_HASH_SIZE + x]);
    }
  }
  const withoutDc = coefficients.slice(1);
  const threshold = medianOf(withoutDc);
  const bits = coefficients.map((value) => (value > threshold ? 1 : 0));
  let hash = "";
  for (let i = 0; i < bits.length; i += 4) {
    const nibble =
      (bits[i] << 3) +
      (bits[i + 1] << 2) +
      (bits[i + 2] << 1) +
      (bits[i + 3] ?? 0);
    hash += nibble.toString(16);
  }
  return hash.slice(0, 16).padEnd(16, "0");
}

export async function extractExif(
  blob: Blob,
): Promise<{ shotAt: string | null; orientation: number | null }> {
  try {
    const exifr = (await import("exifr")).default;
    const data = await exifr.parse(blob, {
      pick: ["DateTimeOriginal", "CreateDate", "Orientation"],
    });
    const dateValue = data?.DateTimeOriginal ?? data?.CreateDate;
    const shotAt = dateValue instanceof Date ? dateValue.toISOString() : null;
    const orientation =
      typeof data?.Orientation === "number" ? normaliseOrientation(data.Orientation) : null;
    return { shotAt, orientation };
  } catch (error) {
    console.warn("Failed to extract EXIF", error);
    return { shotAt: null, orientation: null };
  }
}

export async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  if (!blob.type.startsWith("image/")) {
    throw new Error("Blob is not an image");
  }

  if (isHeic(blob.type)) {
    const converted = await convertHeic(blob);
    return loadImage(converted);
  }

  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  img.crossOrigin = "anonymous";
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Image load failed"));
      img.src = objectUrl;
    });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function toWebp(
  img: HTMLImageElement,
  options: ToWebpOptions,
): Promise<Blob> {
  const orientation = normaliseOrientation(options.orientation);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const longSide = Math.max(width, height);
  const scale = Math.min(1, options.maxSide / longSide);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = renderOriented(img, targetWidth, targetHeight, orientation);
  return canvasToBlob(canvas, "image/webp", options.quality ?? 0.9);
}

export async function thumb256(
  img: HTMLImageElement,
  options: ThumbOptions = {},
): Promise<Blob> {
  const orientation = normaliseOrientation(options.orientation);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const scale = Math.max(256 / width, 256 / height);
  const drawWidth = Math.max(1, Math.round(width * scale));
  const drawHeight = Math.max(1, Math.round(height * scale));
  const oriented = renderOriented(img, drawWidth, drawHeight, orientation);

  const output = document.createElement("canvas");
  output.width = 256;
  output.height = 256;
  const ctx = output.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }
  const sx = Math.max(0, Math.floor((oriented.width - 256) / 2));
  const sy = Math.max(0, Math.floor((oriented.height - 256) / 2));
  ctx.drawImage(oriented, sx, sy, 256, 256, 0, 0, 256, 256);
  return canvasToBlob(output, "image/webp", 0.85);
}

export function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error("Hashes must be equal length");
  }
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = parseInt(a[i], 16);
    const right = parseInt(b[i], 16);
    distance += popCount4(left ^ right);
  }
  return distance;
}

export function buildMetaJson(meta: {
  sha256: string;
  phash: string | null;
  width: number;
  height: number;
  exifShotAt: string | null;
  originalTranscoded: boolean;
}): ReceiptMetaJson {
  return {
    sha256: meta.sha256,
    phash: meta.phash,
    width: meta.width,
    height: meta.height,
    exifShotAt: meta.exifShotAt,
    originalTranscoded: meta.originalTranscoded,
  };
}

export function metaFromImage(
  img: HTMLImageElement,
  options: { sha256: string; phash: string | null; exifShotAt: string | null; originalTranscoded: boolean },
): ReceiptMetaJson {
  return {
    sha256: options.sha256,
    phash: options.phash,
    width: img.naturalWidth,
    height: img.naturalHeight,
    exifShotAt: options.exifShotAt,
    originalTranscoded: options.originalTranscoded,
  };
}

function renderOriented(
  source: CanvasImageSource,
  drawWidth: number,
  drawHeight: number,
  orientation: number,
): HTMLCanvasElement {
  const swap = orientation >= 5 && orientation <= 8;
  const canvas = document.createElement("canvas");
  canvas.width = swap ? drawHeight : drawWidth;
  canvas.height = swap ? drawWidth : drawHeight;
  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }
  ctx.save();
  applyOrientation(ctx, orientation, canvasWidth, canvasHeight);
  ctx.drawImage(source, 0, 0, drawWidth, drawHeight);
  ctx.restore();
  return canvas;
}

function applyOrientation(
  ctx: CanvasRenderingContext2D,
  orientation: number,
  width: number,
  height: number,
): void {
  switch (orientation) {
    case 2:
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      break;
    case 3:
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
      break;
    case 4:
      ctx.translate(0, height);
      ctx.scale(1, -1);
      break;
    case 5:
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1);
      break;
    case 6:
      ctx.rotate(0.5 * Math.PI);
      ctx.translate(0, -height);
      break;
    case 7:
      ctx.rotate(0.5 * Math.PI);
      ctx.translate(width, -height);
      ctx.scale(-1, 1);
      break;
    case 8:
      ctx.rotate(-0.5 * Math.PI);
      ctx.translate(-width, 0);
      break;
    default:
      break;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Failed to convert canvas to blob"));
      }
    }, type, quality);
  });
}

function dct2(input: Float64Array, size: number): Float64Array {
  const output = new Float64Array(size * size);
  const factor = Math.PI / size;
  for (let u = 0; u < size; u += 1) {
    for (let v = 0; v < size; v += 1) {
      let sum = 0;
      for (let x = 0; x < size; x += 1) {
        for (let y = 0; y < size; y += 1) {
          const cosine =
            Math.cos((2 * x + 1) * u * factor * 0.5) *
            Math.cos((2 * y + 1) * v * factor * 0.5);
          sum += input[y * size + x] * cosine;
        }
      }
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      output[v * size + u] = 0.25 * cu * cv * sum;
    }
  }
  return output;
}

function medianOf(values: number[]): number {
  const copy = [...values].sort((a, b) => a - b);
  const middle = Math.floor(copy.length / 2);
  if (copy.length % 2 === 0) {
    return (copy[middle - 1] + copy[middle]) / 2;
  }
  return copy[middle];
}

function popCount4(value: number): number {
  let remaining = value & 0xf;
  let bits = 0;
  while (remaining) {
    bits += remaining & 1;
    remaining >>= 1;
  }
  return bits;
}

function isHeic(type: string): boolean {
  return type === "image/heic" || type === "image/heif";
}

async function convertHeic(blob: Blob): Promise<Blob> {
  const heic2any = (await import("heic2any")).default as unknown as (
    options: { blob: Blob; toType: string; quality?: number },
  ) => Promise<Blob | Blob[]>;
  const converted = await heic2any({ blob, toType: "image/jpeg", quality: 0.95 });
  return Array.isArray(converted) ? converted[0] : converted;
}

function normaliseOrientation(value?: number | null): number {
  if (!value) {
    return 1;
  }
  return ORIENTATION_VALUES.has(value) ? value : 1;
}

