"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { FirebaseError } from "firebase/app";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Timestamp,
} from "firebase/firestore";
import { ref, uploadBytesResumable, type UploadMetadata, type UploadTask } from "firebase/storage";

import { useAppSelector } from "@/lib/state/store";
import { auth, db, storage, firebaseApp } from "@/lib/firebase/client";
import { useUserPermissions } from "@/lib/hooks/useUserPermissions";
import { receiptsCollection } from "@/lib/firestoreRefs";
import { buildReceiptStoragePaths } from "@/lib/storagePaths";
import { chooseExt } from "@/lib/fileNamer";
import { PURPOSE_OPTIONS, PURPOSE_NOTE_MAX_LENGTH, findPurposeOption, getPurposeNoteBucket, type ReceiptPurposeOption } from "@/lib/purposeOptions";
import {
  extractExif,
  hammingDistanceHex,
  loadImage,
  pHash,
  sha256Of,
  thumb256,
  toWebp,
} from "@/lib/imageUtil";
import type { ReceiptDoc, ReceiptPaymentMethod, ReceiptPaymentMethodType, ReceiptSourceType, ReceiptSummaryData } from "@/types/receipt";
import type { StoreDoc } from "@/types/store";

const RECEIPTS_FLAG = process.env.NEXT_PUBLIC_APPFLAG_RECEIPTS === "on";
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const DUPLICATE_LOOKBACK = 120;
const PHASH_THRESHOLD = 6;
const SYNC_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_UPLOADS = 3;

const SOURCE_TYPE_OPTIONS: ReadonlyArray<{ value: ReceiptSourceType; label: string; description: string }> = [
  { value: "receipt", label: "Receipt", description: "Use for standard purchase receipts." },
  { value: "passbook", label: "Passbook", description: "Use for bank passbook scans." },
];
const SOURCE_TYPE_LABELS: Record<ReceiptSourceType, string> = {
  receipt: "Receipt",
  passbook: "Passbook",
  label: "Label",
};

const PURPOSE_HISTORY_STORAGE_KEY = "upload:purpose-history";
const PURCHASE_HISTORY_STORAGE_KEY = "upload:purchase-purpose-history";
const STORE_HISTORY_STORAGE_KEY = "upload:store-history";
const STORE_HISTORY_LIMIT = 5;

const PURCHASE_PURPOSE_MAX_LENGTH = 80;
const RECENT_PAYMENT_METHOD_LOOKBACK = 40;

const MAX_PAYMENT_METHOD_CHOICES = 4;

const DEFAULT_PAYMENT_METHODS: ReadonlyArray<ReceiptPaymentMethod> = [
  { type: "cash" },
  { type: "credit" },
  { type: "bank" },
  { type: "other" },
];

const PAYMENT_METHOD_TYPES: readonly ReceiptPaymentMethodType[] = ["cash", "credit", "bank", "other"];

function isFirebasePermissionError(error: unknown): error is FirebaseError {
  return error instanceof FirebaseError && (error.code === "permission-denied" || error.code === "auth/permission-denied");
}

function createPaymentMethodKey(method: ReceiptPaymentMethod): string {
  return `${method.type}:${method.cardId ?? ""}`;
}

function isPaymentMethodType(value: unknown): value is ReceiptPaymentMethodType {
  return typeof value === "string" && PAYMENT_METHOD_TYPES.includes(value as ReceiptPaymentMethodType);
}

function normalisePaymentMethod(value: unknown): ReceiptPaymentMethod | null {
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

function formatPaymentMethodLabel(method: ReceiptPaymentMethod): string {
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

function humanFileSize(bytes: number): string {
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

function persistStoreHistory(entries: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORE_HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn("[upload] failed to persist store history", error);
  }
}

class Semaphore {
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

type UploadSource = "change" | "drop" | "capture";
type UploadStatus = "pending" | "hashing" | "ready" | "blocked" | "uploading" | "success" | "error" | "cancelled";

interface UploadItem {
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

interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

interface DuplicateInfo {
  sha: Set<string>;
  phash: string[];
}

interface PaymentMethodChoice {
  key: string;
  label: string;
  method: ReceiptPaymentMethod;
  source: "recent" | "default";
}

interface EnqueueContext {
  purposeKey: string | null;
  purposeBucket: string;
  sourceType: ReceiptSourceType;
}

const DUPLICATE_CACHE_PREFIX = "upload:dup-cache:";
const DUPLICATE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let sessionStorageUnavailableLogged = false;

function getSessionStorage(): Storage | null {
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

function loadDuplicateCache(storeId: string): DuplicateInfo | null {
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

function persistDuplicateCache(storeId: string, info: DuplicateInfo): void {
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

const STATUS_LABELS: Record<UploadStatus, string> = {
  pending: "Pending",
  hashing: "Processing",
  ready: "Ready",
  blocked: "Blocked",
  uploading: "Uploading",
  success: "Uploaded",
  error: "Error",
  cancelled: "Cancelled",
};

const STATUS_CLASSES: Record<UploadStatus, string> = {
  pending: "text-neutral-500",
  hashing: "text-amber-600",
  ready: "text-blue-600",
  blocked: "text-red-600",
  uploading: "text-sky-600",
  success: "text-green-600",
  error: "text-red-600",
  cancelled: "text-neutral-500",
};

export default function UploadPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ?????E?v?????[?h
  const { permissions, loading: permissionsLoading, optimisticMemberships, confirmed, authReady, currentUid } =
    useUserPermissions();
  const preload = useAppSelector((state) => state.permissions);
  const sameUserPreload =
    preload.hasData && (preload.userId === null || currentUid === null || preload.userId === currentUid);
  const preloadReady = sameUserPreload;

  const storeIds = preloadReady ? preload.storeIds : permissions?.storeIds ?? [];
  const activeStoreId = preloadReady ? preload.activeStoreId ?? null : permissions?.activeStoreId ?? null;

  // UI state
  const requestedStoreId = searchParams.get("store");
  const [storeId, setStoreId] = useState<string>("");
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const captureInputRef = useRef<HTMLInputElement | null>(null);
  const activeQueueKeysRef = useRef<Set<string>>(new Set());
  const duplicateCache = useRef<Map<string, DuplicateInfo>>(new Map());
  const duplicateFetches = useRef<Map<string, Promise<DuplicateInfo>>>(new Map());
  const uploadTasks = useRef<Map<string, UploadTask[]>>(new Map());
  const uploadSemaphore = useRef(new Semaphore(MAX_CONCURRENT_UPLOADS));
  const [storeDetails, setStoreDetails] = useState<Record<string, { name: string }>>({});
  const [storeHistory, setStoreHistory] = useState<string[]>([]);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);
  const [syncExceeded, setSyncExceeded] = useState(false);
  const [sourceType, setSourceType] = useState<ReceiptSourceType>('receipt');
  const [purposeKey, setPurposeKey] = useState<string>("");
  const [purposeNote, setPurposeNote] = useState<string>("");
  const [purchasePurpose, setPurchasePurpose] = useState<string>("");
  const [purposeHistory, setPurposeHistory] = useState<string[]>([]);
  const [purchaseHistory, setPurchaseHistory] = useState<string[]>([]);
  const [recentPaymentMethods, setRecentPaymentMethods] = useState<ReceiptPaymentMethod[]>([]);
  const [paymentMethodKey, setPaymentMethodKey] = useState<string>(() => createPaymentMethodKey(DEFAULT_PAYMENT_METHODS[0]));
  const [isHydrated, setIsHydrated] = useState(false);
  const [isDropActive, setIsDropActive] = useState(false);
  const [showDropHint, setShowDropHint] = useState(false);
  const dropCounterRef = useRef(0);
  const dropHintTimeoutRef = useRef<number | null>(null);

  const storeHistoryLoadedRef = useRef(false);

  const paymentMethodChoices = useMemo<PaymentMethodChoice[]>(() => {
    const seen = new Set<string>();
    const choices: PaymentMethodChoice[] = [];

    const addChoice = (method: ReceiptPaymentMethod, source: PaymentMethodChoice["source"]) => {
      const normalized: ReceiptPaymentMethod = {
        type: method.type,
        cardId: typeof method.cardId === "string" && method.cardId.trim().length > 0 ? method.cardId.trim() : null,
      };
      const key = createPaymentMethodKey(normalized);
      if (seen.has(key)) {
        return;
      }
      if (choices.length >= MAX_PAYMENT_METHOD_CHOICES) {
        return;
      }
      seen.add(key);
      choices.push({
        key,
        label: formatPaymentMethodLabel(normalized),
        method: normalized,
        source,
      });
    };

    recentPaymentMethods.forEach((method) => addChoice(method, "recent"));
    DEFAULT_PAYMENT_METHODS.forEach((method) => addChoice(method, "default"));
    return choices;
  }, [recentPaymentMethods]);

  const paymentQuickChoices = useMemo(() => paymentMethodChoices.filter((choice) => choice.source === "recent").slice(0, 2), [paymentMethodChoices]);
  const purposeQuickOptions = useMemo(() => purposeHistory.map((key) => findPurposeOption(key)).filter((option): option is ReceiptPurposeOption => Boolean(option)), [purposeHistory]);
  const purchaseQuickValues = useMemo(() => purchaseHistory.slice(0, 2), [purchaseHistory]);

  useEffect(() => {
    if (!paymentMethodChoices.length) {
      const fallbackKey = createPaymentMethodKey(DEFAULT_PAYMENT_METHODS[0]);
      if (paymentMethodKey !== fallbackKey) {
        setPaymentMethodKey(fallbackKey);
      }
      return;
    }
    if (!paymentMethodChoices.some((choice) => choice.key === paymentMethodKey)) {
      setPaymentMethodKey(paymentMethodChoices[0].key);
    }
  }, [paymentMethodChoices, paymentMethodKey]);

  useEffect(() => {
    setIsHydrated(true);
  }, []);
  useEffect(() => {
    if (storeHistoryLoadedRef.current) {
      return;
    }
    if (!isHydrated) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    storeHistoryLoadedRef.current = true;
    try {
      const raw = window.localStorage.getItem(STORE_HISTORY_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const entries = parsed.filter((value): value is string => typeof value === "string");
      if (!entries.length) {
        return;
      }
      setStoreHistory(entries.slice(0, STORE_HISTORY_LIMIT));
    } catch (error) {
      console.warn("[upload] failed to load store history", error);
    }
  }, [isHydrated]);

  useEffect(() => {
    const runtimeProjectId = firebaseApp.options?.projectId ?? null;
    const envProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? null;
    if (runtimeProjectId && envProjectId && runtimeProjectId !== envProjectId) {
      console.warn('[firebase] project mismatch', { runtimeProjectId, envProjectId });
    }
  }, []);

  const getPurposeContext = useCallback(() => {
    const option = findPurposeOption(purposeKey);
    const sanitizedNote = purposeNote.slice(0, PURPOSE_NOTE_MAX_LENGTH);
    const trimmedNote = option?.requiresNote ? sanitizedNote.trim() : "";
    const bucket = option?.requiresNote ? getPurposeNoteBucket(trimmedNote) : "0";
    return {
      option,
      sanitizedNote,
      trimmedNote,
      bucket,
      label: option?.label ?? null,
    };
  }, [purposeKey, purposeNote]);

  const getPurchasePurpose = useCallback(() => {
    const sanitized = purchasePurpose.slice(0, PURCHASE_PURPOSE_MAX_LENGTH);
    const trimmed = sanitized.trim();
    return { sanitized, trimmed };
  }, [purchasePurpose]);

  const handlePurchasePurposeBlur = useCallback(() => {
    const trimmed = purchasePurpose.trim();
    if (!trimmed) {
      return;
    }
    setPurchaseHistory((prev) => {
      const next = [trimmed, ...prev.filter((entry) => entry !== trimmed)].slice(0, 2);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(PURCHASE_HISTORY_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
          console.warn("[upload] failed to persist purchase history", error);
        }
      }
      return next;
    });
  }, [purchasePurpose]);

  const buildEnqueueContext = useCallback(() => {
    const { option, bucket } = getPurposeContext();
    return {
      purposeKey: option?.key ?? null,
      purposeBucket: bucket,
      sourceType,
    };
  }, [getPurposeContext, sourceType]);

  const getPaymentMethodContext = useCallback((): PaymentMethodChoice => {
    const fallbackMethod: ReceiptPaymentMethod = {
      type: DEFAULT_PAYMENT_METHODS[0].type,
      cardId: DEFAULT_PAYMENT_METHODS[0].cardId ?? null,
    };
    const fallbackChoice: PaymentMethodChoice = {
      key: createPaymentMethodKey(fallbackMethod),
      label: formatPaymentMethodLabel(fallbackMethod),
      method: fallbackMethod,
      source: "default",
    };
    return (
      paymentMethodChoices.find((option) => option.key === paymentMethodKey) ??
      paymentMethodChoices[0] ??
      fallbackChoice
    );
  }, [paymentMethodChoices, paymentMethodKey]);

  const isSyncing = optimisticMemberships.length > 0 && !confirmed;
  const permissionsBusy = (!preloadReady && !authReady) || (permissionsLoading && !preloadReady);

  // ???[?U?[?\???p
  const user = auth.currentUser;
  const userName = user?.displayName || user?.email || user?.uid || "you";

  useEffect(() => {
    if (!authReady) {
      return;
    }
    const current = auth.currentUser;
    if (!current) {
      console.info('[auth] current user not available');
      return;
    }
    let cancelled = false;
    current
      .getIdTokenResult(true)
      .then((token) => {
        if (cancelled) return;
        console.info('[auth] token claims', token.claims);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[auth] failed to fetch token claims', error);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady]);

  // ???m??X?g?AID?iroles + ?y?j
  const knownStoreIds = useMemo(() => {
    const ids = new Set<string>(storeIds);
    optimisticMemberships.forEach((m) => ids.add(m.storeId));
    return Array.from(ids);
  }, [storeIds, optimisticMemberships]);

  // ?X?g?A?I????W?b?N + ??????
  useEffect(() => {
    if (permissionsBusy) return;

    if (!knownStoreIds.length) {
      if (storeId) setStoreId("");
      return;
    }

    if (requestedStoreId && knownStoreIds.includes(requestedStoreId)) {
      if (storeId !== requestedStoreId) setStoreId(requestedStoreId);
      return;
    }

    const defaultStore = (activeStoreId ?? knownStoreIds[0]) ?? "";
    if (!storeId && defaultStore) {
      setStoreId(defaultStore);
      return;
    }
    if (storeId && !knownStoreIds.includes(storeId)) {
      setStoreId(defaultStore);
    }
  }, [permissionsBusy, knownStoreIds, requestedStoreId, storeId, activeStoreId]);

  // ?? ?X??????F?????m???? ?g?????? knownStoreIds?h ?????
  useEffect(() => {
    if (!confirmed || !knownStoreIds.length) return;

    const missing = knownStoreIds.filter((id) => !storeDetails[id]);
    if (!missing.length) return;

    let cancelled = false;
    (async () => {
      const updates: Record<string, { name: string }> = {};
      await Promise.all(
        missing.map(async (id) => {
          try {
            const snapshot = await getDoc(doc(db, "stores", id));
            if (snapshot.exists()) {
              const data = snapshot.data() as Partial<StoreDoc>;
              const name =
                typeof data?.name === "string" && data.name.trim()
                  ? data.name.trim()
                  : id;
              updates[id] = { name };
            } else {
              updates[id] = { name: id };
            }
          } catch (error) {
            if (isFirebasePermissionError(error)) {
              console.debug("[upload] store name pending membership confirmation", id);
              updates[id] = { name: id };
              return;
            }
            console.warn("[upload] failed to load store name", id, error);
            updates[id] = { name: id };
          }
        }),
      );
      if (!cancelled && Object.keys(updates).length) {
        setStoreDetails((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [confirmed, knownStoreIds, storeDetails]);

  useEffect(() => {
    setStoreHistory((prev) => {
      if (!prev.length) {
        return prev;
      }
      const filtered = prev.filter((id) => knownStoreIds.includes(id));
      if (filtered.length === prev.length && filtered.every((id, index) => id === prev[index])) {
        return prev;
      }
      persistStoreHistory(filtered);
      return filtered;
    });
  }, [knownStoreIds]);

  useEffect(() => {
    if (!storeId || !knownStoreIds.includes(storeId)) {
      return;
    }
    setStoreHistory((prev) => {
      const withoutCurrent = prev.filter((id) => id !== storeId);
      const next = [storeId, ...withoutCurrent].slice(0, STORE_HISTORY_LIMIT);
      const unchanged = next.length === prev.length && next.every((id, index) => id === prev[index]);
      if (unchanged) {
        return prev;
      }
      persistStoreHistory(next);
      return next;
    });
  }, [storeId, knownStoreIds]);

  useEffect(() => {
    if (!storeId) {
      setRecentPaymentMethods([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await getDocs(
          query(
            receiptsCollection(),
            where("storeId", "==", storeId),
            orderBy("createdAt", "desc"),
            limit(RECENT_PAYMENT_METHOD_LOOKBACK),
          ),
        );
        const seen = new Set<string>();
        const methods: ReceiptPaymentMethod[] = [];
        snapshot.docs.forEach((docSnap) => {
          const data = docSnap.data() as { paymentMethod?: unknown } | undefined;
          const normalized = normalisePaymentMethod(data?.paymentMethod);
          if (!normalized) {
            return;
          }
          const key = createPaymentMethodKey(normalized);
          if (seen.has(key)) {
            return;
          }
          seen.add(key);
          methods.push(normalized);
        });
        if (!cancelled) {
          setRecentPaymentMethods(methods.slice(0, MAX_PAYMENT_METHOD_CHOICES));
        }
      } catch (error) {
        console.warn("[upload] failed to load recent payment methods", { storeId, error });
        if (!cancelled) {
          setRecentPaymentMethods([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  // ?????o?i?[
  useEffect(() => {
    if (isSyncing) {
      setSyncStartedAt((current) => current ?? Date.now());
      return;
    }
    setSyncStartedAt(null);
    setSyncExceeded(false);
  }, [isSyncing]);
  useEffect(() => {
    if (!syncStartedAt || !isSyncing) return;
    const timer = window.setTimeout(() => setSyncExceeded(true), SYNC_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [syncStartedAt, isSyncing]);
  useEffect(() => {
    if (!syncExceeded || !syncStartedAt) return;
    const delayMs = Date.now() - syncStartedAt;
    console.info("[sync-delay]", { delayMs, storeId });
  }, [syncExceeded, syncStartedAt, storeId]);

  // disable?t???O
  const featureDisabled = !RECEIPTS_FLAG;
  useEffect(() => {
    if (!purposeKey) {
      return;
    }
    const option = findPurposeOption(purposeKey);
    if (!option) {
      return;
    }
    setPurposeHistory((prev) => {
      const next = [option.key, ...prev.filter((item) => item !== option.key)].slice(0, 2);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(PURPOSE_HISTORY_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
          console.warn("[upload] failed to persist purpose history", error);
        }
      }
      return next;
    });
  }, [purposeKey]);

  const showSyncBanner = isSyncing;
  const purposeContext = getPurposeContext();
  const showPurposeField = true;
  const showPurposeNoteInput = purposeContext.option?.requiresNote ?? false;

  // refs ????
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    const activeStatuses = new Set<UploadStatus>(["pending", "hashing", "ready", "blocked", "uploading"]);
    const activeKeys = new Set<string>();
    items.forEach((item) => {
      if (!item.queueKey) {
        return;
      }
      if (activeStatuses.has(item.status)) {
        activeKeys.add(item.queueKey);
      }
    });
    activeQueueKeysRef.current = activeKeys;
  }, [items]);

  // ?@?\???????????N???A
  useEffect(() => {
    if (featureDisabled) setItems([]);
  }, [featureDisabled]);

  // ?X??1???????????I??
  useEffect(() => {
    if (featureDisabled) return;
    if (!storeId && knownStoreIds.length === 1) setStoreId(knownStoreIds[0]);
  }, [featureDisabled, knownStoreIds, storeId]);

  // ?g?[?X?g
  const addToast = useCallback((type: ToastMessage["type"], message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 5000);
  }, []);

    // joined=1 ?????????????K?C?h
  useEffect(() => {
    const joined = searchParams.get("joined");
    const joinedStore = searchParams.get("store");
    if (joined === "1") {
      addToast("success", "Joined the store");
      const target = joinedStore ? `/dashboard/upload?store=${encodeURIComponent(joinedStore)}` : "/dashboard/upload";
      router.replace(target, { scroll: false });
    }
  }, [addToast, router, searchParams]);

  // ??????V?[?g??d?????o?L???b?V??
  const ensureStoreDuplicates = useCallback(
    async (store: string): Promise<DuplicateInfo> => {
      const cache = duplicateCache.current;
      const existing = cache.get(store);
      if (existing) {
        return existing;
      }

      const stored = loadDuplicateCache(store);
      if (stored) {
        cache.set(store, stored);
        persistDuplicateCache(store, stored);
        return stored;
      }

      const inflight = duplicateFetches.current.get(store);
      if (inflight) {
        return inflight;
      }

      const fetchPromise = (async () => {
        const info: DuplicateInfo = { sha: new Set<string>(), phash: [] };
        try {
          const snapshot = await getDocs(
            query(
              receiptsCollection(),
              where("storeId", "==", store),
              orderBy("createdAt", "desc"),
              limit(DUPLICATE_LOOKBACK),
            ),
          );
          snapshot.docs.forEach((docSnap) => {
            const data = docSnap.data();
            const meta = data?.meta ?? {};
            if (meta.sha256) info.sha.add(String(meta.sha256));
            if (meta.phash) info.phash.push(String(meta.phash));
          });
        } catch (error) {
          console.error("Failed to fetch recent receipts", error);
        }
        cache.set(store, info);
        persistDuplicateCache(store, info);
        return info;
      })();

      duplicateFetches.current.set(store, fetchPromise);
      try {
        return await fetchPromise;
      } finally {
        duplicateFetches.current.delete(store);
      }
    },
    [],
  );

  // ?? ?f?o?b?O???O?????FPNG??l????????
  const processItem = useCallback(
    async (itemId: string) => {
      if (featureDisabled) return;
      const current = itemsRef.current.find((entry) => entry.id === itemId);
      if (!current) return;

      setItems((prev) =>
        prev.map((entry) =>
          entry.id === itemId ? { ...entry, status: "hashing", error: undefined, badges: [] } : entry,
        ),
      );

      try {
        const { option: currentPurposeOption, bucket: currentPurposeBucket } = getPurposeContext();
        const purposeKeyValue = currentPurposeOption?.key ?? null;
        const { trimmed: currentPurchasePurpose } = getPurchasePurpose();
        const currentPaymentMethod = getPaymentMethodContext();
        console.info("[upload] processItem:start", {
          id: itemId,
          name: current.file.name,
          type: current.file.type,
          purpose_key: purposeKeyValue,
          purpose_note_len_bucket: currentPurposeBucket,
          purchase_purpose: currentPurchasePurpose || null,
          payment_method_key: currentPaymentMethod.key,
          source_type: current.sourceType,
        });

        const sha = await sha256Of(current.file);
        const { shotAt: exifShotAt, orientation } = await extractExif(current.file);
        const image = await loadImage(current.file);
        const width = image.naturalWidth;
        const height = image.naturalHeight;

        let viewBlob: Blob | undefined;
        try {
          viewBlob = await toWebp(image, { maxSide: 1600, quality: 0.9, orientation });
        } catch (error) {
          console.warn("[upload] toWebp failed, continuing without derived view", error);
          viewBlob = undefined;
        }

        let thumbBlob: Blob | undefined;
        try {
          thumbBlob = await thumb256(image, { orientation });
        } catch (error) {
          console.warn("[upload] thumb256 failed, continuing without thumbnail", error);
          thumbBlob = undefined;
        }

        const phashValue = await pHash(current.file, { orientation });

        const storeInfo = await ensureStoreDuplicates(current.storeId);
        const duplicateExactCache = storeInfo.sha.has(sha);
        const duplicateLikelyCache =
          !!phashValue && storeInfo.phash.some((value) => hammingDistanceHex(value, phashValue) <= PHASH_THRESHOLD);

        const duplicateExactQueue = itemsRef.current.some(
          (entry) => entry.id !== itemId && entry.storeId === current.storeId && entry.sha256 === sha,
        );
        const duplicateLikelyQueue =
          !!phashValue &&
          itemsRef.current.some(
            (entry) =>
              entry.id !== itemId &&
              entry.storeId === current.storeId &&
              entry.phash &&
              hammingDistanceHex(entry.phash, phashValue) <= PHASH_THRESHOLD,
          );

        const duplicateExact = duplicateExactCache || duplicateExactQueue;
        const duplicateLikely = !duplicateExact && !!phashValue && (duplicateLikelyCache || duplicateLikelyQueue);

        const badges: string[] = [];
        if (duplicateExact) {
          badges.push("DuplicateExact");
        } else if (duplicateLikely) {
          badges.push("DuplicateLikely");
          addToast("info", `${current.file.name}: DuplicateLikely detected`);
        }

        const nextStatus: UploadStatus = duplicateExact ? "blocked" : "ready";

        setItems((prev) =>
          prev.map((entry) =>
            entry.id === itemId
              ? {
                  ...entry,
                  status: nextStatus,
                  sha256: sha,
                  phash: phashValue,
                  width,
                  height,
                  exifShotAt,
                  orientation,
                  viewBlob,
                  thumbBlob,
                  badges,
                  error: duplicateExact ? "DuplicateExact" : entry.error,
                }
              : entry,
          ),
        );

        console.info("[upload] processItem:done", {
          id: itemId,
          status: nextStatus,
          sha256: sha,
          viewType: viewBlob?.type,
          thumbType: thumbBlob?.type,
          purpose_key: purposeKeyValue,
          purpose_note_len_bucket: currentPurposeBucket,
          purchase_purpose: currentPurchasePurpose || null,
          payment_method_key: currentPaymentMethod.key,
          source_type: current.sourceType,
        });

        if (duplicateExact) addToast("error", `${current.file.name}: DuplicateExact detected`);
      } catch (error) {
        console.error("Failed to process file", error);
        setItems((prev) =>
          prev.map((entry) => (entry.id === itemId ? { ...entry, status: "error", error: "Failed to process file" } : entry)),
        );
        addToast("error", `${current.file.name}: Failed to process file`);
      }
    },
    [addToast, ensureStoreDuplicates, featureDisabled, getPaymentMethodContext, getPurposeContext, getPurchasePurpose],
  );

  useEffect(() => {
    return () => {
      if (dropHintTimeoutRef.current !== null) {
        window.clearTimeout(dropHintTimeoutRef.current);
      }
    };
  }, []);

  const showDropGuidance = useCallback(() => {
    setShowDropHint(true);
    if (dropHintTimeoutRef.current !== null) {
      window.clearTimeout(dropHintTimeoutRef.current);
    }
    dropHintTimeoutRef.current = window.setTimeout(() => {
      setShowDropHint(false);
      dropHintTimeoutRef.current = null;
    }, 2000);
  }, [setShowDropHint]);

  const enqueueFiles = useCallback(
    (
      filesInput: FileList | File[] | null | undefined,
      source: UploadSource,
      context: EnqueueContext,
    ) => {
      if (!storeId) {
        return false;
      }

      const { purposeKey, purposeBucket, sourceType } = context;
      const { trimmed: queuedPurchasePurpose } = getPurchasePurpose();
      const paymentContext = getPaymentMethodContext();

      const filesArray = filesInput ? Array.from(filesInput as ArrayLike<File>) : [];
      if (!filesArray.length) {
        console.info(`[upload] ${source}: empty file list`, {
          storeId,
          purpose_key: purposeKey,
          purpose_note_len_bucket: purposeBucket,
          purchase_purpose: queuedPurchasePurpose || null,
          payment_method_key: paymentContext.key,
          source_type: sourceType,
        });
        if (source === "drop") {
          showDropGuidance();
        }
        return false;
      }

      const localKeys = new Set<string>();
      const validItems: UploadItem[] = [];
      filesArray.forEach((file) => {
        if (file.size > MAX_FILE_SIZE) {
          addToast("error", `${file.name} exceeds 20MB limit`);
          return;
        }
        const queueKey = [file.name, file.size, file.lastModified].join(":");
        if (activeQueueKeysRef.current.has(queueKey) || localKeys.has(queueKey)) {
          console.info(`[upload] ${source}: duplicate candidate skipped`, {
            storeId,
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
          });
          return;
        }
        localKeys.add(queueKey);
        const id = crypto.randomUUID();
        validItems.push({
          id,
          queueKey,
          file,
          storeId,
          sourceType: context.sourceType,
          status: "pending",
          progress: 0,
          badges: [],
          createdAt: Date.now(),
        });
      });

      if (!validItems.length) {
        if (source === "drop") {
          showDropGuidance();
        }
        return false;
      }

      validItems.forEach((item) => {
        activeQueueKeysRef.current.add(item.queueKey);
      });

      setShowDropHint(false);
      setItems((prev) => [...prev, ...validItems]);

      validItems.forEach((item) =>
        console.info("[upload] queued", {
          id: item.id,
          name: item.file.name,
          type: item.file.type,
          size: item.file.size,
          purpose_key: purposeKey,
          purpose_note_len_bucket: purposeBucket,
          purchase_purpose: queuedPurchasePurpose || null,
          payment_method_key: paymentContext.key,
          source_type: sourceType,
        }),
      );

      window.setTimeout(() => {
        validItems.forEach((item) => void processItem(item.id));
      }, 0);

      return true;
    },
    [addToast, getPaymentMethodContext, getPurchasePurpose, processItem, showDropGuidance, storeId],
  );

const handleResetInfo = useCallback(() => {
  setSourceType('receipt');
  setPurposeKey('');
  setPurposeNote('');
  setPurchasePurpose('');
  const defaultKey = createPaymentMethodKey(DEFAULT_PAYMENT_METHODS[0]);
  setPaymentMethodKey(defaultKey);
}, []);

  const handlePurposeQuickSelect = useCallback((key: string) => {
  setPurposeKey(key);
}, []);

  const handlePurchaseQuickSelect = useCallback((value: string) => {
  setPurchasePurpose(value);
}, []);

  const handleSelectFilesClick = useCallback(() => {
  if (!storeId) {
    addToast('error', 'Select a store before uploading files');
    return;
  }
  fileInputRef.current?.click();
}, [addToast, storeId]);

  const handleCaptureClick = useCallback(() => {
  if (!storeId) {
    addToast('error', 'Select a store before uploading files');
    return;
  }
  captureInputRef.current?.click();
}, [addToast, storeId]);

  const handleCapture = useCallback(
  (event: ChangeEvent<HTMLInputElement>) => {
    const filesList = event.target.files;
    event.target.value = '';
    if (!filesList || !filesList.length) {
      return;
    }
    const enqueueContext = buildEnqueueContext();
    const { trimmed: purchasePurposeValue } = getPurchasePurpose();
    const paymentContext = getPaymentMethodContext();
    const fileDetails = Array.from(filesList).map((file) => ({ name: file.name, type: file.type, size: file.size }));

    console.info('[upload] capture: incoming', {
      disabled: featureDisabled,
      storeId,
      count: filesList.length,
      types: fileDetails,
      purpose_key: enqueueContext.purposeKey,
      purpose_note_len_bucket: enqueueContext.purposeBucket,
      purchase_purpose: purchasePurposeValue || null,
      payment_method_key: paymentContext.key,
      source_type: enqueueContext.sourceType,
    });

    if (featureDisabled) {
      addToast('info', 'Receipts upload is disabled');
      return;
    }
    if (!storeId) {
      addToast('error', 'Select a store before uploading files');
      console.warn('[upload] blocked: no storeId selected (capture)');
      return;
    }

    enqueueFiles(filesList, 'capture', enqueueContext);
  },
  [addToast, buildEnqueueContext, enqueueFiles, featureDisabled, getPaymentMethodContext, getPurchasePurpose, storeId],
);

  const handleFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const filesList = event.target.files;
      event.target.value = "";
      const fileDetails = filesList
        ? Array.from(filesList).map((f) => ({ name: f.name, type: f.type, size: f.size }))
        : [];

      console.info("[diag] change", {
        hasEvent: true,
        currentTarget: Boolean(event.currentTarget),
        fileCount: filesList?.length ?? 0,
        names: fileDetails,
      });

      const enqueueContext = buildEnqueueContext();
      const { trimmed: purchasePurposeValue } = getPurchasePurpose();
      const paymentContext = getPaymentMethodContext();
      const purposeKey = enqueueContext.purposeKey;

      console.info("[upload] handleFiles: incoming", {
        disabled: featureDisabled,
        storeId,
        count: filesList?.length ?? 0,
        types: fileDetails,
        purpose_key: purposeKey,
        purpose_note_len_bucket: enqueueContext.purposeBucket,
        purchase_purpose: purchasePurposeValue || null,
        payment_method_key: paymentContext.key,
        source_type: enqueueContext.sourceType,
      });

      if (featureDisabled) {
        addToast("info", "Receipts upload is disabled");
        return;
      }
      if (!storeId) {
        addToast("error", "Select a store before uploading files");
        console.warn("[upload] blocked: no storeId selected");
        return;
      }

      enqueueFiles(filesList, "change", enqueueContext);
    },
    [addToast, buildEnqueueContext, enqueueFiles, featureDisabled, getPaymentMethodContext, getPurchasePurpose, storeId],
  );

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      dropCounterRef.current += 1;
      if (!storeId) {
        return;
      }
      setIsDropActive(true);
    },
    [storeId],
  );

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dropCounterRef.current = Math.max(0, dropCounterRef.current - 1);
    if (dropCounterRef.current === 0) {
      setIsDropActive(false);
    }
  }, []);

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = storeId ? "copy" : "none";
      }
    },
    [storeId],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const files = event.dataTransfer?.files ?? null;
      const fileDetails = files
        ? Array.from(files).map((f) => ({ name: f.name, type: f.type, size: f.size }))
        : [];
      const fileCount = files?.length ?? 0;

      console.info("[diag] drop", {
        hasEvent: true,
        currentTarget: Boolean(event.currentTarget),
        hasDataTransfer: Boolean(event.dataTransfer),
        fileCount,
        names: fileDetails,
      });

      event.dataTransfer?.clearData();
      dropCounterRef.current = 0;
      setIsDropActive(false);

      const enqueueContext = buildEnqueueContext();
      const { trimmed: purchasePurposeValue } = getPurchasePurpose();
      const paymentContext = getPaymentMethodContext();
      const purposeKey = enqueueContext.purposeKey;

      console.info("[upload] handleDrop: incoming", {
        disabled: featureDisabled,
        storeId,
        count: fileCount,
        types: fileDetails,
        purpose_key: purposeKey,
        purpose_note_len_bucket: enqueueContext.purposeBucket,
        purchase_purpose: purchasePurposeValue || null,
        payment_method_key: paymentContext.key,
        source_type: enqueueContext.sourceType,
      });

      if (featureDisabled) {
        addToast("info", "Receipts upload is disabled");
        return;
      }
      if (!storeId) {
        addToast("error", "Select a store before uploading files");
        console.warn("[upload] blocked: no storeId selected (drop)");
        return;
      }

      enqueueFiles(files, "drop", enqueueContext);
    },
    [addToast, buildEnqueueContext, enqueueFiles, featureDisabled, getPaymentMethodContext, getPurchasePurpose, storeId],
  );


  // ??????O????
  const updateProgress = useCallback((id: string, status: UploadStatus, progress: number, error?: string) => {
    setItems((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, status, progress, error } : entry)),
    );
  }, []);

  // ?A?b?v???[?h?{??

  const uploadItem = useCallback(
    async (item: UploadItem) => {
      if (featureDisabled) {
        return;
      }

      await uploadSemaphore.current.run(async () => {
        const tasks: UploadTask[] = [];
        uploadTasks.current.set(item.id, tasks);
        const registerTask = (task: UploadTask) => {
          tasks.push(task);
        };

        const { option: uploadPurposeOption, trimmedNote: uploadPurposeNote, bucket: uploadPurposeBucket } = getPurposeContext();
        const uploadPurposeKey = uploadPurposeOption?.key ?? null;
        const { trimmed: uploadPurchasePurpose } = getPurchasePurpose();
        const paymentContext = getPaymentMethodContext();
        const selectedPaymentMethod: ReceiptPaymentMethod = {
          type: paymentContext.method.type,
          cardId: paymentContext.method.cardId ?? null,
        };

        const purposeSummary = uploadPurposeOption
          ? {
              key: uploadPurposeOption.key,
              label: uploadPurposeOption.label,
              note: uploadPurposeNote ? uploadPurposeNote : null,
            }
          : null;
        const includePurchasePurpose = uploadPurchasePurpose.length > 0;
        const summaryShouldExist = Boolean(purposeSummary || includePurchasePurpose);
        const summaryPayload: ReceiptSummaryData | null = summaryShouldExist
          ? {
              date: null,
              vendor: null,
              amount: null,
              tax: null,
              currency: null,
              memo: null,
              source: null,
              edited: false,
              language: null,
              keywords: [],
              usage: null,
              modelVersion: null,
              ...(purposeSummary ? { purpose: purposeSummary } : {}),
              ...(includePurchasePurpose ? { purchasePurpose: uploadPurchasePurpose } : {}),
            }
          : null;

        console.info('[upload] uploadItem:start', {
          id: item.id,
          type: item.file.type,
          name: item.file.name,
          purpose_key: uploadPurposeKey,
          purpose_note_len_bucket: uploadPurposeBucket,
          purchase_purpose: uploadPurchasePurpose || null,
          payment_method_key: paymentContext.key,
          source_type: item.sourceType,
        });

        if (!item.sha256) {
          updateProgress(item.id, 'error', item.progress, 'Missing SHA-256');
          addToast('error', `${item.file.name}: Missing SHA-256`);
          uploadTasks.current.delete(item.id);
          return;
        }

        const user = auth.currentUser;
        if (!user) {
          updateProgress(item.id, 'error', item.progress, 'Not authenticated');
          addToast('error', `${item.file.name}: Not authenticated`);
          uploadTasks.current.delete(item.id);
          return;
        }

        const ext = chooseExt(item.file.type, item.file.name);
        const now = new Date();
        const paths = buildReceiptStoragePaths({ storeId: item.storeId, now, originalExt: ext });

        const metadata: UploadMetadata = {
          contentType: item.file.type || 'application/octet-stream',
          customMetadata: { storeId: item.storeId, sha256: item.sha256 },
        };

        const viewBlob = item.viewBlob;
        const thumbBlob = item.thumbBlob;

        const metaBlob = new Blob(
          [
            JSON.stringify({
              sha256: item.sha256,
              phash: item.phash ?? null,
              width: item.width ?? 0,
              height: item.height ?? 0,
              exifShotAt: item.exifShotAt ?? null,
            }),
          ],
          { type: 'application/json' },
        );

        const uploadWithProgress = async (path: string, blob: Blob, objectMetadata: UploadMetadata) => {
          const objectRef = ref(storage, path);
          const task = uploadBytesResumable(objectRef, blob, objectMetadata);
          registerTask(task);
          await new Promise<void>((resolve, reject) => {
            task.on(
              'state_changed',
              (snapshot) => {
                const percent = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
                updateProgress(item.id, 'uploading', percent);
              },
              (err) => reject(err),
              () => resolve(),
            );
          });
        };

        try {
          updateProgress(item.id, 'uploading', 0);
          await uploadWithProgress(paths.originalPath, item.file, metadata);

          if (viewBlob) {
            await uploadWithProgress(paths.viewPath, viewBlob, {
              contentType: viewBlob.type || 'image/webp',
              customMetadata: { storeId: item.storeId, sha256: item.sha256 },
            });
          }

          if (thumbBlob) {
            await uploadWithProgress(paths.thumbPath, thumbBlob, {
              contentType: thumbBlob.type || 'image/webp',
              customMetadata: { storeId: item.storeId, sha256: item.sha256 },
            });
          }

          await uploadWithProgress(paths.metaPath, metaBlob, {
            contentType: 'application/json',
            customMetadata: { storeId: item.storeId, sha256: item.sha256 },
          });

          const receiptDoc: ReceiptDoc = {
            storeId: item.storeId,
            uploaderId: user.uid,
            uploaderName: user.displayName ?? user.email ?? user.uid,
            companyName: null,
            createdAt: serverTimestamp() as unknown as Timestamp,
            updatedAt: serverTimestamp() as unknown as Timestamp,
            status: 'draft',
            lockedBy: null,
            lockedAt: null,
            sourceType: item.sourceType,
            filePath: paths.originalPath,
            viewPath: viewBlob ? paths.viewPath : undefined,
            thumbPath: thumbBlob ? paths.thumbPath : undefined,
            year: now.getUTCFullYear(),
            month: now.getUTCMonth() + 1,
            purpose: purposeSummary?.label ?? null,
            purchasePurpose: uploadPurchasePurpose || null,
            memo: null,
            summary: summaryPayload,
            paymentMethod: selectedPaymentMethod,
            ocr: {
              date: null,
              vendorId: null,
              vendorName: null,
              vendor: null,
              rawText: null,
              amount: null,
              currency: 'JPY',
              tax: null,
              memo: null,
              source: null,
              confidenceGemini: null,
              confidenceFinal: null,
              confidence: 0,
            },
            meta: {
              sha256: item.sha256,
              phash: item.phash ?? null,
              width: item.width ?? 0,
              height: item.height ?? 0,
              exifShotAt: item.exifShotAt ?? null,
              originalTranscoded: false,
              manualEdits: false,
            },
            fraudFlags: item.badges.includes('DuplicateLikely') ? ['DuplicateLikely'] : [],
            assetsCount: 0,
            lastAssetAt: null,
          };

          const receiptRef = doc(collection(db, 'receipts'));
          await setDoc(receiptRef, receiptDoc);

          const storeInfo = duplicateCache.current.get(item.storeId);
          if (storeInfo) {
            if (item.sha256) {
              storeInfo.sha.add(item.sha256);
            }
            if (item.phash) {
              storeInfo.phash.push(item.phash);
            }
            persistDuplicateCache(item.storeId, storeInfo);
          } else if (item.sha256) {
            const info: DuplicateInfo = {
              sha: new Set<string>([item.sha256]),
              phash: item.phash ? [item.phash] : [],
            };
            duplicateCache.current.set(item.storeId, info);
            persistDuplicateCache(item.storeId, info);
          }

          updateProgress(item.id, 'success', 100);
          addToast('success', `${item.file.name}: Upload complete`);
        } catch (error) {
          const firebaseCode = (error as { code?: string })?.code;
          if (firebaseCode === 'storage/canceled') {
            console.info('[upload] uploadItem:cancelled', { id: item.id });
            updateProgress(item.id, 'cancelled', 0, 'Cancelled');
            addToast('info', `${item.file.name}: Cancelled`);
          } else {
            console.error('Upload failed', error);
            updateProgress(item.id, 'error', item.progress, 'Upload failed');
            addToast('error', `${item.file.name}: Upload failed`);
          }
        } finally {
          uploadTasks.current.delete(item.id);
        }
      });
    },
    [addToast, featureDisabled, getPaymentMethodContext, getPurposeContext, getPurchasePurpose, updateProgress],
  );
  const uploadReadyItems = useCallback(async () => {
    if (featureDisabled) {
      addToast("info", "Receipts upload is disabled");
      return;
    }
    const readyItems = itemsRef.current.filter((item) => item.status === "ready");
    if (!readyItems.length) {
      addToast("info", "No files ready for upload");
      return;
    }
    await Promise.all(readyItems.map((item) => uploadItem(item)));
  }, [addToast, featureDisabled, uploadItem]);

  const cancelItem = useCallback(
    (id: string) => {
      const target = itemsRef.current.find((entry) => entry.id === id);
      const wasUploading = target?.status === 'uploading';
      const tasks = uploadTasks.current.get(id);
      if (tasks?.length) {
        tasks.forEach((task) => {
          try {
            task.cancel();
          } catch (error) {
            console.warn('[upload] cancel failed', { id, error });
          }
        });
      }
      uploadTasks.current.delete(id);

      setItems((prev) => {
        const next: UploadItem[] = [];
        prev.forEach((entry) => {
          if (entry.id !== id) {
            next.push(entry);
            return;
          }
          if (entry.status === 'uploading') {
            next.push({
              ...entry,
              status: 'cancelled',
              error: 'Cancelled by user',
            });
          } else if (entry.status === 'success' || entry.status === 'error') {
            next.push(entry);
          }
        });
        return next;
      });

      if (!wasUploading && target) {
        addToast('info', `${target.file.name}: Removed from queue`);
      }
    },
    [addToast],
  );
  const readyCount = items.filter((item) => item.status === "ready").length;
  const uploading = items.some((item) => item.status === "uploading");
  const recentItems = useMemo(() => {
    return [...items]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 10);
  }, [items]);

  // ?? ?\????u?K?????O?v?F???????????????b???ID????????????????X?V
  const storeOptions = useMemo(
    () =>
      knownStoreIds.map((id) => ({
        id,
        name: storeDetails[id]?.name ?? id, // confirmed????????u???????
      })),
    [knownStoreIds, storeDetails],
  );
  const storeQuickOptions = useMemo(() => {
    if (!storeOptions.length) {
      return [];
    }
    const byId = new Map(storeOptions.map((option) => [option.id, option.name] as const));
    const historyIds = storeHistory.filter((id) => byId.has(id));
    const fallbackIds = storeOptions
      .map((option) => option.id)
      .filter((id) => !historyIds.includes(id));
    const combined = [...historyIds, ...fallbackIds];
    if (storeId && byId.has(storeId) && !combined.includes(storeId)) {
      combined.unshift(storeId);
    }
    const unique: string[] = [];
    for (const id of combined) {
      if (!unique.includes(id)) {
        unique.push(id);
      }
    }
    return unique.slice(0, STORE_HISTORY_LIMIT).map((id) => ({
      id,
      name: byId.get(id) ?? id,
    }));
  }, [storeOptions, storeHistory, storeId]);
  const storeSelectValue = isHydrated ? storeId : "";
  const hasStoresAvailable = isHydrated && storeOptions.length > 0;
  const storeSelectDisabled = !isHydrated || !storeOptions.length || (permissionsBusy && !permissions);
  const storeSelectTitle = !isHydrated
    ? "Loading stores"
    : !storeOptions.length
    ? "No stores available"
    : undefined;

  if (!RECEIPTS_FLAG) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6">
        <h1 className="text-xl font-semibold">Receipts upload is disabled</h1>
        <p className="text-sm text-neutral-500">Set NEXT_PUBLIC_APPFLAG_RECEIPTS=on to access this feature.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* ?w?b?_?[?F?^?C?g?? + ???[?U?[???i?v?]?j */}
      <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold">Upload Receipts</h1>
          <p className="text-sm text-neutral-500">
            Select image files (max 20MB each). Duplicate receipts are blocked using SHA-256 and perceptual hash.
          </p>
        </div>
        <p className="text-xs text-neutral-500">Signed in as <span className="font-medium text-neutral-700">{userName}</span></p>
      </div>

      {showSyncBanner ? (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700" aria-live="polite">
          Membership changes are syncing...
          {syncExceeded ? (
            <button type="button" className="ml-2 text-blue-600 underline" onClick={() => router.refresh()}>
              Reload
            </button>
          ) : null}
        </div>
      ) : null}

{showPurposeField ? (
  <section className="space-y-4 rounded border border-neutral-200 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-sm font-medium text-neutral-700">Information</h2>
        <p className="text-xs text-neutral-500">Select store and defaults before uploading.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleResetInfo}
          className="rounded border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
        >
          Reset info
        </button>
        {isHydrated ? (
          <button
            type="button"
            onClick={() => router.push("/stores/new")}
            className="rounded border border-blue-600 px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-50"
          >
            + Add store
          </button>
        ) : null}
        <Link
          href="/dashboard/receipts"
          className="rounded border border-purple-600 px-3 py-2 text-xs font-medium text-purple-600 hover:bg-purple-50"
        >
          View receipts
        </Link>
      </div>
    </div>

    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-neutral-600" htmlFor="information-store">
          Store
        </label>
        {isHydrated && storeQuickOptions.length ? (
          <div className="flex flex-wrap gap-2">
            {storeQuickOptions.map(({ id, name }) => {
              const isActive = storeId === id;
              const disabled = storeSelectDisabled;
              return (
                <button
                  key={`store-pill-${id}`}
                  type="button"
                  onClick={() => setStoreId(id)}
                  disabled={disabled}
                  className={clsx(
                    "rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                    isActive
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
                    disabled ? "cursor-not-allowed opacity-60" : ""
                  )}
                  aria-pressed={isActive}
                >
                  {name}
                </button>
              );
            })}
          </div>
        ) : null}
        <select
          id="information-store"
          className="rounded border border-neutral-300 px-3 py-2 text-sm"
          value={storeSelectValue}
          onChange={(event) => setStoreId(event.target.value)}
          disabled={storeSelectDisabled}
          title={storeSelectTitle}
        >
          {(!isHydrated || !storeSelectValue || !hasStoresAvailable) ? (
            <option value="" disabled hidden>
              {isHydrated && storeOptions.length ? "Select a store" : "Loading stores..."}
            </option>
          ) : null}
          {hasStoresAvailable
            ? storeOptions.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))
            : null}
        </select>
        {isHydrated && !storeOptions.length ? (
          <p className="text-xs text-neutral-500">No stores yet. Add one to start uploading.</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1 lg:col-span-1 xl:col-span-2">
        <span className="text-sm font-medium text-neutral-600">Upload type</span>
        <div className="flex flex-wrap gap-2">
          {SOURCE_TYPE_OPTIONS.map((option) => {
            const isActive = option.value === sourceType;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setSourceType(option.value)}
                disabled={featureDisabled}
                className={clsx(
                  "flex min-w-[140px] flex-col items-start gap-1 rounded border px-3 py-2 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                  isActive
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
                  featureDisabled ? "cursor-not-allowed opacity-60" : ""
                )}
                aria-pressed={isActive}
              >
                <span className="font-medium">{option.label}</span>
                <span className="text-xs text-neutral-500">{option.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1 xl:col-span-3">
        <span className="text-sm font-medium text-neutral-600">Payment method</span>
        {paymentQuickChoices.length ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span className="font-medium text-neutral-500">Recent:</span>
            {paymentQuickChoices.map((choice) => {
              const isActive = choice.key === paymentMethodKey;
              return (
                <button
                  key={`quick-payment-${choice.key}`}
                  type="button"
                  onClick={() => setPaymentMethodKey(choice.key)}
                  className={clsx(
                    "rounded-full border px-3 py-1 text-xs",
                    isActive
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
                  )}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {paymentMethodChoices.map((choice) => {
            const isActive = choice.key === paymentMethodKey;
            return (
              <button
                key={choice.key}
                type="button"
                onClick={() => setPaymentMethodKey(choice.key)}
                className={clsx(
                  "flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                  isActive
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
                )}
                aria-pressed={isActive}
              >
                <span>{choice.label}</span>
                {choice.source === "recent" ? (
                  <span className="text-[11px] uppercase text-neutral-400">Recent</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-neutral-500">We&apos;ll remember the last few methods you used for this store.</span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-neutral-600" htmlFor="receipt-purpose">
          Purpose
        </label>
        <select
          id="receipt-purpose"
          className="rounded border border-neutral-300 px-3 py-2 text-sm"
          value={purposeKey}
          onChange={(event) => setPurposeKey(event.target.value)}
        >
          <option value="">No purpose</option>
          {PURPOSE_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
        {purposeQuickOptions.length ? (
          <div className="flex flex-wrap gap-2 text-xs text-neutral-500">
            <span className="font-medium text-neutral-500">Recent:</span>
            {purposeQuickOptions.map((option) => (
              <button
                key={`purpose-${option.key}`}
                type="button"
                onClick={() => handlePurposeQuickSelect(option.key)}
                className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-400"
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        {showPurposeNoteInput ? (
          <input
            type="text"
            value={purposeNote}
            onChange={(event) => setPurposeNote(event.target.value.slice(0, PURPOSE_NOTE_MAX_LENGTH))}
            maxLength={PURPOSE_NOTE_MAX_LENGTH}
            className="rounded border border-neutral-300 px-3 py-2 text-sm"
            placeholder="Add a short note (optional)"
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-1 xl:col-span-3">
        <label className="text-sm font-medium text-neutral-600" htmlFor="receipt-purchase-purpose">
          Purchase purpose
        </label>
        <input
          id="receipt-purchase-purpose"
          type="text"
          value={purchasePurpose}
          onChange={(event) => setPurchasePurpose(event.target.value.slice(0, PURCHASE_PURPOSE_MAX_LENGTH))}
          onBlur={handlePurchasePurposeBlur}
          maxLength={PURCHASE_PURPOSE_MAX_LENGTH}
          className="rounded border border-neutral-300 px-3 py-2 text-sm"
          placeholder="e.g. store supplies or equipment purchase"
        />
        {purchaseQuickValues.length ? (
          <div className="flex flex-wrap gap-2 text-xs text-neutral-500">
            <span className="font-medium text-neutral-500">Recent:</span>
            {purchaseQuickValues.map((value) => (
              <button
                key={`purchase-${value}`}
                type="button"
                onClick={() => handlePurchaseQuickSelect(value)}
                className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-400"
              >
                {value}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  </section>
      ) : null}

      <section className="space-y-4 rounded border border-neutral-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-neutral-700">Upload files</h2>
            <p className="text-xs text-neutral-500">Drag files into the area or use the buttons to select and capture.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSelectFilesClick}
              disabled={!storeId}
              className="rounded border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Select files
            </button>
            <button
              type="button"
              onClick={handleCaptureClick}
              disabled={!storeId}
              className="rounded border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Take photo
            </button>
            <button
              type="button"
              onClick={uploadReadyItems}
              disabled={!readyCount || uploading}
              className={clsx(
                "rounded px-4 py-2 text-sm font-medium text-white",
                readyCount && !uploading ? "bg-green-600 hover:bg-green-700" : "bg-neutral-400"
              )}
              title={!readyCount ? "No files ready" : uploading ? "Uploading..." : "Create drafts"}
            >
              Create Draft Receipts
            </button>
          </div>
        </div>

        <div
          role="button"
          tabIndex={storeId ? 0 : -1}
          onClick={handleSelectFilesClick}
          onKeyDown={(event) => {
            if (!storeId) {
              return;
            }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleSelectFilesClick();
            }
          }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className={clsx(
            "flex flex-col items-center justify-center gap-2 rounded border-2 border-dashed px-6 py-10 text-center text-sm transition",
            storeId
              ? isDropActive
                ? "cursor-copy border-blue-500 bg-blue-50 text-blue-700"
                : "cursor-pointer border-neutral-300 bg-neutral-50 text-neutral-600 hover:border-blue-400 hover:bg-blue-50"
              : "cursor-not-allowed border-neutral-200 bg-neutral-100 text-neutral-400"
          )}
          aria-disabled={!storeId}
        >
          <p className="text-sm font-medium text-neutral-700">Drop files to add them</p>
          <p className="text-xs text-neutral-500">Supported: JPG, PNG, HEIC, WebP, PDF</p>
          {showDropHint ? <p className="text-xs text-blue-600">Drop files onto this area</p> : null}
        </div>

        <input
          ref={fileInputRef}
          id="upload-file-input"
          type="file"
          accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif,.pdf"
          multiple
          className="hidden"
          onChange={handleFiles}
          disabled={!storeId}
        />
        <input
          ref={captureInputRef}
          id="upload-capture-input"
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleCapture}
          disabled={!storeId}
        />
      </section>



      {/* ?t?@?C???J?[?h */}
      <section className="grid gap-3">
        {items.map((item) => {
          const isCancelable =
            item.status === "pending" ||
            item.status === "hashing" ||
            item.status === "ready" ||
            item.status === "blocked" ||
            item.status === "uploading";

          return (
            <div key={item.id} className="rounded border border-neutral-200 p-3">
              <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-medium">{item.file.name}</p>
                  <p className="text-xs text-neutral-500">
                    {humanFileSize(item.file.size)} - {STATUS_LABELS[item.status]}
                  </p>
                  <p className="text-xs text-neutral-400">Uploaded by {userName}</p>
                  <p className="text-xs text-neutral-400">Source: {SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}</p>
                </div>
                <div className="flex items-center gap-2">
                  {item.error ? <p className="text-xs text-red-600">{item.error}</p> : null}
                  {isCancelable ? (
                    <button
                      type="button"
                      onClick={() => cancelItem(item.id)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>

              {item.badges.length ? (
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {item.badges.map((badge) => (
                    <span
                      key={badge}
                      className={clsx(
                        "rounded px-2 py-1",
                        badge === "DuplicateExact"
                          ? "bg-red-100 text-red-600"
                          : badge === "DuplicateLikely"
                          ? "bg-amber-100 text-amber-600"
                          : "bg-neutral-100 text-neutral-600",
                      )}
                    >
                      {badge}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="mt-2 h-2 rounded-full bg-neutral-100">
                <div
                  className={clsx(
                    "h-2 rounded-full transition-all",
                    item.status === "success"
                      ? "bg-green-500"
                      : item.status === "error"
                      ? "bg-red-500"
                      : item.status === "cancelled"
                      ? "bg-neutral-400"
                      : "bg-blue-500",
                  )}
                  style={{ width: `${item.progress}%` }}
                />
              </div>
            </div>
          );
        })}        {!items.length ? <p className="text-sm text-neutral-500">No files selected yet.</p> : null}
      </section>

      <section className="rounded border border-neutral-200 p-4">
        <h2 className="text-sm font-medium text-neutral-700">Recent activity</h2>
        <div className="mt-2 flex flex-col gap-1">
          {recentItems.length ? (
            recentItems.map((item) => (
              <div key={`recent-${item.id}`} className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
                <span className="flex-1 truncate font-medium text-neutral-700">{item.file.name}</span>
                <span className="w-28 text-right text-neutral-400">{userName}</span>
                <span className="w-20 text-right text-neutral-500">{humanFileSize(item.file.size)}</span>
                <span className={clsx("w-24 text-right", STATUS_CLASSES[item.status])}>{STATUS_LABELS[item.status]}</span>
                <span className="w-12 text-right text-neutral-500">{item.progress}%</span>
                <span className="w-20 text-right text-neutral-400">
                  {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))
          ) : (
            <p className="text-xs text-neutral-500">No uploads yet.</p>
          )}
        </div>
      </section>

      {/* ?g?[?X?g */}
      <div className="fixed inset-x-0 bottom-4 flex justify-center">
        <div className="flex w-full max-w-sm flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={clsx(
                "rounded border px-3 py-2 text-sm shadow",
                toast.type === "success"
                  ? "border-green-200 bg-green-50 text-green-800"
                  : toast.type === "error"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-neutral-200 bg-neutral-50 text-neutral-700",
              )}
            >
              {toast.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}











