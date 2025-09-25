"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  getDocs,
  query,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { useAppDispatch } from "@/lib/state/store";
import { clearUser, setUser, setUserError, setUserLoading } from "@/lib/state/userSlice";
import { clearUserStoreRoles, setUserStoreRoles, type UserStoreRole } from "@/lib/state/rolesSlice";
import { clearSelectedStoreId, setSelectedStoreId } from "@/lib/state/storeSlice";
import { clearPermissionsPreload, setPermissionsPreload } from "@/lib/state/permissionsSlice";
import type { PermissionFlag } from "@/types/permissions";

function resolveNextUrl(searchParams: ReadonlyURLSearchParams): string {
  const nextParam = searchParams.get("next");
  if (!nextParam || !nextParam.startsWith("/")) {
    return "/dashboard/upload";
  }
  return nextParam;
}

function pickInitialStoreId(roles: UserStoreRole[]): string | null {
  if (!roles.length) {
    return null;
  }

  try {
    const previous = localStorage.getItem("selectedStoreId");
    if (previous && roles.some((role) => role.storeId === previous)) {
      return previous;
    }
  } catch {
    // ignore storage failures
  }

  const rank = (value: string) => {
    if (value === "admin") return 2;
    if (value === "manager") return 1;
    return 0;
  };
  const sorted = [...roles].sort((a, b) => rank(b.role) - rank(a.role));
  return sorted[0]?.storeId ?? null;
}

function normalizeRolesPayload(rawRoles: unknown, fallbackUid: string): UserStoreRole[] {
  if (!Array.isArray(rawRoles)) {
    return [];
  }

  return rawRoles
    .map((roleCandidate) => {
      if (!roleCandidate || typeof roleCandidate !== "object") {
        return null;
      }
      const record = roleCandidate as Record<string, unknown>;
      const storeId = typeof record["storeId"] === "string" ? (record["storeId"] as string) : null;
      const roleName = typeof record["role"] === "string" ? (record["role"] as string) : null;
      if (!storeId || !roleName) {
        return null;
      }
      const uid = typeof record["uid"] === "string" ? (record["uid"] as string) : fallbackUid;
      const id = typeof record["id"] === "string" ? (record["id"] as string) : `${uid}:${storeId}`;
      const flags = Array.isArray(record["flags"])
        ? (record["flags"] as unknown[]).filter((flag): flag is PermissionFlag => typeof flag === "string")
        : [];
      const normalized: UserStoreRole = {
        id,
        uid,
        storeId,
        role: roleName,
        flags,
      };
      return normalized;
    })
    .filter((role): role is UserStoreRole => Boolean(role));
}

async function fetchRolesFromFirestore(uid: string): Promise<UserStoreRole[]> {
  const rolesQuery = query(collection(db, "userStoreRoles"), where("uid", "==", uid));
  const snapshot = await getDocs(rolesQuery);
  return snapshot.docs.map((doc: QueryDocumentSnapshot<DocumentData>) => {
    const data = doc.data();
    const flags = Array.isArray(data.flags)
      ? (data.flags as unknown[]).filter((flag): flag is PermissionFlag => typeof flag === "string")
      : [];
    return {
      id: doc.id,
      uid: data.uid as string,
      storeId: data.storeId as string,
      role: data.role as string,
      flags,
    } satisfies UserStoreRole;
  });
}

function clearLocalSelectedStore(): void {
  try {
    localStorage.removeItem("selectedStoreId");
  } catch {
    // ignore storage failures
  }
}

export default function SplashPage(): ReactNode {
  const router = useRouter();
  const params = useSearchParams();
  const dispatch = useAppDispatch();
  const [message, setMessage] = useState("Checking your session...");
  const navigatingRef = useRef(false);

  useEffect(() => {
    let canceled = false;

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (canceled) {
        return;
      }

      if (!firebaseUser) {
        dispatch(clearUser());
        dispatch(clearUserStoreRoles());
        dispatch(clearSelectedStoreId());
        dispatch(clearPermissionsPreload());
        clearLocalSelectedStore();
        const nextUrl = encodeURIComponent(resolveNextUrl(params));
        router.replace(`/login?next=${nextUrl}`);
        return;
      }

      if (navigatingRef.current) {
        return;
      }
      navigatingRef.current = true;

      dispatch(setUserLoading());
      setMessage("Loading your workspace...");

      try {
        const idToken = await firebaseUser.getIdToken();
        if (canceled) {
          return;
        }

        const response = await fetch("/api/users/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${idToken}` },
          cache: "no-store",
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Profile request failed: ${response.status} ${errorText}`);
        }

        const payload = await response.json();
        if (canceled) {
          return;
        }

        dispatch(
          setUser({
            uid: payload.uid,
            email: payload.email ?? null,
            displayName: payload.displayName ?? null,
            photoURL: payload.photoURL ?? null,
            providerIds: Array.isArray(payload.providerIds) ? payload.providerIds : [],
            lastLoginAt: payload.lastLoginAt ?? null,
          }),
        );

        const rawPermissions = payload.userPermissions ?? null;
        const permissionsStoreIds = Array.isArray(rawPermissions?.storeIds)
          ? (rawPermissions.storeIds as unknown[]).filter((id): id is string => typeof id === "string")
          : [];
        const permissionsFlags = Array.isArray(rawPermissions?.flags)
          ? (rawPermissions.flags as unknown[]).filter((flag): flag is PermissionFlag => typeof flag === "string")
          : [];
        const permissionsActiveStoreId =
          typeof rawPermissions?.activeStoreId === "string" ? (rawPermissions.activeStoreId as string) : null;

        dispatch(
          setPermissionsPreload({
            userId: payload.uid ?? firebaseUser.uid,
            storeIds: permissionsStoreIds,
            flags: permissionsFlags,
            activeStoreId: permissionsActiveStoreId,
            fetchedAt: Date.now(),
          }),
        );

        let roles = normalizeRolesPayload(payload.roles, firebaseUser.uid);
        if (!roles.length) {
          try {
            roles = await fetchRolesFromFirestore(firebaseUser.uid);
          } catch (roleError) {
            console.warn("[splash] failed to load roles, continuing with empty list", roleError);
            roles = [];
          }
        }
        if (canceled) {
          return;
        }

        dispatch(setUserStoreRoles(roles));

        const fallbackStoreId = permissionsStoreIds[0] ?? null;
        const initialStoreId = permissionsActiveStoreId ?? pickInitialStoreId(roles) ?? fallbackStoreId;

        if (initialStoreId) {
          dispatch(setSelectedStoreId(initialStoreId));
          try {
            localStorage.setItem("selectedStoreId", initialStoreId);
          } catch {
            // ignore storage failures
          }
        } else {
          dispatch(clearSelectedStoreId());
          clearLocalSelectedStore();
        }

        const nextUrl = resolveNextUrl(params);
        const shouldOnboard = permissionsStoreIds.length === 0 && roles.length === 0;
        const targetUrl = shouldOnboard ? "/onboarding" : nextUrl;

        router.replace(targetUrl);
      } catch (error) {
        console.error("[splash] failed to initialise session", error);
        dispatch(setUserError("Failed to initialize session"));
        dispatch(clearUserStoreRoles());
        dispatch(clearSelectedStoreId());
        dispatch(clearPermissionsPreload());
        clearLocalSelectedStore();
        try {
          await auth.signOut();
        } catch (signOutError) {
          console.warn("[splash] signOut failed", signOutError);
        }
        const nextUrl = encodeURIComponent(resolveNextUrl(params));
        router.replace(`/login?next=${nextUrl}`);
      }
    });

    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [dispatch, params, router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50 px-6 text-center">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-neutral-600">Kazuki Finance Platform</p>
        <p className="text-lg font-semibold text-neutral-900">Preparing your workspace...</p>
        <p className="text-sm text-neutral-500">{message}</p>
      </div>
      <div
        className="h-12 w-12 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600"
        aria-hidden
      />
    </main>
  );
}
