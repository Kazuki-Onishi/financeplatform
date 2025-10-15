import type { NormaliseOcrResult } from "./ocr";
import { defaultOcr } from "./ocr";
import type { ReceiptPassbookEntry } from "../types/receipt";
import { toHalfWidth } from "./text/width";

export interface NormalisePassbookOptions {
  rawText: string;
}

const DATE_PATTERN = /\b\d{2}\.\d{2}\.\d{2}\b/g;
const LEADING_INDEX_BEFORE_DATE = /(?<!\d)(\d{1,2})\s*(?=\d{2}\.\d{2}\.\d{2})/g;
const AMOUNT_TOKEN = /([*\uFF0A]?)[\u00A5\uFFE5]?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)/g;
const COLUMN_HEADER_PATTERN = /\u304a\u652f\u6255\u91d1\u984d[\s\S]*?\u304a\u9810\u308a\u91d1\u984d[\s\S]*?\u5dee\u5f15\u6b8b\u9ad8/g;
const NON_AMOUNT_HINT_PATTERN = /(\u53D6\u6271\u5E97|ATM|\uFF21\uFF34\uFF2D|FB|\uFF26\uFF22|\u632F\u8FBC|\u6C7A\u7B97|\u5229\u606F|\u30D5\u30A1\u30F3\u30D5\u30A9|\u30D5\u30A1\u30F3\u30A2\u30AA)/i;

const DROP_PATTERNS = [
  /\u304a\u53d6\u5f15\u660e\u7d30/,
  /\u5dee\u5f15\u6b8b\u9ad8\u306e\u91d1\u984d/,
  /\u5e74\u6708\u65e5/,
  /\u6458\u8981/,
  /\u304a\u652f\u6255\u91d1\u984d/,
  /\u304a\u9810\u308a\u91d1\u984d/,
  /\u5dee\u5f15\u6b8b\u9ad8/,
  /\u306e\u8868\u5f62\u5f0f/,
];

type AmountToken = {
  raw: string;
  value: number;
  isDepositHint: boolean;
  hasYen: boolean;
};

export function cleanAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (!cleaned) {
    return null;
  }
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function toIsoDate(fragment: string): string | null {
  if (!/^\d{2}\.\d{2}\.\d{2}$/.test(fragment)) {
    return null;
  }
  const [yy, mm, dd] = fragment.split(".");
  const year = Number.parseInt(yy, 10);
  const month = Number.parseInt(mm, 10);
  const day = Number.parseInt(dd, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const fullYear = year >= 70 ? 1900 + year : 2000 + year;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return `${fullYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normaliseText(raw: string): string {
  let text = toHalfWidth(raw);
  text = text.replace(/\u3000/g, " ");
  text = text.replace(/\t+/g, " ");
  text = text.replace(/\r?\n/g, "\n");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      if (/^0+$/.test(line)) {
        return false;
      }
      if (/^\d{1,2}$/.test(line)) {
        return false;
      }
      if (DROP_PATTERNS.some((pattern) => pattern.test(line))) {
        return false;
      }
      return true;
    });
  text = lines.join("\n");
  text = text.replace(LEADING_INDEX_BEFORE_DATE, "");
  return text;
}

function splitRecords(text: string): Array<{ date: string; body: string; start: number }> {
  const matches: Array<{ index: number; value: string }> = [];
  let match: RegExpExecArray | null;
  DATE_PATTERN.lastIndex = 0;
  while ((match = DATE_PATTERN.exec(text))) {
    matches.push({ index: match.index, value: match[0] });
  }
  if (!matches.length) {
    return [];
  }
  const records: Array<{ date: string; body: string; start: number }> = [];
  for (let i = 0; i < matches.length; i += 1) {
    const dateToken = matches[i];
    const start = dateToken.index + dateToken.value.length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    records.push({ date: dateToken.value, body, start: dateToken.index });
  }
  return records;
}

function summariseBody(body: string): string {
  const withoutAmounts = body.replace(AMOUNT_TOKEN, " ");
  const cleaned = withoutAmounts.replace(/\s+/g, " ").replace(/[|,]+$/g, "").trim();
  return cleaned;
}

function extractAmountTokens(source: string): AmountToken[] {
  const tokens: AmountToken[] = [];
  let match: RegExpExecArray | null;
  AMOUNT_TOKEN.lastIndex = 0;
  while ((match = AMOUNT_TOKEN.exec(source))) {
    const value = cleanAmount(match[2]);
    if (value === null) {
      continue;
    }
    const marker = match[1] ?? "";
    const raw = match[0];
    tokens.push({
      raw,
      value,
      isDepositHint: marker.includes("*") || marker.includes("\uFF0A"),
      hasYen: /[\u00A5\uFFE5]/.test(raw),
    });
  }
  return tokens;
}

function parseEntry(date: string, body: string): ReceiptPassbookEntry {
  const tokens = extractAmountTokens(body);

  let balance: number | null = null;
  let withdrawal: number | null = null;
  let deposit: number | null = null;

  if (tokens.length) {
    const last = tokens[tokens.length - 1];
    balance = last.value;
    const preceding = tokens.slice(0, -1);
    if (preceding.length >= 2) {
      withdrawal = preceding[0].value;
      deposit = preceding[preceding.length - 1].value;
    } else if (preceding.length === 1) {
      if (preceding[0].isDepositHint) {
        deposit = preceding[0].value;
      } else {
        withdrawal = preceding[0].value;
      }
    } else if (!preceding.length && tokens.length === 1) {
      balance = tokens[0].value;
    }
    if (deposit === null) {
      const hinted = preceding.find((token) => token.isDepositHint);
      if (hinted) {
        deposit = hinted.value;
        if (withdrawal === deposit) {
          withdrawal = null;
        }
      }
    }
  }

  const summary = summariseBody(body);

  return {
    rawDate: date,
    date: toIsoDate(date),
    description: summary || null,
    withdrawal,
    deposit,
    balance,
  };
}
interface ParsedRecord {
  start: number;
  entry: ReceiptPassbookEntry;
}

function extractNonAmountSegments(blockText: string): string[] {
  AMOUNT_TOKEN.lastIndex = 0;
  const withoutAmounts = blockText.replace(AMOUNT_TOKEN, " ");
  return withoutAmounts
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && NON_AMOUNT_HINT_PATTERN.test(line));
}

function applyColumnBlocksToRecords(text: string, records: ParsedRecord[]): void {
  if (!records.length) {
    return;
  }
  const headerRegex = new RegExp(COLUMN_HEADER_PATTERN.source, COLUMN_HEADER_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(text))) {
    const headerStart = match.index;
    const headerEnd = headerStart + match[0].length;
    let blockEnd = text.length;
    for (const rec of records) {
      if (rec.start > headerEnd) {
        blockEnd = rec.start;
        break;
      }
    }
    const blockText = text.slice(headerEnd, blockEnd);
    const tokens = extractAmountTokens(blockText);
    if (!tokens.length) {
      continue;
    }
    const balances = tokens.filter((token) => token.hasYen).map((token) => token.value);
    const deposits = tokens.filter((token) => !token.hasYen && token.isDepositHint).map((token) => token.value);
    const withdrawals = tokens.filter((token) => !token.hasYen && !token.isDepositHint).map((token) => token.value);
    const expected = Math.max(balances.length, deposits.length, withdrawals.length);
    if (!expected) {
      continue;
    }
    const eligible = records.filter(
      (record) =>
        record.start < headerStart
        && (record.entry.balance == null || record.entry.withdrawal == null || record.entry.deposit == null),
    );
    if (!eligible.length) {
      continue;
    }
    const assignCount = Math.min(expected, eligible.length);
    const targets = eligible.slice(-assignCount);
    for (let i = 0; i < assignCount; i += 1) {
      const target = targets[i];
      if (balances[i] != null) {
        target.entry.balance = balances[i];
      }
      if (withdrawals[i] != null) {
        target.entry.withdrawal = withdrawals[i];
      }
      if (deposits[i] != null) {
        target.entry.deposit = deposits[i];
      }
      if (target.entry.withdrawal == null && target.entry.deposit == null) {
        if (deposits[i] != null) {
          target.entry.deposit = deposits[i];
        } else if (withdrawals[i] != null) {
          target.entry.withdrawal = withdrawals[i];
        }
      }
    }

    const nonAmountSegments = extractNonAmountSegments(blockText);
    if (nonAmountSegments.length) {
      const descriptionAssignCount = Math.min(nonAmountSegments.length, targets.length);
      for (let i = 0; i < descriptionAssignCount; i += 1) {
        const segment = nonAmountSegments[i];
        if (!segment) {
          continue;
        }
        const entry = targets[i].entry;
        if (entry.description && entry.description.length) {
          if (!entry.description.includes(segment)) {
            entry.description = `${entry.description} ${segment}`.replace(/\s+/g, " ").trim();
          }
        } else {
          entry.description = segment;
        }
      }

      const nextIndex = records.findIndex((record) => record.start >= blockEnd);
      if (nextIndex !== -1) {
        const nextEntry = records[nextIndex].entry;
        if (nextEntry.description && nextEntry.description.length) {
          let cleaned = nextEntry.description;
          for (const segment of nonAmountSegments) {
            if (!segment) {
              continue;
            }
            const pattern = segment
              .replace(/[\^$.*+?()[\]{}|]/g, "\$&")
              .replace(/\s+/g, "\s+");
            cleaned = cleaned.replace(new RegExp(pattern, "g"), " ");
          }
          nextEntry.description = cleaned.replace(/\s+/g, " ").trim();
        }
      }
    }
  }
}


function parsePassbookEntries(raw: string): ReceiptPassbookEntry[] {
  const normalised = normaliseText(raw);
  const rawRecords = splitRecords(normalised);
  if (!rawRecords.length) {
    return [];
  }
  const parsedRecords: ParsedRecord[] = rawRecords.map((record) => ({
    start: record.start,
    entry: parseEntry(record.date, record.body),
  }));
  applyColumnBlocksToRecords(normalised, parsedRecords);
  return parsedRecords.map((record) => record.entry);
}

export function normalisePassbookOcr(options: NormalisePassbookOptions): NormaliseOcrResult {
  const trimmed = options.rawText?.trim?.() ?? "";
  const base = defaultOcr();
  const passbookEntries = trimmed ? parsePassbookEntries(trimmed) : [];
  const ocr = {
    ...base,
    rawText: trimmed || null,
    source: "vision",
    passbookEntries,
  } as typeof base;

  return {
    ocr,
    vendorMatch: null,
  };
}

