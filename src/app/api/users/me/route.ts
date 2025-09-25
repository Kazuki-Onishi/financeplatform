export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase/admin";

export async function GET(request: Request): Promise<Response> {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }

    const idToken = authHeader.slice("Bearer ".length).trim();
    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(idToken);
    } catch (error) {
      console.warn("Invalid ID token (users/me)", error);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }

    const [userRecord, permissionsSnapshot, rolesSnapshot] = await Promise.all([
      adminAuth.getUser(decoded.uid),
      adminDb.collection("userPermissions").doc(decoded.uid).get(),
      adminDb.collection("userStoreRoles").where("uid", "==", decoded.uid).get(),
    ]);

    const permissionData = permissionsSnapshot.exists ? permissionsSnapshot.data() ?? {} : {};
    const storeIds = Array.isArray(permissionData.storeIds)
      ? (permissionData.storeIds as string[]).filter((id) => typeof id === "string")
      : [];
    const flags = Array.isArray(permissionData.flags)
      ? (permissionData.flags as string[]).filter((flag) => typeof flag === "string")
      : [];
    const activeStoreId =
      typeof permissionData.activeStoreId === "string" || permissionData.activeStoreId === null
        ? (permissionData.activeStoreId as string | null)
        : null;

    const roles = rolesSnapshot.docs
      .map((doc) => {
        const data = doc.data() ?? {};
        return {
          id: doc.id,
          uid: typeof data.uid === "string" ? data.uid : decoded.uid,
          storeId: typeof data.storeId === "string" ? data.storeId : null,
          role: typeof data.role === "string" ? data.role : "",
          flags: Array.isArray(data.flags) ? data.flags.filter((flag: unknown) => typeof flag === "string") : [],
        };
      })
      .filter((role) => role.storeId);

    const payload = {
      uid: userRecord.uid,
      email: userRecord.email ?? null,
      displayName: userRecord.displayName ?? null,
      photoURL: userRecord.photoURL ?? null,
      providerIds: userRecord.providerData.map((provider) => provider.providerId),
      lastLoginAt: userRecord.metadata.lastSignInTime,
      userPermissions: {
        userId: decoded.uid,
        storeIds: Array.isArray(storeIds) ? storeIds : [],
        flags: Array.isArray(flags) ? flags : [],
        activeStoreId: typeof activeStoreId === "string" || activeStoreId === null ? activeStoreId : null,
      },
      roles: Array.isArray(roles) ? roles : [],
    };

    return NextResponse.json(payload, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to resolve users/me", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
