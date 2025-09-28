export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../../../../lib/firebase/admin";
import { jsonResponse } from "../../../../../lib/http";
import { generateInviteCode, generateInviteToken } from "../../../../../lib/inviteUtils";
import type { PermissionFlag } from "../../../../../types/permissions";
import type { StoreInviteDoc, StoreMemberDoc } from "../../../../../types/store";

const MANAGE_FLAGS: PermissionFlag[] = ["perm.lock", "perm.unlock", "perm.manageVendors", "perm.manageMembers"];

interface CreateInviteBody {
  role?: unknown;
  flags?: unknown;
  maxUses?: unknown;
  expiresAt?: unknown;
  note?: unknown;
  targetUserId?: unknown;
}

function hasManagePermission(member: StoreMemberDoc | null): boolean {
  if (!member) {
    return false;
  }
  if (member.status !== "active") {
    return false;
  }
  return member.role === "owner" || MANAGE_FLAGS.some((flag) => member.flags?.includes(flag));
}

function parseFlags(input: unknown): PermissionFlag[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return (input as unknown[])
    .filter((item): item is PermissionFlag => typeof item === "string") as PermissionFlag[];
}

function parseMaxUses(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return 1;
}

function parseExpires(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value.trim());
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return null;
}

function normaliseRole(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const lowered = value.trim().toLowerCase();
  if (!lowered) {
    return null;
  }
  if (["owner", "manager", "staff", "viewer"].includes(lowered)) {
    return lowered;
  }
  return null;
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
      console.warn("Invalid ID token (list invites)", error);
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { storeId } = await params;
    if (!storeId) {
      return jsonResponse({ error: "Invalid store" }, { status: 400 });
    }

    const memberSnap = await adminDb
      .collection("stores")
      .doc(storeId)
      .collection("members")
      .doc(decoded.uid)
      .get();
    const memberData = memberSnap.exists ? (memberSnap.data() as StoreMemberDoc) : null;
    if (!hasManagePermission(memberData)) {
      return jsonResponse({ error: "Forbidden" }, { status: 403 });
    }

    const invitesSnap = await adminDb
      .collection("stores")
      .doc(storeId)
      .collection("invites")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const invites = invitesSnap.docs.map((doc) => {
      const data = doc.data() as StoreInviteDoc;
      return {
        id: doc.id,
        code: data.code,
        token: data.token,
        role: data.role,
        flags: data.flags ?? [],
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : null,
        expiresAt:
          data.expiresAt instanceof Timestamp && data.expiresAt
            ? data.expiresAt.toDate().toISOString()
            : null,
        status: data.status,
        maxUses: data.maxUses,
        used: data.used,
        note: data.note ?? null,
        targetUserId: data.targetUserId ?? null,
        targetEmail: data.targetEmail ?? null,
        targetDisplayName: data.targetDisplayName ?? null,
        link: `/invites/accept?token=${encodeURIComponent(data.token)}`,
      };
    });

    return jsonResponse({ invites });
  } catch (error) {
    console.error("Failed to list invites", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(
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
      console.warn("Invalid ID token (create invite)", error);
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    let body: CreateInviteBody;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { storeId } = await params;
    if (!storeId) {
      return jsonResponse({ error: "Invalid store" }, { status: 400 });
    }

    const storeRef = adminDb.collection("stores").doc(storeId);
    const memberRef = storeRef.collection("members").doc(decoded.uid);
    const memberSnap = await memberRef.get();
    const memberData = memberSnap.exists ? (memberSnap.data() as StoreMemberDoc) : null;
    if (!hasManagePermission(memberData)) {
      return jsonResponse({ error: "Forbidden" }, { status: 403 });
    }

    const role = normaliseRole(body.role) ?? "staff";
    const flags = parseFlags(body.flags);
    let maxUses = parseMaxUses(body.maxUses);
    const expiresDate = parseExpires(body.expiresAt);
    let note = typeof body.note === "string" ? body.note.slice(0, 160) : null;
    const rawTargetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
    let targetUserId: string | null = null;
    let targetEmail: string | null = null;
    let targetDisplayName: string | null = null;


    if (rawTargetUserId) {
      try {
        const userRecord = await adminAuth.getUser(rawTargetUserId);
        targetUserId = userRecord.uid;
        targetEmail = userRecord.email ?? null;
        targetDisplayName = userRecord.displayName ?? null;
      } catch (error) {
        console.warn("[invites] target user not found", rawTargetUserId, error);
        return jsonResponse({ error: "Target user not found" }, { status: 404 });
      }

      if (!targetUserId) {
        return jsonResponse({ error: "Target user not found" }, { status: 404 });
      }

      const targetMemberSnap = await storeRef.collection("members").doc(targetUserId).get();
      if (targetMemberSnap.exists) {
        return jsonResponse({ error: "User is already a member of this store." }, { status: 409 });
      }

      const directInviteSnap = await storeRef
        .collection("invites")
        .where("targetUserId", "==", targetUserId)
        .get();
      const hasActiveInvite = directInviteSnap.docs.some((doc) => {
        const data = doc.data() as StoreInviteDoc;
        return data.status === "active";
      });
      if (hasActiveInvite) {
        return jsonResponse({ error: "User already has an active invite." }, { status: 409 });
      }

      maxUses = 1;
      if (!note) {
        if (targetEmail) {
          note = `Direct invite for ${targetEmail}`;
        } else if (targetDisplayName) {
          note = `Direct invite for ${targetDisplayName}`;
        } else if (targetUserId) {
          note = `Direct invite for ${targetUserId}`;
        }
      }
    }

    const inviteRef = storeRef.collection("invites").doc();

    const now = FieldValue.serverTimestamp();
    const tokenValue = generateInviteToken();
    const codeValue = generateInviteCode();

    const invitePayload: Partial<StoreInviteDoc> = {
      token: tokenValue,
      code: codeValue.replace(/-/g, ""),
      createdAt: now as unknown as StoreInviteDoc["createdAt"],
      createdBy: decoded.uid,
      storeId,
      role: role as StoreInviteDoc["role"],
      flags,
      status: "active",
      maxUses,
      used: 0,
      note,
    };

    if (targetUserId) {
      invitePayload.targetUserId = targetUserId;
      invitePayload.targetEmail = targetEmail ?? null;
      invitePayload.targetDisplayName = targetDisplayName ?? null;
    }

    const batch = adminDb.batch();
    batch.set(inviteRef, invitePayload);

    if (expiresDate) {
      batch.update(inviteRef, {
        expiresAt: expiresDate,
      });
    }

    await batch.commit();

    return jsonResponse(
      {
        id: inviteRef.id,
        token: tokenValue,
        code: codeValue,
        role,
        flags,
        maxUses,
        expiresAt: expiresDate ? expiresDate.toISOString() : null,
        note,
        targetUserId,
        targetEmail,
        targetDisplayName,
        link: `/invites/accept?token=${encodeURIComponent(tokenValue)}`,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Failed to create invite", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}