export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "../../../../../lib/firebase/admin";
import { jsonResponse } from "../../../../../lib/http";
import { fetchUserProfiles } from "../../../../../lib/userProfiles";
import {
  mapStoreMemberToAggregate,
  upsertUserStoreRoleFromMember,
  type AggregatedStoreMembership,
} from "../../../../../lib/userStoreRoles";
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

    const rolesQuery = await adminDb
      .collection("userStoreRoles")
      .where("storeIds", "array-contains", storeId)
      .get();

    const memberEntries: Array<{ id: string; entry: AggregatedStoreMembership }> = [];

    if (!rolesQuery.empty) {
      rolesQuery.forEach((doc) => {
        const data = doc.data() as { stores?: AggregatedStoreMembership[] };
        const entry = Array.isArray(data.stores)
          ? data.stores.find((value) => value.storeId === storeId)
          : undefined;
        if (entry) {
          memberEntries.push({ id: doc.id, entry });
        }
      });
    }

    if (!memberEntries.length) {
      const fallbackSnap = await storeRef.collection("members").orderBy("joinedAt", "asc").get();
      const fallbackDocs = fallbackSnap.docs.map((doc) => ({
        id: doc.id,
        data: doc.data() as StoreMemberDoc & { isResigned?: boolean },
      }));

      await Promise.all(
        fallbackDocs.map(({ id, data }) => upsertUserStoreRoleFromMember(id, storeId, data)),
      );

      fallbackDocs.forEach(({ id, data }) => {
        memberEntries.push({ id, entry: mapStoreMemberToAggregate(storeId, data) });
      });
    }

    if (!memberEntries.length) {
      return jsonResponse({ members: [], canManageMembers: hasManagePermission(memberData) });
    }

    const profileMap = await fetchUserProfiles(
      memberEntries.map((entry) => entry.id),
      {
        onBatchError: (uids, error) => {
          console.warn("[members] failed to load user profiles batch", { batchSize: uids.length }, error);
        },
      },
    );

    const members = memberEntries.map(({ id, entry }) => {
      const profile = profileMap.get(id);
      return {
        id,
        role: entry.role,
        flags: Array.isArray(entry.flags) ? entry.flags : [],
        status: entry.status,
        resigned: Boolean(entry.resigned),
        joinedAt: entry.joinedAt ?? null,
        invitedBy: entry.invitedBy ?? null,
        displayName: profile?.displayName ?? null,
        email: profile?.email ?? null,
        photoURL: profile?.photoURL ?? null,
      };
    });

    return jsonResponse({ members, canManageMembers: hasManagePermission(memberData) });
  } catch (error) {
    console.error("Failed to list members", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}
