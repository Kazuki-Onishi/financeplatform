"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "@/lib/i18n/I18nProvider";
import { useParams, useRouter } from "next/navigation";
import {
  collection,
  endBefore,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getDownloadURL, ref } from "firebase/storage";
import SummaryPanel, { type SummaryPreview } from "./SummaryPanel";
import { receiptDoc, storeDoc } from "../../../../lib/firestoreRefs";
import { db, storage } from "../../../../lib/firebase/client";
import { useUserPermissions } from "../../../../lib/hooks/useUserPermissions";
import {
  canEdit as canEditUtil,
  canView as canViewUtil,
  hasStoreAccess as hasStoreAccessUtil,
} from "../../../../lib/permissions";
import type { ReceiptRecord, ReceiptStatus } from "../../../../types/receipt";
import { normaliseStoragePath } from "@/lib/utils/storage";
const RECEIPTS_FLAG = process.env.NEXT_PUBLIC_APPFLAG_RECEIPTS === "on";
const GEMINI_FLAG = process.env.NEXT_PUBLIC_APPFLAG_GEMINI_NORMALIZE === "on";
const STATUS_FILTER_OPTIONS: ("all" | ReceiptStatus)[] = [
  "all",
  "draft",
  "pending",
  "confirmed",
  "reviewed",
  "locked",
];
type ToastKind = "success" | "error" | "info";
interface ToastMessage {
  id: string;
  type: ToastKind;
  message: string;
}
type FilterState = {
  storeId: string;
  status: "all" | ReceiptStatus;
  uploaderId: string;
  startDate: string;
  endDate: string;
};
const createDefaultFilters = (receipt: ReceiptRecord | null): FilterState => ({
  storeId: receipt?.storeId ?? "",
  status: "all",
  uploaderId: receipt?.uploaderId ?? "",
  startDate: "",
  endDate: "",
});

type AmountSourceKind = "summary" | "ocr";

interface AmountInfo {
  value: number | null;
  currency: string;
  sourceKind: AmountSourceKind | null;
  source: string | null;
  edited: boolean;
}

function formatCurrency(amount: number, currency: string): string {
  const safeCurrency = currency && currency.trim().length ? currency.trim().toUpperCase() : "JPY";
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency: safeCurrency,
      currencyDisplay: "code",
      minimumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${safeCurrency} ${amount.toLocaleString("ja-JP")}`;
  }
}

function resolveAmountSourceLabel(
  kind: AmountSourceKind | null,
  source: string | null,
  edited: boolean,
  t: (key: string) => string,
): string | null {
  if (!kind) {
    return null;
  }
  if (kind === "summary") {
    if (edited) {
      return t("amountSource.summaryEdited");
    }
    if (source) {
      const label = source.trim().toLowerCase();
      if (label === "gemini") {
        return t("amountSource.summaryAi");
      }
      if (label === "manual") {
        return t("amountSource.summaryManual");
      }
      if (label === "ocr" || label === "vision") {
        return t("amountSource.summaryOcr");
      }
    }
    return t("amountSource.summary");
  }
  return t("amountSource.ocr");
}



export default function ReceiptDetailPage() {
  const router = useRouter();
  const tCommon = useTranslations("common");
  const tDetail = useTranslations("receipts.detailPage");
  const tStatusLabel = useTranslations("receipts.status");
  const params = useParams<{ id: string }>();
  const receiptId = Array.isArray(params?.id)
    ? params?.id[0]
    : (params?.id ?? "");
  const {
    permissions,
    loading: permissionsLoading,
    authReady,
  } = useUserPermissions();
  const [receipt, setReceipt] = useState<ReceiptRecord | null>(null);
  const [storeName, setStoreName] = useState<string>("-");
  const [loadingReceipt, setLoadingReceipt] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(() =>
    createDefaultFilters(null),
  );
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [navigatingPrev, setNavigatingPrev] = useState(false);
  const [navigatingNext, setNavigatingNext] = useState(false);
  const storeId = receipt?.storeId ?? null;
  const pushToast = useCallback((type: ToastKind, message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 3000);
  }, []);
  useEffect(() => {
    if (!RECEIPTS_FLAG) {
      setLoadingReceipt(false);
      setError(tDetail("errors.disabled"));
      return;
    }
    if (!authReady || permissionsLoading || !receiptId) {
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingReceipt(true);
      try {
        const snapshot = await getDoc(receiptDoc(receiptId));
        if (!snapshot.exists()) {
          if (!cancelled) {
            setReceipt(null);
            setError(tDetail("errors.notFound"));
          }
          return;
        }
        if (cancelled) {
          return;
        }
        const data = snapshot.data() as ReceiptRecord;
        const record = {
          ...data,
          id: snapshot.id,
        };
        setReceipt(record);
        setFilters(createDefaultFilters(record));
        setError(null);
      } catch (fetchError) {
        console.error(tDetail("errors.loadReceipt"), fetchError);
        if (!cancelled) {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : tDetail("errors.loadReceipt"),
          );
          setReceipt(null);
        }
      } finally {
        if (!cancelled) {
          setLoadingReceipt(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, permissionsLoading, receiptId, tDetail]);
  useEffect(() => {
    if (!storeId) {
      setStoreName("-");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(storeDoc(storeId));
        if (!cancelled) {
          const data = snap.data() as { name?: string } | undefined;
          setStoreName(data?.name?.trim() || storeId);
        }
      } catch (storeError) {
        console.warn(tDetail("errors.loadStore"), storeError);
        if (!cancelled) {
          setStoreName(storeId);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, tDetail]);
  const previewCandidates = useMemo(() => {
    if (!receipt) {
      return [];
    }
    return [
      receipt.viewPath,
      receipt.file?.path,
      receipt.thumbPath,
      receipt.filePath,
    ];
  }, [receipt]);

  useEffect(() => {
    if (!receipt) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      for (const candidate of previewCandidates) {
        const normalised = normaliseStoragePath(
          typeof candidate === "string" ? candidate : undefined,
        );
        if (!normalised) {
          continue;
        }
        try {
          const url = await getDownloadURL(ref(storage, normalised));
          if (!cancelled) {
            setPreviewUrl(url);
          }
          return;
        } catch (downloadError) {
          console.warn(tDetail("errors.loadPreview"), {
            candidate: normalised,
            downloadError,
          });
        }
      }
      if (!cancelled) {
        setPreviewUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewCandidates, receipt, tDetail]);
  useEffect(() => {
    if (!filtersOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFiltersOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [filtersOpen]);
  useEffect(() => {
    setFiltersOpen(false);
  }, [receiptId]);
  const canViewReceipt = useMemo(() => {
    if (!permissions || !receipt) {
      return false;
    }
    return (
      canViewUtil(permissions) &&
      hasStoreAccessUtil(permissions, receipt.storeId)
    );
  }, [permissions, receipt]);
  const canEditReceipt = useMemo(() => {
    if (!permissions || !receipt) {
      return false;
    }
    return (
      canEditUtil(permissions) &&
      hasStoreAccessUtil(permissions, receipt.storeId)
    );
  }, [permissions, receipt]);
  const isLocked = receipt?.status === "locked";
  const uploaderDisplay = useMemo(() => {
    const trimmedName = receipt?.uploaderName?.trim();
    if (trimmedName) {
      return trimmedName;
    }
    return receipt?.uploaderId ?? tCommon("unknown");
  }, [receipt?.uploaderName, receipt?.uploaderId, tCommon]);
  const summaryPreviews: SummaryPreview[] = useMemo(() => {
    if (!previewUrl) {
      return [];
    }
    return [
      {
        id: "receipt-primary",
        url: previewUrl,
        label: tDetail("preview.primary"),
        thumbnailUrl: previewUrl,
      },
    ];
  }, [previewUrl, tDetail]);

  const amountInfo = useMemo<AmountInfo>(() => {
    if (!receipt) {
      return {
        value: null,
        currency: "JPY",
        sourceKind: null,
        source: null,
        edited: false,
      };
    }
    const summaryAmount =
      typeof receipt.summary?.amount === "number" && Number.isFinite(receipt.summary.amount)
        ? receipt.summary.amount
        : null;
    if (summaryAmount !== null) {
      const summaryCurrency =
        typeof receipt.summary?.currency === "string" ? receipt.summary.currency.trim() : "";
      const ocrCurrency =
        typeof receipt.ocr?.currency === "string" ? receipt.ocr.currency.trim() : "";
      const resolvedCurrency = (summaryCurrency || ocrCurrency || "JPY").toUpperCase();
      return {
        value: summaryAmount,
        currency: resolvedCurrency,
        sourceKind: "summary",
        source: typeof receipt.summary?.source === "string" ? receipt.summary.source : null,
        edited: Boolean(receipt.summary?.edited),
      };
    }
    const ocrAmount =
      typeof receipt.ocr?.amount === "number" && Number.isFinite(receipt.ocr.amount)
        ? receipt.ocr.amount
        : null;
    if (ocrAmount !== null) {
      const ocrCurrency =
        typeof receipt.ocr?.currency === "string" ? receipt.ocr.currency.trim() : "";
      const resolvedCurrency = (ocrCurrency || "JPY").toUpperCase();
      return {
        value: ocrAmount,
        currency: resolvedCurrency,
        sourceKind: "ocr",
        source: typeof receipt.ocr?.source === "string" ? receipt.ocr.source : null,
        edited: false,
      };
    }
    return {
      value: null,
      currency: "JPY",
      sourceKind: null,
      source: null,
      edited: false,
    };
  }, [receipt]);

  const amountDisplay =
    amountInfo.value !== null ? formatCurrency(amountInfo.value, amountInfo.currency) : "-";
  const amountSourceLabel = resolveAmountSourceLabel(
    amountInfo.sourceKind,
    amountInfo.source,
    amountInfo.edited,
    (key) => tDetail(key),
  );

  const filtersAtDefault = useMemo(() => {
    if (!receipt) {
      return true;
    }
    return (
      filters.storeId === (receipt.storeId ?? "") &&
      filters.status === "all" &&
      filters.uploaderId.trim() === (receipt.uploaderId ?? "") &&
      !filters.startDate &&
      !filters.endDate
    );
  }, [filters, receipt]);
  const filterStoreMismatch = Boolean(
    receipt && filters.storeId && filters.storeId !== receipt.storeId,
  );
  const filterStatusMismatch = Boolean(
    receipt && filters.status !== "all" && filters.status !== receipt.status,
  );
  const filterUploaderMismatch = Boolean(
    receipt &&
      filters.uploaderId.trim() &&
      filters.uploaderId.trim() !== (receipt.uploaderId ?? ""),
  );
  const handleToggleFilters = useCallback(() => {
    setFiltersOpen((prev) => !prev);
  }, []);
  const handleCloseFilters = useCallback(() => {
    setFiltersOpen(false);
  }, []);
  const handleResetFilters = useCallback(() => {
    setFilters(createDefaultFilters(receipt));
  }, [receipt]);
  const handleBackToList = useCallback(() => {
    router.push("/dashboard/receipts");
  }, [router]);
  const handleGoToPrev = useCallback(async () => {
    if (!receipt) {
      return;
    }
    const storeId = filters.storeId || receipt.storeId;
    const createdAt = receipt.createdAt;
    if (!storeId || !createdAt) {
      pushToast("info", tDetail("toasts.noPrevious"));
      return;
    }
    setNavigatingPrev(true);
    try {
      const snapshot = await getDocs(
        query(
          collection(db, "receipts"),
          where("storeId", "==", storeId),
          orderBy("createdAt", "desc"),
          endBefore(createdAt),
          limit(1),
        ),
      );
      if (snapshot.empty) {
        pushToast("info", tDetail("toasts.noPrevious"));
        return;
      }
      router.push(`/dashboard/receipts/${snapshot.docs[0].id}`);
    } catch (navigationError) {
      console.error(tDetail("errors.loadPrevious"), navigationError);
      pushToast("error", tDetail("errors.loadPrevious"));
    } finally {
      setNavigatingPrev(false);
    }
  }, [filters.storeId, receipt, pushToast, router, tDetail]);
  const handleGoToNext = useCallback(async () => {
    if (!receipt) {
      return;
    }
    const storeId = filters.storeId || receipt.storeId;
    const createdAt = receipt.createdAt;
    if (!storeId || !createdAt) {
      pushToast("info", tDetail("toasts.noNext"));
      return;
    }
    setNavigatingNext(true);
    try {
      const snapshot = await getDocs(
        query(
          collection(db, "receipts"),
          where("storeId", "==", storeId),
          orderBy("createdAt", "desc"),
          startAfter(createdAt),
          limit(1),
        ),
      );
      if (snapshot.empty) {
        pushToast("info", tDetail("toasts.noNext"));
        return;
      }
      router.push(`/dashboard/receipts/${snapshot.docs[0].id}`);
    } catch (navigationError) {
      console.error(tDetail("errors.loadNext"), navigationError);
      pushToast("error", tDetail("errors.loadNext"));
    } finally {
      setNavigatingNext(false);
    }
  }, [filters.storeId, receipt, pushToast, router, tDetail]);
  const handleCancelChanges = useCallback(() => {
    pushToast("info", tDetail("toasts.noPendingChanges"));
  }, [pushToast, tDetail]);
  const handleConfirm = useCallback(async () => {
    if (!receipt) {
      pushToast("error", tDetail("errors.notLoaded"));
      return;
    }
    if (!canEditReceipt) {
      pushToast("error", tDetail("errors.noPermission"));
      return;
    }
    if (receipt.status === "confirmed") {
      pushToast("info", tDetail("toasts.alreadyConfirmed"));
      return;
    }
    try {
      await updateDoc(receiptDoc(receipt.id), {
        status: "confirmed",
        updatedAt: serverTimestamp(),
      });
      setReceipt((prev) =>
        prev
          ? {
              ...prev,
              status: "confirmed",
            }
          : prev,
      );
      pushToast("success", tDetail("toasts.confirmed"));
    } catch (confirmError) {
      console.error(tDetail("errors.confirmFailed"), confirmError);
      const message =
        (confirmError as Error).message ?? tDetail("errors.confirmFailed");
      pushToast("error", message);
    }
  }, [canEditReceipt, pushToast, receipt, tDetail]);
  const handleEnhance = useCallback(() => {
    pushToast("info", tDetail("toasts.enhanceUnavailable"));
  }, [pushToast, tDetail]);
  if (!RECEIPTS_FLAG) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6">
        {" "}
        <h1 className="text-xl font-semibold">
          Receipts feature is disabled
        </h1>{" "}
        <p className="text-sm text-neutral-500">
          Enable NEXT_PUBLIC_APPFLAG_RECEIPTS to view this page.
        </p>{" "}
      </div>
    );
  }
  if (loadingReceipt) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        {" "}
        <p className="text-sm text-neutral-500">Loading receipt...</p>{" "}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6">
        {" "}
        <h1 className="text-xl font-semibold">Failed to load receipt</h1>{" "}
        <p className="text-sm text-neutral-500">{error}</p>{" "}
      </div>
    );
  }
  if (!receipt) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6">
        {" "}
        <h1 className="text-xl font-semibold">Receipt not found</h1>{" "}
        <p className="text-sm text-neutral-500">
          The requested receipt is unavailable.
        </p>{" "}
      </div>
    );
  }
  if (!canViewReceipt) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6">
        {" "}
        <h1 className="text-xl font-semibold">Access denied</h1>{" "}
        <p className="text-sm text-neutral-500">
          You do not have access to this receipt.
        </p>{" "}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6 p-6">
      {" "}
      <header className="flex flex-col gap-3 border-b border-neutral-200 pb-4 lg:flex-row lg:items-center lg:justify-between">
        {" "}
        <h1 className="text-2xl font-semibold">Receipt Detail</h1>{" "}
        <div className="flex flex-wrap items-center gap-4">
          {" "}
          <div className="flex flex-col gap-1 text-sm text-gray-600">
            <span>
              Store: {storeName}
              {receipt.storeId ? ` (${receipt.storeId})` : ""}
            </span>
            <span>{tDetail("warnings.filterStatus", { status: tStatusLabel(receipt.status) })}</span>
            <span className="flex flex-wrap items-center gap-2">
              Amount: {amountDisplay}
              {amountSourceLabel ? (
                <span className="rounded border border-neutral-300 px-2 py-0.5 text-xs font-medium text-neutral-600">
                  {amountSourceLabel}
                </span>
              ) : null}
            </span>
            <span>Submitted by: {uploaderDisplay}</span>
          </div>{" "}
          <div className="relative">
            {" "}
            <button
              type="button"
              onClick={handleToggleFilters}
              className="rounded border border-neutral-300 px-3 py-1 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
            >
              {" "}
              Filters{" "}
            </button>{" "}
          </div>{" "}
        </div>{" "}
      </header>{" "}
      {filtersOpen ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={handleCloseFilters}
        >
          {" "}
          <div
            className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-4 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            {" "}
            <div className="flex items-center justify-between">
              {" "}
              <h2 className="text-sm font-semibold text-neutral-700">
                Filters
              </h2>{" "}
              <button
                type="button"
                onClick={handleCloseFilters}
                className="rounded px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
              >
                {" "}
                Close{" "}
              </button>{" "}
            </div>{" "}
            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              {" "}
              <label className="flex flex-col gap-1 text-xs">
                {" "}
                <span className="text-neutral-500">Store</span>{" "}
                <select
                  value={filters.storeId}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      storeId: event.target.value,
                    }))
                  }
                  className="rounded border border-neutral-300 px-2 py-1 text-sm"
                >
                  {" "}
                  <option value="">All stores</option>{" "}
                  {[filters.storeId || receipt.storeId]
                    .filter(Boolean)
                    .map((id) => (
                      <option key={id!} value={id!}>
                        {" "}
                        {id}{" "}
                      </option>
                    ))}{" "}
                </select>{" "}
              </label>{" "}
              <label className="flex flex-col gap-1 text-xs">
                {" "}
                <span className="text-neutral-500">{tDetail("filters.status")}</span>{" "}
                <select
                  value={filters.status}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      status: event.target.value as "all" | ReceiptStatus,
                    }))
                  }
                  className="rounded border border-neutral-300 px-2 py-1 text-sm"
                >
                  {" "}
                  {STATUS_FILTER_OPTIONS.map((option) => {
                    const label =
                      option === "all"
                        ? tDetail("filters.statusAll")
                        : tStatusLabel(option);
                    return (
                      <option key={option} value={option}>
                        {label}
                      </option>
                    );
                  })}{" "}
                </select>{" "}
              </label>{" "}
              <label className="flex flex-col gap-1 text-xs sm:col-span-2">
                {" "}
                <span className="text-neutral-500">{tDetail("filters.uploader")}</span>{" "}
                <input
                  type="text"
                  value={filters.uploaderId}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      uploaderId: event.target.value,
                    }))
                  }
                  className="rounded border border-neutral-300 px-2 py-1 text-sm"
                  placeholder={
                    uploaderDisplay || receipt.uploaderId || tCommon("search")
                  }
                />{" "}
                {uploaderDisplay ? (
                  <span className="text-[11px] text-neutral-400">
                    {tDetail("filters.currentUploader", { uploader: uploaderDisplay })}
                  </span>
                ) : null}{" "}
              </label>{" "}
              <label className="flex flex-col gap-1 text-xs">
                {" "}
                <span className="text-neutral-500">{tDetail("filters.startDate")}</span>{" "}
                <input
                  type="date"
                  value={filters.startDate}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      startDate: event.target.value,
                    }))
                  }
                  className="rounded border border-neutral-300 px-2 py-1 text-sm"
                />{" "}
              </label>{" "}
              <label className="flex flex-col gap-1 text-xs">
                {" "}
                <span className="text-neutral-500">{tDetail("filters.endDate")}</span>{" "}
                <input
                  type="date"
                  value={filters.endDate}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      endDate: event.target.value,
                    }))
                  }
                  className="rounded border border-neutral-300 px-2 py-1 text-sm"
                />{" "}
              </label>{" "}
            </div>{" "}
            {filterStoreMismatch ||
            filterStatusMismatch ||
            filterUploaderMismatch ? (
              <div className="mt-4 space-y-1 rounded border border-amber-100 bg-amber-50 p-2 text-xs text-amber-700">
                {" "}
                <p>
                  {tDetail("warnings.filterMismatch")}
                </p>{" "}
                {filterStoreMismatch ? <p>{tDetail("warnings.filterStore", { store: receipt.storeId })}</p> : null}{" "}
                {filterStatusMismatch ? <p>{tDetail("warnings.filterStatus", { status: tStatusLabel(receipt.status) })}</p> : null}{" "}
                {filterUploaderMismatch ? (
                  <p>{tDetail("warnings.filterUploader", { uploader: receipt.uploaderId })}</p>
                ) : null}{" "}
              </div>
            ) : null}{" "}
            <div className="mt-4 flex items-center justify-between">
              {" "}
              <button
                type="button"
                onClick={handleResetFilters}
                disabled={filtersAtDefault}
                className="rounded border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {" "}
                {tDetail("buttons.reset")} 
              </button>{" "}
              <button
                type="button"
                onClick={handleCloseFilters}
                className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                {" "}
                {tDetail("buttons.apply")} 
              </button>{" "}
            </div>{" "}
          </div>{" "}
        </div>
      ) : null}{" "}
      <SummaryPanel
        receipt={receipt}
        canEdit={canEditReceipt && !isLocked}
        pushToast={pushToast}
        onReceiptUpdate={setReceipt}
        previews={summaryPreviews}
        onConfirm={handleConfirm}
        confirmDisabled={!canEditReceipt || isLocked || receipt.status === "confirmed"}
        summariesEnabled={GEMINI_FLAG}
      />{" "}
      <div className="flex flex-wrap gap-3">
        {" "}
        <button
          type="button"
          onClick={handleBackToList}
          className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
        >
          {" "}
          {tDetail("buttons.backToList")} 
        </button>{" "}
        <button
          type="button"
          onClick={handleGoToPrev}
          disabled={navigatingPrev}
          className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {" "}
          {navigatingPrev ? tCommon("loading") : tDetail("buttons.previous")} 
        </button>{" "}
        <button
          type="button"
          onClick={handleGoToNext}
          disabled={navigatingNext}
          className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {" "}
          {navigatingNext ? tCommon("loading") : tDetail("buttons.next")} 
        </button>{" "}
        <button
          type="button"
          onClick={handleCancelChanges}
          className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
        >
          {" "}
          {tDetail("buttons.cancelChanges")} 
        </button>{" "}
        <button
          type="button"
          onClick={handleConfirm}
          disabled={
            !canEditReceipt || isLocked || receipt.status === "confirmed"
          }
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-600"
        >
          {" "}
          {tDetail("buttons.confirm")} 
        </button>{" "}
        {GEMINI_FLAG && !isLocked ? (
          <button
            type="button"
            onClick={handleEnhance}
            className="rounded border border-purple-400 px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-50"
          >
            {" "}
            {tDetail("buttons.enhance")} 
          </button>
        ) : null}{" "}
      </div>{" "}
      <div className="fixed inset-x-0 bottom-4 flex justify-center">
        {" "}
        <div className="flex w-full max-w-sm flex-col gap-2">
          {" "}
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`rounded border px-3 py-2 text-sm shadow ${toast.type === "success" ? "border-green-200 bg-green-50 text-green-800" : toast.type === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-neutral-200 bg-neutral-50 text-neutral-700"}`}
            >
              {" "}
              {toast.message}{" "}
            </div>
          ))}{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

