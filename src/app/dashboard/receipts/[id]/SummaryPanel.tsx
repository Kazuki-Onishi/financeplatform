"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { serverTimestamp, updateDoc } from "firebase/firestore";
import { callOCR, callSummarize } from "@/lib/api.client";
import { receiptDoc } from "@/lib/firestoreRefs";
import { PURPOSE_NOTE_MAX_LENGTH, PURPOSE_OPTIONS, findPurposeOption } from "@/lib/purposeOptions";
import type { ReceiptOcrData, ReceiptPassbookEntry, ReceiptRecord, ReceiptSummaryData, ReceiptSummaryLineItem } from "@/types/receipt";

const STORAGE_BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "";

const COMMON_TAX_RATES = [10, 8, 0];

type ToastKind = "success" | "error" | "info";

export type SummaryPreview = {
  id: string;
  url: string;
  label: string;
  thumbnailUrl?: string | null;
};

type SummaryLineItemState = {
  id: string;
  label: string;
  amount: number | null;
  tax: number | null;
  taxRate: number | null;
  memo: string;
};

const MAX_LINE_ITEMS = 10;

type SummaryFormState = {
  date: string | null;
  vendor: string | null;
  amount: number | null;
  tax: number | null;
  currency: string | null;
  memo: string | null;
  purposeKey: string | null;
  purposeLabel: string | null;
  purposeNote: string | null;
  lineItems: SummaryLineItemState[];
};

type SummaryMetaState = {
  language: string | null;
  keywords: string[];
  usage: Record<string, unknown> | null;
  modelVersion: string | null;
};

interface SummaryPanelProps {
  receipt: ReceiptRecord;
  canEdit: boolean;
  pushToast: (type: ToastKind, message: string) => void;
  onReceiptUpdate: React.Dispatch<React.SetStateAction<ReceiptRecord | null>>;
  previews?: SummaryPreview[];
  maxLineItems?: number;
  onConfirm?: () => void;
  confirmDisabled?: boolean;
}

const DEFAULT_FORM: SummaryFormState = {
  date: null,
  vendor: null,
  amount: null,
  tax: null,
  currency: "JPY",
  memo: null,
  purposeKey: null,
  purposeLabel: null,
  purposeNote: null,
  lineItems: [],
};

const DEFAULT_META: SummaryMetaState = {
  language: null,
  keywords: [],
  usage: null,
  modelVersion: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseStoragePath(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  if (value.startsWith("gs://")) {
    const withoutScheme = value.slice(5);
    const slash = withoutScheme.indexOf("/");
    if (slash === -1) {
      return "";
    }
    value = withoutScheme.slice(slash + 1);
  }
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildGcsUri(filePath: string): { gcsUri: string; path: string } | null {
  if (!STORAGE_BUCKET) {
    return null;
  }
  const path = normaliseStoragePath(filePath);
  if (!path) {
    return null;
  }
  return {
    gcsUri: `gs://${STORAGE_BUCKET}/${path}`,
    path,
  };
}

function generateLineItemId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `line-${Math.random().toString(36).slice(2, 10)}`;
}

function formatPassbookNumber(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "";
  }
  return value.toLocaleString("ja-JP");
}

function formatPassbookDate(entry: ReceiptPassbookEntry): string {
  if (entry.rawDate && entry.rawDate.trim().length) {
    return entry.rawDate.trim();
  }
  if (entry.date) {
    const parts = entry.date.split("-");
    if (parts.length === 3) {
      const [year, month, day] = parts;
      if (year && month && day) {
        return `${year.slice(-2)}.${month}.${day}`;
      }
    }
    return entry.date;
  }
  return "";
}

function normaliseTaxRate(
  raw: number | null,
  totalAmount: number | null,
  fallbackTaxAmount?: number | null,
): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const abs = Math.abs(raw);
    if (abs === 0) {
      return 0;
    }
    if (abs <= 1) {
      return Math.round(abs * 10000) / 100;
    }
    if (abs <= 100) {
      return Math.round(abs * 100) / 100;
    }
    if (totalAmount && totalAmount !== 0) {
      return Math.round((abs / totalAmount) * 10000) / 100;
    }
  }
  if (
    typeof fallbackTaxAmount === "number" &&
    Number.isFinite(fallbackTaxAmount) &&
    totalAmount &&
    totalAmount !== 0
  ) {
    return Math.round((fallbackTaxAmount / totalAmount) * 10000) / 100;
  }
  return null;
}

export default function SummaryPanel({ receipt, canEdit, pushToast, onReceiptUpdate, previews = [], maxLineItems = MAX_LINE_ITEMS, onConfirm, confirmDisabled }: SummaryPanelProps) {
  const [summaryForm, setSummaryForm] = useState<SummaryFormState>(DEFAULT_FORM);
  const [summaryMeta, setSummaryMeta] = useState<SummaryMetaState>(DEFAULT_META);
  const [summaryDirty, setSummaryDirty] = useState(false);
  const [ocrPreview, setOcrPreview] = useState<string>("");
  const [latestOcr, setLatestOcr] = useState<ReceiptOcrData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePreviewTab, setActivePreviewTab] = useState<"image" | "ocr">(() => (previews.length ? "image" : "ocr"));
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(() => (previews[0]?.id ?? null));

  const hadPreviewsRef = useRef(false);

  useEffect(() => {
    if (!previews.length) {
      setSelectedPreviewId(null);
      if (activePreviewTab === "image") {
        setActivePreviewTab("ocr");
      }
      return;
    }
    setSelectedPreviewId((current) =>
      current && previews.some((preview) => preview.id === current) ? current : previews[0].id,
    );
  }, [previews, activePreviewTab]);

  useEffect(() => {
    if (previews.length && !hadPreviewsRef.current) {
      setActivePreviewTab("image");
    }
    hadPreviewsRef.current = previews.length > 0;
  }, [previews.length]);

  const hasImagePreviews = previews.length > 0;
  const activePreview = selectedPreviewId
    ? previews.find((preview) => preview.id === selectedPreviewId) ?? null
    : null;
  const isPassbook = receipt.sourceType === "passbook";
  const passbookEntries = useMemo<ReceiptPassbookEntry[]>(() => {
    const entries = receipt.ocr?.passbookEntries;
    return Array.isArray(entries) ? (entries as ReceiptPassbookEntry[]) : [];
  }, [receipt.ocr?.passbookEntries]);
  const hasPassbookEntries = passbookEntries.length > 0;


  useEffect(() => {
    const nextSummary = receipt.summary ?? null;
    const summaryAmountValue =
      typeof nextSummary?.amount === "number" && Number.isFinite(nextSummary.amount)
        ? nextSummary.amount
        : typeof receipt.ocr?.amount === "number" && Number.isFinite(receipt.ocr.amount)
        ? receipt.ocr.amount
        : null;
    const ocrTaxAmount =
      typeof receipt.ocr?.tax === "number" && Number.isFinite(receipt.ocr.tax) ? receipt.ocr.tax : null;
    const summaryPurpose = nextSummary?.purpose ?? null;
    const resolvedPurposeOption = summaryPurpose?.key ? findPurposeOption(summaryPurpose.key) : undefined;
    const fallbackPurposeOption = (
      !resolvedPurposeOption && summaryPurpose?.label
        ? PURPOSE_OPTIONS.find((option) => option.label === summaryPurpose.label)
        : undefined
    );
    const receiptPurposeOption = (
      !resolvedPurposeOption && !fallbackPurposeOption && receipt.purpose
        ? PURPOSE_OPTIONS.find((option) => option.label === receipt.purpose)
        : undefined
    );
    const effectivePurposeOption = resolvedPurposeOption ?? fallbackPurposeOption ?? receiptPurposeOption;
    const initialPurposeKey = summaryPurpose?.key ?? effectivePurposeOption?.key ?? null;
    const initialPurposeLabel = summaryPurpose?.label ?? effectivePurposeOption?.label ?? receipt.purpose ?? null;
    const initialPurposeNoteRaw =
      typeof summaryPurpose?.note === "string" ? summaryPurpose.note : null;
    const initialPurposeNote = initialPurposeNoteRaw
      ? initialPurposeNoteRaw.slice(0, PURPOSE_NOTE_MAX_LENGTH)
      : null;

    const summaryItems = Array.isArray(nextSummary?.items)
      ? nextSummary.items
          .filter((item): item is ReceiptSummaryLineItem => item !== null && typeof item === "object")
          .slice(0, maxLineItems)
          .map((item) => {
            const amount =
              typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : null;
            const taxAmount =
              typeof item.tax === "number" && Number.isFinite(item.tax) ? item.tax : null;
            const taxRateValue =
              typeof item.taxRate === "number" && Number.isFinite(item.taxRate) ? item.taxRate : null;
            const baseAmount = amount ?? summaryAmountValue;
            return {
              id: typeof item.id === "string" ? item.id : generateLineItemId(),
              label: typeof item.label === "string" ? item.label : "",
              amount,
              tax: taxAmount,
              taxRate: normaliseTaxRate(taxRateValue, baseAmount, taxAmount),
              memo: typeof item.memo === "string" ? item.memo : "",
            };
          })
      : [];

    setSummaryForm({
      date: nextSummary?.date ?? receipt.ocr?.date ?? null,
      vendor: nextSummary?.vendor ?? receipt.ocr?.vendorName ?? null,
      amount: summaryAmountValue,
      tax: normaliseTaxRate(
        typeof nextSummary?.tax === "number" && Number.isFinite(nextSummary.tax) ? nextSummary.tax : null,
        summaryAmountValue,
        ocrTaxAmount,
      ),
      currency: nextSummary?.currency ?? receipt.ocr?.currency ?? "JPY",
      memo: nextSummary?.memo ?? receipt.memo ?? null,
      purposeKey: initialPurposeKey,
      purposeLabel: initialPurposeLabel,
      purposeNote: initialPurposeNote,
      lineItems: summaryItems,
    });
    setSummaryMeta({
      language: nextSummary?.language ?? null,
      keywords: Array.isArray(nextSummary?.keywords)
        ? (nextSummary?.keywords?.filter((item): item is string => typeof item === "string") ?? [])
        : [],
      usage: isRecord(nextSummary?.usage) ? (nextSummary?.usage as Record<string, unknown>) : null,
      modelVersion: typeof nextSummary?.modelVersion === "string" ? nextSummary?.modelVersion : null,
    });
    setSummaryDirty(false);
    setLatestOcr(receipt.ocr ?? null);
    setOcrPreview(receipt.ocr?.rawText ?? "");
    setError(null);
  }, [receipt, maxLineItems]);

  const handleAddLineItem = useCallback(() => {
    if (!canEdit) {
      return;
    }
    let added = false;
    setSummaryForm((prev) => {
      if (prev.lineItems.length >= maxLineItems) {
        return prev;
      }
      added = true;
      return {
        ...prev,
        lineItems: [
          ...prev.lineItems,
          { id: generateLineItemId(), label: "", amount: null, tax: null, taxRate: null, memo: "" },
        ],
      };
    });
    if (added) {
      setSummaryDirty(true);
    }
  }, [canEdit, maxLineItems]);

  const handleLineItemChange = useCallback(
    <K extends keyof SummaryLineItemState>(lineItemId: string, field: K, value: SummaryLineItemState[K]) => {
      if (!canEdit) {
        return;
      }
      let updated = false;
      setSummaryForm((prev) => {
        const nextItems = prev.lineItems.map((item) => {
          if (item.id !== lineItemId) {
            return item;
          }
          if (item[field] === value) {
            return item;
          }
          updated = true;
          return { ...item, [field]: value };
        });
        if (!updated) {
          return prev;
        }
        return { ...prev, lineItems: nextItems };
      });
      if (updated) {
        setSummaryDirty(true);
      }
    },
    [canEdit],
  );

  const handleRemoveLineItem = useCallback((lineItemId: string) => {
    if (!canEdit) {
      return;
    }
    let removed = false;
    setSummaryForm((prev) => {
      if (!prev.lineItems.some((item) => item.id === lineItemId)) {
        return prev;
      }
      removed = true;
      return { ...prev, lineItems: prev.lineItems.filter((item) => item.id !== lineItemId) };
    });
    if (removed) {
      setSummaryDirty(true);
    }
  }, [canEdit]);

  const keywords = useMemo(() => summaryMeta.keywords ?? [], [summaryMeta.keywords]);

  const lineItems = summaryForm.lineItems;
  const canAddAnotherLineItem = lineItems.length < maxLineItems;

  const usageDetails = useMemo(() => {
    if (!summaryMeta.usage || !isRecord(summaryMeta.usage)) {
      return null;
    }
    const usage = summaryMeta.usage as Record<string, unknown>;
    const prompt = (
      typeof usage["promptTokens"] === "number"
        ? (usage["promptTokens"] as number)
        : typeof usage["promptTokenCount"] === "number"
        ? (usage["promptTokenCount"] as number)
        : null
    );
    const candidates = (
      typeof usage["candidatesTokens"] === "number"
        ? (usage["candidatesTokens"] as number)
        : typeof usage["candidatesTokenCount"] === "number"
        ? (usage["candidatesTokenCount"] as number)
        : null
    );
    const total = (
      typeof usage["totalTokens"] === "number"
        ? (usage["totalTokens"] as number)
        : typeof usage["totalTokenCount"] === "number"
        ? (usage["totalTokenCount"] as number)
        : null
    );
    return {
      prompt,
      candidates,
      total,
    };
  }, [summaryMeta.usage]);
  const selectedPurposeOption = useMemo(
    () => (summaryForm.purposeKey ? findPurposeOption(summaryForm.purposeKey) : undefined),
    [summaryForm.purposeKey],
  );
  const showPurposeNoteField = selectedPurposeOption?.requiresNote ?? false;



  const handleSummaryFieldChange = useCallback(<K extends keyof SummaryFormState>(field: K, value: SummaryFormState[K]) => {
    setSummaryForm((prev) => ({ ...prev, [field]: value }));
    setSummaryDirty(true);
  }, []);

  const handlePurposeKeyChange = useCallback((value: string) => {
    setSummaryForm((prev) => {
      const option = value ? findPurposeOption(value) : undefined;
      const existingNote = prev.purposeNote ?? "";
      const sanitizedNote = existingNote.slice(0, PURPOSE_NOTE_MAX_LENGTH);
      return {
        ...prev,
        purposeKey: value ? value : null,
        purposeLabel: option?.label ?? (value ? prev.purposeLabel : null),
        purposeNote: option?.requiresNote ? sanitizedNote : prev.purposeNote,
      };
    });
    setSummaryDirty(true);
  }, []);

  const handlePurposeNoteChange = useCallback((value: string) => {
    const sanitized = value.slice(0, PURPOSE_NOTE_MAX_LENGTH);
    setSummaryForm((prev) => ({ ...prev, purposeNote: sanitized }));
    setSummaryDirty(true);
  }, []);

  const handleRun = useCallback(async () => {
    if (!canEdit) {
      pushToast("error", "You do not have permission to run OCR on this receipt.");
      return;
    }
    const gcsInfo = buildGcsUri(receipt.filePath);
    if (!gcsInfo) {
      pushToast("error", "Storage bucket configuration is missing or file path is invalid.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const ocrResult = await callOCR(gcsInfo.gcsUri, "document", receipt.id);
      const text = typeof ocrResult.text === "string" ? ocrResult.text : "";
      if (!text) {
        throw new Error("OCR returned empty text");
      }
      setOcrPreview(text);

      let nextOcr: ReceiptOcrData | null = null;
      if (ocrResult.ocr && isRecord(ocrResult.ocr)) {
        nextOcr = ocrResult.ocr as unknown as ReceiptOcrData;
      } else if (isRecord(ocrResult.raw)) {
        const raw = ocrResult.raw as Record<string, unknown>;
        const candidate = raw["ocr"];
        if (candidate && isRecord(candidate)) {
          nextOcr = candidate as unknown as ReceiptOcrData;
        }
      }
      if (nextOcr) {
        setLatestOcr(nextOcr);
        onReceiptUpdate((prev) => (prev ? { ...prev, ocr: nextOcr } : prev));
      }

      const summaryResult = await callSummarize(text);
      setSummaryForm((prev) => {
        const resultAmount =
          typeof summaryResult.summary.amount === "number" && Number.isFinite(summaryResult.summary.amount)
            ? summaryResult.summary.amount
            : null;
        const fallbackAmount =
          typeof receipt.ocr?.amount === "number" && Number.isFinite(receipt.ocr.amount)
            ? receipt.ocr.amount
            : null;
        const nextAmount = resultAmount ?? fallbackAmount ?? prev.amount;
        const resultTax =
          typeof summaryResult.summary.tax === "number" && Number.isFinite(summaryResult.summary.tax)
            ? summaryResult.summary.tax
            : null;
        const fallbackTaxAmount =
          typeof receipt.ocr?.tax === "number" && Number.isFinite(receipt.ocr.tax)
            ? receipt.ocr.tax
            : null;
        return {
          ...prev,
          date: summaryResult.summary.date ?? null,
          vendor: summaryResult.summary.vendor ?? null,
          amount: nextAmount,
          tax: normaliseTaxRate(resultTax, nextAmount, fallbackTaxAmount),
          currency: summaryResult.summary.currency ?? "JPY",
          memo: summaryResult.summary.memo ?? null,
        };
      });
      setSummaryMeta({
        language: summaryResult.language ?? null,
        keywords: summaryResult.keywords ?? [],
        usage: summaryResult.usage ?? null,
        modelVersion: summaryResult.modelVersion ?? null,
      });
      setSummaryDirty(false);
      pushToast("success", "OCR and summary refreshed.");
    } catch (err) {
      console.error("Failed to run OCR and summarise", err);
      const message = (err as Error).message ?? "Failed to run OCR and summarise.";
      setError(message);
      pushToast("error", message);
    } finally {
      setLoading(false);
    }
  }, [canEdit, onReceiptUpdate, pushToast, receipt]);

  const handleSave = useCallback(async () => {
    if (!canEdit) {
      pushToast("error", "You do not have permission to save this summary.");
      return;
    }
    const gcsInfo = buildGcsUri(receipt.filePath);
    if (!gcsInfo) {
      pushToast("error", "Storage bucket configuration is missing or file path is invalid.");
      return;
    }
    const wasConfirmed = receipt.status === "confirmed";
    if (wasConfirmed) {
      const proceed = window.confirm(
        "This receipt was already confirmed. Editing will move it back to Reviewed until you confirm again. Continue?",
      );
      if (!proceed) {
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const currentPurposeOption = summaryForm.purposeKey ? findPurposeOption(summaryForm.purposeKey) : undefined;
      const trimmedPurposeNote = (summaryForm.purposeNote ?? "").trim();
      const purposePayload = currentPurposeOption
        ? {
            key: currentPurposeOption.key,
            label: currentPurposeOption.label,
            note:
              currentPurposeOption.requiresNote && trimmedPurposeNote ? trimmedPurposeNote : null,
          }
        : summaryForm.purposeLabel
        ? {
            key: summaryForm.purposeKey ?? "",
            label: summaryForm.purposeLabel,
            note: trimmedPurposeNote ? trimmedPurposeNote : null,
          }
        : null;

      const itemsPayload = summaryForm.lineItems
        .map<ReceiptSummaryLineItem>((item) => {
          const trimmedLabel = item.label.trim();
          const trimmedMemo = item.memo.trim();
          const amountValue =
            typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : null;
          const taxRateValue =
            typeof item.taxRate === "number" && Number.isFinite(item.taxRate) ? item.taxRate : null;
          return {
            id: item.id,
            label: trimmedLabel ? trimmedLabel : null,
            amount: amountValue,
            tax: null,
            taxRate: taxRateValue,
            memo: trimmedMemo ? trimmedMemo : null,
          };
        })
        .filter((item) =>
          item.label !== null ||
          item.amount !== null ||
          item.tax !== null ||
          item.taxRate !== null ||
          item.memo !== null,
        );

      const summaryPayload: ReceiptSummaryData = {
        date: summaryForm.date,
        vendor: summaryForm.vendor,
        amount: summaryForm.amount,
        tax: summaryForm.tax,
        currency: summaryForm.currency ?? "JPY",
        memo: summaryForm.memo,
        purpose: purposePayload,
        source: "gemini",
        edited: summaryDirty,
        language: summaryMeta.language ?? null,
        keywords,
        usage: summaryMeta.usage ?? null,
        modelVersion: summaryMeta.modelVersion ?? null,
        items: itemsPayload.length ? itemsPayload : null,
      };

      const baseOcr = latestOcr ?? receipt.ocr;
      const ocrPayload: ReceiptOcrData = {
        ...baseOcr,
        rawText: ocrPreview ? ocrPreview : null,
        source: "vision",
      };

      const filePayload = {
        bucket: STORAGE_BUCKET,
        path: gcsInfo.path,
        gcsUri: gcsInfo.gcsUri,
      };

      const updatePayload: Record<string, unknown> = {
        ocr: ocrPayload,
        summary: summaryPayload,
        file: filePayload,
        purpose: purposePayload?.label ?? null,
        updatedAt: serverTimestamp(),
        "meta.manualEdits": true,
      };

      if (wasConfirmed) {
        updatePayload.status = "reviewed";
      }

      await updateDoc(receiptDoc(receipt.id), updatePayload);

      onReceiptUpdate((prev) =>
        prev
          ? {
              ...prev,
              ocr: ocrPayload,
              summary: summaryPayload,
              file: filePayload,
              purpose: purposePayload?.label ?? null,
              status: wasConfirmed ? "reviewed" : prev.status,
              meta: {
                ...prev.meta,
                manualEdits: true,
              },
            }
          : prev,
      );
      setSummaryDirty(false);
      pushToast(
        wasConfirmed ? "info" : "success",
        wasConfirmed
          ? "Summary updated. Status reverted to reviewed - please confirm again."
          : "Summary saved.",
      );
    } catch (err) {
      console.error("Failed to save summary", err);
      const message = (err as Error).message ?? "Failed to save summary.";
      setError(message);
      pushToast("error", message);
    } finally {
      setSaving(false);
    }
  }, [canEdit, keywords, latestOcr, onReceiptUpdate, ocrPreview, pushToast, receipt, summaryDirty, summaryForm, summaryMeta]);

  const disableRun = !canEdit || loading || saving;
  const disableSave = !canEdit || saving;

  if (isPassbook) {
    const rawText = receipt.ocr?.rawText ?? "";
    return (
      <section className="flex flex-col gap-4 rounded border border-neutral-200 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Passbook OCR</h2>
            <p className="text-sm text-neutral-500">Vision OCR result for bankbook entries.</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleRun}
              disabled={disableRun}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Processing..." : "Run OCR"}
            </button>
            {onConfirm ? (
              <button
                type="button"
                onClick={onConfirm}
                disabled={confirmDisabled}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Confirm
              </button>
            ) : null}
          </div>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <div className="overflow-x-auto">
          <table className="min-w-full border border-neutral-200 text-sm">
            <thead className="bg-neutral-50 text-neutral-600">
              <tr>
                <th className="px-3 py-2 text-left font-medium">日付</th>
                <th className="px-3 py-2 text-left font-medium">摘要</th>
                <th className="px-3 py-2 text-right font-medium">お支払金額</th>
                <th className="px-3 py-2 text-right font-medium">お預り金額</th>
                <th className="px-3 py-2 text-right font-medium">差引残高</th>
              </tr>
            </thead>
            <tbody>
              {hasPassbookEntries ? (
                passbookEntries.map((entry, index) => (
                  <tr key={`${index}-${entry.rawDate ?? entry.date ?? index}`} className="border-t border-neutral-200">
                    <td className="px-3 py-2 text-sm text-neutral-700">{formatPassbookDate(entry) || "-"}</td>
                    <td className="px-3 py-2 text-sm text-neutral-700">{entry.description ?? ""}</td>
                    <td className="px-3 py-2 text-right font-mono text-sm text-neutral-700 tabular-nums">
                      {formatPassbookNumber(entry.withdrawal)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-sm text-neutral-700 tabular-nums">
                      {formatPassbookNumber(entry.deposit)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-sm text-neutral-800 tabular-nums">
                      {formatPassbookNumber(entry.balance)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr className="border-t border-neutral-200">
                  <td className="px-3 py-4 text-center text-sm text-neutral-500" colSpan={5}>
                    OCR で通帳明細を検出できませんでした。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-neutral-700">OCR テキスト</h3>
          <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600">
            {rawText || "(テキストなし)"}
          </pre>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded border border-neutral-200 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">AI Summary</h2>
          <p className="text-sm text-neutral-500">Run OCR and Gemini summarisation for this receipt.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleRun}
            disabled={disableRun}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Processing..." : "Run OCR + Summarise"}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={disableSave}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save Summary"}
          </button>
          {onConfirm ? (
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmDisabled}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Confirm
            </button>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {!STORAGE_BUCKET ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-700">
          NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set. Configure it to enable OCR.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <button
              type="button"
              onClick={() => setActivePreviewTab("image")}
              disabled={!hasImagePreviews}
              className={`rounded px-3 py-1 ${
                activePreviewTab === "image"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-200 text-neutral-700"
              } ${!hasImagePreviews ? "cursor-not-allowed opacity-60" : "hover:bg-blue-700 hover:text-white"}`}
            >
              Receipt image
            </button>
            <button
              type="button"
              onClick={() => setActivePreviewTab("ocr")}
              className={`rounded px-3 py-1 ${
                activePreviewTab === "ocr"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-200 text-neutral-700 hover:bg-blue-700 hover:text-white"
              }`}
            >
              OCR text
            </button>
          </div>
          {activePreviewTab === "image" ? (
            hasImagePreviews && activePreview ? (
              <div className="flex flex-col gap-3">
                <div
                  className="relative w-full overflow-hidden rounded border border-neutral-200 bg-neutral-100"
                  style={{ aspectRatio: "3 / 4" }}
                >
                  <Image
                    src={activePreview.url}
                    alt={`Receipt preview ${activePreview.label}`}
                    fill
                    sizes="(min-width: 1024px) 420px, 100vw"
                    className="object-contain"
                    unoptimized
                  />
                </div>
                {previews.length > 1 ? (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {previews.map((preview) => {
                      const isActive = activePreview?.id === preview.id;
                      return (
                        <button
                          key={preview.id}
                          type="button"
                          onClick={() => setSelectedPreviewId(preview.id)}
                          className={`flex min-w-[5.5rem] flex-col items-center gap-1 rounded border px-2 py-2 text-[11px] ${
                            isActive
                              ? "border-blue-500 bg-blue-50 text-blue-700"
                              : "border-neutral-200 bg-white text-neutral-600 hover:border-blue-300"
                          }`}
                        >
                          <span className="block h-16 w-20 overflow-hidden rounded bg-neutral-100">
                            <Image
                              src={preview.thumbnailUrl ?? preview.url}
                              alt={`Preview ${preview.label}`}
                              width={80}
                              height={64}
                              className="h-full w-full object-cover"
                              unoptimized
                            />
                          </span>
                          <span className="truncate">{preview.label}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="rounded border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500">
                No receipt image available.
              </p>
            )
          ) : (
            <textarea
              value={ocrPreview}
              onChange={(event) => {
                setOcrPreview(event.target.value);
              }}
              rows={hasImagePreviews ? 12 : 16}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
              placeholder="Raw OCR text will appear here"
              disabled={!canEdit}
            />
          )}
        </div>
        <div className="grid gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Date (YYYY-MM-DD)</span>
            <input
              type="date"
              value={summaryForm.date ?? ""}
              onChange={(event) => handleSummaryFieldChange("date", event.target.value ? event.target.value : null)}
              className="rounded border border-neutral-300 px-3 py-2"
              disabled={!canEdit}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Vendor</span>
            <input
              type="text"
              value={summaryForm.vendor ?? ""}
              onChange={(event) => handleSummaryFieldChange("vendor", event.target.value ? event.target.value : null)}
              className="rounded border border-neutral-300 px-3 py-2"
              placeholder="���[�\��"
              disabled={!canEdit}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Amount (JPY)</span>
            <input
              type="number"
              inputMode="decimal"
              value={summaryForm.amount ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                handleSummaryFieldChange("amount", value ? Number.parseFloat(value) : null);
              }}
              className="rounded border border-neutral-300 px-3 py-2"
              disabled={!canEdit}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Tax rate (%)</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={summaryForm.tax ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                handleSummaryFieldChange("tax", value ? Number.parseFloat(value) : null);
              }}
              className="rounded border border-neutral-300 px-3 py-2"
              disabled={!canEdit}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Currency</span>
            <input
              type="text"
              value={summaryForm.currency ?? ""}
              onChange={(event) => handleSummaryFieldChange("currency", event.target.value ? event.target.value.toUpperCase() : null)}
              className="rounded border border-neutral-300 px-3 py-2 uppercase"
              placeholder="JPY"
              disabled={!canEdit}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Purpose</span>
            <select
              value={summaryForm.purposeKey ?? ""}
              onChange={(event) => handlePurposeKeyChange(event.target.value)}
              disabled={!canEdit}
              className="rounded border border-neutral-300 px-3 py-2"
            >
              <option value="">No purpose</option>
              {PURPOSE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-neutral-500">
              Optional. You can also add or edit this later in the receipt.
            </span>
          </label>
          {showPurposeNoteField ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">Purpose note</span>
              <input
                type="text"
                value={summaryForm.purposeNote ?? ""}
                onChange={(event) => handlePurposeNoteChange(event.target.value)}
                maxLength={PURPOSE_NOTE_MAX_LENGTH}
                className="rounded border border-neutral-300 px-3 py-2"
                placeholder="Add a short note (optional)"
                disabled={!canEdit}
              />
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Memo</span>
            <textarea
              value={summaryForm.memo ?? ""}
              onChange={(event) => handleSummaryFieldChange("memo", event.target.value ? event.target.value : null)}
              rows={4}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
              placeholder="�������̃���"
              disabled={!canEdit}
            />
          </label>

          <div className="rounded border border-neutral-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-neutral-700">Tax breakdown</h3>
                <p className="text-xs text-neutral-500">Allocate totals by tax rate for accounting.</p>
              </div>
              <button
                type="button"
                onClick={handleAddLineItem}
                disabled={!canEdit || !canAddAnotherLineItem}
                className="rounded border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add tax bucket
              </button>
            </div>
            {lineItems.length ? (
              <div className="mt-3 grid gap-3">
                {lineItems.map((item, index) => (
                  <div key={item.id} className="rounded border border-neutral-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-neutral-500">Bucket {index + 1}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveLineItem(item.id)}
                        disabled={!canEdit}
                        className="text-xs text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-neutral-500">Tax rate (%)</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.1"
                          min="0"
                          value={item.taxRate ?? ""}
                          onChange={(event) =>
                            handleLineItemChange(
                              item.id,
                              "taxRate",
                              event.target.value ? Number.parseFloat(event.target.value) : null,
                            )
                          }
                          className="rounded border border-neutral-300 px-3 py-2"
                          disabled={!canEdit}
                        />
                        {COMMON_TAX_RATES.length ? (
                          <div className="flex flex-wrap gap-1 pt-1">
                            {COMMON_TAX_RATES.map((rate) => (
                              <button
                                key={rate}
                                type="button"
                                onClick={() => handleLineItemChange(item.id, "taxRate", rate)}
                                disabled={!canEdit}
                                className="rounded border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {rate}%
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() => handleLineItemChange(item.id, "taxRate", null)}
                              disabled={!canEdit}
                              className="rounded border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Clear
                            </button>
                          </div>
                        ) : null}
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-neutral-500">Amount (tax included, JPY)</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={item.amount ?? ""}
                          onChange={(event) =>
                            handleLineItemChange(
                              item.id,
                              "amount",
                              event.target.value ? Number.parseFloat(event.target.value) : null,
                            )
                          }
                          className="rounded border border-neutral-300 px-3 py-2"
                          disabled={!canEdit}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                        <span className="text-neutral-500">Description (optional)</span>
                        <input
                          type="text"
                          value={item.label}
                          onChange={(event) => handleLineItemChange(item.id, "label", event.target.value)}
                          className="rounded border border-neutral-300 px-3 py-2"
                          placeholder="e.g. 10% rate items"
                          disabled={!canEdit}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                        <span className="text-neutral-500">Memo</span>
                        <textarea
                          value={item.memo}
                          onChange={(event) => handleLineItemChange(item.id, "memo", event.target.value)}
                          rows={2}
                          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
                          placeholder="Optional note"
                          disabled={!canEdit}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-neutral-500">No tax buckets defined.</p>
            )}
            {!canAddAnotherLineItem ? (
              <p className="mt-2 text-[11px] text-neutral-400">Maximum of {maxLineItems} tax buckets reached.</p>
            ) : null}
          </div>

        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        {summaryMeta.language ? <span className="rounded bg-neutral-100 px-2 py-1">Language: {summaryMeta.language}</span> : null}
        {summaryMeta.modelVersion ? (
          <span className="rounded bg-neutral-100 px-2 py-1">Model: {summaryMeta.modelVersion}</span>
        ) : null}
        {usageDetails ? (
          <span className="rounded bg-neutral-100 px-2 py-1">
            Tokens: prompt {usageDetails.prompt ?? "-"} / response {usageDetails.candidates ?? "-"} / total {usageDetails.total ?? "-"}
          </span>
        ) : null}
      </div>

      {keywords.length ? (
        <div className="flex flex-wrap gap-2 text-xs">
          {keywords.map((keyword) => (
            <span key={keyword} className="rounded bg-neutral-100 px-2 py-1 text-neutral-600">
              {keyword}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
