import type { Timestamp } from "firebase/firestore";

export type ReceiptStatus = "draft" | "pending" | "confirmed" | "reviewed" | "locked";

export type ReceiptSourceType = "receipt" | "passbook" | "label";

export type ReceiptFraudFlag =
  | "DuplicateExact"
  | "DuplicateLikely"
  | "ExifDateMismatch"
  | "ManualOverride";

export type ReceiptPaymentMethodType = "cash" | "credit" | "bank" | "other";

export interface ReceiptPaymentMethod {
  /** Payment method chosen by uploader; credit stores card id reference. */
  type: ReceiptPaymentMethodType;
  cardId?: string | null;
}

export interface ReceiptMeta {
  /** SHA-256 hash of the original upload used for dedupe. */
  sha256: string;
  /** 64-bit pHash for near-duplicate detection. */
  phash: string | null;
  /** Pixel width of the original image/pdf first page. */
  width: number;
  /** Pixel height of the original image/pdf first page. */
  height: number;
  /** ISO timestamp extracted from EXIF DateTimeOriginal/CreateDate if present. */
  exifShotAt: string | null;
  /** Whether the original file was transcoded to WebP during upload. */
  originalTranscoded: boolean;
  /** Whether any manual edits have been applied after OCR. */
  manualEdits: boolean;
}

export interface ReceiptFileInfo {
  bucket: string;
  path: string;
  gcsUri: string;
}

export interface ReceiptSummaryLineItem {
  id: string;
  label: string | null;
  amount: number | null;
  tax?: number | null;
  taxRate?: number | null;
  memo?: string | null;
}

export interface ReceiptSummaryData {
  date: string | null;
  vendor: string | null;
  amount: number | null;
  tax: number | null;
  currency: string | null;
  memo: string | null;
  purpose?: {
    key: string;
    label: string;
    note?: string | null;
  } | null;
  purchasePurpose?: string | null;
  advancePayment?: boolean;
  source: string | null;
  edited: boolean;
  language?: string | null;
  keywords?: string[];
  usage?: Record<string, unknown> | null;
  modelVersion?: string | null;
  items?: ReceiptSummaryLineItem[] | null;
}

export interface ReceiptOcrData {
  /** Normalised purchase date (ISO, Asia/Tokyo). */
  date: string | null;
  /** Matched vendor document id. */
  vendorId: string | null;
  /** Display vendor name (normalised or raw). */
  vendorName: string | null;
  /** Legacy raw vendor string (deprecated). */
  vendor?: string | null;
  /** Raw OCR text captured from Vision. */
  rawText?: string | null;
  /** Total amount including tax. */
  amount: number | null;
  /** Currency code (MVP: only JPY). */
  currency: "JPY";
  /** Tax portion of amount if supplied. */
  tax: number | null;
  /** Free-form memo extracted/entered by user. */
  memo: string | null;
  /** Primary source of the OCR data (vision, gemini, manual, etc.). */
  source?: string | null;
  /** Confidence returned by Gemini enhancement (0-1). */
  confidenceGemini?: number | null;
  /** Final effective confidence after merging sources (0-1). */
  confidenceFinal?: number | null;
  /** Confidence score for current OCR normalisation (0-1). */
  confidence: number;
}

/**
 * Firestore: /receipts/{receiptId}
 */
export interface ReceiptDoc {
  storeId: string;
  uploaderId: string;
  uploaderName?: string | null;
  companyName?: string | null;
  createdBy?: {
    uid: string;
    email?: string | null;
  };
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  status: ReceiptStatus;
  lockedBy?: string | null;
  lockedAt?: Timestamp | null;
  sourceType?: ReceiptSourceType;
  /** gs:// path to original file. */
  filePath: string;
  /** gs:// path to resized view asset. */
  viewPath?: string;
  /** gs:// path to thumbnail asset. */
  thumbPath?: string;
  file?: ReceiptFileInfo;
  /** Calendar year used for aggregation. */
  year: number;
  /** Calendar month (1-12) used for aggregation. */
  month: number;
  /** Optional business purpose supplied by uploader. */
  purpose?: string | null;
  /** Free-form purchase purpose context captured during upload. */
  purchasePurpose?: string | null;
  /** Whether the expense was fronted for reimbursement. */
  advancePayment?: boolean;
  memo?: string | null;
  paymentMethod?: ReceiptPaymentMethod;
  summary?: ReceiptSummaryData | null;
  ocr: ReceiptOcrData;
  meta: ReceiptMeta;
  fraudFlags: ReceiptFraudFlag[];
  /** Number of item photos attached under /receipts/{id}/assets. */
  assetsCount?: number;
  /** Last time an asset was uploaded. */
  lastAssetAt?: Timestamp | null;
}

/** Convenience shape including Firestore document id. */
export interface ReceiptRecord extends ReceiptDoc {
  id: string;
}

/**
 * Firestore: /receipts/{receiptId}/assets/{assetId}
 */
export interface ReceiptAssetDoc {
  kind: "itemPhoto";
  /** gs:// path to asset original. */
  filePath: string;
  /** gs:// path to view asset. */
  viewPath: string;
  /** gs:// path to thumbnail. */
  thumbPath: string;
  meta: {
    sha256: string;
    phash: string | null;
    width: number;
    height: number;
    exifShotAt: string | null;
    originalTranscoded?: boolean;
  };
  uploaderId: string;
  createdAt: Timestamp;
}

export interface ReceiptAssetRecord extends ReceiptAssetDoc {
  id: string;
  /** Parent receipt id for convenience when hydrated with Firestore id. */
  receiptId: string;
  /** Store id denormalised for security rule checks. */
  storeId: string;
}

// Compatibility exports for existing modules (feature flag pending)
export type SourceType = ReceiptSourceType;
export type FraudFlag = ReceiptFraudFlag;
export type ReceiptOcrResult = ReceiptOcrData;
export type ReceiptDocData = ReceiptDoc;
export type ReceiptAssetDocData = ReceiptAssetDoc;
export interface ReceiptMetaJson extends Omit<ReceiptMeta, "manualEdits"> {
  manualEdits?: boolean;
}

