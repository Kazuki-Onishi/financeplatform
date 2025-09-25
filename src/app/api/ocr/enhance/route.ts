export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../../../lib/firebase/admin";
import type { ReceiptDoc } from "../../../../types/receipt";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const CONFIDENCE_THRESHOLD = Number.parseFloat(process.env.GEMINI_CONFIDENCE_THRESHOLD ?? "0.7");

interface RateLimitEntry {
  tokens: number;
  resetAt: number;
}

interface EnhanceRequestBody {
  receiptId?: unknown;
}

interface GeminiStructuredResult {
  date?: string | null;
  vendorName?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  tax?: number | string | null;
  memo?: string | null;
  confidence?: number | string | null;
}

interface GeminiCallResult {
  fields: {
    date: string | null;
    vendorName: string | null;
    amount: number | null;
    currency: string | null;
    tax: number | null;
    memo: string | null;
    confidence: number | null;
  };
}

const rateLimiter = new Map<string, RateLimitEntry>();

function isGeminiEnabled(): boolean {
  const value =
    process.env.APPFLAG_GEMINI_NORMALIZE ?? process.env.NEXT_PUBLIC_APPFLAG_GEMINI_NORMALIZE ?? "off";
  return ["on", "true", "1"].includes(value.toLowerCase());
}

function consumeRateLimit(key: string): boolean {
  if (!key) {
    return false;
  }
  const now = Date.now();
  const entry = rateLimiter.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimiter.set(key, {
      tokens: RATE_LIMIT_MAX_REQUESTS - 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }
  if (entry.tokens <= 0) {
    return true;
  }
  entry.tokens -= 1;
  return false;
}

function clampConfidence(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.min(0.99, Math.max(0, value));
}

function normaliseNumber(input: number | string | null | undefined): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normaliseText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildPrompt(rawText: string, existing: ReceiptDoc["ocr"]): string {
  const snapshot = {
    date: existing.date ?? null,
    vendorName: existing.vendorName ?? null,
    amount: existing.amount ?? null,
    currency: existing.currency ?? "JPY",
    tax: existing.tax ?? null,
    memo: existing.memo ?? null,
  };

  return [
    "You are a finance assistant helping normalise Japanese receipt OCR results.",
    "Return STRICT JSON only (no prose, no markdown).",
    "Required JSON schema: {",
    '  "date": string | null (ISO YYYY-MM-DD),',
    '  "vendorName": string | null,',
    '  "amount": number | null,',
    `  "currency": "JPY",`,
    '  "tax": number | null,',
    '  "memo": string | null,',
    `  "confidence": number | null (0-1, higher is better)`,
    "}",
    "If unsure about a field, return null.",
    "Do NOT invent vendor IDs or other keys.",
    "Prefer concise memos (<= 120 chars).",
    "Existing parsed fields:",
    JSON.stringify(snapshot, null, 2),
    "Raw OCR text:",
    rawText,
  ].join("\n\n");

}

async function callGemini(prompt: string): Promise<GeminiCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const endpoint =
    process.env.GEMINI_API_ENDPOINT ??
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${endpoint}?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : undefined;
    let jsonText: string | null = null;
    if (candidate && typeof candidate === "object") {
      const content = (candidate as { content?: { parts?: Array<{ text?: string }> } }).content;
      if (content?.parts && Array.isArray(content.parts) && content.parts.length) {
        const firstPart = content.parts[0];
        if (firstPart && typeof firstPart.text === "string" && firstPart.text.trim()) {
          jsonText = firstPart.text;
        }
      }
    }

    if (typeof jsonText !== "string" || !jsonText.trim()) {
      throw new Error("Gemini response missing text content");
    }

    let parsed: GeminiStructuredResult;
    try {
      parsed = JSON.parse(jsonText) as GeminiStructuredResult;
    } catch (parseError) {
      console.error("Failed to parse Gemini JSON", { jsonText, error: parseError });
      throw new Error("Gemini response was not valid JSON");
    }

    const fields: GeminiCallResult["fields"] = {
      date: normaliseText(parsed.date ?? null),
      vendorName: normaliseText(parsed.vendorName ?? null),
      amount: normaliseNumber(parsed.amount ?? null),
      currency: normaliseText(parsed.currency ?? null) ?? "JPY",
      tax: normaliseNumber(parsed.tax ?? null),
      memo: normaliseText(parsed.memo ?? null),
      confidence: clampConfidence(normaliseNumber(parsed.confidence ?? null)),
    };

    if (fields.currency !== "JPY") {
      fields.currency = "JPY";
    }

    return { fields };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error("Gemini request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractIp(request: NextRequest): string | null {
  const header = request.headers.get("x-forwarded-for");
  if (header) {
    return header.split(",")[0]?.trim() ?? null;
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (!isGeminiEnabled()) {
      return NextResponse.json({ error: "AI enhancement disabled" }, { status: 403 });
    }

    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice("Bearer ".length).trim();

    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch (error) {
      console.warn("Invalid ID token", error);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ipKey = extractIp(request);
    if (consumeRateLimit(`ip:${ipKey ?? "unknown"}`)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }
    if (consumeRateLimit(`uid:${decoded.uid}`)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    let body: EnhanceRequestBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const receiptId = typeof body.receiptId === "string" ? body.receiptId.trim() : "";
    if (!receiptId) {
      return NextResponse.json({ error: "receiptId is required" }, { status: 400 });
    }

    const receiptRef = adminDb.collection("receipts").doc(receiptId);
    const receiptSnap = await receiptRef.get();
    if (!receiptSnap.exists) {
      return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
    }

    const receipt = receiptSnap.data() as ReceiptDoc;
    const receiptOcr = (receipt.ocr ?? {}) as ReceiptDoc["ocr"];
    const storeId = receipt.storeId;
    if (typeof storeId !== "string" || !storeId) {
      return NextResponse.json({ error: "Receipt store missing" }, { status: 500 });
    }

    const permissionsSnap = await adminDb.collection("userPermissions").doc(decoded.uid).get();
    const permissionsData = permissionsSnap.data() ?? { storeIds: [], flags: [] };
    const storeIds = Array.isArray(permissionsData.storeIds)
      ? (permissionsData.storeIds as string[])
      : [];
    const flags = Array.isArray(permissionsData.flags) ? (permissionsData.flags as string[]) : [];

    if (!storeIds.includes(storeId)) {
      return NextResponse.json({ error: "Access denied for store" }, { status: 403 });
    }

    const hasEditPermission = flags.includes("perm.editFields");
    if (!hasEditPermission) {
      return NextResponse.json({ error: "Missing edit permission" }, { status: 403 });
    }

    if (receipt.status === "locked") {
      return NextResponse.json({ error: "Receipt is locked" }, { status: 409 });
    }

    const existingOcr = receiptOcr;
    const currentConfidence = typeof existingOcr.confidence === "number" ? existingOcr.confidence : 0;

    if (currentConfidence >= CONFIDENCE_THRESHOLD) {
      return NextResponse.json(
        {
          status: "skipped",
          reason: "confidence-high",
          confidence: currentConfidence,
          ocr: existingOcr,
        },
        { status: 200 },
      );
    }

    const rawText = typeof existingOcr.rawText === "string" ? existingOcr.rawText.trim() : "";
    if (!rawText) {
      return NextResponse.json(
        {
          status: "skipped",
          reason: "raw-text-missing",
        },
        { status: 409 },
      );
    }

    let gemini;
    try {
      gemini = await callGemini(buildPrompt(rawText, receiptOcr));
    } catch (error) {
      console.error("Gemini enhancement failed", error);
      const message = (error as Error).message ?? "Gemini enhancement failed";
      return NextResponse.json({ error: message }, { status: message.includes("timed out") ? 504 : 502 });
    }

    const geminiFields = gemini.fields;
    const confidenceGemini = clampConfidence(geminiFields.confidence);
    const finalConfidence = clampConfidence(
      Math.max(currentConfidence, confidenceGemini ?? 0),
    ) ?? currentConfidence;

    const nextOcr: ReceiptDoc["ocr"] = {
      ...existingOcr,
      vendorId: existingOcr.vendorId ?? null,
      vendor: existingOcr.vendor ?? null,
      date: geminiFields.date ?? existingOcr.date ?? null,
      vendorName: geminiFields.vendorName ?? existingOcr.vendorName ?? null,
      rawText,
      amount: geminiFields.amount ?? existingOcr.amount ?? null,
      currency: "JPY",
      tax: geminiFields.tax ?? existingOcr.tax ?? null,
      memo: geminiFields.memo ?? existingOcr.memo ?? null,
      source: "gemini",
      confidenceGemini,
      confidenceFinal: finalConfidence,
      confidence: finalConfidence,
    };

    const updateData = {
      ocr: nextOcr,
      updatedAt: FieldValue.serverTimestamp(),
      "meta.manualEdits": true,
    };

    try {
      const writeResult = await receiptRef.update(updateData, {
        lastUpdateTime: receiptSnap.updateTime,
      });

      const updatedAtIso = writeResult.writeTime.toDate().toISOString();
      return NextResponse.json(
        {
          status: "enhanced",
          ocr: nextOcr,
          confidence: nextOcr.confidence,
          updatedAt: updatedAtIso,
        },
        { status: 200 },
      );
    } catch (error) {
      console.error("Failed to persist Gemini enhancement", error);
      return NextResponse.json({ error: "Failed to update receipt" }, { status: 409 });
    }
  } catch (error) {
    console.error("Unexpected Gemini enhance error", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
