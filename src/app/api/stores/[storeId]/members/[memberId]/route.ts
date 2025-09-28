export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../../../../../lib/firebase/admin";
import { jsonResponse } from "../../../../../../lib/http";
import { coercePermissionFlags, normalizeStoreMemberRole } from "../../../../../../lib/permissions";
import type { PermissionFlag } from "../../../../../../types/permissions";
import type { StoreMemberDoc } from "../../../../../../types/store";

const MANAGE_FLAGS: PermissionFlag[] = ["perm.manageMembers", "perm.lock", "perm.unlock"];

function hasManagePermission(member: StoreMemberDoc | null): boolean {
  if (!member || member.status !== "active") {
    return false;
  }
  if (member.role === "owner") {
    return true;
  }
  const flags = member.flags ?? [];
  return MANAGE_FLAGS.some((flag) => flags.includes(flag));
}

function normalizeStatus(value: unknown): StoreMemberDoc["status"] | null {
  if (value === "active" || value === "pending") {
    return value;
  }
  return null;
}

interface UpdateMemberPayload {
  role?: unknown;
  flags?: unknown;
  status?: unknown;
  resigned?: unknown;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string; memberId: string }> },
): Promise<Response> {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice("Bearer ".length).trim();
    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch (error) {
      console.warn("Invalid ID token (update member)", error);
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    let payload: UpdateMemberPayload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { storeId, memberId } = await params;
    if (!storeId || !memberId) {
      return jsonResponse({ error: "Invalid member" }, { status: 400 });
    }

    const storeRef = adminDb.collection("stores").doc(storeId);
    const requesterSnap = await storeRef.collection("members").doc(decoded.uid).get();
    const requester = requesterSnap.exists ? (requesterSnap.data() as StoreMemberDoc) : null;

    if (!hasManagePermission(requester)) {
      return jsonResponse({ error: "Forbidden" }, { status: 403 });
    }

    const targetRef = storeRef.collection("members").doc(memberId);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      return jsonResponse({ error: "Member not found" }, { status: 404 });
    }

    const current = targetSnap.data() as StoreMemberDoc & { isResigned?: boolean };
    const updates: Partial<StoreMemberDoc> & { isResigned?: boolean } = {};
    let changed = false;

    if (Object.prototype.hasOwnProperty.call(payload, "role")) {
      const nextRole = normalizeStoreMemberRole(payload.role, current.role);
      if (nextRole !== current.role) {
        updates.role = nextRole;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, "flags")) {
      const nextFlags = coercePermissionFlags(payload.flags);
      updates.flags = nextFlags;
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "status")) {
      const nextStatus = normalizeStatus(payload.status);
      if (!nextStatus) {
        return jsonResponse({ error: "Invalid status" }, { status: 400 });
      }
      if (nextStatus !== current.status) {
        updates.status = nextStatus;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, "resigned")) {
      const nextResigned = Boolean(payload.resigned);
      if (nextResigned !== Boolean(current.isResigned)) {
        updates.isResigned = nextResigned;
        changed = true;
      }
    }

    if (!changed) {
      return jsonResponse({ error: "No changes provided" }, { status: 400 });
    }

    await targetRef.update(updates);
    const refreshedSnap = await targetRef.get();
    const refreshed = refreshedSnap.data() as StoreMemberDoc & { isResigned?: boolean };

    let displayName: string | null = null;
    let email: string | null = null;
    let photoURL: string | null = null;
    try {
      const userRecord = await adminAuth.getUser(memberId);
      displayName = userRecord.displayName ?? null;
      email = userRecord.email ?? null;
      photoURL = userRecord.photoURL ?? null;
    } catch (error) {
      console.warn("[members] failed to load user profile after update", memberId, error);
    }

    const joinedAtValue = refreshed.joinedAt instanceof Timestamp ? refreshed.joinedAt.toDate().toISOString() : null;

    return jsonResponse({
      member: {
        id: memberId,
        role: refreshed.role,
        flags: refreshed.flags ?? [],
        status: refreshed.status,
        resigned: Boolean(refreshed.isResigned),
        joinedAt: joinedAtValue,
        invitedBy: refreshed.invitedBy ?? null,
        displayName,
        email,
        photoURL,
      },
    });
  } catch (error) {
    console.error("Failed to update member", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}
