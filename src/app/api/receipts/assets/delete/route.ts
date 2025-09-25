export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue, Timestamp as FirestoreTimestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb, adminStorage } from "../../../../../lib/firebase/admin";
import type { ReceiptAssetDoc, ReceiptDoc } from "../../../../../types/receipt";

interface DeleteRequestBody {
  receiptId?: unknown;
  assetId?: unknown;
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

async function deleteStoragePath(path: string): Promise<void> {
  const normalised = normaliseStoragePath(path);
  if (!normalised) {
    return;
  }
  try {
    await adminStorage.bucket().file(normalised).delete({ ignoreNotFound: true });
  } catch (error) {
    console.warn("Failed to delete asset file", { path: normalised, error });
  }
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
      console.warn("Invalid ID token for asset delete", error);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: DeleteRequestBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const receiptId = validateString(body.receiptId, "receiptId");
    const assetId = validateString(body.assetId, "assetId");

    const { storeIds, flags } = await getUserPermissions(decoded.uid);
    if (!flags.includes("perm.upload")) {
      return NextResponse.json({ error: "Missing upload permission" }, { status: 403 });
    }

    const receiptRef = adminDb.collection("receipts").doc(receiptId);
    const assetRef = receiptRef.collection("assets").doc(assetId);

    let assetSnapshotData: (ReceiptAssetDoc & { createdAt?: FirestoreTimestamp }) | null = null;
    let receiptAfter: ReceiptDoc | null = null;

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

        const assetSnap = await tx.get(assetRef);
        if (!assetSnap.exists) {
          throw new HttpError("Asset not found", 404);
        }
        assetSnapshotData = assetSnap.data() as ReceiptAssetDoc;

        const nextCount = Math.max((receipt.assetsCount ?? 1) - 1, 0);
        const now = FieldValue.serverTimestamp();
        tx.delete(assetRef);
        tx.update(receiptRef, {
          assetsCount: nextCount,
          updatedAt: now,
        });
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    receiptAfter = ((await receiptRef.get()).data() as ReceiptDoc | undefined) ?? null;

    if (!assetSnapshotData) {
      return NextResponse.json({ error: "Asset snapshot missing" }, { status: 500 });
    }

    const assetSnapshot = assetSnapshotData as ReceiptAssetDoc;
    const filesToDelete: string[] = [];
    filesToDelete.push(assetSnapshot.filePath);
    filesToDelete.push(assetSnapshot.viewPath);
    filesToDelete.push(assetSnapshot.thumbPath);
    const assetBase = normaliseStoragePath(assetSnapshot.filePath).split("/").slice(0, -1).join("/");
    if (assetBase) {
      filesToDelete.push(`${assetBase}/meta.json`);
    }

    await Promise.all(filesToDelete.map((path) => deleteStoragePath(path)));

    const assetsCount = receiptAfter?.assetsCount ?? 0;
    const lastAssetAtTs = receiptAfter?.lastAssetAt as FirestoreTimestamp | undefined;
    const lastAssetAt = lastAssetAtTs ? lastAssetAtTs.toDate().toISOString() : null;

    return NextResponse.json({
      assetId,
      assetsCount,
      lastAssetAt,
    });
  } catch (error) {
    console.error("Unexpected asset delete error", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
