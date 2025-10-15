export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "../../../../lib/firebase/admin";
import { jsonResponse } from "../../../../lib/http";
import { fetchUserProfiles } from "../../../../lib/userProfiles";
import { canManageMembers } from "../../../../lib/permissions";
import {
  mapStoreMemberToAggregate,
  upsertUserStoreRoleFromMember,
  type AggregatedStoreMembership,
} from "../../../../lib/userStoreRoles";
import type { StoreDoc, StoreMemberDoc } from "../../../../types/store";
import type { UserPermissionsDoc } from "../../../../types/permissions";

interface StoreRecordPayload {
  id: string;
  name: string;
  currency: string;
  timezone: string;
}

type MemberRolePayload = AggregatedStoreMembership;

interface MemberPayload {
  userId: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  roles: MemberRolePayload[];
}

async function loadUserPermissions(uid: string): Promise<UserPermissionsDoc | null> {
  const snap = await adminDb.collection("userPermissions").doc(uid).get();
  if (!snap.exists) {
    return null;
  }
  return snap.data() as UserPermissionsDoc;
}

function normalizeStoreDoc(id: string, data: StoreDoc): StoreRecordPayload {
  return {
    id,
    name: data.name ?? id,
    currency: data.currency ?? "JPY",
    timezone: data.timezone ?? "Asia/Tokyo",
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice("Bearer ".length).trim();

    const decoded = await adminAuth
      .verifyIdToken(token)
      .catch((error) => {
        console.warn("Invalid ID token (admin members)", error);
        return null;
      });

    if (!decoded) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const perms = await loadUserPermissions(decoded.uid);
    if (!perms || !canManageMembers(perms)) {
      return jsonResponse({ error: "Forbidden" }, { status: 403 });
    }

    const accessibleStoreIds = perms.storeIds ?? [];
    if (!accessibleStoreIds.length) {
      return jsonResponse({ stores: [], members: [] });
    }

    const storeSnaps = await Promise.all(
      accessibleStoreIds.map((storeId) => adminDb.collection("stores").doc(storeId).get()),
    );

    const stores: StoreRecordPayload[] = [];
    storeSnaps.forEach((snap, index) => {
      if (!snap.exists) {
        return;
      }
      stores.push(normalizeStoreDoc(accessibleStoreIds[index], snap.data() as StoreDoc));
    });

    const storeIdSet = new Set(accessibleStoreIds);
    const pendingStoreIds = new Set(accessibleStoreIds);
    const memberMap = new Map<string, MemberPayload>();

    const userStoreRolesRef = adminDb.collection("userStoreRoles");
    for (const group of chunk(accessibleStoreIds, 10)) {
      const snapshot = await userStoreRolesRef.where("storeIds", "array-contains-any", group).get();
      snapshot.forEach((doc) => {
        const raw = doc.data() as { stores?: AggregatedStoreMembership[] };
        if (!Array.isArray(raw.stores)) {
          return;
        }
        const roles = raw.stores
          .filter((entry) => storeIdSet.has(entry.storeId))
          .map((entry) => ({
            storeId: entry.storeId,
            role: entry.role,
            flags: Array.isArray(entry.flags) ? entry.flags : [],
            status: entry.status,
            joinedAt: entry.joinedAt ?? null,
            invitedBy: entry.invitedBy ?? null,
            resigned: Boolean(entry.resigned),
          }));
        if (!roles.length) {
          return;
        }
        const existing = memberMap.get(doc.id);
        if (existing) {
          existing.roles.push(...roles);
        } else {
          memberMap.set(doc.id, {
            userId: doc.id,
            displayName: null,
            email: null,
            photoURL: null,
            roles: [...roles],
          });
        }
        roles.forEach((role) => pendingStoreIds.delete(role.storeId));
      });
    }

    if (pendingStoreIds.size) {
      await Promise.all(
        Array.from(pendingStoreIds).map(async (storeId) => {
          const storeSnap = await adminDb.collection("stores").doc(storeId).get();
          if (!storeSnap.exists) {
            return;
          }
          const membersSnap = await storeSnap.ref.collection("members").get();
          await Promise.all(
            membersSnap.docs.map(async (memberDoc) => {
              const data = memberDoc.data() as StoreMemberDoc & { isResigned?: boolean };
              await upsertUserStoreRoleFromMember(memberDoc.id, storeId, data);
              const entry = mapStoreMemberToAggregate(storeId, data);
              const existing = memberMap.get(memberDoc.id);
              if (existing) {
                existing.roles.push(entry);
              } else {
                memberMap.set(memberDoc.id, {
                  userId: memberDoc.id,
                  displayName: null,
                  email: null,
                  photoURL: null,
                  roles: [entry],
                });
              }
            }),
          );
        }),
      );
    }

    if (!memberMap.size) {
      return jsonResponse({ stores, members: [] });
    }

    const profileMap = await fetchUserProfiles(Array.from(memberMap.keys()), {
      onBatchError: (uids, error) => {
        console.warn("[admin.members] failed to load user profile batch", { batchSize: uids.length }, error);
      },
    });

    const members = Array.from(memberMap.values()).map((member) => {
      const profile = profileMap.get(member.userId);
      const uniqueRoles = new Map<string, MemberRolePayload>();
      member.roles.forEach((role) => {
        uniqueRoles.set(role.storeId, {
          storeId: role.storeId,
          role: role.role,
          flags: Array.isArray(role.flags) ? role.flags : [],
          status: role.status,
          joinedAt: role.joinedAt ?? null,
          invitedBy: role.invitedBy ?? null,
          resigned: Boolean(role.resigned),
        });
      });
      return {
        userId: member.userId,
        displayName: profile?.displayName ?? null,
        email: profile?.email ?? null,
        photoURL: profile?.photoURL ?? null,
        roles: Array.from(uniqueRoles.values()).sort((a, b) => a.storeId.localeCompare(b.storeId)),
      };
    });

    return jsonResponse({ stores, members });
  } catch (error) {
    console.error("Failed to list admin members", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}
