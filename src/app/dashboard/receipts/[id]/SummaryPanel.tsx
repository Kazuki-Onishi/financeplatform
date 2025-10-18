"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { serverTimestamp, updateDoc } from "firebase/firestore";
import { callOCR, callSummarize } from "@/lib/api.client";
import { cleanAmount, toIsoDate } from "@/lib/ocrPassbook";
import { toHalfWidth } from "@/lib/text/width";
import { receiptDoc } from "@/lib/firestoreRefs";
import { PURPOSE_NOTE_MAX_LENGTH, PURPOSE_OPTIONS, findPurposeOption } from "@/lib/purposeOptions";
import { PURCHASE_PURPOSE_MAX_LENGTH } from "@/app/dashboard/upload/constants";
import { useTranslations } from "@/lib/i18n/I18nProvider";
import type {
  ReceiptOcrData,
  ReceiptPassbookEntry,
  ReceiptPaymentMethod,
  ReceiptPaymentMethodType,
  ReceiptRecord,
  ReceiptSummaryData,
  ReceiptSummaryLineItem,
} from "@/types/receipt";

const STORAGE_BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "";

const COMMON_TAX_RATES = [10, 8, 0];
const PAYMENT_CARD_ID_MAX_LENGTH = 64;

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
  purchasePurpose: string | null;
  advancePayment: boolean;
  lineItems: SummaryLineItemState[];
};

type SummaryMetaState = {
  language: string | null;
  keywords: string[];
  usage: Record<string, unknown> | null;
  modelVersion: string | null;
};

type PassbookEntryDraft = {
  id: string;
  rawDate: string;
  description: string;
  withdrawal: string;
  deposit: string;
  balance: string;
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
  summariesEnabled?: boolean;
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
  purchasePurpose: null,
  advancePayment: false,
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

function generatePassbookEntryDraftId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `passbook-${Math.random().toString(36).slice(2, 10)}`;
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

function createEmptyPassbookDraft(): PassbookEntryDraft {
  return {
    id: generatePassbookEntryDraftId(),
    rawDate: "",
    description: "",
    withdrawal: "",
    deposit: "",
    balance: "",
  };
}

function buildPassbookDraft(entries: ReceiptPassbookEntry[]): PassbookEntryDraft[] {
  if (!entries.length) {
    return [];
  }
  return entries.map((entry) => ({
    id: generatePassbookEntryDraftId(),
    rawDate: formatPassbookDate(entry),
    description: entry.description ?? "",
    withdrawal: entry.withdrawal != null ? String(entry.withdrawal) : "",
    deposit: entry.deposit != null ? String(entry.deposit) : "",
    balance: entry.balance != null ? String(entry.balance) : "",
  }));
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

export default function SummaryPanel({ receipt, canEdit, pushToast, onReceiptUpdate, previews = [], maxLineItems = MAX_LINE_ITEMS, onConfirm, confirmDisabled, summariesEnabled = true }: SummaryPanelProps) {
  const t = useTranslations("receipts.summaryPanel");
  const [summaryForm, setSummaryForm] = useState<SummaryFormState>(DEFAULT_FORM);
  const [summaryMeta, setSummaryMeta] = useState<SummaryMetaState>(DEFAULT_META);
  const [summaryDirty, setSummaryDirty] = useState(false);
  const [paymentMethodType, setPaymentMethodType] = useState<ReceiptPaymentMethodType>(
    () => receipt.paymentMethod?.type ?? "cash",
  );
  const [paymentMethodCardId, setPaymentMethodCardId] = useState<string>(
    () =>
      receipt.paymentMethod?.type === "credit" && typeof receipt.paymentMethod?.cardId === "string"
        ? receipt.paymentMethod.cardId
        : "",
  );
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


  const [editingPassbook, setEditingPassbook] = useState(false);
  const [passbookDraft, setPassbookDraft] = useState<PassbookEntryDraft[]>(() =>
    passbookEntries.length ? buildPassbookDraft(passbookEntries) : [],
  );
  const [passbookDirty, setPassbookDirty] = useState(false);
  const [passbookSaving, setPassbookSaving] = useState(false);
  const [passbookEditError, setPassbookEditError] = useState<string | null>(null);

  useEffect(() => {
    if (!editingPassbook) {
      setPassbookDraft(passbookEntries.length ? buildPassbookDraft(passbookEntries) : []);
      setPassbookDirty(false);
      setPassbookEditError(null);
    }
  }, [editingPassbook, passbookEntries]);

  const handleStartPassbookEdit = useCallback(() => {
    setPassbookDraft(passbookEntries.length ? buildPassbookDraft(passbookEntries) : [createEmptyPassbookDraft()]);
    setPassbookDirty(false);
    setPassbookEditError(null);
    setEditingPassbook(true);
  }, [passbookEntries]);

  const handleCancelPassbookEdit = useCallback(() => {
    setEditingPassbook(false);
    setPassbookDraft(passbookEntries.length ? buildPassbookDraft(passbookEntries) : []);
    setPassbookDirty(false);
    setPassbookEditError(null);
  }, [passbookEntries]);

  const handleAddPassbookRow = useCallback(() => {
    setPassbookDraft((prev) => [...prev, createEmptyPassbookDraft()]);
    setPassbookDirty(true);
  }, []);

  const handleRemovePassbookRow = useCallback((id: string) => {
    setPassbookDraft((prev) => prev.filter((row) => row.id !== id));
    setPassbookDirty(true);
  }, []);

  const handlePassbookDraftChange = useCallback(
    (id: string, field: keyof PassbookEntryDraft, value: string) => {
      setPassbookDraft((prev) =>
        prev.map((row) =>
          row.id === id
            ? {
                ...row,
                [field]: field === "description" ? value : toHalfWidth(value),
              }
            : row,
        ),
      );
      setPassbookDirty(true);
    },
    [],
  );

  const handleSavePassbookEntries = useCallback(async () => {
    if (!canEdit) {
      pushToast("error", t("toasts.passbookNoPermission"));
      return;
    }
    setPassbookSaving(true);
    setPassbookEditError(null);
    try {
      const parseAmountValue = (input: string): number | null => {
        const normalised = toHalfWidth(input);
        if (!normalised.trim().length) {
          return null;
        }
        return cleanAmount(normalised);
      };

      const nextEntries = passbookDraft
        .map((row) => {
          const rawDate = toHalfWidth(row.rawDate).replace(/\s+/g, "");
          const description = row.description.trim() ? row.description.trim() : null;
          const withdrawal = parseAmountValue(row.withdrawal);
          const deposit = parseAmountValue(row.deposit);
          const balance = parseAmountValue(row.balance);
          if (!rawDate && !description && withdrawal === null && deposit === null && balance === null) {
            return null;
          }
          return {
            rawDate: rawDate || null,
            date: rawDate ? toIsoDate(rawDate) : null,
            description,
            withdrawal,
            deposit,
            balance,
          } as ReceiptPassbookEntry;
        })
        .filter((entry): entry is ReceiptPassbookEntry => entry !== null);

      await updateDoc(receiptDoc(receipt.id), {
        "ocr.passbookEntries": nextEntries,
        updatedAt: serverTimestamp(),
        "meta.manualEdits": true,
      });

      onReceiptUpdate((prev) =>
        prev
          ? {
              ...prev,
              ocr: {
                ...prev.ocr,
                passbookEntries: nextEntries,
              },
              meta: {
                ...prev.meta,
                manualEdits: true,
              },
            }
          : prev,
      );

      setPassbookDraft(nextEntries.length ? buildPassbookDraft(nextEntries) : []);
      setPassbookDirty(false);
      setEditingPassbook(false);
      pushToast("success", t("toasts.passbookSaved"));
    } catch (err) {
      console.error("Failed to save passbook entries", err);
      const fallbackMessage = t("toasts.passbookSaveFailed");
      setPassbookEditError(fallbackMessage);
      pushToast("error", fallbackMessage);
    } finally {
      setPassbookSaving(false);
    }
  }, [canEdit, onReceiptUpdate, passbookDraft, pushToast, receipt.id, t]);

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

    const summaryPurchasePurposeRaw =
      typeof nextSummary?.purchasePurpose === "string" ? nextSummary.purchasePurpose : null;
    const initialPurchasePurpose =
      summaryPurchasePurposeRaw ??
      (typeof receipt.purchasePurpose === "string" ? receipt.purchasePurpose : null);
    const sanitizedPurchasePurpose = initialPurchasePurpose
      ? initialPurchasePurpose.slice(0, PURCHASE_PURPOSE_MAX_LENGTH)
      : null;
    const initialAdvancePayment =
      typeof nextSummary?.advancePayment === "boolean"
        ? nextSummary.advancePayment
        : Boolean(receipt.advancePayment);
    const initialPaymentType = receipt.paymentMethod?.type ?? "cash";
    const initialPaymentCardId =
      receipt.paymentMethod?.type === "credit" && typeof receipt.paymentMethod?.cardId === "string"
        ? receipt.paymentMethod.cardId
        : "";

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
      purchasePurpose: sanitizedPurchasePurpose,
      advancePayment: initialAdvancePayment,
      lineItems: summaryItems,
    });
    setPaymentMethodType(initialPaymentType);
    setPaymentMethodCardId(initialPaymentCardId);
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

  const handlePurchasePurposeChange = useCallback((value: string) => {
    if (!canEdit) {
      return;
    }
    const sanitized = value.slice(0, PURCHASE_PURPOSE_MAX_LENGTH);
    const nextValue = sanitized.length ? sanitized : null;
    let changed = false;
    setSummaryForm((prev) => {
      if (prev.purchasePurpose === nextValue) {
        return prev;
      }
      changed = true;
      return {
        ...prev,
        purchasePurpose: nextValue,
      };
    });
    if (changed) {
      setSummaryDirty(true);
    }
  }, [canEdit, setSummaryDirty]);

  const handleAdvancePaymentChange = useCallback((value: boolean) => {
    if (!canEdit) {
      return;
    }
    let changed = false;
    setSummaryForm((prev) => {
      if (prev.advancePayment === value) {
        return prev;
      }
      changed = true;
      return {
        ...prev,
        advancePayment: value,
      };
    });
    if (changed) {
      setSummaryDirty(true);
    }
  }, [canEdit, setSummaryDirty]);

  const handlePaymentMethodTypeChange = useCallback((value: ReceiptPaymentMethodType) => {
    if (!canEdit) {
      return;
    }
    let changed = false;
    setPaymentMethodType((prev) => {
      if (prev === value) {
        return prev;
      }
      changed = true;
      return value;
    });
    if (value !== "credit") {
      setPaymentMethodCardId("");
    }
    if (changed) {
      setSummaryDirty(true);
    }
  }, [canEdit, setSummaryDirty]);

  const handlePaymentMethodCardIdChange = useCallback((value: string) => {
    if (!canEdit) {
      return;
    }
    const sanitized = value.slice(0, PAYMENT_CARD_ID_MAX_LENGTH);
    let changed = false;
    setPaymentMethodCardId((prev) => {
      if (prev === sanitized) {
        return prev;
      }
      changed = true;
      return sanitized;
    });
    if (changed) {
      setSummaryDirty(true);
    }
  }, [canEdit, setSummaryDirty]);

  const handleRun = useCallback(async () => {
    if (!canEdit) {
      pushToast("error", t("toasts.runNoPermission"));
      return;
    }
    const gcsInfo = buildGcsUri(receipt.filePath);
    if (!gcsInfo) {
      pushToast("error", t("errors.storageConfig"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const ocrResult = await callOCR(gcsInfo.gcsUri, "document", receipt.id);
      const text = typeof ocrResult.text === "string" ? ocrResult.text : "";
      if (!text) {
        throw new Error(t("errors.ocrEmpty"));
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

      if (!summariesEnabled) {
        setSummaryMeta(DEFAULT_META);
        setSummaryDirty(false);
        pushToast("success", t("toasts.ocrRefreshed"));
        return;
      }

      const summaryResult = await callSummarize(text);
      setSummaryForm((prev) => {
        const summaryExtras = summaryResult.summary as {
          purchasePurpose?: unknown;
          advancePayment?: unknown;
        };
        const summaryPurchaseRaw = summaryExtras.purchasePurpose;
        const summaryAdvanceRaw = summaryExtras.advancePayment;
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
          purchasePurpose:
            typeof summaryPurchaseRaw === "string" && summaryPurchaseRaw.length
              ? summaryPurchaseRaw.slice(0, PURCHASE_PURPOSE_MAX_LENGTH)
              : prev.purchasePurpose,
          advancePayment:
            typeof summaryAdvanceRaw === "boolean"
              ? summaryAdvanceRaw
              : prev.advancePayment,
        };
      });
      setSummaryMeta({
        language: summaryResult.language ?? null,
        keywords: summaryResult.keywords ?? [],
        usage: summaryResult.usage ?? null,
        modelVersion: summaryResult.modelVersion ?? null,
      });
      setSummaryDirty(false);
      pushToast("success", t("toasts.ocrSummaryRefreshed"));
    } catch (err) {
      console.error("Failed to run OCR and summarise", err);
      const fallbackMessage = t("toasts.runFailed");
      setError(fallbackMessage);
      pushToast("error", fallbackMessage);
    } finally {
      setLoading(false);
    }
  }, [canEdit, onReceiptUpdate, pushToast, receipt, summariesEnabled, t]);

  const handleSave = useCallback(async () => {
    if (!canEdit) {
      pushToast("error", t("toasts.summaryNoPermission"));
      return;
    }
    const gcsInfo = buildGcsUri(receipt.filePath);
    if (!gcsInfo) {
      pushToast("error", t("errors.storageConfig"));
      return;
    }
    const wasConfirmed = receipt.status === "confirmed";
    if (wasConfirmed) {
      const proceed = window.confirm(t("prompts.revertToReviewed"));
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
      const trimmedPurchasePurpose = (summaryForm.purchasePurpose ?? "").trim();
      const purchasePurposeValue = trimmedPurchasePurpose.length ? trimmedPurchasePurpose : null;
      const trimmedCardId = paymentMethodCardId.trim();
      const paymentMethodPayload: ReceiptPaymentMethod = {
        type: paymentMethodType,
        cardId: paymentMethodType === "credit" ? (trimmedCardId.length ? trimmedCardId : null) : null,
      };

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
        purchasePurpose: purchasePurposeValue,
        advancePayment: summaryForm.advancePayment,
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
        purchasePurpose: purchasePurposeValue,
        advancePayment: summaryForm.advancePayment,
        paymentMethod: paymentMethodPayload,
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
              purchasePurpose: purchasePurposeValue,
              advancePayment: summaryForm.advancePayment,
              paymentMethod: paymentMethodPayload,
              status: wasConfirmed ? "reviewed" : prev.status,
              meta: {
                ...prev.meta,
                manualEdits: true,
              },
            }
          : prev,
      );
      setSummaryDirty(false);
      const successMessage = wasConfirmed ? t("toasts.summaryUpdated") : t("toasts.summarySaved");
      pushToast(wasConfirmed ? "info" : "success", successMessage);
    } catch (err) {
      console.error("Failed to save summary", err);
      const fallbackMessage = t("toasts.summarySaveFailed");
      setError(fallbackMessage);
      pushToast("error", fallbackMessage);
    } finally {
      setSaving(false);
    }
  }, [
    canEdit,
    keywords,
    latestOcr,
    onReceiptUpdate,
    ocrPreview,
    paymentMethodCardId,
    paymentMethodType,
    pushToast,
    receipt,
    summaryDirty,
    summaryForm,
    summaryMeta,
    t,
  ]);

  const disableRun = !canEdit || loading || saving || passbookSaving || editingPassbook;
  const disableSave = !canEdit || saving;

  if (isPassbook) {
    const rawText = receipt.ocr?.rawText ?? "";
    const confirmDisabledState = (confirmDisabled ?? false) || editingPassbook || passbookSaving;
    const hasDraftRows = passbookDraft.length > 0;

    return (
      <section className="flex flex-col gap-4 rounded border border-neutral-200 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t("passbook.title")}</h2>
            <p className="text-sm text-neutral-500">{t("passbook.subtitle")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleRun}
              disabled={disableRun}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? t("buttons.processing") : t("buttons.runOcr")}
            </button>
            {editingPassbook ? (
              <>
                <button
                  type="button"
                  onClick={handleSavePassbookEntries}
                  disabled={!passbookDirty || passbookSaving}
                  className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {passbookSaving ? t("buttons.saving") : t("buttons.save")}
                </button>
                <button
                  type="button"
                  onClick={handleCancelPassbookEdit}
                  disabled={passbookSaving}
                  className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t("buttons.cancel")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleStartPassbookEdit}
                disabled={!canEdit || passbookSaving}
                className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("passbook.edit")}
              </button>
            )}
            {onConfirm ? (
              <button
                type="button"
                onClick={onConfirm}
                disabled={confirmDisabledState}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("buttons.confirm")}
              </button>
            ) : null}
          </div>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {passbookEditError ? <p className="text-sm text-red-600">{passbookEditError}</p> : null}

        <div className="flex flex-col gap-6">
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="min-w-full border border-neutral-200 text-sm">
                <thead className="bg-neutral-50 text-neutral-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("passbook.columns.date")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("passbook.columns.description")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("passbook.columns.withdrawal")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("passbook.columns.deposit")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("passbook.columns.balance")}</th>
                  </tr>
                </thead>
                <tbody>
                  {editingPassbook ? (
                    hasDraftRows ? (
                      passbookDraft.map((row) => (
                        <tr key={row.id} className="border-t border-neutral-200">
                          <td className="px-3 py-2 align-top">
                            <input
                              value={row.rawDate}
                              onChange={(event) => handlePassbookDraftChange(row.id, "rawDate", event.target.value)}
                              placeholder="24.04.10"
                              inputMode="numeric"
                              className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                            />
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="flex items-start gap-2">
                              <input
                                value={row.description}
                                onChange={(event) => handlePassbookDraftChange(row.id, "description", event.target.value)}
                                placeholder="摘要"
                                className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                              />
                              <button
                                type="button"
                                onClick={() => handleRemovePassbookRow(row.id)}
                                className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
                              >
                                削除
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <input
                              value={row.withdrawal}
                              onChange={(event) => handlePassbookDraftChange(row.id, "withdrawal", event.target.value)}
                              placeholder="0"
                              inputMode="decimal"
                              className="w-full rounded border border-neutral-300 px-2 py-1 text-right text-sm font-mono"
                            />
                          </td>
                          <td className="px-3 py-2 align-top">
                            <input
                              value={row.deposit}
                              onChange={(event) => handlePassbookDraftChange(row.id, "deposit", event.target.value)}
                              placeholder="0"
                              inputMode="decimal"
                              className="w-full rounded border border-neutral-300 px-2 py-1 text-right text-sm font-mono"
                            />
                          </td>
                          <td className="px-3 py-2 align-top">
                            <input
                              value={row.balance}
                              onChange={(event) => handlePassbookDraftChange(row.id, "balance", event.target.value)}
                              placeholder="0"
                              inputMode="decimal"
                              className="w-full rounded border border-neutral-300 px-2 py-1 text-right text-sm font-mono"
                            />
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr className="border-t border-neutral-200">
                        <td className="px-3 py-3 text-center text-sm text-neutral-500" colSpan={5}>
                          {t("passbook.empty.noDraftRows", { action: t("passbook.actions.addRow") })}
                        </td>
                      </tr>
                    )
                  ) : hasPassbookEntries ? (
                    passbookEntries.map((entry, index) => {
                      const description = entry.description?.trim().length
                        ? entry.description
                        : t("passbook.entries.noDescription");
                      const positionLabel =
                        passbookEntries.length > 1
                          ? t("passbook.entries.position", {
                              current: index + 1,
                              total: passbookEntries.length,
                            })
                          : null;
                      return (
                        <tr key={`${index}-${entry.rawDate ?? entry.date ?? index}`} className="border-t border-neutral-200">
                          <td className="px-3 py-2 text-sm text-neutral-700">{formatPassbookDate(entry) || "-"}</td>
                          <td className="px-3 py-2 text-sm text-neutral-700">
                            <div className="space-y-1">
                              <div>{description}</div>
                              {positionLabel ? (
                                <div className="text-[11px] text-neutral-400">{positionLabel}</div>
                              ) : null}
                            </div>
                          </td>
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
                      );
                    })
                  ) : (
                    <tr className="border-t border-neutral-200">
                      <td className="px-3 py-4 text-center text-sm text-neutral-500" colSpan={5}>
                        {t("passbook.empty.noEntries")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {editingPassbook ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
                <button
                  type="button"
                  onClick={handleAddPassbookRow}
                  className="rounded border border-neutral-300 px-3 py-1 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed"
                >
                  {t("passbook.actions.addRow")}
                </button>
                <span>{t("passbook.hints.normalisation")}</span>
              </div>
            ) : null}
          </div>

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
                {t("passbook.tabs.image")}
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
                {t("passbook.tabs.ocr")}
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
                      alt={t("passbook.previewAlt", { label: activePreview.label })}
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
                  {t("passbook.empty.noImage")}
                </p>
              )
            ) : (
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600">
                {rawText || t("passbook.empty.noOcrText")}
              </pre>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded border border-neutral-200 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("summary.title")}</h2>
          <p className="text-sm text-neutral-500">{t("summary.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleRun}
            disabled={disableRun}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? t("buttons.processing") : t("buttons.runOcrSummarise")}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={disableSave}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? t("buttons.saving") : t("buttons.saveSummary")}
          </button>
          {onConfirm ? (
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmDisabled}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("buttons.confirm")}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {!STORAGE_BUCKET ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-700">
          {t("alerts.storageUnset")}
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
              {t("tabs.image")}
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
              {t("tabs.ocr")}
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
                    alt={t("summary.previewAlt", { label: activePreview.label })}
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
                {t("empty.noImage")}
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
              placeholder={t("empty.ocrPlaceholder")}
              disabled={!canEdit}
            />
          )}
        </div>
        <div className="grid gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">{t("fields.date")}</span>
            <input
              type="date"
              value={summaryForm.date ?? ""}
              onChange={(event) => handleSummaryFieldChange("date", event.target.value ? event.target.value : null)}
              className="rounded border border-neutral-300 px-3 py-2"
              disabled={!canEdit}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">{t("fields.vendor")}</span>
            <input
              type="text"
              value={summaryForm.vendor ?? ""}
              onChange={(event) => handleSummaryFieldChange("vendor", event.target.value ? event.target.value : null)}
              className="rounded border border-neutral-300 px-3 py-2"
              placeholder={t("fields.vendorPlaceholder")}
              disabled={!canEdit}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">{t("fields.amount")}</span>
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
            <span className="text-neutral-500">{t("fields.taxRate")}</span>
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
            <span className="text-neutral-500">{t("fields.currency")}</span>
            <input
              type="text"
              value={summaryForm.currency ?? ""}
              onChange={(event) => handleSummaryFieldChange("currency", event.target.value ? event.target.value.toUpperCase() : null)}
              className="rounded border border-neutral-300 px-3 py-2 uppercase"
              placeholder={t("fields.currencyPlaceholder")}
              disabled={!canEdit}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">{t("fields.purpose")}</span>
            <select
              value={summaryForm.purposeKey ?? ""}
              onChange={(event) => handlePurposeKeyChange(event.target.value)}
              disabled={!canEdit}
              className="rounded border border-neutral-300 px-3 py-2"
            >
              <option value="">{t("fields.purposeNone")}</option>
              {PURPOSE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-neutral-500">
              {t("fields.purposeHint")}
            </span>
          </label>
          {showPurposeNoteField ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">{t("fields.purposeNote")}</span>
              <input
                type="text"
                value={summaryForm.purposeNote ?? ""}
                onChange={(event) => handlePurposeNoteChange(event.target.value)}
                maxLength={PURPOSE_NOTE_MAX_LENGTH}
                className="rounded border border-neutral-300 px-3 py-2"
                placeholder={t("fields.purposeNotePlaceholder")}
                disabled={!canEdit}
              />
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">{t("fields.purchasePurpose")}</span>
            <input
              type="text"
              value={summaryForm.purchasePurpose ?? ""}
              onChange={(event) => handlePurchasePurposeChange(event.target.value)}
              maxLength={PURCHASE_PURPOSE_MAX_LENGTH}
              className="rounded border border-neutral-300 px-3 py-2"
              placeholder={t("fields.purchasePurposePlaceholder")}
              disabled={!canEdit}
            />
            <span className="text-xs text-neutral-500">
              {t("fields.purchasePurposeHelp", { max: PURCHASE_PURPOSE_MAX_LENGTH })}
            </span>
          </label>
          <div className="flex flex-col gap-2 text-sm">
            <span className="text-neutral-500">{t("fields.advancePayment")}</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleAdvancePaymentChange(true)}
                className={`rounded border px-3 py-1 text-xs font-medium ${
                  summaryForm.advancePayment
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-neutral-300 text-neutral-600 hover:bg-neutral-100"
                }`}
                aria-pressed={summaryForm.advancePayment}
                disabled={!canEdit}
              >
                {t("fields.advanceYes")}
              </button>
              <button
                type="button"
                onClick={() => handleAdvancePaymentChange(false)}
                className={`rounded border px-3 py-1 text-xs font-medium ${
                  !summaryForm.advancePayment
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-neutral-300 text-neutral-600 hover:bg-neutral-100"
                }`}
                aria-pressed={!summaryForm.advancePayment}
                disabled={!canEdit}
              >
                {t("fields.advanceNo")}
              </button>
            </div>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">{t("fields.paymentMethod")}</span>
            <select
              value={paymentMethodType}
              onChange={(event) => handlePaymentMethodTypeChange(event.target.value as ReceiptPaymentMethodType)}
              disabled={!canEdit}
              className="rounded border border-neutral-300 px-3 py-2"
            >
              <option value="cash">{t("fields.paymentCash")}</option>
              <option value="credit">{t("fields.paymentCredit")}</option>
              <option value="bank">{t("fields.paymentBank")}</option>
              <option value="other">{t("fields.paymentOther")}</option>
            </select>
          </label>
          {paymentMethodType === "credit" ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">{t("fields.cardReference")}</span>
              <input
                type="text"
                value={paymentMethodCardId}
                onChange={(event) => handlePaymentMethodCardIdChange(event.target.value)}
                maxLength={PAYMENT_CARD_ID_MAX_LENGTH}
                className="rounded border border-neutral-300 px-3 py-2"
                placeholder={t("fields.cardReferencePlaceholder")}
                disabled={!canEdit}
              />
              <span className="text-xs text-neutral-500">{t("fields.cardReferenceHint")}</span>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">{t("fields.memo")}</span>
            <textarea
              value={summaryForm.memo ?? ""}
              onChange={(event) => handleSummaryFieldChange("memo", event.target.value ? event.target.value : null)}
              rows={4}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
              placeholder={t("fields.memoPlaceholder")}
              disabled={!canEdit}
            />
          </label>

          <div className="rounded border border-neutral-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-neutral-700">{t("tax.title")}</h3>
                <p className="text-xs text-neutral-500">{t("tax.subtitle")}</p>
              </div>
              <button
                type="button"
                onClick={handleAddLineItem}
                disabled={!canEdit || !canAddAnotherLineItem}
                className="rounded border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("tax.addBucket")}
              </button>
            </div>
            {lineItems.length ? (
              <div className="mt-3 grid gap-3">
                {lineItems.map((item, index) => (
                  <div key={item.id} className="rounded border border-neutral-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-neutral-500">
                        {t("tax.bucketLabel", { index: index + 1 })}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveLineItem(item.id)}
                        disabled={!canEdit}
                        className="text-xs text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("tax.removeBucket")}
                      </button>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-neutral-500">{t("tax.rateLabel")}</span>
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
                              {t("tax.clearRate")}
                            </button>
                          </div>
                        ) : null}
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-neutral-500">{t("tax.amountLabel")}</span>
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
                        <span className="text-neutral-500">{t("tax.descriptionLabel")}</span>
                        <input
                          type="text"
                          value={item.label}
                          onChange={(event) => handleLineItemChange(item.id, "label", event.target.value)}
                          className="rounded border border-neutral-300 px-3 py-2"
                          placeholder={t("tax.descriptionPlaceholder")}
                          disabled={!canEdit}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                        <span className="text-neutral-500">{t("tax.memoLabel")}</span>
                        <textarea
                          value={item.memo}
                          onChange={(event) => handleLineItemChange(item.id, "memo", event.target.value)}
                          rows={2}
                          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
                          placeholder={t("tax.memoPlaceholder")}
                          disabled={!canEdit}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-neutral-500">{t("tax.empty")}</p>
            )}
            {!canAddAnotherLineItem ? (
              <p className="mt-2 text-[11px] text-neutral-400">{t("tax.maxReached", { count: maxLineItems })}</p>
            ) : null}
          </div>

        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        {summaryMeta.language ? (
          <span className="rounded bg-neutral-100 px-2 py-1">
            {t("meta.language", { value: summaryMeta.language })}
          </span>
        ) : null}
        {summaryMeta.modelVersion ? (
          <span className="rounded bg-neutral-100 px-2 py-1">
            {t("meta.model", { value: summaryMeta.modelVersion })}
          </span>
        ) : null}
        {usageDetails ? (
          <span className="rounded bg-neutral-100 px-2 py-1">
            {t("meta.tokens", {
              prompt: usageDetails.prompt ?? "-",
              response: usageDetails.candidates ?? "-",
              total: usageDetails.total ?? "-",
            })}
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

