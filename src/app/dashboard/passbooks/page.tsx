"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Timestamp,
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from "firebase/firestore";

import { db } from "@/lib/firebase/client";
import { toIsoDate } from "@/lib/ocrPassbook";
import { useDashboardPermissions } from "../PermissionsProvider";
import type { ReceiptPassbookEntry } from "@/types/receipt";

function formatPassbookNumber(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return value.toLocaleString("en-US");
}

function formatPassbookDate(entry: ReceiptPassbookEntry | null, fallback?: Timestamp | null): string {
  if (entry) {
    if (entry.rawDate && entry.rawDate.trim().length) {
      return entry.rawDate.trim();
    }
    if (entry.date) {
      const parts = entry.date.split("-");
      if (parts.length === 3) {
        const [year, month, day] = parts;
        return `${year}-${month}-${day}`;
      }
      return entry.date;
    }
  }
  if (fallback) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(fallback.toDate());
  }
  return "-";
}

function formatUploadedAt(value: Timestamp | null): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value.toDate());
}


type PassbookRow = {
  receiptId: string;
  storeId: string;
  createdAt: Timestamp | null;
  entry: ReceiptPassbookEntry | null;
  entryIndex: number;
  totalEntries: number;
};

type PassbookGroup = {
  receiptId: string;
  storeId: string;
  createdAt: Timestamp | null;
  rows: PassbookRow[];
};


type SortOption = "entry-desc" | "entry-asc" | "uploaded-desc" | "uploaded-asc";

function resolveEntryDate(row: PassbookRow): Date | null {
  const entry = row.entry;
  if (entry?.date) {
    const date = new Date(`${entry.date}T00:00:00`);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  if (entry?.rawDate) {
    const iso = toIsoDate(entry.rawDate.trim());
    if (iso) {
      const date = new Date(`${iso}T00:00:00`);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }
  if (row.createdAt) {
    try {
      return row.createdAt.toDate();
    } catch {
      return null;
    }
  }
  return null;
}

function getEntryDateMillis(row: PassbookRow): number | null {
  const date = resolveEntryDate(row);
  return date ? date.getTime() : null;
}

function getEntryIsoString(row: PassbookRow): string | null {
  const entry = row.entry;
  if (entry?.date) {
    return entry.date;
  }
  if (entry?.rawDate) {
    const iso = toIsoDate(entry.rawDate.trim());
    if (iso) {
      return iso;
    }
  }
  return null;
}

function formatCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const stringValue = String(value);
  return /[",\n\r]/.test(stringValue) ? `"${stringValue.replace(/"/g,'""')}"` : stringValue;
}

export default function PassbooksPage() {
  const { permissions, loading: permissionsLoading } = useDashboardPermissions();

  const storeOptions = useMemo(() => {
    const ids = permissions?.storeIds ?? [];
    return ids.map((id) => ({ id, label: id }));
  }, [permissions?.storeIds]);

  const [storeId, setStoreId] = useState<string>("all");
  const [rows, setRows] = useState<PassbookRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [sortOption, setSortOption] = useState<SortOption>("entry-desc");
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const filteredRows = useMemo<PassbookRow[]>(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const startMillis = startDate ? Date.parse(`${startDate}T00:00:00`) : null;
    const endMillis = endDate ? Date.parse(`${endDate}T23:59:59.999`) : null;
    return rows.filter((row) => {
      const effectiveMillis = getEntryDateMillis(row) ?? row.createdAt?.toMillis?.() ?? null;
      if (startMillis !== null && (effectiveMillis === null || effectiveMillis < startMillis)) {
        return false;
      }
      if (endMillis !== null && (effectiveMillis === null || effectiveMillis > endMillis)) {
        return false;
      }
      if (normalizedSearch) {
        const haystack = [
          row.receiptId,
          row.storeId,
          row.entry?.description ?? "",
          row.entry?.rawDate ?? "",
          row.entry?.date ?? "",
          row.entry?.withdrawal?.toString() ?? "",
          row.entry?.deposit?.toString() ?? "",
          row.entry?.balance?.toString() ?? "",
          formatPassbookNumber(row.entry?.withdrawal ?? null),
          formatPassbookNumber(row.entry?.deposit ?? null),
          formatPassbookNumber(row.entry?.balance ?? null),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(normalizedSearch)) {
          return false;
        }
      }
      return true;
    });
  }, [rows, searchTerm, startDate, endDate]);

  const sortedRows = useMemo<PassbookRow[]>(() => {
    const copy = [...filteredRows];
    copy.sort((a, b) => {
      const entryMillisA = getEntryDateMillis(a);
      const entryMillisB = getEntryDateMillis(b);
      const uploadedMillisA = a.createdAt?.toMillis?.() ?? null;
      const uploadedMillisB = b.createdAt?.toMillis?.() ?? null;
      switch (sortOption) {
        case "entry-asc":
          return (entryMillisA ?? Number.POSITIVE_INFINITY) - (entryMillisB ?? Number.POSITIVE_INFINITY);
        case "uploaded-desc":
          return (uploadedMillisB ?? Number.MIN_SAFE_INTEGER) - (uploadedMillisA ?? Number.MIN_SAFE_INTEGER);
        case "uploaded-asc":
          return (uploadedMillisA ?? Number.POSITIVE_INFINITY) - (uploadedMillisB ?? Number.POSITIVE_INFINITY);
        case "entry-desc":
        default:
          return (entryMillisB ?? Number.MIN_SAFE_INTEGER) - (entryMillisA ?? Number.MIN_SAFE_INTEGER);
      }
    });
    return copy;
  }, [filteredRows, sortOption]);

  const groupedRows = useMemo<PassbookGroup[]>(() => {
    const groups: PassbookGroup[] = [];
    let current: PassbookGroup | null = null;
    sortedRows.forEach((row) => {
      if (!current || current.receiptId !== row.receiptId) {
        current = {
          receiptId: row.receiptId,
          storeId: row.storeId,
          createdAt: row.createdAt,
          rows: [],
        };
        groups.push(current);
      }
      current.rows.push(row);
    });
    return groups;
  }, [sortedRows]);

  const totalEntries = rows.length;
  const filteredEntries = sortedRows.length;
  const filteredReceipts = groupedRows.length;

  useEffect(() => {
    setExportStatus(null);
  }, [storeId, startDate, endDate, searchTerm, sortOption]);

  useEffect(() => {
    if (!exportStatus) {
      return undefined;
    }
    const timer = window.setTimeout(() => setExportStatus(null), 4000);
    return () => window.clearTimeout(timer);
  }, [exportStatus]);

  const handleExport = useCallback(() => {
    if (!filteredEntries) {
      setExportStatus('No entries to export.');
      return;
    }
    setExporting(true);
    try {
      const header = [
        'Receipt ID',
        'Entry Index',
        'Entries Total',
        'Entry Date',
        'Raw Date',
        'Description',
        'Withdrawal',
        'Deposit',
        'Balance',
        'Store ID',
        'Uploaded At',
      ];
      const csvLines = [header.map(formatCsvValue).join(',')];
      sortedRows.forEach((row) => {
        const entry = row.entry;
        const entryIso = getEntryIsoString(row);
        const lineValues = [
          row.receiptId,
          row.entryIndex + 1,
          row.totalEntries,
          entryIso ?? '',
          entry?.rawDate ?? '',
          entry?.description ?? '',
          entry?.withdrawal ?? '',
          entry?.deposit ?? '',
          entry?.balance ?? '',
          row.storeId,
          row.createdAt ? row.createdAt.toDate().toISOString() : '',
        ];
        csvLines.push(lineValues.map(formatCsvValue).join(','));
      });
      const csvContent = csvLines.join("\r\n");
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `passbook-entries-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setExportStatus(`Exported ${filteredEntries} ${filteredEntries === 1 ? 'entry' : 'entries'}.`);
    } catch (exportError) {
      console.error('Failed to export passbook entries', exportError);
      setExportStatus('Failed to export entries.');
    } finally {
      setExporting(false);
    }
  }, [filteredEntries, sortedRows]);

  const exportDisabled = exporting || !filteredEntries;


  useEffect(() => {
    if (!permissionsLoading && storeOptions.length && storeId === "all") {
      setStoreId("all");
    }
  }, [permissionsLoading, storeOptions, storeId]);

  useEffect(() => {
    let cancelled = false;

    async function fetchPassbooks(): Promise<void> {
      if (permissionsLoading) return;
      const availableIds = storeOptions.map((option) => option.id);
      if (!availableIds.length) {
        setRows([]);
        return;
      }

      const targetStoreIds = storeId === "all" ? availableIds : [storeId];
      setLoading(true);
      setError(null);

      try {
        const constraints: QueryConstraint[] = [
          where("sourceType", "==", "passbook"),
          orderBy("createdAt", "desc"),
          limit(50),
        ];

        const snapshots = await Promise.all(
          targetStoreIds.map((id) =>
            getDocs(query(collection(db, "receipts"), where("storeId", "==", id), ...constraints)),
          ),
        );

        if (cancelled) return;

        const collected: PassbookRow[] = [];

        snapshots.forEach((snapshot) => {
          snapshot.docs.forEach((docSnap) => {
            const data = docSnap.data();
            const entries = Array.isArray(data.ocr?.passbookEntries)
              ? (data.ocr.passbookEntries as ReceiptPassbookEntry[])
              : [];
            const createdAt = (data.createdAt as Timestamp | undefined) ?? null;

            if (!entries.length) {
              collected.push({
                receiptId: docSnap.id,
                storeId: data.storeId ?? "",
                createdAt,
                entry: null,
                entryIndex: 0,
                totalEntries: 0,
              });
              return;
            }

            entries.forEach((entry, index) => {
              collected.push({
                receiptId: docSnap.id,
                storeId: data.storeId ?? "",
                createdAt,
                entry,
                entryIndex: index,
                totalEntries: entries.length,
              });
            });
          });
        });

        const sorted = collected.sort((a, b) => {
          const aKey = a.entry?.date ?? a.createdAt?.toDate().toISOString() ?? "";
          const bKey = b.entry?.date ?? b.createdAt?.toDate().toISOString() ?? "";
          return bKey.localeCompare(aKey);
        });

        setRows(sorted);
      } catch (err) {
        console.error("Failed to load passbook entries", err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load passbook entries");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchPassbooks();
    return () => {
      cancelled = true;
    };
  }, [permissionsLoading, storeId, storeOptions]);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-neutral-900">Passbook entries</h1>
        <p className="text-sm text-neutral-500">
          Review the transactions that were extracted from uploaded passbook images.
        </p>
      </header>

      <section className="space-y-4 rounded border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col text-sm text-neutral-700">
            <span className="text-xs font-semibold uppercase text-neutral-500">Store</span>
            <select
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
              className="mt-1 rounded border border-neutral-300 px-3 py-2 text-sm"
            >
              <option value="all">All stores</option>
              {storeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm text-neutral-700">
            <span className="text-xs font-semibold uppercase text-neutral-500">Start date</span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="mt-1 rounded border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col text-sm text-neutral-700">
            <span className="text-xs font-semibold uppercase text-neutral-500">End date</span>
            <input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              className="mt-1 rounded border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col text-sm text-neutral-700">
            <span className="text-xs font-semibold uppercase text-neutral-500">Search</span>
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search description or receipt ID"
              className="mt-1 rounded border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col text-sm text-neutral-700">
            <span className="text-xs font-semibold uppercase text-neutral-500">Sort</span>
            <select
              value={sortOption}
              onChange={(event) => setSortOption(event.target.value as SortOption)}
              className="mt-1 rounded border border-neutral-300 px-3 py-2 text-sm"
            >
              <option value="entry-desc">Entry date (newest first)</option>
              <option value="entry-asc">Entry date (oldest first)</option>
              <option value="uploaded-desc">Uploaded (newest first)</option>
              <option value="uploaded-asc">Uploaded (oldest first)</option>
            </select>
          </label>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={handleExport}
              disabled={exportDisabled}
              className="rounded border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {exporting ? "Exporting..." : "Export CSV"}
            </button>
            {exportStatus ? <span className="text-xs text-neutral-500">{exportStatus}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
          <span>Showing {filteredEntries.toLocaleString()} of {totalEntries.toLocaleString()} entries</span>
          <span>Receipts {filteredReceipts.toLocaleString()}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[720px] table-auto text-sm">
            <thead className="bg-neutral-50 text-xs text-neutral-500">
              <tr>
                <th className="p-3 text-left whitespace-nowrap">日付</th>
                <th className="p-3 text-left">摘要</th>
                <th className="p-3 text-right whitespace-nowrap">お支払金額</th>
                <th className="p-3 text-right whitespace-nowrap">お預り金額</th>
                <th className="p-3 text-right whitespace-nowrap">残高</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="p-6 text-center text-neutral-500" colSpan={5}>
                    Loading passbook entries...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td className="p-6 text-center text-red-600" colSpan={5}>
                    {error}
                  </td>
                </tr>
              ) : groupedRows.length === 0 ? (
                <tr>
                  <td className="p-6 text-center text-neutral-500" colSpan={5}>
                    No passbook entries yet.
                  </td>
                </tr>
              ) : (
                groupedRows.map((group) => {
                  const detailHref = `/dashboard/passbooks/${group.receiptId}`;
                  const visibleRows = group.rows.filter((row) => row.entry !== null);
                  const entryCount = visibleRows.length;
                  return (
                    <Fragment key={group.receiptId}>
                      <tr className="border-t border-neutral-200 bg-neutral-50">
                        <td colSpan={5} className="p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-600">
                            <div className="flex flex-wrap items-center gap-3">
                              <span className="text-sm font-medium text-neutral-800">
                                {group.storeId || "店舗未設定"}
                              </span>
                              <span>撮影 {formatUploadedAt(group.createdAt)}</span>
                              <span>明細 {entryCount}件</span>
                              <span className="text-neutral-400">ID: {group.receiptId}</span>
                            </div>
                            <Link className="text-xs font-semibold text-blue-600 hover:underline" href={detailHref}>
                              詳細を開く
                            </Link>
                          </div>
                        </td>
                      </tr>
                      {entryCount === 0 ? (
                        <tr className="border-t border-neutral-100 bg-white">
                          <td className="p-4 text-center text-sm text-neutral-500" colSpan={5}>
                            Vision OCR で通帳明細を検出できませんでした。
                          </td>
                        </tr>
                      ) : (
                        visibleRows.map((row, index) => {
                          const dateDisplay = formatPassbookDate(row.entry, group.createdAt ?? null);
                          const description = row.entry?.description?.trim().length ? row.entry.description : "（摘要なし）";
                          const withdrawal = formatPassbookNumber(row.entry?.withdrawal ?? null);
                          const deposit = formatPassbookNumber(row.entry?.deposit ?? null);
                          const balance = formatPassbookNumber(row.entry?.balance ?? null);
                          const rowPositionLabel =
                            row.totalEntries > 1 ? `全${row.totalEntries}件中${row.entryIndex + 1}件目` : null;
                          const isLastRow = index === entryCount - 1;
                          return (
                            <tr
                              key={`${row.receiptId}-${row.entryIndex}`}
                              className={`border-t border-neutral-100 hover:bg-neutral-50 ${isLastRow ? "border-b border-neutral-200" : ""}`}
                            >
                              <td className="p-3 text-neutral-700 whitespace-nowrap">{dateDisplay}</td>
                              <td className="p-3 text-neutral-700">
                                <div className="space-y-1">
                                  <div>{description}</div>
                                  {rowPositionLabel ? (
                                    <div className="text-[11px] text-neutral-400">{rowPositionLabel}</div>
                                  ) : null}
                                </div>
                              </td>
                              <td className="p-3 text-right font-mono text-neutral-700 tabular-nums whitespace-nowrap">{withdrawal}</td>
                              <td className="p-3 text-right font-mono text-neutral-700 tabular-nums whitespace-nowrap">{deposit}</td>
                              <td className="p-3 text-right font-mono text-neutral-800 tabular-nums whitespace-nowrap">{balance}</td>
                            </tr>
                          );
                        })
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>


      </section>
    </div>
  );
}







