import { auth } from "@/lib/firebase/client";

export type OcrMode = "document" | "text" | "label";

interface OcrResponseBody {
  text: string;
  raw: unknown;
  ocr?: unknown;
  vendorMatch?: unknown;
  confidence?: number;
  updatedAt?: string | null;
}

interface SummarizeResponseBody {
  summary: {
    date: string | null;
    vendor: string | null;
    amount: number | null;
    tax: number | null;
    currency: string | null;
    memo: string | null;
  };
  language?: string;
  keywords?: string[];
  usage?: Record<string, unknown> | null;
  modelVersion?: string | null;
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const message = await response.text();
  throw new Error(message || `Request failed (${response.status})`);
}

export async function callOCR(
  gcsUri: string,
  mode: OcrMode = "document",
  receiptId?: string,
): Promise<OcrResponseBody> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("signin required");
  }
  const idToken = await user.getIdToken();
  const response = await fetch("/api/ocr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ gsUri: gcsUri, mode, receiptId }),
  });
  await assertOk(response);
  return (await response.json()) as OcrResponseBody;
}

export async function callSummarize(text: string): Promise<SummarizeResponseBody> {
  const response = await fetch("/api/ai/summarize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  await assertOk(response);
  return (await response.json()) as SummarizeResponseBody;
}

export interface BulkAnalysisResult {
  success: string[];
  failed: Array<{ receiptId: string; error: string }>;
}

export async function runBulkAnalysis(receiptIds: string[]): Promise<BulkAnalysisResult> {
  if (!Array.isArray(receiptIds) || !receiptIds.length) {
    throw new Error("No receipts selected");
  }
  const user = auth.currentUser;
  if (!user) {
    throw new Error("signin required");
  }
  const idToken = await user.getIdToken();
  const response = await fetch("/api/receipts/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({ receiptIds })
  });
  await assertOk(response);
  return (await response.json()) as BulkAnalysisResult;
}
