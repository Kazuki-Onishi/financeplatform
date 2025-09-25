"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type DocumentData,
  type QueryConstraint,
  Timestamp,
} from "firebase/firestore";
import { getDownloadURL, ref } from "firebase/storage";
import { auth, db, storage } from "../../../lib/firebase/client";
import { useUserPermissions } from "../../../lib/hooks/useUserPermissions";
import { runBulkAnalysis } from "../../../lib/api.client";
import type { ReceiptRecord, ReceiptStatus, ReceiptFraudFlag } from "../../../types/receipt";
import type { StoreDoc } from "../../../types/store";

const RECEIPTS_FLAG = process.env.NEXT_PUBLIC_APPFLAG_RECEIPTS === "on";
const SYNC_TIMEOUT_MS = 10_000;

interface ReceiptRow extends ReceiptRecord {
  viewUrl?: string | null;
  thumbUrl?: string | null;
}

interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

const ALL_STORES_OPTION = "all" as const;
const STATUS_OPTIONS: ("all" | ReceiptStatus)[] = ["all", "draft", "pending", "confirmed", "reviewed", "locked"];

function formatJst(timestamp: Timestamp): string {
  const date = timestamp.toDate();
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAmount(amount: number | null, currency: string): string {
  if (amount === null || Number.isNaN(amount)) {
    return "?";
  }
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: 0,
  }).format(amount);
}

function describePayment(row: ReceiptRecord): string {
  const method = row.paymentMethod;
  if (!method) {
    return "?";
  }
  if (method.type === "credit") {
    return method.cardId ? `credit E ${method.cardId.slice(-4)}` : "credit";
  }
  return method.type;
}

function fallbackThumbPath(viewPath?: string, filePath?: string): string | null {
  const base = viewPath ?? filePath;
  if (!base) {
    return null;
  }
  const index = base.lastIndexOf("/");
  if (index <= 0) {
    return null;
  }
  const parent = base.slice(0, index);
  return `${parent}/thumb.webp`;
}

export default function ReceiptsPage() {
  const router = useRouter();
  const { permissions, loading: permissionsLoading, optimisticMemberships, confirmed, authReady } = useUserPermissions();
  const searchParams = useSearchParams();
  const requestedStoreId = searchParams.get("store");

  const [storeId, setStoreId] = useState<string>("");
  const [status, setStatus] = useState<"all" | ReceiptStatus>("all");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);
  const [syncExceeded, setSyncExceeded] = useState(false);

  useEffect(() => {
    console.info("[Receipts] page mounted");
  }, []);

  const featureDisabled = !RECEIPTS_FLAG;
  const isSyncing = optimisticMemberships.length > 0 && !confirmed;
  const showSyncBanner = isSyncing;
  const [storeDetails, setStoreDetails] = useState<Record<string, { name: string }>>({});
  const availableStoreIds = useMemo(() => {
    const ids = new Set<string>(permissions?.storeIds ?? []);
    optimisticMemberships.forEach((membership) => ids.add(membership.storeId));
    return Array.from(ids).sort();
  }, [permissions?.storeIds, optimisticMemberships]);
  const hasAllStoresOption = availableStoreIds.length > 1;
  const storeOptions = useMemo(() => {
    const options = availableStoreIds.map((id) => ({
      id,
      name: storeDetails[id]?.name ?? id,
    }));
    if (hasAllStoresOption) {
      options.unshift({ id: ALL_STORES_OPTION, name: "All stores" });
    }
    return options;
  }, [availableStoreIds, storeDetails, hasAllStoresOption]);
  useEffect(() => {
    if (!confirmed || !availableStoreIds.length) {
      return;
    }
    const missing = availableStoreIds.filter((id) => !storeDetails[id]);
    if (!missing.length) {
      return;
    }
    let cancelled = false;
    (async () => {
      const updates: Record<string, { name: string }> = {};
      await Promise.all(
        missing.map(async (id) => {
          try {
            const snapshot = await getDoc(doc(db, "stores", id));
            if (snapshot.exists()) {
              const data = snapshot.data() as Partial<StoreDoc>;
              const resolvedName =
                typeof data?.name === "string" && data.name.trim()
                  ? data.name.trim()
                  : id;
              updates[id] = { name: resolvedName };
            } else {
              updates[id] = { name: id };
            }
          } catch (error) {
            console.warn("[Receipts] failed to load store name", id, error);
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
  }, [availableStoreIds, confirmed, storeDetails]);

  const permissionsBusy = !authReady || permissionsLoading;

  const canExportCsv = permissions?.flags.includes("perm.exportCsv") ?? false;
  useEffect(() => {
    if (isSyncing) {
      setSyncStartedAt((current) => current ?? Date.now());
      return;
    }
    setSyncStartedAt(null);
    setSyncExceeded(false);
  }, [isSyncing]);

  useEffect(() => {
    if (!syncStartedAt || !isSyncing) {
      return;
    }
    const timer = window.setTimeout(() => setSyncExceeded(true), SYNC_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [syncStartedAt, isSyncing]);

  useEffect(() => {
    if (!syncExceeded || !syncStartedAt) {
      return;
    }
    const delayMs = Date.now() - syncStartedAt;
    console.info("[sync-delay]", { delayMs, storeId });
  }, [syncExceeded, syncStartedAt, storeId]);
  useEffect(() => {
    if (permissionsBusy) {
      return;
    }
    if (!availableStoreIds.length) {
      router.replace("/onboarding");
      return;
    }

    if (requestedStoreId === ALL_STORES_OPTION && hasAllStoresOption) {
      if (storeId !== ALL_STORES_OPTION) {
        setStoreId(ALL_STORES_OPTION);
      }
      return;
    }

    if (requestedStoreId && availableStoreIds.includes(requestedStoreId)) {
      if (storeId !== requestedStoreId) {
        setStoreId(requestedStoreId);
      }
      return;
    }

    if (storeId === ALL_STORES_OPTION && !hasAllStoresOption) {
      setStoreId(availableStoreIds[0] ?? "");
      return;
    }

    if (!storeId) {
      const preferred = permissions?.activeStoreId && availableStoreIds.includes(permissions.activeStoreId)
        ? permissions.activeStoreId
        : hasAllStoresOption
        ? ALL_STORES_OPTION
        : availableStoreIds[0] ?? "";
      if (preferred) {
        setStoreId(preferred);
      }
      return;
    }

    if (storeId !== ALL_STORES_OPTION && !availableStoreIds.includes(storeId)) {
      const fallback = permissions?.activeStoreId && availableStoreIds.includes(permissions.activeStoreId)
        ? permissions.activeStoreId
        : availableStoreIds[0] ?? (hasAllStoresOption ? ALL_STORES_OPTION : "");
      setStoreId(fallback);
    }
  }, [availableStoreIds, hasAllStoresOption, permissions?.activeStoreId, permissionsBusy, requestedStoreId, router, storeId]);

  useEffect(() => {
    if (featureDisabled) {
      setRows([]);
    }
  }, [featureDisabled]);

  useEffect(() => {
    setSelectedIds([]);
    setAnalysisStatus(null);
  }, [storeId]);

  const pushToast = useCallback((type: ToastMessage["type"], message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);


  useEffect(() => {
    if (featureDisabled) {
      return;
    }
    let cancelled = false;
    async function fetchReceipts(): Promise<void> {
      const targetStoreIds =
        storeId === ALL_STORES_OPTION ? availableStoreIds : storeId ? [storeId] : [];
      if (!targetStoreIds.length) {
        setRows([]);
        setSelectedIds([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const baseConstraints: QueryConstraint[] = [];
        if (status !== "all") {
          baseConstraints.push(where("status", "==", status));
        }
        if (startDate) {
          const start = Timestamp.fromDate(new Date(`${startDate}T00:00:00`));
          baseConstraints.push(where("createdAt", ">=", start));
        }
        if (endDate) {
          const end = Timestamp.fromDate(new Date(`${endDate}T23:59:59`));
          baseConstraints.push(where("createdAt", "<=", end));
        }
        baseConstraints.push(orderBy("createdAt", "desc"));
        baseConstraints.push(limit(200));

        const snapshots = await Promise.all(
          targetStoreIds.map((id) =>
            getDocs(query(collection(db, "receipts"), where("storeId", "==", id), ...baseConstraints)),
          ),
        );
        if (cancelled) {
          return;
        }

        const mapped = snapshots.flatMap((snapshot) =>
          snapshot.docs.map((docSnap) => {
            const data = docSnap.data() as DocumentData;
            const record: ReceiptRow = {
              id: docSnap.id,
              storeId: data.storeId,
              uploaderId: data.uploaderId,
              uploaderName: data.uploaderName ?? "",
              companyName: data.companyName ?? "",
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              status: data.status,
              lockedBy: data.lockedBy ?? null,
              lockedAt: data.lockedAt ?? null,
              sourceType: data.sourceType ?? "receipt",
              filePath: data.filePath,
              viewPath: data.viewPath,
              thumbPath: data.thumbPath,
              year: data.year,
              month: data.month,
              purpose: data.purpose ?? null,
              paymentMethod: data.paymentMethod,
              ocr: data.ocr,
              meta: data.meta,
              fraudFlags: Array.isArray(data.fraudFlags) ? (data.fraudFlags as ReceiptFraudFlag[]) : [],
              assetsCount: data.assetsCount ?? 0,
              lastAssetAt: data.lastAssetAt ?? null,
            };
            return record;
          }),
        );

        const sorted = mapped
          .sort((a, b) => {
            const aMillis = a.createdAt?.toMillis?.() ?? 0;
            const bMillis = b.createdAt?.toMillis?.() ?? 0;
            return bMillis - aMillis;
          })
          .slice(0, 200);

        const resolved = await Promise.all(
          sorted.map(async (record) => {
            let thumbUrl: string | null = null;
            const thumbPath = record.thumbPath ?? fallbackThumbPath(record.viewPath, record.filePath);
            if (thumbPath) {
              try {
                thumbUrl = await getDownloadURL(ref(storage, thumbPath));
              } catch (err) {
                console.warn("Failed to load thumb", err);
              }
            }
            return { ...record, thumbUrl };
          }),
        );
        setRows(resolved);
        setSelectedIds((prev) => prev.filter((id) => resolved.some((row) => row.id === id)));
      } catch (fetchError) {
        console.error(fetchError);
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load receipts");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchReceipts();
    return () => {
      cancelled = true;
    };
  }, [availableStoreIds, endDate, featureDisabled, reloadCount, startDate, status, storeId]);


  const rowsCount = rows.length;

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => rows.some((row) => row.id === id)));
  }, [rows]);

  const allSelected = rowsCount > 0 && selectedIds.length === rowsCount;
  const partiallySelected = selectedIds.length > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected, allSelected]);

  const canBulkAnalyze = permissions?.flags.includes("perm.upload") ?? false;
  const selectedCount = selectedIds.length;
  const analyzeDisabled = !canBulkAnalyze || !storeId || !selectedCount || analyzing;
  const analyzeButtonLabel = analyzing ? "Analyzing..." : "Analyze Selected";

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds([]);
      setAnalysisStatus(null);
    } else {
      setSelectedIds(rows.map((row) => row.id));
    }
  }, [allSelected, rows]);

  const handleBulkAnalyze = useCallback(async () => {
    if (!selectedIds.length) {
      pushToast("info", "Select receipts to analyze.");
      return;
    }
    if (!canBulkAnalyze) {
      pushToast("error", "You do not have permission to analyze receipts.");
      return;
    }
    console.info("[Receipts] analyze clicked", { selectedIds });
    setAnalyzing(true);
    setAnalysisStatus(null);
    try {
      const result = await runBulkAnalysis(selectedIds);
      if (result.success.length) {
        pushToast("success", `Analysis started for ${result.success.length} receipt(s).`);
      }
      if (result.failed.length) {
        result.failed.forEach((entry) => {
          const message = entry.error.length > 140 ? `${entry.error.slice(0, 137)}...` : entry.error;
          pushToast("error", `${entry.receiptId}: ${message}`);
        });
      }
      setAnalysisStatus(
        result.failed.length
          ? `${result.success.length} succeeded, ${result.failed.length} failed.`
          : `Analysis started for ${result.success.length} receipt(s).`
      );
      setSelectedIds(result.failed.length ? result.failed.map((entry) => entry.receiptId) : []);
      setReloadCount((prev) => prev + 1);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "Failed to start analysis";
      setAnalysisStatus(message);
      pushToast("error", message);
    } finally {
      setAnalyzing(false);
    }
  }, [selectedIds, canBulkAnalyze, pushToast]);

  const handleExport = useCallback(async () => {
    if (!canExportCsv) {
      pushToast("error", "You do not have permission to export receipts.");
      return;
    }
    if (!storeId) {
      pushToast("error", "Select a store before exporting.");
      return;
    }
    if (storeId === ALL_STORES_OPTION) {
      pushToast("error", "Choose a specific store before exporting.");
      return;
    }
    const approxCount = rowsCount;
    const filtersDescription = [
      `store=${storeId}`,
      status !== "all" ? `status=${status}` : null,
      startDate ? `from=${startDate}` : null,
      endDate ? `to=${endDate}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const approxLabel = approxCount === 0
      ? "all matching receipts"
      : approxCount >= 200
      ? `at least ${approxCount}`
      : `${approxCount}`;
    const confirmed = window.confirm(
      `Export receipts (${filtersDescription || "no filters"}).\nThis will download ${approxLabel}. Continue?`,
    );
    if (!confirmed) {
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      pushToast("error", "You must be signed in to export receipts.");
      return;
    }
    setExporting(true);
    setExportStatus("Generating CSV...");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/receipts/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          storeId,
          status,
          startDate: startDate || null,
          endDate: endDate || null,
        }),
      });
      if (!response.ok) {
        let message = `Failed to export CSV (status ${response.status})`;
        try {
          const payload = await response.json();
          if (payload?.error) {
            message = payload.error as string;
          }
        } catch {
          // ignore JSON parse errors
        }
        pushToast("error", message);
        return;
      }
      setExportStatus("Preparing download...");
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const safeStore = storeId.replace(/[^a-zA-Z0-9_-]/g, "-");
      const filename = `receipts-${safeStore}-${new Date().toISOString().slice(0, 10)}.csv`;
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);
      pushToast("success", "CSV export complete.");
    } catch (error) {
      console.error("CSV export failed", error);
      pushToast("error", (error as Error).message ?? "Failed to export CSV.");
    } finally {
      setExporting(false);
      setExportStatus(null);
    }
  }, [canExportCsv, endDate, pushToast, rowsCount, startDate, status, storeId]);

  if (featureDisabled) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6">
        <h1 className="text-xl font-semibold">Receipts viewer is disabled</h1>
        <p className="text-sm text-neutral-500">Set NEXT_PUBLIC_APPFLAG_RECEIPTS=on to access this feature.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between md:gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Receipts</h1>
          <p className="text-sm text-neutral-500">Filter and inspect uploaded receipts.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="storeId-filter">
              Store
            </label>
            <select
              id="storeId-filter"
              className="w-48 rounded border border-neutral-300 px-2 py-1 text-sm"
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
              disabled={permissionsBusy || !storeOptions.length}
            >
              <option value="">
                {permissionsBusy ? "Loading stores..." : "Select a store"}
              </option>
              {storeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="status-filter">
              Status
            </label>
            <select
              id="status-filter"
              className="w-32 rounded border border-neutral-300 px-2 py-1 text-sm"
              value={status}
              onChange={(event) => setStatus(event.target.value as "all" | ReceiptStatus)}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="start-date">
              Start date
            </label>
            <input
              id="start-date"
              type="date"
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="end-date">
              End date
            </label>
            <input
              id="end-date"
              type="date"
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </div>
          {canBulkAnalyze ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">Analysis</span>
              <button
                type="button"
                onClick={handleBulkAnalyze}
                disabled={analyzeDisabled}
                className="rounded border border-purple-600 px-3 py-1 text-sm font-medium text-purple-600 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {analyzeButtonLabel}
              </button
              >
              {analysisStatus ? (
                <span className="text-xs text-neutral-500">{analysisStatus}</span>
              ) : null}
              {selectedCount && !analyzing ? (
                <span className="text-xs text-neutral-400">{selectedCount} selected</span>
              ) : null}
            </div>
          ) : null}

          {canExportCsv ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">Export</span>
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting || !storeId || storeId === ALL_STORES_OPTION}
                className="rounded border border-blue-600 px-3 py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {exporting ? "Exporting..." : "Export CSV"}
              </button>
              {exportStatus ? (
                <span className="text-xs text-neutral-500">{exportStatus}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>
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

      <section className="rounded border border-neutral-200">
        <div className="overflow-x-auto">
          <table className="min-w-full table-auto text-sm">
            <thead className="bg-neutral-50 text-xs uppercase text-neutral-500">
              <tr>
                <th className="p-3">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    disabled={!rowsCount}
                    aria-label="Select all receipts"
                    className="h-4 w-4 align-middle"
                  />
                </th>
                <th className="p-3 text-left">Thumb</th>
                <th className="p-3 text-left">Date</th>
                <th className="p-3 text-left">Vendor</th>
                <th className="p-3 text-right">Amount</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-left">Uploader</th>
                <th className="p-3 text-left">Purpose</th>
                <th className="p-3 text-left">Payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="p-6 text-center text-neutral-500" colSpan={9}>
                    {loading ? "Loading receiptsc" : storeId ? "No receipts found." : "Select a store to view receipts."}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="border-t border-neutral-100 hover:bg-neutral-50">
                    <td className="p-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 align-middle"
                        checked={selectedIds.includes(row.id)}
                        onChange={() => toggleSelect(row.id)}
                        aria-label={`Select receipt ${row.id}`}
                      />
                    </td>
                    <td className="p-3">
                      {row.thumbUrl ? (
                        <Image
                          src={row.thumbUrl}
                          alt="Thumb"
                          width={64}
                          height={64}
                          className="h-16 w-16 rounded object-cover"
                          unoptimized
                        />
                      ) : (
                        <span className="text-xs text-neutral-400">No thumb</span>
                      )}
                    </td>
                    <td className="p-3 text-neutral-700">{formatJst(row.createdAt)}</td>
                    <td className="p-3 text-neutral-700">{row.ocr.vendorName ?? "?"}</td>
                    <td className="p-3 text-right text-neutral-700">{formatAmount(row.ocr.amount, row.ocr.currency)}</td>
                    <td className="p-3 text-neutral-700">
                      <Link className="text-blue-600 hover:underline" href={`/dashboard/receipts/${row.id}`}>
                        {row.status}
                      </Link>
                    </td>
                    <td className="p-3 text-neutral-700">{row.uploaderName || row.uploaderId}</td>
                    <td className="p-3 text-neutral-700">{row.purpose ?? "?"}</td>
                    <td className="p-3 text-neutral-700">{describePayment(row)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="fixed inset-x-0 bottom-4 flex justify-center">
        <div className="flex w-full max-w-sm flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`rounded border px-3 py-2 text-sm shadow ${
                toast.type === "success"
                  ? "border-green-200 bg-green-50 text-green-800"
                  : toast.type === "error"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-neutral-200 bg-neutral-50 text-neutral-700"
              }`}
            >
              {toast.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}















