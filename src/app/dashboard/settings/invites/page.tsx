"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { auth } from "@/lib/firebase/client";
import { useUserPermissions } from "@/lib/hooks/useUserPermissions";
import type { PermissionFlag } from "@/types/permissions";
import type { StoreMemberRole } from "@/types/store";

interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

interface InviteListItem {
  id: string;
  token: string;
  code: string;
  link: string;
  role: StoreMemberRole;
  flags: PermissionFlag[];
  status: string;
  used: number;
  maxUses: number;
  createdAt: string;
  expiresAt: string;
  note: string | null;
}

interface InviteFormState {
  role: StoreMemberRole;
  flags: PermissionFlag[];
  maxUses: string;
  expiresInDays: string;
  note: string;
}

const ROLE_OPTIONS: Array<{ value: StoreMemberRole; label: string; description: string }> = [
  { value: "owner", label: "Owner", description: "Full access. Grants all permissions including invites." },
  { value: "manager", label: "Manager", description: "Upload, review, and manage cards/vendors." },
  { value: "staff", label: "Staff", description: "Upload receipts and edit basic details." },
  { value: "viewer", label: "Viewer", description: "Read-only access." },
];

const FLAG_OPTIONS: Array<{ value: PermissionFlag; label: string; description: string }> = [
  { value: "perm.upload", label: "Upload", description: "Allow uploading receipts." },
  { value: "perm.editFields", label: "Edit Fields", description: "Allow editing receipt metadata." },
  { value: "perm.view", label: "View", description: "Permit viewing receipts." },
  { value: "perm.exportCsv", label: "Export CSV", description: "Enable CSV exports." },
  { value: "perm.lock", label: "Lock", description: "Allow locking receipts." },
  { value: "perm.unlock", label: "Unlock", description: "Allow unlocking receipts." },
  { value: "perm.manageCards", label: "Manage Cards", description: "Grant access to card registry." },
  { value: "perm.manageVendors", label: "Manage Vendors", description: "Grant access to vendor catalogue." },
];

const EXPIRES_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "0", label: "No expiry" },
];

function formatDate(value: string): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function uniqueFlags(flags: PermissionFlag[]): PermissionFlag[] {
  return Array.from(new Set(flags));
}

export default function SettingsInvitesPage(): JSX.Element {
  const {
    permissions,
    loading: permissionsLoading,
    authReady,
  } = useUserPermissions();

  const storeIds = useMemo(() => permissions?.storeIds ?? [], [permissions?.storeIds]);

  const [selectedStoreId, setSelectedStoreId] = useState<string>("");

  const [invites, setInvites] = useState<InviteListItem[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesError, setInvitesError] = useState<string | null>(null);

  const [formState, setFormState] = useState<InviteFormState>({
    role: "staff",
    flags: ["perm.upload", "perm.view"],
    maxUses: "1",
    expiresInDays: "7",
    note: "",
  });
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const pushToast = useCallback((type: ToastMessage["type"], message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);

  useEffect(() => {
    if (!storeIds.length) {
      setSelectedStoreId("");
      return;
    }
    setSelectedStoreId((current) => (current && storeIds.includes(current) ? current : storeIds[0]));
  }, [storeIds]);

  const storeName = useMemo(() => (selectedStoreId ? selectedStoreId : ""), [selectedStoreId]);

  const handleLoadInvites = useCallback(
    async (storeId: string) => {
      if (!storeId) {
        setInvites([]);
        setInvitesError(null);
        return;
      }
      const user = auth.currentUser;
      if (!user) {
        setInvitesError("You must be signed in to manage invites.");
        setInvites([]);
        return;
      }
      setInvitesLoading(true);
      setInvitesError(null);
      try {
        const idToken = await user.getIdToken();
        const response = await fetch(`/api/stores/${encodeURIComponent(storeId)}/invites`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${idToken}`,
          },
        });
        const payload = (await response.json().catch(() => null)) as { invites?: InviteListItem[]; error?: string } | null;
        if (!response.ok || !payload || !payload.invites) {
          const message = payload?.error ?? "Failed to load invites.";
          setInvitesError(message);
          setInvites([]);
          if (response.status === 403) {
            pushToast("error", "You do not have permission to manage invites for this store.");
          }
          return;
        }
        const mapped = payload.invites.map((invite) => ({
          ...invite,
          role: invite.role as StoreMemberRole,
          flags: Array.isArray(invite.flags) ? (invite.flags as PermissionFlag[]) : [],
          status: invite.status,
        }));
        setInvites(mapped);
      } catch (error) {
        console.error("[settings] failed to load invites", error);
        setInvitesError("Network error while loading invites.");
        setInvites([]);
      } finally {
        setInvitesLoading(false);
      }
    },
    [pushToast],
  );

  useEffect(() => {
    if (!selectedStoreId) {
      return;
    }
    void handleLoadInvites(selectedStoreId);
  }, [selectedStoreId, handleLoadInvites]);

  const toggleFlag = useCallback((flag: PermissionFlag) => {
    setFormState((prev) => {
      const hasFlag = prev.flags.includes(flag);
      const nextFlags = hasFlag ? prev.flags.filter((item) => item !== flag) : [...prev.flags, flag];
      return { ...prev, flags: uniqueFlags(nextFlags) };
    });
  }, []);

  const handleCreateInvite = useCallback(async () => {
    const storeId = selectedStoreId;
    if (!storeId) {
      pushToast("error", "Select a store first.");
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      pushToast("error", "You must be signed in to manage invites.");
      return;
    }

    const maxUsesRaw = formState.maxUses.trim();
    const maxUsesValue = Number.parseInt(maxUsesRaw, 10);
    const maxUses = Number.isNaN(maxUsesValue) ? 1 : Math.max(0, maxUsesValue);

    let expiresAt: string | null = null;
    if (formState.expiresInDays !== "0") {
      const days = Number.parseInt(formState.expiresInDays, 10);
      if (!Number.isNaN(days) && days > 0) {
        const now = new Date();
        now.setDate(now.getDate() + days);
        expiresAt = now.toISOString();
      }
    }

    const note = formState.note.trim() ? formState.note.trim().slice(0, 160) : undefined;

    setCreating(true);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch(`/api/stores/${encodeURIComponent(storeId)}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          role: formState.role,
          flags: formState.flags,
          maxUses,
          expiresAt,
          note,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!response.ok || !payload?.id) {
        const message = payload?.error ?? "Failed to create invite.";
        pushToast("error", message);
        return;
      }
      pushToast("success", "Invite created.");
      setFormState((prev) => ({
        ...prev,
        maxUses: "1",
        note: "",
      }));
      await handleLoadInvites(storeId);
    } catch (error) {
      console.error("[settings] failed to create invite", error);
      pushToast("error", "Network error while creating invite.");
    } finally {
      setCreating(false);
    }
  }, [formState, handleLoadInvites, pushToast, selectedStoreId]);

  const handleCopyLink = useCallback((invite: InviteListItem) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const fullLink = origin ? `${origin}${invite.link}` : invite.link;
    if (navigator?.clipboard) {
      navigator.clipboard
        .writeText(fullLink)
        .then(() => pushToast("success", "Invite link copied."))
        .catch(() => pushToast("error", "Failed to copy link."));
    } else {
      pushToast("info", fullLink);
    }
  }, [pushToast]);

  const handleRevoke = useCallback(
    async (invite: InviteListItem) => {
      if (!selectedStoreId) {
        return;
      }
      const user = auth.currentUser;
      if (!user) {
        pushToast("error", "You must be signed in to manage invites.");
        return;
      }
      const confirm = window.confirm("Revoke this invite? Users will no longer be able to join with this link.");
      if (!confirm) {
        return;
      }
      setRevokingId(invite.id);
      try {
        const idToken = await user.getIdToken();
        const response = await fetch(
          `/api/stores/${encodeURIComponent(selectedStoreId)}/invites/${encodeURIComponent(invite.id)}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${idToken}`,
            },
          },
        );
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          const message = payload?.error ?? "Failed to revoke invite.";
          pushToast("error", message);
          return;
        }
        pushToast("success", "Invite revoked.");
        setInvites((prev) => prev.map((item) => (item.id === invite.id ? { ...item, status: "revoked" } : item)));
      } catch (error) {
        console.error("[settings] failed to revoke invite", error);
        pushToast("error", "Network error while revoking invite.");
      } finally {
        setRevokingId(null);
      }
    },
    [pushToast, selectedStoreId],
  );

  const hasStores = storeIds.length > 0;
  const disableActions = !authReady || permissionsLoading || !selectedStoreId;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-neutral-900">Team invitations</h1>
        <p className="text-sm text-neutral-600">
          Issue invite links for teammates. Invitees can accept via the generated link and will be granted the
          selected role and permissions.
        </p>
        <p className="text-xs text-neutral-500">
          Invites require owner access or a role with locking/manage vendor permissions.
        </p>
      </div>

      {!hasStores ? (
        <div className="rounded border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
          You do not have access to any stores yet. Create a store or accept an invitation to begin managing team
          members.
        </div>
      ) : null}

      {hasStores ? (
        <section className="flex flex-col gap-3 rounded border border-neutral-200 p-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-neutral-700" htmlFor="invite-store">
              Store
            </label>
            <select
              id="invite-store"
              className="max-w-md rounded border border-neutral-300 px-3 py-2 text-sm"
              value={selectedStoreId}
              onChange={(event) => setSelectedStoreId(event.target.value)}
              disabled={permissionsLoading}
            >
              {storeIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <span>Selected store:</span>
            <span className="rounded bg-neutral-100 px-2 py-1 font-medium text-neutral-700">{storeName}</span>
          </div>
        </section>
      ) : null}

      {hasStores ? (
        <section className="flex flex-col gap-4 rounded border border-neutral-200 p-4">
          <h2 className="text-lg font-semibold text-neutral-900">Create invite</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">Role</span>
              <select
                value={formState.role}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, role: event.target.value as StoreMemberRole }))
                }
                disabled={disableActions || creating}
                className="rounded border border-neutral-300 px-3 py-2"
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-neutral-400">
                {ROLE_OPTIONS.find((option) => option.value === formState.role)?.description ?? ""}
              </span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">Max uses</span>
              <input
                type="number"
                min={0}
                value={formState.maxUses}
                onChange={(event) => setFormState((prev) => ({ ...prev, maxUses: event.target.value }))}
                disabled={disableActions || creating}
                className="rounded border border-neutral-300 px-3 py-2"
              />
              <span className="text-xs text-neutral-400">Use 0 for unlimited.
              </span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">Expires</span>
              <select
                value={formState.expiresInDays}
                onChange={(event) => setFormState((prev) => ({ ...prev, expiresInDays: event.target.value }))}
                disabled={disableActions || creating}
                className="rounded border border-neutral-300 px-3 py-2"
              >
                {EXPIRES_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm md:col-span-2">
              <span className="text-neutral-500">Note (optional)</span>
              <input
                type="text"
                value={formState.note}
                onChange={(event) => setFormState((prev) => ({ ...prev, note: event.target.value }))}
                maxLength={160}
                disabled={disableActions || creating}
                className="rounded border border-neutral-300 px-3 py-2"
                placeholder="Visible internally to admins"
              />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-neutral-700">Permission flags</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {FLAG_OPTIONS.map((option) => {
                const checked = formState.flags.includes(option.value);
                return (
                  <label
                    key={option.value}
                    className="flex items-start gap-2 rounded border border-neutral-200 bg-neutral-50 p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disableActions || creating}
                      onChange={() => toggleFlag(option.value)}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium text-neutral-800">{option.label}</span>
                      <span className="block text-xs text-neutral-500">{option.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleCreateInvite}
              disabled={disableActions || creating}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
            >
              {creating ? "Creating invite..." : "Create invite"}
            </button>
            <button
              type="button"
              onClick={() =>
                setFormState({ role: "staff", flags: ["perm.upload", "perm.view"], maxUses: "1", expiresInDays: "7", note: "" })
              }
              disabled={disableActions || creating}
              className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reset
            </button>
          </div>
        </section>
      ) : null}

      {selectedStoreId ? (
        <section className="flex flex-col gap-3">
          <header className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900">Active invites</h2>
              <p className="text-xs text-neutral-500">Lists the latest 50 invites for {storeName}.</p>
            </div>
            <button
              type="button"
              onClick={() => handleLoadInvites(selectedStoreId)}
              disabled={invitesLoading}
              className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {invitesLoading ? "Refreshing..." : "Refresh"}
            </button>
          </header>

          {invitesError ? (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{invitesError}</div>
          ) : null}

          <div className="divide-y divide-neutral-200 rounded border border-neutral-200">
            {!invites.length && !invitesLoading ? (
              <p className="px-4 py-6 text-sm text-neutral-500">No invites yet.</p>
            ) : null}
            {invites.map((invite) => (
              <div key={invite.id} className="flex flex-col gap-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-semibold text-neutral-900">{invite.code}</span>
                  <span className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600">{invite.role}</span>
                  <span
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      invite.status === "active"
                        ? "bg-green-100 text-green-700"
                        : invite.status === "revoked"
                        ? "bg-red-100 text-red-700"
                        : "bg-neutral-100 text-neutral-600"
                    }`}
                  >
                    {invite.status}
                  </span>
                  <span className="text-xs text-neutral-500">
                    Uses: {invite.used}/{invite.maxUses === 0 ? "Unlimited" : invite.maxUses}
                  </span>
                </div>

                {invite.flags.length ? (
                  <div className="flex flex-wrap gap-2 text-[11px] uppercase text-neutral-500">
                    {invite.flags.map((flag) => (
                      <span key={flag} className="rounded bg-neutral-100 px-2 py-1">
                        {flag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-neutral-400">No extra flags granted.</span>
                )}

                {invite.note ? (
                  <p className="text-xs text-neutral-500">Note: {invite.note}</p>
                ) : null}

                <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
                  <span>Created: {formatDate(invite.createdAt)}</span>
                  <span>Expires: {invite.expiresAt ? formatDate(invite.expiresAt) : "No expiry"}</span>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => handleCopyLink(invite)}
                    className="rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-100"
                  >
                    Copy link
                  </button>
                  <Link
                    href={invite.link}
                    className="rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-100"
                    target="_blank"
                  >
                    Open link
                  </Link>
                  <button
                    type="button"
                    onClick={() => handleRevoke(invite)}
                    disabled={invite.status === "revoked" || revokingId === invite.id}
                    className="rounded border border-red-300 px-3 py-1 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {revokingId === invite.id ? "Revoking..." : "Revoke"}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {invitesLoading ? <p className="text-xs text-neutral-500">Loading invites...</p> : null}
        </section>
      ) : null}

      <div className="fixed inset-x-0 bottom-4 flex justify-center">
        <div className="flex w-full max-w-sm flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`rounded border px-3 py-2 text-sm shadow ${
                toast.type === "success"
                  ? "border-green-200 bg-green-50 text-green-800"
                  : toast.type === "error"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-neutral-200 bg-neutral-50 text-neutral-700"
              }`}
            >
              {toast.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}





