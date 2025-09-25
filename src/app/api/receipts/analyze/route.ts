export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { jsonResponse } from "@/lib/http";

const MAX_RECEIPTS_PER_REQUEST = 5;
const REQUIRED_FLAG = "perm.upload";

interface AnalyzeRequestBody {
  receiptIds?: unknown;
}

function resolveBucket(): string | null {
  return (
    process.env.FIREBASE_STORAGE_BUCKET ??
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ??
    null
  );
}

function normaliseReceiptIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MAX_RECEIPTS_PER_REQUEST) {
      break;
    }
  }
  return result;
}

export async function POST(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }
  const token = authHeader.slice("Bearer ".length).trim();
  console.info("[Analyze] auth header head", authHeader.slice(0, 32));

  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(token);
  } catch (error) {
    console.warn("[analyze] invalid token", error);
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: AnalyzeRequestBody;
  try {
    payload = (await request.json()) as AnalyzeRequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }

  console.info("[Analyze API] request received", { uid: decoded.uid, receiptIds: payload.receiptIds });

  const receiptIds = normaliseReceiptIds(payload.receiptIds);
  if (!receiptIds.length) {
    return jsonResponse({ error: "No receipt IDs provided" }, { status: 400 });
  }

  const permissionsSnap = await adminDb.collection("userPermissions").doc(decoded.uid).get();
  const permissionsData = permissionsSnap.data() ?? {};
  const storeIds = Array.isArray(permissionsData.storeIds)
    ? (permissionsData.storeIds as string[])
    : [];
  const flags = Array.isArray(permissionsData.flags)
    ? (permissionsData.flags as string[])
    : [];

  if (!flags.includes(REQUIRED_FLAG)) {
    return jsonResponse({ error: "Missing upload permission" }, { status: 403 });
  }

  const bucket = resolveBucket();
  if (!bucket) {
    return jsonResponse({ error: "Storage bucket not configured" }, { status: 500 });
  }

  const ocrEndpoint = new URL("/api/ocr", request.url);
  const success: string[] = [];
  const failed: Array<{ receiptId: string; error: string }> = [];

  for (const receiptId of receiptIds) {
    try {
      const docSnap = await adminDb.collection("receipts").doc(receiptId).get();
      if (!docSnap.exists) {
        failed.push({ receiptId, error: "Receipt not found" });
        continue;
      }
      const data = docSnap.data() ?? {};
      const receiptStoreId = typeof data.storeId === "string" ? data.storeId : "";
      if (!receiptStoreId) {
        failed.push({ receiptId, error: "Receipt store not set" });
        continue;
      }
      if (!storeIds.includes(receiptStoreId)) {
        failed.push({ receiptId, error: "Access denied for store" });
        continue;
      }
      if (typeof data.status === "string" && data.status !== "draft") {
        failed.push({ receiptId, error: "Receipt not in draft status" });
        continue;
      }
      const filePath = typeof data.filePath === "string" ? data.filePath : "";
      if (!filePath) {
        failed.push({ receiptId, error: "Receipt file path missing" });
        continue;
      }
      const normalisedPath = filePath.replace(/^\/+/, "");
      const gsUri = filePath.startsWith("gs://") ? filePath : `gs://${bucket}/${normalisedPath}`;

      console.info("[Analyze API] invoking OCR", { receiptId, gsUri });
      const response = await fetch(ocrEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({ receiptId, gsUri }),
      });

      if (!response.ok) {
        const message = await response.text();
        failed.push({ receiptId, error: message || `OCR request failed (${response.status})` });
        continue;
      }

      success.push(receiptId);
    } catch (error) {
      failed.push({ receiptId, error: (error as Error).message });
    }
  }

  return jsonResponse({ success, failed, total: receiptIds.length });
}

