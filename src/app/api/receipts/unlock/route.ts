export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue, Timestamp as FirestoreTimestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../../../lib/firebase/admin";
import type { ReceiptDoc } from "../../../../types/receipt";

interface UnlockRequestBody {
  receiptId?: unknown;
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
      console.warn("Invalid ID token for unlock", error);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: UnlockRequestBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const receiptId = typeof body.receiptId === "string" ? body.receiptId.trim() : "";
    if (!receiptId) {
      return NextResponse.json({ error: "receiptId is required" }, { status: 400 });
    }

    const { storeIds, flags } = await getUserPermissions(decoded.uid);
    if (!flags.includes("perm.unlock")) {
      return NextResponse.json({ error: "Missing unlock permission" }, { status: 403 });
    }

    const receiptRef = adminDb.collection("receipts").doc(receiptId);

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
        if (receipt.status !== "locked") {
          throw new HttpError("Receipt is not locked", 409);
        }

        tx.update(receiptRef, {
          status: "confirmed",
          // We clear lockedBy/lockedAt on unlock so fresh locks record new actors.
          lockedBy: null,
          lockedAt: null,
          updatedAt: FieldValue.serverTimestamp(),
        });

        const logRef = receiptRef.collection("logs").doc();
        tx.set(logRef, {
          type: "unlock",
          uid: decoded.uid,
          ts: FieldValue.serverTimestamp(),
        });
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const updatedSnap = await receiptRef.get();
    const updated = updatedSnap.data() as ReceiptDoc | undefined;
    const lockedAtTimestamp = updated?.lockedAt as FirestoreTimestamp | undefined;
    const lockedAtIso = lockedAtTimestamp ? lockedAtTimestamp.toDate().toISOString() : null;

    return NextResponse.json(
      {
        status: updated?.status ?? "confirmed",
        lockedBy: updated?.lockedBy ?? null,
        lockedAt: lockedAtIso,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Unexpected unlock error", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
