export const runtime = "nodejs";

import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import {
  FieldPath,
  Timestamp as AdminTimestamp,
} from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../../../lib/firebase/admin";
import { csvLine } from "../../../../lib/csv";
import type { ReceiptDoc, ReceiptOcrData } from "../../../../types/receipt";

const RECEIPT_STATUS = new Set(["draft", "pending", "confirmed", "reviewed", "locked"]);
const PAGE_SIZE = 500;

interface ExportRequestBody {
  storeId?: unknown;
  status?: unknown;
  startDate?: unknown;
  endDate?: unknown;
}

class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

function isReceiptsEnabled(): boolean {
  const flag =
    process.env.APPFLAG_RECEIPTS ?? process.env.NEXT_PUBLIC_APPFLAG_RECEIPTS ?? "off";
  return ["on", "true", "1"].includes(flag.toLowerCase());
}

function parseDate(value: unknown, suffix: string): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const iso = `${value}T${suffix}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatNumber(value: unknown): string {
  if (typeof value !== "number") {
    return "";
  }
  if (!Number.isFinite(value)) {
    return "";
  }
  return String(value);
}

function formatJst(timestamp?: AdminTimestamp | null): string {
  if (!timestamp) {
    return "";
  }
  const date = timestamp.toDate();
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  // Convert to ISO string and replace the trailing Z with explicit +09:00.
  return jst.toISOString().replace(/Z$/, "+09:00");
}

async function resolveVendorName(
  vendorId: string | null | undefined,
  fallback: string | null | undefined,
  cache: Map<string, string>,
): Promise<string> {
  if (vendorId) {
    if (cache.has(vendorId)) {
      return cache.get(vendorId) ?? (fallback ?? "");
    }
    const doc = await adminDb.collection("vendors").doc(vendorId).get();
    const name = doc.exists ? (doc.data()?.displayName as string | undefined) ?? fallback ?? "" : fallback ?? "";
    cache.set(vendorId, name);
    return name;
  }
  return fallback ?? "";
}

async function resolveCardLast4(
  cardId: string | null | undefined,
  cache: Map<string, string>,
): Promise<string> {
  if (!cardId) {
    return "";
  }
  if (cache.has(cardId)) {
    return cache.get(cardId) ?? "";
  }
  const doc = await adminDb.collection("creditCards").doc(cardId).get();
  const last4 = doc.exists ? ((doc.data()?.last4 as string | undefined) ?? "") : "";
  cache.set(cardId, last4);
  return last4;
}

function paymentType(payment?: ReceiptDoc["paymentMethod"]): string {
  if (!payment) {
    return "other";
  }
  return payment.type;
}

function extractAmount(ocr: ReceiptOcrData | undefined, field: "amount" | "tax"): string {
  if (!ocr) {
    return "";
  }
  const value = ocr[field as keyof ReceiptOcrData];
  return typeof value === "number" ? formatNumber(value) : "";
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    if (!isReceiptsEnabled()) {
      throw new HttpError("Receipts feature disabled", 403);
    }

    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new HttpError("Unauthorized", 401);
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const decoded = await adminAuth.verifyIdToken(token).catch((error: unknown) => {
      console.warn("Invalid ID token for receipts export", error);
      throw new HttpError("Unauthorized", 401);
    });

    let body: ExportRequestBody;
    try {
      body = await request.json();
    } catch {
      throw new HttpError("Invalid JSON body", 400);
    }

    const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
    if (!storeId) {
      throw new HttpError("storeId is required", 400);
    }

    const status = typeof body.status === "string" && body.status ? body.status : "all";
    if (status !== "all" && !RECEIPT_STATUS.has(status)) {
      throw new HttpError("Invalid status", 400);
    }

    const startDate = parseDate(body.startDate, "00:00:00");
    const endDate = parseDate(body.endDate, "23:59:59");

    const permsSnap = await adminDb.collection("userPermissions").doc(decoded.uid).get();
    const permsData = permsSnap.data() ?? { storeIds: [], flags: [] };
    const storeIds = Array.isArray(permsData.storeIds) ? (permsData.storeIds as string[]) : [];
    const flags = Array.isArray(permsData.flags) ? (permsData.flags as string[]) : [];

    if (!storeIds.includes(storeId)) {
      throw new HttpError("Access denied for store", 403);
    }
    if (!flags.includes("perm.exportCsv")) {
      throw new HttpError("Missing export permission", 403);
    }

    let queryRef = adminDb.collection("receipts").where("storeId", "==", storeId);
    if (status !== "all") {
      queryRef = queryRef.where("status", "==", status);
    }
    if (startDate) {
      queryRef = queryRef.where("createdAt", ">=", AdminTimestamp.fromDate(startDate));
    }
    if (endDate) {
      queryRef = queryRef.where("createdAt", "<=", AdminTimestamp.fromDate(endDate));
    }

    queryRef = queryRef.orderBy("createdAt", "asc").orderBy(FieldPath.documentId(), "asc");

    const headers = [
      "date",
      "vendor",
      "amount",
      "currency",
      "tax",
      "purpose",
      "paymentType",
      "cardLast4",
      "storeId",
      "uploader",
      "status",
      "assetsCount",
      "createdAt",
      "updatedAt",
    ];

    const vendorCache = new Map<string, string>();
    const cardCache = new Map<string, string>();

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode("\ufeff" + csvLine(headers) + "\n"));

                    let lastDoc: QueryDocumentSnapshot | null = null;

          for (;;) {
            let pageQuery = queryRef.limit(PAGE_SIZE);
            if (lastDoc) {
              pageQuery = pageQuery.startAfter(lastDoc);
            }
            const snapshot = await pageQuery.get();
            if (snapshot.empty) {
              break;
            }

            for (const docSnap of snapshot.docs) {
              lastDoc = docSnap;
              const data = docSnap.data() as ReceiptDoc;
              const ocr = data.ocr as ReceiptOcrData | undefined;
              const vendorName = await resolveVendorName(
                ocr?.vendorId ?? null,
                ocr?.vendorName ?? null,
                vendorCache,
              );
              const cardLast4 = await resolveCardLast4(
                data.paymentMethod?.cardId ?? null,
                cardCache,
              );

              const row = csvLine([
                ocr?.date ?? "",
                vendorName,
                extractAmount(ocr, "amount"),
                ocr?.currency ?? "JPY",
                extractAmount(ocr, "tax"),
                data.purpose ?? "",
                paymentType(data.paymentMethod),
                cardLast4,
                data.storeId,
                data.uploaderName ?? data.uploaderId ?? "",
                data.status,
                typeof data.assetsCount === "number" ? String(data.assetsCount) : "0",
                formatJst(data.createdAt ?? null),
                formatJst(data.updatedAt ?? null),
              ]);

              controller.enqueue(encoder.encode(row + "\n"));
            }

            if (snapshot.size < PAGE_SIZE) {
              break;
            }
          }

          controller.close();
        } catch (error) {
          console.error("CSV export stream error", error);
          controller.error(error);
        }
      },
    });

    const filenameStore = storeId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const today = new Date().toISOString().slice(0, 10);
    const responseHeaders = new Headers({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="receipts-${filenameStore}-${today}.csv"`,
      "Cache-Control": "no-store",
    });

    return new Response(stream, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof HttpError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Unexpected receipts export error", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
