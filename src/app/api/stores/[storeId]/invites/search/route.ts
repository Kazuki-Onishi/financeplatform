export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "../../../../../../lib/firebase/admin";
import { jsonResponse } from "../../../../../../lib/http";
import type { PermissionFlag } from "../../../../../../types/permissions";
import type { StoreInviteDoc, StoreMemberDoc } from "../../../../../../types/store";
import type { UserRecord } from "firebase-admin/auth";

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

function matchesQuery(user: UserRecord, query: string): boolean {
  const lower = query.toLowerCase();
  const email = user.email?.toLowerCase() ?? "";
  const name = user.displayName?.toLowerCase() ?? "";
  const uid = user.uid.toLowerCase();
  const phone = user.phoneNumber?.toLowerCase() ?? "";
  return (
    (email && email.includes(lower)) ||
    (name && name.includes(lower)) ||
    uid.includes(lower) ||
    (phone && phone.includes(lower))
  );
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
      console.warn("Invalid ID token (search invite targets)", error);
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { storeId } = await params;
    if (!storeId) {
      return jsonResponse({ error: "Invalid store" }, { status: 400 });
    }

    const url = new URL(request.url);
    const rawQuery = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    const query = rawQuery.trim();
    if (!query) {
      return jsonResponse({ users: [] });
    }

    if (query.length < 2 && !query.includes("@")) {
      return jsonResponse({ users: [] });
    }

    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 20) : 10;

    const storeRef = adminDb.collection("stores").doc(storeId);
    const requesterSnap = await storeRef.collection("members").doc(decoded.uid).get();
    const requester = requesterSnap.exists ? (requesterSnap.data() as StoreMemberDoc) : null;

    if (!hasManagePermission(requester)) {
      return jsonResponse({ error: "Forbidden" }, { status: 403 });
    }

    const membersSnap = await storeRef.collection("members").get();
    const memberIds = new Set<string>(membersSnap.docs.map((doc) => doc.id));

    const invitesSnap = await storeRef
      .collection("invites")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();
    const activeTargetIds = new Set<string>();
    invitesSnap.docs.forEach((doc) => {
      const data = doc.data() as StoreInviteDoc;
      if (data.targetUserId && data.status === "active") {
        activeTargetIds.add(data.targetUserId);
      }
    });

    const seen = new Set<string>();
    const matches: UserRecord[] = [];

    function addUser(user: UserRecord): void {
      if (seen.has(user.uid)) {
        return;
      }
      seen.add(user.uid);
      matches.push(user);
    }

    if (query.includes("@")) {
      try {
        const userRecord = await adminAuth.getUserByEmail(query.toLowerCase());
        addUser(userRecord);
      } catch (error) {
        console.debug("[invites] no user found for email", query, error);
      }
    }

    if (matches.length < limit) {
      const lower = query.toLowerCase();
      let nextPageToken: string | undefined;
      let pagesFetched = 0;
      while (matches.length < limit && pagesFetched < 5) {
        const result = await adminAuth.listUsers(1000, nextPageToken);
        for (const user of result.users) {
          if (seen.has(user.uid)) {
            continue;
          }
          if (matchesQuery(user, lower)) {
            addUser(user);
            if (matches.length >= limit) {
              break;
            }
          }
        }
        if (!result.pageToken) {
          break;
        }
        nextPageToken = result.pageToken;
        pagesFetched += 1;
      }
    }

    const users = matches.slice(0, limit).map((user) => {
      let status: "available" | "member" | "invited" = "available";
      if (memberIds.has(user.uid)) {
        status = "member";
      } else if (activeTargetIds.has(user.uid)) {
        status = "invited";
      }
      return {
        uid: user.uid,
        email: user.email ?? null,
        displayName: user.displayName ?? null,
        photoURL: user.photoURL ?? null,
        status,
      };
    });

    return jsonResponse({ users });
  } catch (error) {
    console.error("Failed to search invite targets", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}
