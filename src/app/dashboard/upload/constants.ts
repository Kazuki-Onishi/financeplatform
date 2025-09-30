import type {
  ReceiptPaymentMethod,
  ReceiptPaymentMethodType,
  ReceiptSourceType,
} from "@/types/receipt";

import type { UploadStatus } from "./types";

export const RECEIPTS_FLAG = process.env.NEXT_PUBLIC_APPFLAG_RECEIPTS === "on";
export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
export const MAX_CONCURRENT_UPLOADS = 3;
export const DUPLICATE_LOOKBACK = 120;
export const PHASH_THRESHOLD = 6;

export const SOURCE_TYPE_DEFINITIONS: ReadonlyArray<{
  value: ReceiptSourceType;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    value: "receipt",
    labelKey: "upload.source.receipt.label",
    descriptionKey: "upload.source.receipt.description",
  },
  {
    value: "passbook",
    labelKey: "upload.source.passbook.label",
    descriptionKey: "upload.source.passbook.description",
  },
];

export const SOURCE_TYPE_LABEL_KEYS: Record<ReceiptSourceType, string> = {
  receipt: "upload.source.receipt.label",
  passbook: "upload.source.passbook.label",
  label: "upload.source.label",
};

export const PURPOSE_HISTORY_STORAGE_KEY = "upload:purpose-history";
export const PURCHASE_HISTORY_STORAGE_KEY = "upload:purchase-purpose-history";
export const STORE_HISTORY_STORAGE_KEY = "upload:store-history";
export const STORE_HISTORY_LIMIT = 5;

export const SYNC_TIMEOUT_MS = 10_000;

export const PURCHASE_PURPOSE_MAX_LENGTH = 80;
export const RECENT_PAYMENT_METHOD_LOOKBACK = 40;

export const MAX_PAYMENT_METHOD_CHOICES = 6;

export const CREDIT_CARD_FETCH_LIMIT = 40;

export const DEFAULT_PAYMENT_METHODS: ReadonlyArray<ReceiptPaymentMethod> = [
  { type: "cash" },
  { type: "credit" },
  { type: "bank" },
  { type: "other" },
];

export const PAYMENT_METHOD_TYPES = [
  "cash",
  "credit",
  "bank",
  "other",
] as const satisfies readonly ReceiptPaymentMethodType[];

export const DUPLICATE_CACHE_PREFIX = "upload:dup-cache:";
export const DUPLICATE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export const STATUS_LABEL_KEYS: Record<UploadStatus, string> = {
  pending: "upload.queue.statuses.pending",
  hashing: "upload.queue.statuses.hashing",
  ready: "upload.queue.statuses.ready",
  blocked: "upload.queue.statuses.blocked",
  uploading: "upload.queue.statuses.uploading",
  success: "upload.queue.statuses.success",
  error: "upload.queue.statuses.error",
  cancelled: "upload.queue.statuses.cancelled",
};

export const STATUS_CLASSES: Record<UploadStatus, string> = {
  pending: "text-neutral-500",
  hashing: "text-amber-600",
  ready: "text-blue-600",
  blocked: "text-red-600",
  uploading: "text-sky-600",
  success: "text-green-600",
  error: "text-red-600",
  cancelled: "text-neutral-500",
};
