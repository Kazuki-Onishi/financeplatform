export const runtime = "nodejs";

import { NextRequest } from "next/server";
import type { DocumentReference } from "firebase-admin/firestore";
import { FieldValue, Timestamp as AdminTimestamp } from "firebase-admin/firestore";
import type { ReceiptDoc } from "../../../types/receipt";
import type { VendorRecord } from "../../../types/vendor";
import { adminAuth, adminDb, adminStorage } from "../../../lib/firebase/admin";
import { normaliseOcrText } from "../../../lib/ocr";
import { jsonResponse } from "../../../lib/http";
import { GoogleAuth, type GoogleAuthOptions } from "google-auth-library";

type VisionFeatureMode = "document" | "text" | "label";
console.info("[OCR ROUTE] version=2025-09-24T02:xx test");

type VisionResponse = {
  responses?: Array<{
    fullTextAnnotation?: { text?: string };
    textAnnotations?: Array<{ description?: string }>;
    labelAnnotations?: Array<{ description?: string; score?: number }>;
    error?: { message?: string };
  }>;
};

type OcrRequestBody = {
  receiptId?: unknown;
  gsUri?: unknown;
  mode?: unknown;
};

type GoogleAuthClientWithEmail = {
  email?: string;
  jsonContent?: { client_email?: string } | null;
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MODE: VisionFeatureMode = "document";
const VISION_ENDPOINT =
  process.env.VISION_ENDPOINT ?? "https://vision.googleapis.com/v1/images:annotate";

const VISION_FEATURE_TYPE: Record<VisionFeatureMode, string> = {
  document: "DOCUMENT_TEXT_DETECTION",
  text: "TEXT_DETECTION",
  label: "LABEL_DETECTION",
};

interface RateLimitEntry {
  tokens: number;
  resetAt: number;
}

const rateLimiter = new Map<string, RateLimitEntry>();

function consumeRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimiter.set(key, {
      tokens: RATE_LIMIT_MAX_REQUESTS - 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }
  if (entry.tokens <= 0) return true;
  entry.tokens -= 1;
  return false;
}

function resolveMode(input: unknown): VisionFeatureMode {
  if (input === "text" || input === "label") return input;
  return DEFAULT_MODE;
}

function parseGsUri(uri: string): { bucket: string; object: string } | null {
  if (!uri.startsWith("gs://")) return null;
  const rest = uri.slice(5);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const bucket = rest.slice(0, slash);
  const object = rest.slice(slash + 1);
  if (!bucket || !object) return null;
  return { bucket, object };
}

let vendorsCache: { data: VendorRecord[]; expiresAt: number } | null = null;
const VENDORS_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadVendors(): Promise<VendorRecord[]> {
  const now = Date.now();
  if (vendorsCache && vendorsCache.expiresAt > now) return vendorsCache.data;
  const snapshot = await adminDb.collection("vendors").get();
  const vendors = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) as VendorRecord[];
  vendorsCache = { data: vendors, expiresAt: now + VENDORS_CACHE_TTL_MS };
  return vendors;
}


type ServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
  [key: string]: unknown;
};

function getServiceAccountFromEnv(): ServiceAccountCredentials {
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!json || !json.trim()) {
    throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env");
  }
  const parsed = JSON.parse(json) as ServiceAccountCredentials & { private_key?: string };
  if (typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  return parsed;
}

async function getAccessToken(): Promise<string> {
  try {
    const credentials = getServiceAccountFromEnv();
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      credentials: credentials as GoogleAuthOptions['credentials'],
    });
    const accessToken = await auth.getAccessToken();
    if (!accessToken) {
      throw new Error('Failed to obtain access token for Vision API');
    }
    return accessToken;
  } catch (error) {
    throw new Error('Access token fetch failed: ' + (error as Error).message);
  }
}

let serviceAccountLogged = false;
async function logServiceAccountOnce(): Promise<void> {
  if (serviceAccountLogged) return;
  try {
    const credentials = getServiceAccountFromEnv();
    console.info("[OCR] Using service account:", credentials.client_email ?? "unknown");
  } catch (error) {
    console.warn("[OCR] logServiceAccountOnce failed; continuing", (error as Error).message);
  } finally {
    serviceAccountLogged = true;
  }
}

function extractVisionText(
  response: NonNullable<VisionResponse["responses"]>[number],
  mode: VisionFeatureMode,
): string {
  if (mode === "label") {
    const labels = response.labelAnnotations?.map((l) => l.description?.trim()).filter(Boolean) ?? [];
    return labels.join("\n");
  }
  if (mode === "text") {
    const text = response.textAnnotations?.[0]?.description?.trim();
    if (text) return text;
  }
  const documentText = response.fullTextAnnotation?.text?.trim();
  return documentText || "";
}

/** Vision 蜻ｼ縺ｳ蜃ｺ縺暦ｼ亥ｼｷ蛻ｶ繝ｭ繧ｰ + Content-Type 繝√ぉ繝・け + 髱曷SON髦ｲ蠕｡・・*/
async function fetchVisionAnnotation(
  imageBase64: string,
  locale: string,
  mode: VisionFeatureMode,
): Promise<{ text: string; response: VisionResponse }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const endpoint = VISION_ENDPOINT;

  try {
    const accessToken = await getAccessToken();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: VISION_FEATURE_TYPE[mode] }],
            imageContext: mode === "label" ? undefined : locale ? { languageHints: [locale] } : undefined,
          },
        ],
      }),
      signal: controller.signal,
    });

    const ct = res.headers.get("content-type") || "";
    const rawPayload = await res.text();
    console.error("[Vision raw]", rawPayload.slice(0, 400)); // 先頭だけでも

    // stderr 縺ｫ蠢・★蜷舌￥
    process.stderr.write(
      `\n=== Vision DEBUG ===\n` +
        `endpoint: ${endpoint}\n` +
        `status: ${res.status}\n` +
        `content-type: ${ct}\n` +
        `body(head 400): ${rawPayload.slice(0, 400)}\n` +
        `=== /Vision DEBUG ===\n`,
    );

    if (!res.ok) throw new Error(`Vision API request failed (${res.status}): ${rawPayload.slice(0, 200)}`);
    if (!ct.toLowerCase().includes("application/json")) {
      throw new Error(`Vision API returned non-JSON content-type: ${ct} body(head): ${rawPayload.slice(0, 200)}`);
    }

    let payload: VisionResponse;
    try {
      payload = JSON.parse(rawPayload) as VisionResponse;
    } catch {
      throw new Error(`Vision API returned unparsable JSON: ${rawPayload.slice(0, 400)}`);
    }

    const first = payload.responses?.[0];
    if (!first) throw new Error("Vision API returned no responses");
    if (first.error?.message) throw new Error(first.error.message);

    return { text: extractVisionText(first, mode), response: payload };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("Vision API request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadGsFile(
  gsUri: string,
): Promise<{ bucketName: string; objectPath: string; buffer: Buffer }> {
  const parsed = parseGsUri(gsUri);
  if (!parsed) throw new Error("Invalid gsUri");
  const bucket = adminStorage.bucket(parsed.bucket);
  const file = bucket.file(parsed.object);
  const [buffer] = await file.download();
  return { bucketName: parsed.bucket, objectPath: parsed.object, buffer };
}

function buildBaseResponse({
  rawText,
  ocr,
  vendorMatch,
  vision,
  updatedAt,
}: {
  rawText: string;
  ocr: ReceiptDoc["ocr"];
  vendorMatch: ReturnType<typeof normaliseOcrText>["vendorMatch"];
  vision: VisionResponse | null;
  updatedAt: string | null;
}) {
  return {
    text: rawText,
    raw: { ocr, vendorMatch, vision },
    ocr,
    vendorMatch,
    confidence: ocr.confidence,
    updatedAt,
  };
}

/** 霑ｽ蜉・哽WT縺｣縺ｽ縺輔・繝輔か繝ｼ繝槭ャ繝域､懈渊・亥｣翫ｌ繝医・繧ｯ繝ｳ譌ｩ譛滓､懷・・・*/
function isJwtLike(token: string): boolean {
  return /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(token);
}

function b64urlToUtf8(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 ? 4 - (normalized.length % 4) : 0;
  return Buffer.from(normalized + "=".repeat(pad), "base64").toString("utf8");
}

function decodeJwtParts(token: string):
  | { ok: true; header: string; payload: string }
  | { ok: false; reason: "not-three-segments" | "decode-or-json-fail"; sampleHeader?: string; samplePayload?: string; msg?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "not-three-segments" };
  }
  try {
    const header = b64urlToUtf8(parts[0]);
    const payload = b64urlToUtf8(parts[1]);
    JSON.parse(header);
    JSON.parse(payload);
    return { ok: true, header, payload };
  } catch (error) {
    return {
      ok: false,
      reason: "decode-or-json-fail",
      sampleHeader: parts[0].slice(0, 12),
      samplePayload: parts[1].slice(0, 12),
      msg: (error as Error).message,
    };
  }
}

type ParsedJwtPayload = {
  iss?: string;
  aud?: string;
  sub?: string;
  user_id?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
};

function parseJwtPayload(token: string):
  | { ok: true; payload: ParsedJwtPayload }
  | { ok: false; reason: string; detail?: Record<string, unknown> } {
  const decoded = decodeJwtParts(token);
  if (!decoded.ok) {
    return {
      ok: false,
      reason: decoded.reason,
      detail: { sampleHeader: decoded.sampleHeader, samplePayload: decoded.samplePayload, msg: decoded.msg },
    };
  }
  try {
    const payload = JSON.parse(decoded.payload) as ParsedJwtPayload;
    return { ok: true, payload };
  } catch (error) {
    return {
      ok: false,
      reason: 'payload-json-fail',
      detail: { msg: (error as Error).message },
    };
  }
}

async function wrapVerify(token: string) {
  try {
    return await adminAuth.verifyIdToken(token);
  } catch (error) {
    throw new Error('verifyIdToken failed: ' + (error as Error).message);
  }
}

async function safeVerifyIdToken(
  token: string,
  timeoutMs = 5000,
): Promise<Awaited<ReturnType<typeof adminAuth.verifyIdToken>>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      wrapVerify(token),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('verifyIdToken timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}


export async function POST(request: NextRequest): Promise<Response> {
  let _step = "start";
  try {
    _step = "auth.header";
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized", step: _step }, { status: 401 });
    }
    const token = authHeader.slice("Bearer ".length).trim();
    if (!isJwtLike(token)) {
      return jsonResponse(
        { error: "Invalid ID token format", step: _step, sample: token.slice(0, 60) },
        { status: 401 },
      );
    }

    const payloadCheck = parseJwtPayload(token);
    if (!payloadCheck.ok) {
      return jsonResponse(
        {
          error: "ID token decode failed",
          step: "auth.decode",
          reason: payloadCheck.reason,
          detail: payloadCheck.detail,
          sample: token.slice(0, 60),
        },
        { status: 401 },
      );
    }

    const payload = payloadCheck.payload;
    console.info("[OCR] token payload", payload);
    const projectId =
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.FIREBASE_PROJECT_ID ?? null;
    const expectedIss = projectId ? `https://securetoken.google.com/${projectId}` : null;
    if (expectedIss && payload.iss !== expectedIss) {
      return jsonResponse(
        { error: "Issuer mismatch", step: "auth.decode", iss: payload.iss, expectedIss },
        { status: 401 },
      );
    }
    if (projectId && payload.aud !== projectId) {
      return jsonResponse(
        { error: "Audience mismatch", step: "auth.decode", aud: payload.aud, expectedAud: projectId },
        { status: 401 },
      );
    }
    const subject = payload.sub ?? payload.user_id ?? null;
    if (!subject) {
      return jsonResponse({ error: "Missing subject in token", step: "auth.decode" }, { status: 401 });
    }

    _step = "auth.verify";
    let decoded: Awaited<ReturnType<typeof adminAuth.verifyIdToken>>;
    try {
      decoded = await safeVerifyIdToken(token, 5000);
    } catch (error) {
      console.warn("Invalid ID token", error);
      return jsonResponse(
        { error: "Unauthorized", step: _step, reason: String((error as Error).message ?? error) },
        { status: 401 },
      );
    }

    _step = "auth.post-verify";
    try {
      await logServiceAccountOnce();
    } catch (error) {
      console.warn('[OCR] logServiceAccountOnce surfaced error', error);
    }

    _step = "ratelimit";
    if (consumeRateLimit(decoded.uid)) {
      return jsonResponse({ error: "Too many requests", step: _step }, { status: 429 });
    }

    let body: OcrRequestBody;
    _step = "body.parse";
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body", step: _step }, { status: 400 });
    }

    _step = "input.validate";
    const receiptId = typeof body.receiptId === "string" ? body.receiptId.trim() : "";
    const gsUri = typeof body.gsUri === "string" ? body.gsUri.trim() : "";
    const mode = resolveMode(body.mode);

    if (!gsUri) return jsonResponse({ error: "gsUri is required", step: _step }, { status: 400 });

    const parsedUri = parseGsUri(gsUri);
    if (!parsedUri) return jsonResponse({ error: "Invalid gsUri", step: _step }, { status: 400 });

    const allowedBucket =
      process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? null;
    if (allowedBucket && parsedUri.bucket !== allowedBucket) {
      return jsonResponse({ error: "Bucket is not allowed", step: _step }, { status: 400 });
    }

    const permissionsSnap = await adminDb.collection("userPermissions").doc(decoded.uid).get();
    const permissionsData = permissionsSnap.data() ?? { storeIds: [], flags: [] };
    const storeIds = Array.isArray(permissionsData.storeIds) ? (permissionsData.storeIds as string[]) : [];
    const flags = Array.isArray(permissionsData.flags) ? (permissionsData.flags as string[]) : [];

    if (!flags.includes("perm.upload")) {
      return jsonResponse({ error: "Missing upload permission", step: _step }, { status: 403 });
    }

    let receiptRef: DocumentReference<ReceiptDoc> | null = null;
    let receipt: ReceiptDoc | null = null;
    _step = "receipt.lookup";

    if (receiptId) {
      receiptRef = adminDb.collection("receipts").doc(receiptId) as DocumentReference<ReceiptDoc>;
      const receiptSnap = await receiptRef.get();
      if (!receiptSnap.exists) {
        return jsonResponse({ error: "Receipt not found", step: _step }, { status: 404 });
      }
      receipt = receiptSnap.data() as ReceiptDoc;
      const storeId = receipt.storeId;
      if (!storeId) {
        return jsonResponse({ error: "Receipt store not set", step: _step }, { status: 500 });
      }
      if (!storeIds.includes(storeId)) {
        return jsonResponse({ error: "Access denied for store", step: _step }, { status: 403 });
      }
      if (receipt.status !== "draft") {
        return jsonResponse({ error: "Only draft receipts can be processed", step: _step }, { status: 409 });
      }

      const filePath = typeof receipt.filePath === "string" ? receipt.filePath : "";
      if (!filePath) {
        return jsonResponse({ error: "Receipt file path missing", step: _step }, { status: 500 });
      }

      const expectedObjectPath = filePath.startsWith("gs://")
        ? (() => {
            const slash = filePath.indexOf("/", 5);
            return slash === -1 ? "" : filePath.slice(slash + 1);
          })()
        : filePath;

      if (parsedUri.object !== expectedObjectPath) {
        return jsonResponse({ error: "gsUri does not match receipt file", step: _step }, { status: 400 });
      }
    }

    _step = "gcs.download";
    const { buffer } = await downloadGsFile(gsUri);

    _step = "image.base64";
    const imageBase64 = buffer.toString("base64");

    _step = "vision.call";
    let rawText = "";
    let vision: VisionResponse | null = null;
    try {
      const result = await fetchVisionAnnotation(imageBase64, "ja", mode);
      rawText = (result.text ?? "").trim();
      vision = result.response;
    } catch (error) {
      console.error("Vision OCR failed", error);
      return jsonResponse({ error: String((error as Error).message ?? error), step: _step }, { status: 502 });
    }

    _step = "ocr.normalise";
    const vendors = await loadVendors();
    let ocr: ReceiptDoc["ocr"];
    let vendorMatch: ReturnType<typeof normaliseOcrText>["vendorMatch"];
    try {
      ({ ocr, vendorMatch } = normaliseOcrText({ rawText, vendors }));
    } catch (error) {
      return jsonResponse(
        {
          error: "normaliseOcrText failed: " + String((error as Error).message ?? error),
          step: _step,
          head: rawText.slice(0, 120),
        },
        { status: 500 },
      );
    }

    _step = "db.update_or_respond";
    if (receiptRef && receipt) {
      const writeResult = await receiptRef.update({ ocr, updatedAt: FieldValue.serverTimestamp() });
      const updatedAtTimestamp: AdminTimestamp = writeResult.writeTime;
      return jsonResponse(
        buildBaseResponse({
          rawText,
          ocr,
          vendorMatch,
          vision,
          updatedAt: updatedAtTimestamp.toDate().toISOString(),
        }),
      );
    }

    return jsonResponse(
      buildBaseResponse({
        rawText,
        ocr,
        vendorMatch,
        vision,
        updatedAt: null,
      }),
    );
  } catch (error) {
    console.error("Unexpected OCR error", error, "at step:", _step);
    const dev = process.env.NODE_ENV !== "production";
    const payload = dev
      ? { error: String((error as Error).message ?? error), step: _step }
      : { error: "Internal Server Error" };
    return jsonResponse(payload, { status: 500 });
  }
}




