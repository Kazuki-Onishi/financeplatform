export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import type { PermissionFlag, UserPermissionsDoc } from "@/types/permissions";
import type { StoreDoc, StoreInviteDoc, StoreMemberDoc } from "@/types/store";

interface AcceptInviteBody {
  token?: unknown;
  code?: unknown;
}

function normalizeToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return cleaned ? cleaned : null;
}

function ensureArray(value: PermissionFlag[] | undefined | null): PermissionFlag[] {
  return Array.isArray(value) ? value : [];
}

function inviteIsExpired(invite: StoreInviteDoc, now: Date): boolean {
  const expiresAt = invite.expiresAt;
  if (!expiresAt) {
    return false;
  }
  let expiryMs: number;
  if (expiresAt instanceof Timestamp) {
    expiryMs = expiresAt.toMillis();
  } else if (expiresAt instanceof Date) {
    expiryMs = expiresAt.getTime();
  } else {
    const parsed = new Date(expiresAt as unknown as string);
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }
    expiryMs = parsed.getTime();
  }
  return expiryMs <= now.getTime();
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

    const idToken = authHeader.slice("Bearer ".length).trim();
    let decodedToken;
    try {
      decodedToken = await adminAuth.verifyIdToken(idToken);
    } catch (authError) {
      console.warn("Invalid ID token (invite accept)", authError);
      return jsonNoStore({ error: "Unauthorized" }, { status: 401 });
    }

    let body: AcceptInviteBody;
    try {
      body = await request.json();
    } catch {
      return jsonNoStore({ error: "Invalid JSON body" }, { status: 400 });
    }

    const inviteToken = normalizeToken(body.token);
    const inviteCode = normalizeCode(body.code);
    if (!inviteToken && !inviteCode) {
      return jsonNoStore({ error: "token or code is required" }, { status: 400 });
    }

    const invitesQuery = inviteToken
      ? adminDb.collectionGroup("invites").where("token", "==", inviteToken).limit(1)
      : adminDb.collectionGroup("invites").where("code", "==", inviteCode).limit(1);

    const inviteSnap = await invitesQuery.get();
    if (inviteSnap.empty) {
      return jsonNoStore({ error: "Invite not found" }, { status: 404 });
    }

    const inviteDoc = inviteSnap.docs[0];
    const inviteRef = inviteDoc.ref;
    const storeRef = inviteRef.parent.parent;
    if (!storeRef) {
      return jsonNoStore({ error: "Malformed invite" }, { status: 500 });
    }

    const now = new Date();
    const responsePayload = await adminDb.runTransaction(async (transaction) => {
      const inviteSnapshot = await transaction.get(inviteRef);
      if (!inviteSnapshot.exists) {
        throw new Error("invite-missing");
      }
      const inviteData = inviteSnapshot.data() as StoreInviteDoc;
      if (inviteData.status !== "active") {
        throw new Error("invite-inactive");
      }
      if (inviteIsExpired(inviteData, now)) {
        transaction.update(inviteRef, { status: "expired" });
        throw new Error("invite-expired");
      }
      if (inviteData.maxUses > 0 && inviteData.used >= inviteData.maxUses) {
        transaction.update(inviteRef, { status: "consumed" });
        throw new Error("invite-consumed");
      }

      const memberRef = storeRef.collection("members").doc(decodedToken.uid);
      const memberSnap = await transaction.get(memberRef);
      const currentMember = memberSnap.exists ? (memberSnap.data() as StoreMemberDoc) : null;

      const storeSnap = await transaction.get(storeRef);
      if (!storeSnap.exists) {
        throw new Error("store-missing");
      }
      const storeData = storeSnap.data() as StoreDoc;

      const invitedFlags = ensureArray(inviteData.flags);
      const existingMemberFlags = ensureArray(currentMember?.flags ?? []);
      const combinedMemberFlags = mergeUnique([
        ...existingMemberFlags,
        ...invitedFlags,
      ]);
      const shouldActivateMembership = !currentMember || currentMember.status !== "active";
      const joinedAt = FieldValue.serverTimestamp();

      transaction.set(
        memberRef,
        {
          role: inviteData.role,
          flags: combinedMemberFlags,
          joinedAt,
          invitedBy: inviteData.createdBy,
          status: "active",
        },
        { merge: true },
      );

      if (shouldActivateMembership) {
        const nextUsed = inviteData.used + 1;
        const nextStatus =
          inviteData.maxUses > 0 && nextUsed >= inviteData.maxUses ? "consumed" : inviteData.status;
        transaction.update(inviteRef, {
          used: nextUsed,
          status: nextStatus,
          lastAcceptedAt: joinedAt,
        });
      }

      const userPermRef = adminDb.collection("userPermissions").doc(decodedToken.uid);
      const userPermSnap = await transaction.get(userPermRef);
      const existingPerms = userPermSnap.exists ? (userPermSnap.data() as UserPermissionsDoc) : null;
      const nextStoreIds = mergeUnique([...(existingPerms?.storeIds ?? []), storeRef.id]);
      const nextFlags = mergeUnique([...(existingPerms?.flags ?? []), ...combinedMemberFlags]);

      const userPermUpdate: Record<string, unknown> = {
        storeIds: FieldValue.arrayUnion(storeRef.id),
        activeStoreId: storeRef.id,
      };
      if (combinedMemberFlags.length) {
        userPermUpdate.flags = FieldValue.arrayUnion(...combinedMemberFlags);
      }

      transaction.set(userPermRef, userPermUpdate, { merge: true });

      return {
        storeId: storeRef.id,
        role: inviteData.role,
        perms: combinedMemberFlags,
        userPermissions: {
          storeIds: nextStoreIds,
          activeStoreId: storeRef.id,
          flags: nextFlags,
        },
        store: {
          name: storeData.name,
          currency: storeData.currency,
          timezone: storeData.timezone,
        },
      };
    });

    const secure = process.env.NODE_ENV === "production";
    const response = jsonNoStore({
      storeId: responsePayload.storeId,
      role: responsePayload.role,
      perms: responsePayload.perms,
      userPermissions: responsePayload.userPermissions,
    });
    response.cookies.set("activeStoreId", responsePayload.storeId, { httpOnly: true, sameSite: "lax", path: "/", secure });
    return response;
  } catch (error) {
    if (error instanceof Error) {
      switch (error.message) {
        case "invite-inactive":
          return jsonNoStore({ error: "Invite is no longer active" }, { status: 409 });
        case "invite-expired":
          return jsonNoStore({ error: "Invite has expired" }, { status: 409 });
        case "invite-consumed":
          return jsonNoStore({ error: "Invite has already been used" }, { status: 409 });
        case "invite-missing":
          return jsonNoStore({ error: "Invite not found" }, { status: 404 });
        case "store-missing":
          return jsonNoStore({ error: "Store not found" }, { status: 404 });
        default:
          console.error("Invite accept failed", error);
      }
    }
    return jsonNoStore({ error: "Internal Server Error" }, { status: 500 });
  }
}

