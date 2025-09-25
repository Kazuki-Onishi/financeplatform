export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../../lib/firebase/admin";

import type { StoreDoc, StoreMemberDoc } from "../../../types/store";
import type { PermissionFlag, UserPermissionsDoc } from "../../../types/permissions";

const OWNER_FLAGS: PermissionFlag[] = [
  "perm.upload",
  "perm.editFields",
  "perm.view",
  "perm.exportCsv",
  "perm.lock",
  "perm.unlock",
  "perm.manageCards",
  "perm.manageVendors",
];

interface CreateStoreBody {
  name?: unknown;
  currency?: unknown;
  timezone?: unknown;
}

function normaliseString(input: unknown, max = 120): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const value = input.trim();
  if (!value) {
    return null;
  }
  return value.slice(0, max);
}

function mergeUnique<T>(values: Iterable<T>): T[] {
  return Array.from(new Set(values));
}

function jsonNoStore(body: unknown, init: ResponseInit = {}): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonNoStore({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice("Bearer ".length).trim();
    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch (error) {
      console.warn("Invalid ID token (store create)", error);
      return jsonNoStore({ error: "Unauthorized" }, { status: 401 });
    }

    let body: CreateStoreBody;
    try {
      body = await request.json();
    } catch {
      return jsonNoStore({ error: "Invalid JSON body" }, { status: 400 });
    }

    const name = normaliseString(body.name, 80);
    const currency = normaliseString(body.currency, 8) ?? "JPY";
    const timezone = normaliseString(body.timezone, 64) ?? "Asia/Tokyo";

    if (!name) {
      return jsonNoStore({ error: "name is required" }, { status: 400 });
    }

    const result = await adminDb.runTransaction(async (transaction) => {
      const storesCollection = adminDb.collection("stores");
      const storeRef = storesCollection.doc();
      const now = FieldValue.serverTimestamp();

      const storeDoc: Partial<StoreDoc> = {
        name,
        currency,
        timezone,
        createdAt: now as unknown as StoreDoc["createdAt"],
        createdBy: decoded.uid,
        updatedAt: now as unknown as StoreDoc["updatedAt"],
        inviteEnabled: true,
      };

      const memberRef = storeRef.collection("members").doc(decoded.uid);
      const memberDoc: Partial<StoreMemberDoc> = {
        role: "owner",
        flags: OWNER_FLAGS,
        joinedAt: now as unknown as StoreMemberDoc["joinedAt"],
        invitedBy: decoded.uid,
        status: "active",
      };

      const userPermsRef = adminDb.collection("userPermissions").doc(decoded.uid);
      const userPermsSnap = await transaction.get(userPermsRef);
      const existingPerms = userPermsSnap.exists ? (userPermsSnap.data() as UserPermissionsDoc) : null;
      const nextStoreIds = mergeUnique([...(existingPerms?.storeIds ?? []), storeRef.id]);
      const nextFlags = mergeUnique([...(existingPerms?.flags ?? []), ...OWNER_FLAGS]);

      transaction.set(storeRef, storeDoc);
      transaction.set(memberRef, memberDoc);

      transaction.set(
        userPermsRef,
        {
          storeIds: nextStoreIds,
          activeStoreId: storeRef.id,
          flags: nextFlags,
        },
        { merge: true },
      );

      return {
        storeId: storeRef.id,
        role: "owner",
        perms: OWNER_FLAGS,
        store: {
          name,
          currency,
          timezone,
        },
        userPermissions: {
          storeIds: nextStoreIds,
          activeStoreId: storeRef.id,
          flags: nextFlags,
        },
      };
    });

    const secure = process.env.NODE_ENV === "production";
    const response = jsonNoStore(result, { status: 201 });
    response.cookies.set("activeStoreId", result.storeId, { httpOnly: true, sameSite: "lax", path: "/", secure });
    return response;
  } catch (error) {
    console.error("Failed to create store", error);
    const message = error instanceof Error ? error.message : String(error);
    return jsonNoStore({ error: "Internal Server Error", message }, { status: 500 });
  }
}


