import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase/admin";
import type { StoreMemberDoc } from "@/types/store";

export interface AggregatedStoreMembership {
  storeId: string;
  role: StoreMemberDoc["role"];
  flags: StoreMemberDoc["flags"];
  status: StoreMemberDoc["status"];
  joinedAt: string | null;
  invitedBy: string | null;
  resigned: boolean;
}

interface UserStoreRolesDoc {
  storeIds?: string[];
  stores?: AggregatedStoreMembership[];
}

const collectionRef = adminDb.collection("userStoreRoles");

function normaliseStoreIds(stores: AggregatedStoreMembership[]): string[] {
  return Array.from(new Set(stores.map((entry) => entry.storeId)));
}

export function mapStoreMemberToAggregate(
  storeId: string,
  data: StoreMemberDoc & { isResigned?: boolean },
): AggregatedStoreMembership {
  return {
    storeId,
    role: data.role,
    flags: Array.isArray(data.flags) ? data.flags : [],
    status: data.status,
    joinedAt: data.joinedAt instanceof Timestamp ? data.joinedAt.toDate().toISOString() : null,
    invitedBy: data.invitedBy ?? null,
    resigned: Boolean(data.isResigned),
  };
}

export async function upsertUserStoreRoleEntry(
  userId: string,
  entry: AggregatedStoreMembership | null,
): Promise<void> {
  const docRef = collectionRef.doc(userId);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    let stores: AggregatedStoreMembership[] = [];
    if (snap.exists) {
      const data = snap.data() as UserStoreRolesDoc;
      if (Array.isArray(data.stores)) {
        stores = data.stores.map((value) => ({
          storeId: value.storeId,
          role: value.role,
          flags: Array.isArray(value.flags) ? value.flags : [],
          status: value.status,
          joinedAt: value.joinedAt ?? null,
          invitedBy: value.invitedBy ?? null,
          resigned: Boolean(value.resigned),
        }));
      }
    }
    const index = stores.findIndex((value) => value.storeId === entry?.storeId);
    if (entry) {
      if (index >= 0) {
        stores[index] = entry;
      } else {
        stores.push(entry);
      }
    } else if (index >= 0) {
      stores.splice(index, 1);
    }

    if (!stores.length) {
      tx.delete(docRef);
      return;
    }

    tx.set(
      docRef,
      {
        uid: userId,
        stores,
        storeIds: normaliseStoreIds(stores),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

export async function upsertUserStoreRoleFromMember(
  userId: string,
  storeId: string,
  data: StoreMemberDoc & { isResigned?: boolean },
): Promise<void> {
  const entry = mapStoreMemberToAggregate(storeId, data);
  await upsertUserStoreRoleEntry(userId, entry);
}

export async function upsertManyUserStoreRoles(entries: Array<{ userId: string; storeId: string; data: StoreMemberDoc & { isResigned?: boolean } }>): Promise<void> {
  for (const entry of entries) {
    await upsertUserStoreRoleFromMember(entry.userId, entry.storeId, entry.data);
  }
}


