import { FirebaseError } from "firebase/app";

import type { ReceiptPaymentMethod, ReceiptPaymentMethodType } from "@/types/receipt";

import {
  DUPLICATE_CACHE_PREFIX,
  DUPLICATE_CACHE_TTL_MS,
  PAYMENT_METHOD_TYPES,
  STORE_HISTORY_STORAGE_KEY,
} from "./constants";
import type { DuplicateInfo } from "./types";

let sessionStorageUnavailableLogged = false;

export function isFirebasePermissionError(error: unknown): error is FirebaseError {
  return (
    error instanceof FirebaseError &&
    (error.code === "permission-denied" || error.code === "auth/permission-denied")
  );
}

export function createPaymentMethodKey(method: ReceiptPaymentMethod): string {
  return `${method.type}:${method.cardId ?? ""}`;
}

function isPaymentMethodType(value: unknown): value is ReceiptPaymentMethodType {
  return typeof value === "string" && PAYMENT_METHOD_TYPES.includes(value as ReceiptPaymentMethodType);
}

export function normalisePaymentMethod(value: unknown): ReceiptPaymentMethod | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { type?: unknown; cardId?: unknown };
  if (!isPaymentMethodType(candidate.type)) {
    return null;
  }
  const cardId =
    typeof candidate.cardId === "string" && candidate.cardId.trim().length > 0 ? candidate.cardId.trim() : null;
  return { type: candidate.type, cardId };
}

export function formatPaymentMethodLabel(method: ReceiptPaymentMethod): string {
  switch (method.type) {
    case "cash":
      return "Cash";
    case "credit":
      return method.cardId ? `Credit card (${method.cardId.slice(-4)})` : "Credit card";
    case "bank":
      return "Bank transfer";
    case "other":
      return "Other";
    default:
      return method.type;
  }
}

export function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted =
    unitIndex === 0 ? Math.round(value).toString() : value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return formatted + " " + units[unitIndex];
}

export function persistStoreHistory(entries: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORE_HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn("[upload] failed to persist store history", error);
  }
}

export class Semaphore {
  private queue: Array<() => void> = [];
  private current = 0;

  constructor(private readonly max: number) {}

  private enqueue(resolve: () => void): void {
    this.queue.push(resolve);
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current += 1;
      return;
    }
    await new Promise<void>((resolve) => this.enqueue(resolve));
    this.current += 1;
  }

  release(): void {
    if (this.current > 0) {
      this.current -= 1;
    }
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch (error) {
    if (!sessionStorageUnavailableLogged) {
      console.warn("[upload] sessionStorage unavailable", error);
      sessionStorageUnavailableLogged = true;
    }
    return null;
  }
}

export function loadDuplicateCache(storeId: string): DuplicateInfo | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(`${DUPLICATE_CACHE_PREFIX}${storeId}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { timestamp?: number; sha?: unknown; phash?: unknown } | null;
    if (!parsed || typeof parsed.timestamp !== "number") {
      storage.removeItem(`${DUPLICATE_CACHE_PREFIX}${storeId}`);
      return null;
    }
    if (Date.now() - parsed.timestamp > DUPLICATE_CACHE_TTL_MS) {
      storage.removeItem(`${DUPLICATE_CACHE_PREFIX}${storeId}`);
      return null;
    }
    const shaValues = Array.isArray(parsed.sha) ? parsed.sha.map(String) : [];
    const phashValues = Array.isArray(parsed.phash) ? parsed.phash.map(String) : [];
    const info: DuplicateInfo = {
      sha: new Set(shaValues),
      phash: phashValues,
    };
    return info;
  } catch (error) {
    console.warn("[upload] failed to read duplicate cache", error);
    return null;
  }
}

export function persistDuplicateCache(storeId: string, info: DuplicateInfo): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }
  try {
    const payload = JSON.stringify({
      timestamp: Date.now(),
      sha: Array.from(info.sha),
      phash: info.phash,
    });
    storage.setItem(`${DUPLICATE_CACHE_PREFIX}${storeId}`, payload);
  } catch (error) {
    console.warn("[upload] failed to persist duplicate cache", error);
  }
}
