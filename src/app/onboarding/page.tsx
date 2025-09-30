"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { auth } from "@/lib/firebase/client";
import { useUserPermissions } from "@/lib/hooks/useUserPermissions";
import { useAppSelector } from "@/lib/state/store";
import { coercePermissionFlags, normalizeStoreMemberRole } from "@/lib/permissions";
import {
  applyPermissionsPatch,
  setActiveStoreId,
  upsertMembership,
  usePermissionsStore,
} from "@/lib/state/userPermissionsStore";

interface AcceptResponse {
  storeId: string;
  role: string;
  perms: string[];
  userPermissions?: {
    storeIds?: string[];
    activeStoreId?: string | null;
    flags?: string[];
  };
}

const SYNC_TIMEOUT_MS = 10_000;

export default function OnboardingPage() {
  const router = useRouter();
  const { permissions, loading, confirmed, authReady, currentUid, hasPreload } = useUserPermissions();
  const preloadPermissions = useAppSelector((state) => state.permissions);
  const sameUserPreload =
    hasPreload &&
    preloadPermissions.hasData &&
    (preloadPermissions.userId === null || currentUid === null || preloadPermissions.userId === currentUid);
  const preloadStoreIds = useMemo(() => {
    if (!sameUserPreload) {
      return [];
    }
    return preloadPermissions.storeIds;
  }, [sameUserPreload, preloadPermissions.storeIds]);
  const storeIds = useMemo(() => {
    if (preloadStoreIds.length) {
      return preloadStoreIds;
    }
    return permissions?.storeIds ?? [];
  }, [preloadStoreIds, permissions?.storeIds]);
  const onboardingBusy = (!sameUserPreload && !authReady) || (loading && !sameUserPreload);
  const redirectedRef = useRef(false);
  const { dispatch } = usePermissionsStore();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);
  const [syncExceeded, setSyncExceeded] = useState(false);

  const searchParams = useSearchParams();
  const forceJoin = searchParams.get("intent") === "join";

  useEffect(() => {
    if (onboardingBusy || redirectedRef.current || forceJoin) {
      return;
    }
    if (storeIds.length) {
      redirectedRef.current = true;
      router.replace("/dashboard/upload");
    }
  }, [onboardingBusy, storeIds, router, forceJoin]);

  useEffect(() => {
    if (!syncStartedAt) {
      setSyncExceeded(false);
      return;
    }
    if (confirmed) {
      setSyncStartedAt(null);
      setSyncExceeded(false);
      return;
    }
    const timer = window.setTimeout(() => setSyncExceeded(true), SYNC_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [syncStartedAt, confirmed]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setInfo(null);

    const trimmed = code.trim();
    if (!trimmed) {
      setError("Invite code is required.");
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      setError("Please sign in to join a store.");
      return;
    }
    setSubmitting(true);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/invites/accept", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ code: trimmed }),
      });

      const payload = (await response.json().catch(() => null)) as AcceptResponse | { error?: string } | null;
      if (!response.ok || !payload || typeof payload !== "object" || !("storeId" in payload)) {
        const message = (payload as { error?: string } | null)?.error ?? "Failed to accept invite.";
        setError(message);
        return;
      }

      const { storeId, role, perms, userPermissions } = payload as AcceptResponse;
      const flags = coercePermissionFlags(perms);
      const fallbackFlags = coercePermissionFlags(userPermissions?.flags);
      const effectiveFlags = fallbackFlags.length ? fallbackFlags : flags;
      const normalizedRole = normalizeStoreMemberRole(role, "viewer");

      dispatch(setActiveStoreId(storeId));
      dispatch(
        applyPermissionsPatch({
          storeIds: userPermissions?.storeIds ?? [storeId],
          flags: effectiveFlags,
          activeStoreId: userPermissions?.activeStoreId ?? storeId,
        }),
      );
      dispatch(
        upsertMembership({
          storeId,
          role: normalizedRole,
          flags,
          source: "invite",
        }),
      );

      setInfo("Invite accepted. Redirecting to upload...");
      setSyncStartedAt(Date.now());
      setSyncExceeded(false);

      router.replace(`/dashboard/upload?store=${encodeURIComponent(storeId)}&joined=1`);
    } catch (err) {
      console.error("Failed to accept invite", err);
      setError("Network error while accepting invite.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateStore = () => {
    router.push("/stores/new");
  };

  const handleRefresh = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const user = auth.currentUser;
      if (user) {
        await user.getIdToken(true);
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const isSignedIn = Boolean(auth.currentUser);

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Join or create a store</h1>
        <p className="text-sm text-neutral-500">
          Enter an invite code to join an existing store, or create a new store to get started immediately.
        </p>
      </header>

      {!isSignedIn ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          Please sign in to continue.
          <button type="button" onClick={() => router.push("/login")} className="ml-2 underline">
            Sign in
          </button>
        </div>
      ) : null}

      <section className="rounded border border-neutral-200 p-4">
        <h2 className="text-lg font-medium">Join an existing store</h2>
        <p className="mt-1 text-sm text-neutral-500">Enter the invite code you received from a teammate.</p>
        <form className="mt-4 flex flex-col gap-3" onSubmit={handleSubmit}>
          <label className="text-sm font-medium" htmlFor="invite-code">
            Invite code
          </label>
          <input
            id="invite-code"
            className="w-full rounded border border-neutral-300 px-3 py-2 text-sm uppercase"
            placeholder="ABCD-EFGH"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={submitting || !isSignedIn}
          />
          <button
            type="submit"
            disabled={submitting || !isSignedIn}
            className="inline-flex w-fit items-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Joining..." : "Join store"}
          </button>
        </form>
      </section>

      <section className="rounded border border-neutral-200 p-4">
        <h2 className="text-lg font-medium">Create a new store</h2>
        <p className="mt-1 text-sm text-neutral-500">Start fresh and invite teammates once your store is ready.</p>
        <button
          type="button"
          onClick={handleCreateStore}
          disabled={submitting}
          className="mt-4 inline-flex items-center rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Create store
        </button>
      </section>

      {syncStartedAt && !confirmed ? (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700">Syncing membership...</span>
          {syncExceeded ? (
            <button type="button" className="text-blue-600 underline" onClick={handleRefresh} disabled={submitting}>
              Reload
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : null}
      {info ? (
        <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">{info}</div>
      ) : null}

      <div className="text-xs text-neutral-400">
        If you already accepted an invite, refresh the page after 10 seconds if the dashboard does not unlock.
        <button type="button" onClick={handleRefresh} className="ml-1 underline disabled:opacity-60" disabled={submitting}>
          Refresh now
        </button>
      </div>
    </div>
  );
}
