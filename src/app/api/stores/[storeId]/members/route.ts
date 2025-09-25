export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../../../../lib/firebase/admin";
import { jsonResponse } from "../../../../../lib/http";
import type { StoreMemberDoc } from "../../../../../types/store";
import type { PermissionFlag } from "../../../../../types/permissions";

const MANAGE_FLAGS: PermissionFlag[] = ["perm.manageMembers", "perm.lock", "perm.unlock"];

function canViewMembers(member: StoreMemberDoc | null): boolean {
  return Boolean(member && member.status === "active");
}

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string }> },
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
      console.warn("Invalid ID token (list members)", error);
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { storeId } = await params;
    if (!storeId) {
      return jsonResponse({ error: "Invalid store" }, { status: 400 });
    }

    const storeRef = adminDb.collection("stores").doc(storeId);
    const memberRef = storeRef.collection("members").doc(decoded.uid);
    const memberSnap = await memberRef.get();
    const memberData = memberSnap.exists ? (memberSnap.data() as StoreMemberDoc) : null;

    if (!canViewMembers(memberData)) {
      return jsonResponse({ error: "Forbidden" }, { status: 403 });
    }

    const membersSnap = await storeRef.collection("members").orderBy("joinedAt", "asc").get();
    const members = await Promise.all(
      membersSnap.docs.map(async (doc) => {
        const data = doc.data() as StoreMemberDoc & { isResigned?: boolean };
        let displayName: string | null = null;
        let email: string | null = null;
        let photoURL: string | null = null;
        try {
          const userRecord = await adminAuth.getUser(doc.id);
          displayName = userRecord.displayName ?? null;
          email = userRecord.email ?? null;
          photoURL = userRecord.photoURL ?? null;
        } catch (error) {
          console.warn("[members] failed to load user profile", doc.id, error);
        }
        return {
          id: doc.id,
          role: data.role,
          flags: data.flags ?? [],
          status: data.status,
          resigned: Boolean(data.isResigned),
          joinedAt: data.joinedAt instanceof Timestamp ? data.joinedAt.toDate().toISOString() : null,
          invitedBy: data.invitedBy ?? null,
          displayName,
          email,
          photoURL,
        };
      }),
    );

    return jsonResponse({ members, canManageMembers: hasManagePermission(memberData) });
  } catch (error) {
    console.error("Failed to list members", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}