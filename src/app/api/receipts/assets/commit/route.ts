export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue, Timestamp as FirestoreTimestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../../../../lib/firebase/admin";
import type { ReceiptDoc, ReceiptAssetDoc } from "../../../../../types/receipt";

interface CommitRequestBody {
  receiptId?: unknown;
  assetId?: unknown;
  filePath?: unknown;
  viewPath?: unknown;
  thumbPath?: unknown;
  meta?: unknown;
}

interface AssetMetaPayload {
  sha256: string;
  phash: string | null;
  width: number;
  height: number;
  exifShotAt: string | null;
  originalTranscoded?: boolean;
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

async function getUserPermissions(uid: string): Promise<{ storeIds: string[]; flags: string[] }> {
  const snap = await adminDb.collection("userPermissions").doc(uid).get();
  const data = snap.data() ?? { storeIds: [], flags: [] };
  const storeIds = Array.isArray(data.storeIds) ? (data.storeIds as string[]) : [];
  const flags = Array.isArray(data.flags) ? (data.flags as string[]) : [];
  return { storeIds, flags };
}

function validateString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(`${field} is required`, 400);
  }
  return value.trim();
}

function validateMeta(meta: unknown): AssetMetaPayload {
  if (!meta || typeof meta !== "object") {
    throw new HttpError("meta is required", 400);
  }
  const payload = meta as Record<string, unknown>;
  const sha256 = validateString(payload.sha256, "meta.sha256");
  if (sha256.length !== 64) {
    throw new HttpError("meta.sha256 must be 64 hex chars", 400);
  }
  const width = Number(payload.width);
  const height = Number(payload.height);
  if (!Number.isFinite(width) || width <= 0) {
    throw new HttpError("meta.width must be positive", 400);
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new HttpError("meta.height must be positive", 400);
  }
  const phashValue = typeof payload.phash === "string" && payload.phash ? payload.phash : null;
  const exifShotAtValue = typeof payload.exifShotAt === "string" && payload.exifShotAt
    ? payload.exifShotAt
    : null;
  const originalTranscodedValue = payload.originalTranscoded === true;
  return {
    sha256,
    phash: phashValue,
    width: Number(width),
    height: Number(height),
    exifShotAt: exifShotAtValue,
    originalTranscoded: originalTranscodedValue || undefined,
  };
}

function normaliseStoragePath(value: string): string {
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

function isPathUnderReceipt(filePath: string, receiptBase: string): boolean {
  const normalisedBase = normaliseStoragePath(receiptBase);
  const normalisedPath = normaliseStoragePath(filePath);
  return normalisedPath.startsWith(`${normalisedBase}/assets/`);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (!isReceiptsEnabled()) {
      return NextResponse.json({ error: "Receipts feature disabled" }, { status: 403 });
    }

    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(authHeader.slice("Bearer ".length).trim());
    } catch (error) {
      console.warn("Invalid ID token for asset commit", error);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: CommitRequestBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const receiptId = validateString(body.receiptId, "receiptId");
    const assetId = validateString(body.assetId, "assetId");
    const filePath = validateString(body.filePath, "filePath");
    const viewPath = validateString(body.viewPath, "viewPath");
    const thumbPath = validateString(body.thumbPath, "thumbPath");
    const meta = validateMeta(body.meta);

    const { storeIds, flags } = await getUserPermissions(decoded.uid);
    if (!flags.includes("perm.upload")) {
      return NextResponse.json({ error: "Missing upload permission" }, { status: 403 });
    }

    const receiptRef = adminDb.collection("receipts").doc(receiptId);
    const assetRef = receiptRef.collection("assets").doc(assetId);

    try {
      await adminDb.runTransaction(async (tx) => {
        const receiptSnap = await tx.get(receiptRef);
        if (!receiptSnap.exists) {
          throw new HttpError("Receipt not found", 404);
        }
        const receipt = receiptSnap.data() as ReceiptDoc;
        const storeId = receipt.storeId;
        if (typeof storeId !== "string" || !storeId) {
          throw new HttpError("Receipt store missing", 500);
        }
        if (!storeIds.includes(storeId)) {
          throw new HttpError("Access denied for store", 403);
        }
        if (receipt.status === "locked") {
          throw new HttpError("Receipt is locked", 409);
        }

        const receiptBase = normaliseStoragePath(receipt.filePath).split("/").slice(0, -1).join("/");
        if (!receiptBase) {
          throw new HttpError("Receipt file path invalid", 500);
        }
        if (!isPathUnderReceipt(filePath, receiptBase) || !isPathUnderReceipt(viewPath, receiptBase) || !isPathUnderReceipt(thumbPath, receiptBase)) {
          throw new HttpError("Asset paths do not belong to receipt", 400);
        }

        const existingAsset = await tx.get(assetRef);
        if (existingAsset.exists) {
          throw new HttpError("Asset already exists", 409);
        }

        const now = FieldValue.serverTimestamp();
        tx.set(assetRef, {
          kind: "itemPhoto",
          filePath,
          viewPath,
          thumbPath,
          meta,
          uploaderId: decoded.uid,
          createdAt: now,
        });
        tx.update(receiptRef, {
          assetsCount: FieldValue.increment(1),
          lastAssetAt: now,
          updatedAt: now,
        });
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const [receiptSnapAfter, assetSnapAfter] = await Promise.all([
      receiptRef.get(),
      assetRef.get(),
    ]);
    const receiptAfter = receiptSnapAfter.data() as ReceiptDoc | undefined;
    const assetAfter = assetSnapAfter.data() as (ReceiptAssetDoc & { createdAt: FirestoreTimestamp }) | undefined;

    const assetsCount = receiptAfter?.assetsCount ?? 0;
    const lastAssetAtTs = receiptAfter?.lastAssetAt as FirestoreTimestamp | undefined;
    const lastAssetAt = lastAssetAtTs ? lastAssetAtTs.toDate().toISOString() : null;
    const createdAtIso = assetAfter?.createdAt?.toDate().toISOString() ?? null;

    return NextResponse.json({
      asset: assetAfter
        ? {
            id: assetId,
            filePath: assetAfter.filePath,
            viewPath: assetAfter.viewPath,
            thumbPath: assetAfter.thumbPath,
            meta: assetAfter.meta,
            uploaderId: assetAfter.uploaderId,
            createdAt: createdAtIso,
          }
        : null,
      assetsCount,
      lastAssetAt,
    });
  } catch (error) {
    console.error("Unexpected asset commit error", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
