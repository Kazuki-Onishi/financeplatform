import type {
  ReceiptPaymentMethod,
  ReceiptPaymentMethodType,
  ReceiptSourceType,
} from "@/types/receipt";

import type { UploadStatus } from "./types";

export const RECEIPTS_FLAG = process.env.NEXT_PUBLIC_APPFLAG_RECEIPTS === "on";
export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
export const DUPLICATE_LOOKBACK = 120;
export const PHASH_THRESHOLD = 6;
export const SYNC_TIMEOUT_MS = 10_000;
export const MAX_CONCURRENT_UPLOADS = 3;

export const SOURCE_TYPE_OPTIONS: ReadonlyArray<{
  value: ReceiptSourceType;
  label: string;
  description: string;
}> = [
  { value: "receipt", label: "Receipt", description: "Use for standard purchase receipts." },
  { value: "passbook", label: "Passbook", description: "Use for bank passbook scans." },
];

export const SOURCE_TYPE_LABELS: Record<ReceiptSourceType, string> = {
  receipt: "Receipt",
  passbook: "Passbook",
  label: "Label",
};

export const PURPOSE_HISTORY_STORAGE_KEY = "upload:purpose-history";
export const PURCHASE_HISTORY_STORAGE_KEY = "upload:purchase-purpose-history";
export const STORE_HISTORY_STORAGE_KEY = "upload:store-history";
export const STORE_HISTORY_LIMIT = 5;

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

export const STATUS_LABELS: Record<UploadStatus, string> = {
  pending: "Pending",
  hashing: "Processing",
  ready: "Ready",
  blocked: "Blocked",
  uploading: "Uploading",
  success: "Uploaded",
  error: "Error",
  cancelled: "Cancelled",
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
