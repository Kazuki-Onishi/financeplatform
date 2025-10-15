export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { jsonResponse } from "../../../../lib/http";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 4_000;

interface SummarizeRequestBody {
  text?: unknown;
  language?: unknown;
}

interface SummaryFields {
  date: string | null;
  vendor: string | null;
  amount: number | null;
  tax: number | null;
  currency: string | null;
  memo: string | null;
}

interface GeminiSummaryResult {
  summary: SummaryFields;
  language: string;
  keywords: string[];
  usage: {
    promptTokens: number | null;
    candidatesTokens: number | null;
    totalTokens: number | null;
  };
  modelVersion: string | null;
}

interface GeminiResponseUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  modelVersion?: string;
  usageMetadata?: GeminiResponseUsage;
}

interface GeminiSummarySchema {
  summary?: unknown;
  language?: unknown;
  keywords?: unknown;
}

interface GeminiSummarySchemaSummary {
  date?: unknown;
  vendor?: unknown;
  amount?: unknown;
  tax?: unknown;
  currency?: unknown;
  memo?: unknown;
}

function normaliseLanguage(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : fallback;
}

function normaliseText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normaliseCurrency(value: unknown, fallback: string | null): string | null {
  const text = normaliseText(value);
  if (!text) {
    return fallback;
  }
  return text.toUpperCase();
}

function normaliseNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const SUMMARY_PROMPT = `You are a finance assistant helping summarise Japanese receipts.
Return STRICT JSON only with the shape:
{
  "summary": {
    "date": string | null,
    "vendor": string | null,
    "amount": number | null,
    "tax": number | null,
    "currency": string | null,
    "memo": string | null
  },
  "language": string,
  "keywords": string[]
}
Rules:
- Preserve Japanese text without transliteration.
- Use ISO format YYYY-MM-DD for date when possible.
- Amounts and tax must be numbers (no currency symbols).
- If unsure, use null.
- Do not add extra fields.
`;

function toSummarizePrompt(text: string, language: string): string {
  const requested = language === "ja" ? "日本語" : language;
  return [SUMMARY_PROMPT, `Requested language: ${requested}.`, "Input text:", text].join("\n");
}

function extractJsonCandidate(payload: GeminiResponse): string | null {
  const candidate = payload.candidates?.[0];
  const part = candidate?.content?.parts?.find((entry) => typeof entry?.text === "string" && entry.text.trim());
  return part?.text?.trim() ?? null;
}

function tryParseGeminiJson(raw: string): GeminiSummarySchema | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate) as GeminiSummarySchema;
  } catch (error) {
    console.warn('Gemini summarize JSON parse failed', { candidate, error });
    return null;
  }
}

function normaliseKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => Boolean(item));
}

function withApiKey(endpoint: string, apiKey: string): string {
  return endpoint.includes("?") ? `${endpoint}&key=${apiKey}` : `${endpoint}?key=${apiKey}`;
}

function resolveSummaryFields(input: unknown): SummaryFields {
  const fallbackCurrency = "JPY";
  const summary = (typeof input === "object" && input && !Array.isArray(input)
    ? (input as GeminiSummarySchemaSummary)
    : {}) as GeminiSummarySchemaSummary;

  return {
    date: normaliseText(summary.date),
    vendor: normaliseText(summary.vendor),
    amount: normaliseNumber(summary.amount),
    tax: normaliseNumber(summary.tax),
    currency: normaliseCurrency(summary.currency, fallbackCurrency),
    memo: normaliseText(summary.memo),
  };
}

async function callGeminiSummary(text: string, language: string): Promise<GeminiSummaryResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const model =
    process.env.GEMINI_SUMMARY_MODEL ??
    process.env.GEMINI_API_MODEL ??
    "gemini-2.0-flash";
  const endpointBase =
    process.env.GEMINI_API_SUMMARY_ENDPOINT ??
    process.env.GEMINI_API_ENDPOINT ??
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(withApiKey(endpointBase, apiKey), {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: toSummarizePrompt(text, language) }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 320,
          responseMimeType: "application/json",
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemini summarize request failed (${response.status})`);
    }

    const payload = (await response.json()) as GeminiResponse;
    const jsonText = extractJsonCandidate(payload);
    if (!jsonText) {
      throw new Error("Gemini summarize response missing content");
    }

    const parsed = tryParseGeminiJson(jsonText);
    if (!parsed) {
      console.warn('Gemini summarize response was not valid JSON', { jsonText });
    }

    const summary = resolveSummaryFields(parsed?.summary);
    const detectedLanguage = normaliseLanguage(parsed?.language, language);

    return {
      summary,
      language: detectedLanguage,
      keywords: normaliseKeywords(parsed?.keywords),
      usage: {
        promptTokens: payload.usageMetadata?.promptTokenCount ?? null,
        candidatesTokens: payload.usageMetadata?.candidatesTokenCount ?? null,
        totalTokens: payload.usageMetadata?.totalTokenCount ?? null,
      },
      modelVersion: payload.modelVersion ?? null,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Gemini summarize request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    let body: SummarizeRequestBody;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
    }

    const rawText = typeof body.text === "string" ? body.text : "";
    const text = rawText.trim();
    if (!text) {
      return jsonResponse({ error: "text is required" }, { status: 400 });
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return jsonResponse(
        {
          error: "text is too long",
          maxLength: MAX_TEXT_LENGTH,
        },
        { status: 422 },
      );
    }

    const language = normaliseLanguage(body.language, "ja");

    let result: GeminiSummaryResult;
    try {
      result = await callGeminiSummary(text, language);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gemini summarize failed";
      const status = message.includes("timed out") ? 504 : 502;
      return jsonResponse({ error: message }, { status });
    }

    return jsonResponse({
      summary: result.summary,
      language: result.language,
      keywords: result.keywords,
      usage: result.usage,
      modelVersion: result.modelVersion,
    });
  } catch (error) {
    console.error("Unexpected summarize error", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}
