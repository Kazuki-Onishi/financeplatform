import type { ReceiptPaymentMethod, ReceiptSourceType } from "@/types/receipt";

export type UploadSource = "change" | "drop" | "capture";

export type UploadStatus =
  | "pending"
  | "hashing"
  | "ready"
  | "blocked"
  | "uploading"
  | "success"
  | "error"
  | "cancelled";

export interface UploadItem {
  id: string;
  queueKey: string;
  file: File;
  storeId: string;
  sourceType: ReceiptSourceType;
  status: UploadStatus;
  progress: number;
  createdAt: number;
  sha256?: string;
  phash?: string | null;
  width?: number;
  height?: number;
  exifShotAt?: string | null;
  orientation?: number | null;
  viewBlob?: Blob;
  thumbBlob?: Blob;
  badges: string[];
  error?: string;
}

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

export interface DuplicateInfo {
  sha: Set<string>;
  phash: string[];
}

export interface PaymentMethodChoice {
  key: string;
  label: string;
  method: ReceiptPaymentMethod;
  source: "recent" | "default" | "card";
}

export interface EnqueueContext {
  purposeKey: string | null;
  purposeBucket: string;
  sourceType: ReceiptSourceType;
  advancePayment: boolean;
}
