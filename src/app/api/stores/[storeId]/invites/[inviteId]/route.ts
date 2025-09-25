export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "../../../../../../lib/firebase/admin";
import { jsonResponse } from "../../../../../../lib/http";
import type { PermissionFlag } from "../../../../../../types/permissions";
import type { StoreInviteDoc, StoreMemberDoc } from "../../../../../../types/store";

const MANAGE_FLAGS: PermissionFlag[] = ["perm.lock", "perm.unlock", "perm.manageVendors", "perm.manageMembers"];

function hasManagePermission(member: StoreMemberDoc | null): boolean {
  if (!member) {
    return false;
  }
  if (member.status !== "active") {
    return false;
  }
  return member.role === "owner" || MANAGE_FLAGS.some((flag) => member.flags?.includes(flag));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string; inviteId: string }> },
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
      console.warn("Invalid ID token (revoke invite)", error);
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { storeId, inviteId } = await params;
    if (!storeId || !inviteId) {
      return jsonResponse({ error: "Invalid invite" }, { status: 400 });
    }

    const storeRef = adminDb.collection("stores").doc(storeId);
    const inviteRef = storeRef.collection("invites").doc(inviteId);
    const inviteSnap = await inviteRef.get();
    if (!inviteSnap.exists) {
      return jsonResponse({ error: "Invite not found" }, { status: 404 });
    }

    const memberRef = storeRef.collection("members").doc(decoded.uid);
    const memberSnap = await memberRef.get();
    const memberData = memberSnap.exists ? (memberSnap.data() as StoreMemberDoc) : null;
    if (!hasManagePermission(memberData)) {
      return jsonResponse({ error: "Forbidden" }, { status: 403 });
    }

    const inviteData = inviteSnap.data() as StoreInviteDoc;
    if (inviteData.status === "revoked") {
      return jsonResponse({ success: true }, { status: 200 });
    }

    await inviteRef.update({ status: "revoked" });
    return jsonResponse({ success: true });
  } catch (error) {
    console.error("Failed to revoke invite", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}