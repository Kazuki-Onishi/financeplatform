import type { NormaliseOcrResult } from "./ocr";
import { defaultOcr } from "./ocr";

export interface NormalisePassbookOptions {
  rawText: string;
}

export function normalisePassbookOcr(options: NormalisePassbookOptions): NormaliseOcrResult {
  const trimmed = options.rawText?.trim?.() ?? "";
  const base = defaultOcr();
  const ocr = {
    ...base,
    rawText: trimmed || null,
    source: "vision",
    passbookEntries: null,
  } as typeof base;

  return {
    ocr,
    vendorMatch: null,
  };
}
