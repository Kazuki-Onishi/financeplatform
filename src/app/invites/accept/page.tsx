"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { auth } from "@/lib/firebase/client";
import { useUserPermissions } from "@/lib/hooks/useUserPermissions";
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

export default function InviteAcceptPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { confirmed } = useUserPermissions();
  const { dispatch } = usePermissionsStore();
  const [status, setStatus] = useState<string>("Processing invite...");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);
  const [syncExceeded, setSyncExceeded] = useState(false);

  const token = params.get("token") ?? "";

  const isSyncing = Boolean(syncStartedAt && !confirmed);

  useEffect(() => {
    if (confirmed) {
      setSyncStartedAt(null);
    }
  }, [confirmed]);

  useEffect(() => {
    if (!isSyncing) {
      setSyncExceeded(false);
      return;
    }
    const timer = window.setTimeout(() => setSyncExceeded(true), SYNC_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [isSyncing]);

  useEffect(() => {
    const run = async () => {
      if (!token) {
        setStatus("Invite token is required.");
        return;
      }
      const user = auth.currentUser;
      if (!user) {
        setStatus("Please sign in to accept the invite.");
        return;
      }
      setSubmitting(true);
      setStatus("Accepting invite...");
      try {
        const idToken = await user.getIdToken();
        const response = await fetch("/api/invites/accept", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ token }),
        });
        const payload = (await response.json().catch(() => null)) as AcceptResponse | { error?: string } | null;
        if (!response.ok || !payload || typeof payload !== "object" || !("storeId" in payload)) {
          const message = (payload as { error?: string } | null)?.error ?? "Failed to accept invite.";
          setError(message);
          setStatus("Error");
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

        setStatus("Invite accepted! Redirecting to upload...");
        setSyncStartedAt(Date.now());
        setSyncExceeded(false);

        router.replace(`/dashboard/upload?store=${encodeURIComponent(storeId)}&joined=1`);
      } catch (err) {
        console.error("Failed to accept invite", err);
        setError("Network error while accepting invite.");
        setStatus("Error");
      } finally {
        setSubmitting(false);
      }
    };

    run().catch((err) => {
      console.error(err);
      setError("Unexpected error while accepting invite.");
      setStatus("Error");
    });
  }, [token, router, dispatch]);

  const handleGoLogin = () => {
    router.push(`/login?next=${encodeURIComponent(`/invites/accept?token=${token}`)}`);
  };

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col gap-4 px-6 py-10">
      <h1 className="text-2xl font-semibold">Accept Store Invite</h1>
      <p className="text-sm text-neutral-500">
        Invite token: <span className="font-mono">{token || "(missing)"}</span>
      </p>
      <p className="text-sm text-neutral-600">{status}</p>

      {isSyncing ? (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700">\u540C\u671F\u4E2D\u2026</span>
          {syncExceeded ? (
            <button
              type="button"
              className="text-blue-600 underline"
              onClick={() => router.refresh()}
            >
              \u518D\u8AAD\u307F\u8FBC\u307F
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : null}

      {!auth.currentUser ? (
        <button
          type="button"
          onClick={handleGoLogin}
          className="inline-flex w-fit items-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Sign in
        </button>
      ) : (
        <button
          type="button"
          disabled={submitting}
          onClick={() => router.push("/dashboard/upload")}
          className="inline-flex w-fit items-center rounded border border-neutral-300 px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Back to dashboard
        </button>
      )}
    </div>
  );
}






