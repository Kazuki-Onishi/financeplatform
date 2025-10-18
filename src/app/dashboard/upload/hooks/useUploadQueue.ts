"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  collection,
  doc,
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

import { auth, db, storage } from "@/lib/firebase/client";
import { useTranslations } from "@/lib/i18n/I18nProvider";
import { receiptsCollection } from "@/lib/firestoreRefs";
import { buildReceiptStoragePaths } from "@/lib/storagePaths";
import { chooseExt } from "@/lib/fileNamer";
import {
  extractExif,
  hammingDistanceHex,
  loadImage,
  pHash,
  sha256Of,
  thumb256,
  toWebp,
} from "@/lib/imageUtil";
import type { ReceiptDoc, ReceiptPaymentMethod, ReceiptSummaryData } from "@/types/receipt";
import type { ReceiptPurposeOption } from "@/lib/purposeOptions";

import {
  DUPLICATE_LOOKBACK,
  MAX_CONCURRENT_UPLOADS,
  MAX_FILE_SIZE,
  PHASH_THRESHOLD,
} from "../constants";
import {
  loadDuplicateCache,
  persistDuplicateCache,
  Semaphore,
} from "../utils";
import type {
  DuplicateInfo,
  EnqueueContext,
  PaymentMethodChoice,
  ToastMessage,
  UploadItem,
  UploadSource,
  UploadStatus,
} from "../types";

type PurposeContext = {
  option: ReceiptPurposeOption | null;
  sanitizedNote: string;
  trimmedNote: string;
  bucket: string;
  label: string | null;
};

type PurchasePurposeContext = {
  sanitized: string;
  trimmed: string;
};

type UseUploadQueueParams = {
  storeId: string;
  featureDisabled: boolean;
  addToast: (type: ToastMessage["type"], message: string) => void;
  buildEnqueueContext: () => EnqueueContext;
  getPurposeContext: () => PurposeContext;
  getPurchasePurpose: () => PurchasePurposeContext;
  getAdvancePayment: () => boolean;
  getPaymentMethodContext: () => PaymentMethodChoice;
};

type UseUploadQueueResult = {
  items: UploadItem[];
  isDropActive: boolean;
  showDropHint: boolean;
  readyCount: number;
  uploading: boolean;
  recentItems: UploadItem[];
  handleCapture: (event: ChangeEvent<HTMLInputElement>) => void;
  handleFiles: (event: ChangeEvent<HTMLInputElement>) => void;
  handleDragEnter: (event: DragEvent<HTMLElement>) => void;
  handleDragLeave: (event: DragEvent<HTMLElement>) => void;
  handleDragOver: (event: DragEvent<HTMLElement>) => void;
  handleDrop: (event: DragEvent<HTMLElement>) => void;
  uploadReadyItems: () => Promise<void>;
  cancelItem: (id: string) => void;
};

export function useUploadQueue({
  storeId,
  featureDisabled,
  addToast,
  buildEnqueueContext,
  getPurposeContext,
  getPurchasePurpose,
  getAdvancePayment,
  getPaymentMethodContext,
}: UseUploadQueueParams): UseUploadQueueResult {
  const tQueue = useTranslations("upload.queue");
  const tToasts = useTranslations("upload.toasts");
  const tErrors = useTranslations("upload.errors");
  const tPage = useTranslations("upload.page");
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isDropActive, setIsDropActive] = useState(false);
  const [showDropHint, setShowDropHint] = useState(false);

  const itemsRef = useRef<UploadItem[]>([]);
  const activeQueueKeysRef = useRef<Set<string>>(new Set());
  const duplicateCache = useRef<Map<string, DuplicateInfo>>(new Map());
  const duplicateFetches = useRef<Map<string, Promise<DuplicateInfo>>>(new Map());
  const uploadTasks = useRef<Map<string, UploadTask[]>>(new Map());
  const uploadSemaphore = useRef(new Semaphore(MAX_CONCURRENT_UPLOADS));
  const dropCounterRef = useRef(0);
  const dropHintTimeoutRef = useRef<number | null>(null);

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

  useEffect(() => {
    return () => {
      if (dropHintTimeoutRef.current !== null) {
        window.clearTimeout(dropHintTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (featureDisabled) {
      setItems([]);
    }
  }, [featureDisabled]);

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

  const showDropGuidance = useCallback(() => {
    setShowDropHint(true);
    if (dropHintTimeoutRef.current !== null) {
      window.clearTimeout(dropHintTimeoutRef.current);
    }
    dropHintTimeoutRef.current = window.setTimeout(() => {
      setShowDropHint(false);
      dropHintTimeoutRef.current = null;
    }, 2000);
  }, []);

  const processItem = useCallback(
    async (itemId: string) => {
      if (featureDisabled) {
        return;
      }
      const current = itemsRef.current.find((entry) => entry.id === itemId);
      if (!current) {
        return;
      }

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
        const currentAdvancePayment = getAdvancePayment();
        console.info("[upload] processItem:start", {
          id: itemId,
          name: current.file.name,
          type: current.file.type,
          purpose_key: purposeKeyValue,
          purpose_note_len_bucket: currentPurposeBucket,
          purchase_purpose: currentPurchasePurpose || null,
          payment_method_key: currentPaymentMethod.key,
          source_type: current.sourceType,
          advance_payment: currentAdvancePayment,
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
          advance_payment: currentAdvancePayment,
        });

        if (duplicateExact) {
          addToast("error", `${current.file.name}: DuplicateExact detected`);
        }
      } catch (error) {
        console.error("Failed to process file", error);
        setItems((prev) =>
          prev.map((entry) => (entry.id === itemId ? { ...entry, status: "error", error: "Failed to process file" } : entry)),
        );
        const current = itemsRef.current.find((entry) => entry.id === itemId);
        if (current) {
          addToast("error", `${current.file.name}: Failed to process file`);
        }
      }
    },
    [addToast, ensureStoreDuplicates, featureDisabled, getAdvancePayment, getPaymentMethodContext, getPurposeContext, getPurchasePurpose],
  );

  const enqueueFiles = useCallback(
    (
      filesInput: FileList | File[] | null | undefined,
      source: UploadSource,
      context: EnqueueContext,
    ) => {
      if (!storeId) {
        return false;
      }

      const { purposeKey, purposeBucket, sourceType, advancePayment } = context;
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
          advance_payment: advancePayment,
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
          advance_payment: advancePayment,
        }),
      );

      window.setTimeout(() => {
        validItems.forEach((item) => void processItem(item.id));
      }, 0);

      return true;
    },
    [
      addToast,
      getPaymentMethodContext,
      getPurchasePurpose,
      processItem,
      showDropGuidance,
      storeId,
    ],
  );

  const handleCapture = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const filesList = event.target.files;
      const filesArray = filesList ? Array.from(filesList) : [];
      event.target.value = "";
      if (!filesArray.length) {
        return;
      }
      const enqueueContext = buildEnqueueContext();
      const { trimmed: purchasePurposeValue } = getPurchasePurpose();
      const paymentContext = getPaymentMethodContext();
      const fileDetails = filesArray.map((file) => ({ name: file.name, type: file.type, size: file.size }));

      console.info("[upload] capture: incoming", {
        disabled: featureDisabled,
        storeId,
        count: filesArray.length,
        types: fileDetails,
        purpose_key: enqueueContext.purposeKey,
        purpose_note_len_bucket: enqueueContext.purposeBucket,
        purchase_purpose: purchasePurposeValue || null,
        payment_method_key: paymentContext.key,
        source_type: enqueueContext.sourceType,
        advance_payment: enqueueContext.advancePayment,
      });

      if (featureDisabled) {
        addToast("info", tToasts("disabled"));
        return;
      }
      if (!storeId) {
        addToast("error", tPage("storeRequired"));
        console.warn("[upload] blocked: no storeId selected (capture)");
        return;
      }

      enqueueFiles(filesArray, "capture", enqueueContext);
    },
    [
      addToast,
      buildEnqueueContext,
      enqueueFiles,
      featureDisabled,
      getPaymentMethodContext,
      getPurchasePurpose,
      storeId,
      tPage,
      tToasts,
    ],
  );

  const handleFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const filesList = event.target.files;
      const filesArray = filesList ? Array.from(filesList) : [];
      event.target.value = "";
      const fileDetails = filesArray.map((f) => ({ name: f.name, type: f.type, size: f.size }));

      console.info("[diag] change", {
        hasEvent: true,
        currentTarget: Boolean(event.currentTarget),
        fileCount: filesArray.length,
        names: fileDetails,
      });

      const enqueueContext = buildEnqueueContext();
      const { trimmed: purchasePurposeValue } = getPurchasePurpose();
      const paymentContext = getPaymentMethodContext();
      const purposeKey = enqueueContext.purposeKey;

      console.info("[upload] handleFiles: incoming", {
        disabled: featureDisabled,
        storeId,
        count: filesArray.length,
        types: fileDetails,
        purpose_key: purposeKey,
        purpose_note_len_bucket: enqueueContext.purposeBucket,
        purchase_purpose: purchasePurposeValue || null,
        payment_method_key: paymentContext.key,
        source_type: enqueueContext.sourceType,
      });

      if (featureDisabled) {
        addToast("info", tToasts("disabled"));
        return;
      }
      if (!storeId) {
        addToast("error", tPage("storeRequired"));
        console.warn("[upload] blocked: no storeId selected");
        return;
      }

      enqueueFiles(filesArray, "change", enqueueContext);
    },
    [
      addToast,
      buildEnqueueContext,
      enqueueFiles,
      featureDisabled,
      getPaymentMethodContext,
      getPurchasePurpose,
      storeId,
      tPage,
      tToasts,
    ],
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
        advance_payment: enqueueContext.advancePayment,
      });

      if (featureDisabled) {
        addToast("info", tToasts("disabled"));
        return;
      }
      if (!storeId) {
        addToast("error", tPage("storeRequired"));
        console.warn("[upload] blocked: no storeId selected (drop)");
        return;
      }

      enqueueFiles(files, "drop", enqueueContext);
    },
    [
      addToast,
      buildEnqueueContext,
      enqueueFiles,
      featureDisabled,
      getPaymentMethodContext,
      getPurchasePurpose,
      storeId,
      tPage,
      tToasts,
    ],
  );

  const updateProgress = useCallback((id: string, status: UploadStatus, progress: number, error?: string) => {
    setItems((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, status, progress, error } : entry)),
    );
  }, []);

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

        const { option: uploadPurposeOption, trimmedNote: uploadPurposeNote, bucket: uploadPurposeBucket } =
          getPurposeContext();
        const uploadPurposeKey = uploadPurposeOption?.key ?? null;
        const { trimmed: uploadPurchasePurpose } = getPurchasePurpose();
        const paymentContext = getPaymentMethodContext();
        const advancePaymentSelected = getAdvancePayment();
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
        const includeAdvancePayment = advancePaymentSelected;
        const summaryShouldExist = Boolean(purposeSummary || includePurchasePurpose || includeAdvancePayment);
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
              advancePayment: advancePaymentSelected,
            }
          : null;

        console.info("[upload] uploadItem:start", {
          id: item.id,
          type: item.file.type,
          name: item.file.name,
          purpose_key: uploadPurposeKey,
          purpose_note_len_bucket: uploadPurposeBucket,
          purchase_purpose: uploadPurchasePurpose || null,
          payment_method_key: paymentContext.key,
          source_type: item.sourceType,
          advance_payment: advancePaymentSelected,
        });

        if (!item.sha256) {
          updateProgress(item.id, "error", item.progress, "Missing SHA-256");
          addToast("error", `${item.file.name}: Missing SHA-256`);
          uploadTasks.current.delete(item.id);
          return;
        }

        const user = auth.currentUser;
        if (!user) {
          updateProgress(item.id, "error", item.progress, "Not authenticated");
          addToast("error", `${item.file.name}: Not authenticated`);
          uploadTasks.current.delete(item.id);
          return;
        }

        const ext = chooseExt(item.file.type, item.file.name);
        const now = new Date();
        const paths = buildReceiptStoragePaths({ storeId: item.storeId, now, originalExt: ext });

        const metadata: UploadMetadata = {
          contentType: item.file.type || "application/octet-stream",
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
          { type: "application/json" },
        );

        const uploadWithProgress = async (path: string, blob: Blob, objectMetadata: UploadMetadata) => {
          const objectRef = ref(storage, path);
          const task = uploadBytesResumable(objectRef, blob, objectMetadata);
          registerTask(task);
          await new Promise<void>((resolve, reject) => {
            task.on(
              "state_changed",
              (snapshot) => {
                const percent = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
                updateProgress(item.id, "uploading", percent);
              },
              (err) => reject(err),
              () => resolve(),
            );
          });
        };

        try {
          updateProgress(item.id, "uploading", 0);
          await uploadWithProgress(paths.originalPath, item.file, metadata);

          if (viewBlob) {
            await uploadWithProgress(paths.viewPath, viewBlob, {
              contentType: viewBlob.type || "image/webp",
              customMetadata: { storeId: item.storeId, sha256: item.sha256 },
            });
          }

          if (thumbBlob) {
            await uploadWithProgress(paths.thumbPath, thumbBlob, {
              contentType: thumbBlob.type || "image/webp",
              customMetadata: { storeId: item.storeId, sha256: item.sha256 },
            });
          }

          await uploadWithProgress(paths.metaPath, metaBlob, {
            contentType: "application/json",
            customMetadata: { storeId: item.storeId, sha256: item.sha256 },
          });

          const userName = user.displayName ?? user.email ?? user.uid;
          const receiptDoc: ReceiptDoc = {
            storeId: item.storeId,
            uploaderId: user.uid,
            uploaderName: userName,
            companyName: null,
            createdAt: serverTimestamp() as unknown as Timestamp,
            updatedAt: serverTimestamp() as unknown as Timestamp,
            status: "draft",
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
            advancePayment: advancePaymentSelected,
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
              currency: "JPY",
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
            fraudFlags: item.badges.includes("DuplicateLikely") ? ["DuplicateLikely"] : [],
            assetsCount: 0,
            lastAssetAt: null,
          };

          const receiptRef = doc(collection(db, "receipts"));
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

          updateProgress(item.id, "success", 100);
          addToast("success", tToasts("uploadComplete", { file: item.file.name }));
        } catch (error) {
          const firebaseCode = (error as { code?: string })?.code;
          if (firebaseCode === "storage/canceled") {
            console.info("[upload] uploadItem:cancelled", { id: item.id });
            updateProgress(item.id, "cancelled", 0, tQueue("statuses.cancelled"));
            addToast("info", tToasts("cancelled", { file: item.file.name }));
          } else {
            console.error("Upload failed", error);
            updateProgress(item.id, "error", item.progress, tToasts("uploadFailed", { file: item.file.name }));
            addToast("error", tToasts("uploadFailed", { file: item.file.name }));
          }
        } finally {
          uploadTasks.current.delete(item.id);
        }
      });
    },
    [
      addToast,
      featureDisabled,
      getAdvancePayment,
      getPaymentMethodContext,
      getPurposeContext,
      getPurchasePurpose,
      tQueue,
      tToasts,
      updateProgress,
    ],
  );

  const uploadReadyItems = useCallback(async () => {
    if (featureDisabled) {
      addToast("info", tToasts("disabled"));
      return;
    }
    const readyItems = itemsRef.current.filter((item) => item.status === "ready");
    if (!readyItems.length) {
      addToast("info", tToasts("noFiles"));
      return;
    }
    await Promise.all(readyItems.map((item) => uploadItem(item)));
  }, [addToast, featureDisabled, tToasts, uploadItem]);

  const cancelItem = useCallback(
    (id: string) => {
      const target = itemsRef.current.find((entry) => entry.id === id);
      const wasUploading = target?.status === "uploading";
      const tasks = uploadTasks.current.get(id);
      if (tasks?.length) {
        tasks.forEach((task) => {
          try {
            task.cancel();
          } catch (error) {
            console.warn("[upload] cancel failed", { id, error });
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
          if (entry.status === "uploading") {
            next.push({
              ...entry,
              status: "cancelled",
              error: tErrors("cancelledByUser"),
            });
          } else if (entry.status === "success" || entry.status === "error") {
            next.push(entry);
          }
        });
        return next;
      });

      if (!wasUploading && target) {
        addToast("info", tToasts("removed", { file: target.file.name }));
      }
    },
    [addToast, tErrors, tToasts],
  );

  const readyCount = items.filter((item) => item.status === "ready").length;
  const uploading = items.some((item) => item.status === "uploading");
  const recentItems = useMemo(() => {
    return [...items]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 10);
  }, [items]);

  return {
    items,
    isDropActive,
    showDropHint,
    readyCount,
    uploading,
    recentItems,
    handleCapture,
    handleFiles,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    uploadReadyItems,
    cancelItem,
  };
}


