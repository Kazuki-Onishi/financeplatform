"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { onSnapshot, type DocumentSnapshot, type QuerySnapshot } from "firebase/firestore";
import { auth } from "../firebase/client";
import { useAppSelector } from "../state/store";
import { roleTemplatesCollection, userPermissionsDoc } from "../firestoreRefs";
import {
  applyPermissionsPatch,
  clearOptimistic,
  removeMemberships,
  setActiveStoreId,
  usePermissionsStore,
} from "../state/userPermissionsStore";
import type {
  OptimisticMembership,
} from "../state/userPermissionsStore";
import type {
  PermissionFlag,
  RoleTemplateDoc,
  RoleTemplateRecord,
  UserPermissionsDoc,
  UserPermissionsState,
} from "../../types/permissions";
export interface UseUserPermissionsResult {
  loading: boolean;
  error: Error | null;
  permissions: UserPermissionsState | null;
  roleTemplates: RoleTemplateRecord[];
  optimisticMemberships: OptimisticMembership[];
  confirmed: boolean;
  authReady: boolean;
  currentUid: string | null;
  hasPreload: boolean;
}

export interface PermissionsPreloadInput {
  userId?: string | null;
  storeIds?: string[];
  flags?: Array<PermissionFlag | string> | Record<string, unknown> | null;
  activeStoreId?: string | null;
}

interface NormalizedPermissionsPreload {
  userId: string | null;
  storeIds: string[];
  flags: PermissionFlag[];
  activeStoreId: string | null;
}

function normalizePermissionsPreload(
  preload?: PermissionsPreloadInput | (PermissionsPreloadInput & { hasData?: boolean }),
): NormalizedPermissionsPreload | null {
  if (!preload) {
    return null;
  }

  const maybeHasData = (preload as { hasData?: boolean }).hasData;
  if (typeof maybeHasData === "boolean" && !maybeHasData) {
    return null;
  }

  const storeIds = Array.isArray(preload.storeIds)
    ? preload.storeIds.filter((id): id is string => typeof id === "string")
    : [];

  let flags: PermissionFlag[] = [];
  if (Array.isArray(preload.flags)) {
    flags = preload.flags.filter((flag): flag is PermissionFlag => typeof flag === "string");
  } else if (preload.flags && typeof preload.flags === "object") {
    flags = Object.entries(preload.flags)
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key)
      .filter((key): key is PermissionFlag => typeof key === "string");
  }

  const activeStoreId =
    typeof preload.activeStoreId === "string" || preload.activeStoreId === null
      ? preload.activeStoreId ?? null
      : null;

  const userId = typeof preload.userId === "string" ? preload.userId : null;

  return {
    userId,
    storeIds,
    flags: mergeUnique(flags),
    activeStoreId,
  };
}

function mapRoleTemplates(snapshot: QuerySnapshot<RoleTemplateDoc>): RoleTemplateRecord[] {
  return snapshot.docs.map((docSnapshot) => ({
    id: docSnapshot.id,
    ...docSnapshot.data(),
  }));
}
function mapUserPermissions(
  userId: string,
  snapshot: DocumentSnapshot<UserPermissionsDoc>,
  fallbackActiveStoreId: string | null,
): UserPermissionsState {
  if (!snapshot.exists()) {
    return {
      userId,
      storeIds: [],
      flags: [],
      activeStoreId: fallbackActiveStoreId ?? null,
    };
  }
  const data = snapshot.data();
  return {
    userId,
    storeIds: data.storeIds ?? [],
    flags: data.flags ?? [],
    activeStoreId: data.activeStoreId ?? fallbackActiveStoreId ?? null,
  };
}
function mergeUnique<T>(values: Iterable<T>): T[] {
  return Array.from(new Set(values));
}
export function useUserPermissions(preload?: PermissionsPreloadInput): UseUserPermissionsResult {
  const permissionsPreloadState = useAppSelector((state) => state.permissions);
  const storePreload = permissionsPreloadState.hasData ? permissionsPreloadState : undefined;
  const normalizedPreload = useMemo(
    () => normalizePermissionsPreload(preload ?? storePreload),
    [preload, storePreload],
  );
  const initialServerPermissions = useMemo<UserPermissionsState | null>(() => {
    if (!normalizedPreload) {
      return null;
    }
    return {
      userId: normalizedPreload.userId ?? auth.currentUser?.uid ?? "",
      storeIds: normalizedPreload.storeIds,
      flags: normalizedPreload.flags,
      activeStoreId: normalizedPreload.activeStoreId ?? null,
    };
  }, [normalizedPreload]);

  const { state: localState, dispatch } = usePermissionsStore();
  const [serverPermissions, setServerPermissions] = useState<UserPermissionsState | null>(initialServerPermissions);
  const serverPermissionsRef = useRef<UserPermissionsState | null>(initialServerPermissions);
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplateRecord[]>([]);
  const [loading, setLoading] = useState(() => !initialServerPermissions);
  const [error, setError] = useState<Error | null>(null);
  const [confirmed, setConfirmed] = useState(() => Boolean(initialServerPermissions));
  const [firebaseUser, setFirebaseUser] = useState<User | null>(auth.currentUser ?? null);
  const [authReady, setAuthReady] = useState(() => auth.currentUser !== null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(initialServerPermissions?.userId ?? null);
  const currentUserIdRef = useRef<string | null>(initialServerPermissions?.userId ?? null);
  const logRef = useRef<string | null>(null);
  const activeStoreFallbackRef = useRef<string | null>(
    localState.activeStoreId ?? initialServerPermissions?.activeStoreId ?? null,
  );
  const patchRef = useRef(localState.patch);
  const optimisticRef = useRef(localState.optimisticMemberships);
  const authUserRef = useRef<string | null>(initialServerPermissions?.userId ?? null);
  const preloadSignature = useMemo(
    () => (normalizedPreload ? JSON.stringify(normalizedPreload) : null),
    [normalizedPreload],
  );
  const preloadAppliedRef = useRef<string | null>(null);
  const hasPreload = Boolean(normalizedPreload);

  useEffect(() => {
    if (!normalizedPreload) {
      preloadAppliedRef.current = null;
      return;
    }
    if (preloadAppliedRef.current === preloadSignature) {
      return;
    }
    preloadAppliedRef.current = preloadSignature;
    const nextUserId = normalizedPreload.userId ?? auth.currentUser?.uid ?? authUserRef.current ?? "";
    const nextPermissions: UserPermissionsState = {
      userId: nextUserId || "",
      storeIds: normalizedPreload.storeIds,
      flags: normalizedPreload.flags,
      activeStoreId: normalizedPreload.activeStoreId ?? null,
    };
    serverPermissionsRef.current = nextPermissions;
    setServerPermissions(nextPermissions);
    setLoading(false);
    setError(null);
    setConfirmed(true);
    const nextActive = normalizedPreload.activeStoreId ?? null;
    activeStoreFallbackRef.current = nextActive;
    if (localState.activeStoreId !== nextActive) {
      dispatch(setActiveStoreId(nextActive));
    }
    if (nextUserId) {
      authUserRef.current = nextUserId;
      if (currentUserIdRef.current !== nextUserId) {
        setCurrentUserId(nextUserId);
      }
      currentUserIdRef.current = nextUserId;
    }
  }, [
    normalizedPreload,
    preloadSignature,
    dispatch,
    localState.activeStoreId,
  ]);

  useEffect(() => {
    activeStoreFallbackRef.current = localState.activeStoreId;
  }, [localState.activeStoreId]);
  useEffect(() => {
    patchRef.current = localState.patch;
  }, [localState.patch]);
  useEffect(() => {
    optimisticRef.current = localState.optimisticMemberships;
  }, [localState.optimisticMemberships]);
  useEffect(() => {
    console.info("[listen] start", { key: "roleTemplates" });
    const unsubscribeTemplates = onSnapshot(
      roleTemplatesCollection(),
      (snapshot) => {
        setRoleTemplates(mapRoleTemplates(snapshot));
      },
      (err) => {
        console.error("Failed to load role templates", err);
        setError(err);
      },
    );
    return () => {
      console.info("[listen] stop", { key: "roleTemplates" });
      unsubscribeTemplates();
    };
  }, []);
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
    });
    return () => {
      unsubscribe();
    };
  }, []);
  const firebaseUid = firebaseUser?.uid ?? null;

  useEffect(() => {
    if (!authReady) {
      return () => {};
    }
    if (!firebaseUid) {
      authUserRef.current = null;
      currentUserIdRef.current = null;
      setCurrentUserId(null);
      serverPermissionsRef.current = null;
      setServerPermissions(null);
      setConfirmed(false);
      setLoading(false);
      setError(null);
      dispatch(clearOptimistic());
      return () => {};
    }

    const userId = firebaseUid;

    if (authUserRef.current && authUserRef.current !== userId) {
      dispatch(clearOptimistic());
    }

    authUserRef.current = userId;
    if (currentUserIdRef.current !== userId) {
      setCurrentUserId(userId);
    }
    currentUserIdRef.current = userId;

    const currentServer = serverPermissionsRef.current;
    const hasServerForUser = currentServer?.userId === userId;
    if (currentServer && !hasServerForUser) {
      const nextPermissions = { ...currentServer, userId };
      serverPermissionsRef.current = nextPermissions;
      setServerPermissions(nextPermissions);
    }
    if (!hasServerForUser) {
      setLoading(true);
    }

    console.info("[listen] start", { key: "userPermissions", userId });

    const unsubscribePermissions = onSnapshot(
      userPermissionsDoc(userId),
      (snapshot) => {
        const mapped = mapUserPermissions(userId, snapshot, activeStoreFallbackRef.current);
        serverPermissionsRef.current = mapped;
        setServerPermissions(mapped);
        setLoading(false);
        setError(null);
        setConfirmed(true);
        if (mapped.activeStoreId !== undefined) {
          dispatch(setActiveStoreId(mapped.activeStoreId ?? null));
        }
        const pendingPatch = patchRef.current;
        if (pendingPatch) {
          const missing = pendingPatch.storeIds.filter((storeId) => !mapped.storeIds.includes(storeId));
          if (missing.length === 0) {
            dispatch(applyPermissionsPatch(null));
          }
        }
        const optimisticMemberships = optimisticRef.current;
        const optimisticStoreIds = Object.keys(optimisticMemberships);
        if (optimisticStoreIds.length) {
          const confirmedStoreIds = optimisticStoreIds.filter((storeId) => mapped.storeIds.includes(storeId));
          if (confirmedStoreIds.length) {
            dispatch(removeMemberships(confirmedStoreIds));
          }
        }
      },
      (err) => {
        console.error("Failed to load permissions", err);
        const fallbackPermissions: UserPermissionsState = {
          userId,
          storeIds: [],
          flags: [],
          activeStoreId: activeStoreFallbackRef.current ?? null,
        };
        serverPermissionsRef.current = fallbackPermissions;
        setServerPermissions(fallbackPermissions);
        setLoading(false);
        setError(err);
        setConfirmed(false);
      },
    );
    return () => {
      console.info("[listen] stop", { key: "userPermissions", userId });
      unsubscribePermissions();
    };
  }, [authReady, firebaseUid, dispatch]);

  const optimisticMemberships = useMemo(() => {
    const memberships = Object.values(localState.optimisticMemberships);
    if (memberships.length <= 1) {
      return memberships;
    }
    return [...memberships].sort((a, b) => a.createdAt - b.createdAt);
  }, [localState.optimisticMemberships]);
  const derivedPermissions = useMemo(() => {
    if (!authReady) {
      return null;
    }
    const storeIds = mergeUnique([
      ...(serverPermissions?.storeIds ?? []),
      ...(localState.patch?.storeIds ?? []),
      ...optimisticMemberships.map((membership) => membership.storeId),
    ]);
    const flags = mergeUnique<PermissionFlag>([
      ...(serverPermissions?.flags ?? []),
      ...(localState.patch?.flags ?? []),
      ...optimisticMemberships.flatMap((membership) => membership.flags),
    ]);
    if (!serverPermissions && !storeIds.length && !flags.length) {
      return null;
    }
    const userId = serverPermissions?.userId ?? currentUserId ?? authUserRef.current ?? null;
    const activeStoreId = localState.activeStoreId ?? serverPermissions?.activeStoreId ?? null;
    return {
      userId: userId ?? "",
      storeIds,
      flags,
      activeStoreId,
    } satisfies UserPermissionsState;
  }, [authReady, serverPermissions, localState.patch, localState.activeStoreId, optimisticMemberships, currentUserId]);
  const resolvedCurrentUid = currentUserId ?? authUserRef.current ?? null;

  useEffect(() => {
    if (!authReady || !derivedPermissions) {
      logRef.current = null;
      return;
    }
    const key = JSON.stringify({
      flags: derivedPermissions.flags,
      storeIds: derivedPermissions.storeIds,
      active: derivedPermissions.activeStoreId,
      optimistic: optimisticMemberships.map((membership) => membership.storeId).sort(),
    });
    if (logRef.current === key) {
      return;
    }
    logRef.current = key;
    console.info("[receipts] user permissions", {
      flags: derivedPermissions.flags,
      storeIds: derivedPermissions.storeIds,
      activeStoreId: derivedPermissions.activeStoreId,
      optimisticMemberships: optimisticMemberships.map((membership) => membership.storeId),
    });
  }, [authReady, derivedPermissions, optimisticMemberships]);
  const effectiveLoading = loading && !localState.patch && !optimisticMemberships.length;
  return {
    loading: effectiveLoading,
    error: authReady ? error : null,
    permissions: authReady ? derivedPermissions : null,
    roleTemplates,
    optimisticMemberships,
    confirmed,
    authReady,
    currentUid: resolvedCurrentUid,
    hasPreload,
  };
}

