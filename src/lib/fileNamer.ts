// src/lib/fileNamer.ts
// トップレベルからのみインポート（深いパス禁止）
import { v7 as uuidv7, v4 as uuidv4 } from "uuid";

const SAFE_CHAR_REGEX = /[^a-z0-9._-]+/g;

function newId(): string {
  // v7 があれば（uuid@^9）→ 時系列に並びやすい
  if (typeof uuidv7 === "function") return uuidv7();
  // ブラウザ/Nodeの標準API
 
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  // 最後の砦
  return uuidv4();
}

export function sanitize(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const replaced = trimmed.replace(/\s+/g, "-");
  const cleaned = replaced.replace(SAFE_CHAR_REGEX, "");
  return cleaned.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

export function zeroPad(value: number, length = 2): string {
  return value.toString().padStart(length, "0");
}

export function chooseExt(mime: string, originalName?: string): string {
  const m = (mime || "").toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heic",
    "application/pdf": ".pdf",
  };

  if (map[m]) return map[m];

  if (originalName) {
    const match = originalName.toLowerCase().match(/\.[a-z0-9]+$/);
    if (match) return match[0];
  }
  return ".bin";
}

export interface ReceiptPath {
  base: string;
  id: string;
  yyyy: string;
  mm: string;
}

/**
 * レシートのベースパスを生成:
 * receipts/<storeId>/<YYYY>/<MM>/<receiptId>
 */
export function genReceiptPath(
  storeId: string,
  now: Date = new Date(),
  id?: string
): ReceiptPath {
  const safeStoreId = sanitize(storeId) || storeId;
  const receiptId = id ?? newId();
  const yyyy = now.getUTCFullYear().toString();
  const mm = zeroPad(now.getUTCMonth() + 1);
  const base = `receipts/${safeStoreId}/${yyyy}/${mm}/${receiptId}`;
  return { base, id: receiptId, yyyy, mm };
}

export function joinPath(base: string, fileName: string): string {
  // 末尾/先頭のスラッシュを整理して二重スラッシュを避ける
  const b = base.replace(/\/+$/, "");
  const f = fileName.replace(/^\/+/, "");
  return `${b}/${f}`;
}

export interface ReceiptAssetPath {
  base: string;
  assetId: string;
}

/**
 * アセットパス:
 * <receiptBase>/assets/<assetId>
 */
export function genAssetPath(
  receiptBase: string,
  assetId?: string
): ReceiptAssetPath {
  const trimmedBase = receiptBase.replace(/\/+$/, "");
  const id = assetId ?? newId();
  const base = `${trimmedBase}/assets/${id}`;
  return { base, assetId: id };
}
