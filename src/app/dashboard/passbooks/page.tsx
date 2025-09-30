"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
import { useUserPermissions } from "@/lib/hooks/useUserPermissions";
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

type PassbookRow = {
  receiptId: string;
  storeId: string;
  createdAt: Timestamp | null;
  entry: ReceiptPassbookEntry | null;
  entryIndex: number;
  totalEntries: number;
};

export default function PassbooksPage() {
  const { permissions, loading: permissionsLoading } = useUserPermissions();

  const storeOptions = useMemo(() => {
    const ids = permissions?.storeIds ?? [];
    return ids.map((id) => ({ id, label: id }));
  }, [permissions?.storeIds]);

  const [storeId, setStoreId] = useState<string>("all");
  const [rows, setRows] = useState<PassbookRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        </div>



        <div className="overflow-x-auto">
          <table className="min-w-[720px] table-auto text-sm">
            <thead className="bg-neutral-50 text-xs text-neutral-500">
              <tr>
                <th className="p-3 text-left whitespace-nowrap">日付</th>
                <th className="p-3 text-left">摘要</th>
                <th className="p-3 text-right whitespace-nowrap">お支払金額</th>
                <th className="p-3 text-right whitespace-nowrap">お預り金額</th>
                <th className="p-3 text-right whitespace-nowrap">差引残高</th>
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
              ) : rows.length === 0 ? (
                <tr>
                  <td className="p-6 text-center text-neutral-500" colSpan={5}>
                    No passbook entries yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const detailHref = `/dashboard/passbooks/${row.receiptId}`;
                  const dateDisplay = formatPassbookDate(row.entry, row.createdAt ?? null);
                  const description = row.entry?.description?.trim().length ? row.entry.description : "(no description)";
                  const withdrawal = formatPassbookNumber(row.entry?.withdrawal ?? null);
                  const deposit = formatPassbookNumber(row.entry?.deposit ?? null);
                  const balance = formatPassbookNumber(row.entry?.balance ?? null);
                  const extraLabel =
                    row.totalEntries > 1 ? `全${row.totalEntries}件中${row.entryIndex + 1}件目` : null;

                  return (
                    <tr key={`${row.receiptId}-${row.entryIndex}`} className="border-t border-neutral-100 hover:bg-neutral-50">
                      <td className="p-3 text-neutral-700 whitespace-nowrap">{dateDisplay}</td>
                      <td className="p-3 text-neutral-700">
                        <div className="space-y-1">
                          <div>{description}</div>
                          {extraLabel ? <div className="text-[11px] text-neutral-400">{extraLabel}</div> : null}
                          <div>
                            <Link className="text-xs font-medium text-blue-600 hover:underline" href={detailHref}>
                              詳細を見る
                            </Link>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-right font-mono text-neutral-700 tabular-nums whitespace-nowrap">{withdrawal}</td>
                      <td className="p-3 text-right font-mono text-neutral-700 tabular-nums whitespace-nowrap">{deposit}</td>
                      <td className="p-3 text-right font-mono text-neutral-800 tabular-nums whitespace-nowrap">{balance}</td>
                    </tr>
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






