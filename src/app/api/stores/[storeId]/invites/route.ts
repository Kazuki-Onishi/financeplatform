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
    const maxUses = parseMaxUses(body.maxUses);
    const expiresDate = parseExpires(body.expiresAt);
    const note = typeof body.note === "string" ? body.note.slice(0, 160) : null;

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
        link: `/invites/accept?token=${encodeURIComponent(tokenValue)}`,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Failed to create invite", error);
    return jsonResponse({ error: "Internal Server Error" }, { status: 500 });
  }
}