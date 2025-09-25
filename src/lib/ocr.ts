import type { ReceiptOcrResult } from "../types/receipt";
import type { VendorRecord } from "../types/vendor";
import { findBestVendorMatch } from "./vendors";

export interface NormaliseOcrOptions {
  rawText: string;
  vendors: VendorRecord[];
}

export interface VendorMatchResult {
  vendorId: string;
  displayName: string;
  distance: number;
}

export interface NormaliseOcrResult {
  ocr: ReceiptOcrResult;
  vendorMatch: VendorMatchResult | null;
}

const DEFAULT_OCR: ReceiptOcrResult = {
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
};

const AMOUNT_REGEX = /(?:\|￥)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\s*円)?/gi;
const DATE_PATTERNS: Array<{ regex: RegExp; order: "ymd" | "mdy" }> = [
  { regex: /\b(20\d{2})[\/\.\-年](\d{1,2})[\/\.\-月](\d{1,2})日?\b/, order: "ymd" },
  { regex: /\b(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](20\d{2}|\d{2})\b/, order: "mdy" },
];
const TOTAL_HINTS = ["total", "合計", "小計", "請求額", "金額"];
const TAX_HINTS = ["tax", "%", "税", "消費", "軽減"];
const MEMO_KEYWORDS = ["memo", "note", "remarks", "備考", "メモ"];
const VENDOR_SKIP_PREFIX = /^(tel|fax|phone|no\.|領収書)/i;

interface NumberExtractionResult {
  amount: number | null;
  tax: number | null;
}

function resetAmountRegex(): void {
  AMOUNT_REGEX.lastIndex = 0;
}

function extractDate(text: string): string | null {
  for (const { regex, order } of DATE_PATTERNS) {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    if (!match) {
      continue;
    }
    if (order === "ymd") {
      const year = Number.parseInt(match[1], 10);
      const month = Number.parseInt(match[2], 10);
      const day = Number.parseInt(match[3], 10);
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    } else {
      const month = Number.parseInt(match[1], 10);
      const day = Number.parseInt(match[2], 10);
      let year = Number.parseInt(match[3], 10);
      if (year < 100) {
        year += year >= 70 ? 1900 : 2000;
      }
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }
  return null;
}

function extractVendor(lines: string[]): string | null {
  for (const line of lines) {
    if (!line || VENDOR_SKIP_PREFIX.test(line)) {
      continue;
    }
    resetAmountRegex();
    if (AMOUNT_REGEX.test(line) || /\d/.test(line)) {
      continue;
    }
    return line;
  }
  return null;
}

function extractNumbers(lines: string[]): NumberExtractionResult {
  let bestAmount: { value: number; weight: number } | null = null;
  let bestTax: { value: number; weight: number } | null = null;

  for (const rawLine of lines) {
    const line = rawLine ?? "";
    if (!line) {
      continue;
    }
    const lowered = line.toLowerCase();
    const containsTotal = TOTAL_HINTS.some((hint) => lowered.includes(hint) || line.includes(hint));
    const containsTax = TAX_HINTS.some((hint) => lowered.includes(hint) || line.includes(hint));

    resetAmountRegex();
    let match: RegExpExecArray | null;
    while ((match = AMOUNT_REGEX.exec(line))) {
      const numeric = Number.parseInt((match[1] ?? "").replace(/,/g, ""), 10);
      if (!Number.isFinite(numeric)) {
        continue;
      }
      const weight = numeric + (containsTotal ? 1_000_000 : 0);
      if (!bestAmount || weight > bestAmount.weight) {
        bestAmount = { value: numeric, weight };
      }
      if (containsTax) {
        const taxWeight = numeric + 100_000;
        if (!bestTax || taxWeight > bestTax.weight) {
          bestTax = { value: numeric, weight: taxWeight };
        }
      }
    }

    if (!containsTax) {
      continue;
    }

    const numericMatch = /\d{1,3}(?:,\d{3})+|\d+/.exec(line);
    if (numericMatch) {
      const numeric = Number.parseInt(numericMatch[0].replace(/,/g, ""), 10);
      if (Number.isFinite(numeric) && (!bestTax || numeric > bestTax.value)) {
        bestTax = { value: numeric, weight: numeric };
      }
    }
  }

  return {
    amount: bestAmount?.value ?? null,
    tax: bestTax?.value ?? null,
  };
}

function extractMemo(lines: string[]): string | null {
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const keyword of MEMO_KEYWORDS) {
      if (lower.includes(keyword) || line.includes(keyword)) {
        const start = lower.indexOf(keyword);
        if (start !== -1) {
          const memo = line
            .slice(start + keyword.length)
            .replace(/^[\s:\-：]+/, "")
            .trim();
          if (memo) {
            return memo;
          }
        }
      }
    }
  }
  const tail = lines
    .slice(-3)
    .find((line) => line.length >= 4 && (resetAmountRegex(), !AMOUNT_REGEX.test(line)));
  if (tail) {
    return tail;
  }
  return null;
}

function computeConfidence(result: ReceiptOcrResult): number {
  let score = 0;
  if (result.amount !== null) {
    score += 0.3;
  }
  if (result.vendorId) {
    score += 0.25;
  } else if (result.vendorName) {
    score += 0.15;
  }
  if (result.date) {
    score += 0.15;
  }
  if (result.tax !== null) {
    score += 0.1;
  }
  if (result.memo) {
    score += 0.05;
  }
  return Math.min(0.95, score);
}

export function normaliseOcrText(options: NormaliseOcrOptions): NormaliseOcrResult {
  const { rawText, vendors } = options;
  if (!rawText.trim()) {
    return {
      ocr: { ...DEFAULT_OCR },
      vendorMatch: null,
    };
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const vendorCandidate = extractVendor(lines);
  const { amount, tax } = extractNumbers(lines);
  const date = extractDate(rawText);
  const memo = extractMemo(lines);

  const ocr: ReceiptOcrResult = {
    date,
    vendorId: null,
    vendorName: vendorCandidate ?? null,
    vendor: vendorCandidate ?? null,
    rawText: rawText.trim() ? rawText : null,
    amount,
    currency: "JPY",
    tax,
    memo,
    source: "vision",
    confidenceGemini: null,
    confidenceFinal: null,
    confidence: 0,
  };

  let vendorMatch: VendorMatchResult | null = null;
  if (vendorCandidate) {
    const match = findBestVendorMatch(vendors, vendorCandidate, 3);
    if (match) {
      ocr.vendorId = match.record.id;
      ocr.vendorName = match.record.displayName;
      vendorMatch = {
        vendorId: match.record.id,
        displayName: match.record.displayName,
        distance: match.distance,
      };
    }
  }

  ocr.confidence = computeConfidence(ocr);
  ocr.confidenceFinal = ocr.confidence;

  return {
    ocr,
    vendorMatch,
  };
}

export function defaultOcr(): ReceiptOcrResult {
  return { ...DEFAULT_OCR };
}

