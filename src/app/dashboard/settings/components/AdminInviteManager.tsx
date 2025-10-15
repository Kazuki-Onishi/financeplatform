"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createStoreInvite,
  fetchStoreInvites,
  revokeStoreInvite,
  type StoreInviteRecord,
} from "@/lib/api.client";
import type { StoreMemberRole } from "@/types/store";
import type { PermissionFlag } from "@/types/permissions";

const ROLE_OPTIONS: StoreMemberRole[] = ["owner", "manager", "staff", "viewer"];
const FLAG_OPTIONS: Array<{ value: PermissionFlag; label: string }> = [
  { value: "perm.upload", label: "Upload" },
  { value: "perm.editFields", label: "Edit" },
  { value: "perm.view", label: "View" },
  { value: "perm.exportCsv", label: "Export" },
  { value: "perm.lock", label: "Lock" },
  { value: "perm.unlock", label: "Unlock" },
  { value: "perm.manageCards", label: "Cards" },
  { value: "perm.manageVendors", label: "Vendors" },
  { value: "perm.manageMembers", label: "Members" },
];

interface InviteFormState {
  role: StoreMemberRole;
  flags: PermissionFlag[];
  maxUses: number;
  note: string;
  expiresAt: string;
}

interface AdminInviteManagerProps {
  stores: Array<{ id: string; name: string }>;
  selectedStoreId: string;
  onSelectStore: (storeId: string) => void;
  className?: string;
}

export function AdminInviteManager({ stores, selectedStoreId, onSelectStore, className }: AdminInviteManagerProps) {
  const [invites, setInvites] = useState<StoreInviteRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<InviteFormState>({ role: "staff", flags: [], maxUses: 1, note: "", expiresAt: "" });

  useEffect(() => {
    if (!selectedStoreId) {
      setInvites([]);
      return;
    }
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchStoreInvites(selectedStoreId);
        if (active) {
          setInvites(data);
        }
      } catch (err) {
        console.error("Failed to load invites", err);
        if (active) {
          setError((err as Error).message ?? "Failed to load invites");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [selectedStoreId]);

  const pendingInvites = useMemo(() => invites.filter((invite) => invite.status === "active"), [invites]);

  const handleFlagToggle = (flag: PermissionFlag) => {
    setForm((prev) => {
      const nextFlags = prev.flags.includes(flag)
        ? prev.flags.filter((value) => value !== flag)
        : [...prev.flags, flag];
      return { ...prev, flags: nextFlags };
    });
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedStoreId) {
      setError("Select a store first");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = await createStoreInvite(selectedStoreId, {
        role: form.role,
        flags: form.flags,
        maxUses: Math.max(1, Math.floor(form.maxUses || 1)),
        note: form.note ? form.note.trim() : undefined,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
      });
      setInvites((prev) => [payload, ...prev]);
      setForm({ role: form.role, flags: form.flags, maxUses: 1, note: "", expiresAt: "" });
    } catch (err) {
      console.error("Failed to create invite", err);
      setError((err as Error).message ?? "Failed to create invite");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch (err) {
      console.warn("Failed to copy invite code", err);
    }
  };

  const handleRevoke = async (inviteId: string) => {
    if (!selectedStoreId) return;
    try {
      await revokeStoreInvite(selectedStoreId, inviteId);
      setInvites((prev) => prev.map((invite) => (invite.id === inviteId ? { ...invite, status: "revoked" } : invite)));
    } catch (err) {
      console.error("Failed to revoke invite", err);
      setError((err as Error).message ?? "Failed to revoke invite");
    }
  };

  return (
    <section className={className}>
      <header className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">Invitations</h2>
          <p className="text-sm text-neutral-500">Issue and manage invite links for team members.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-neutral-600">
          <span>Store</span>
          <select
            value={selectedStoreId}
            onChange={(event) => onSelectStore(event.target.value)}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error ? (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      {!selectedStoreId ? (
        <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-6 text-sm text-neutral-600">No store selected.</div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <form onSubmit={handleSubmit} className="space-y-4 rounded border border-neutral-200 p-4">
            <div>
              <h3 className="text-sm font-semibold text-neutral-800">Create invite</h3>
              <p className="text-xs text-neutral-500">Generate a reusable link for this store.</p>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600">Role</span>
              <select
                value={form.role}
                onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as StoreMemberRole }))}
                className="rounded border border-neutral-300 px-2 py-1"
                disabled={submitting}
              >
                {ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2 text-xs text-neutral-600">
              {FLAG_OPTIONS.map((flag) => (
                <label key={flag.value} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.flags.includes(flag.value)}
                    onChange={() => handleFlagToggle(flag.value)}
                    disabled={submitting}
                  />
                  <span>{flag.label}</span>
                </label>
              ))}
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600">Maximum uses</span>
              <input
                type="number"
                min={1}
                value={form.maxUses}
                onChange={(event) => setForm((prev) => ({ ...prev, maxUses: Number(event.target.value) }))}
                className="rounded border border-neutral-300 px-2 py-1"
                disabled={submitting}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600">Expires at (optional)</span>
              <input
                type="datetime-local"
                value={form.expiresAt}
                onChange={(event) => setForm((prev) => ({ ...prev, expiresAt: event.target.value }))}
                className="rounded border border-neutral-300 px-2 py-1"
                disabled={submitting}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600">Note (optional)</span>
              <input
                type="text"
                value={form.note}
                onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
                className="rounded border border-neutral-300 px-2 py-1"
                disabled={submitting}
                maxLength={160}
              />
            </label>
            <button
              type="submit"
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={submitting}
            >
              {submitting ? "Creating…" : "Create invite"}
            </button>
          </form>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-neutral-700">Active invites ({pendingInvites.length})</h3>
            {loading ? (
              <div className="text-sm text-neutral-500">Loading invites…</div>
            ) : !invites.length ? (
              <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-6 text-sm text-neutral-600">
                No invites yet.
              </div>
            ) : (
              <div className="space-y-3">
                {invites.map((invite) => (
                  <div key={invite.id} className="rounded border border-neutral-200 p-3 text-sm text-neutral-700">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-medium">{invite.code}</div>
                        <div className="text-xs text-neutral-500">Role: {invite.role}</div>
                        <div className="text-xs text-neutral-500">Uses: {invite.used}/{invite.maxUses || "∞"}</div>
                        <div className="text-xs text-neutral-500">Flags: {invite.flags.length ? invite.flags.join(", ") : "–"}</div>
                        <div className="text-xs text-neutral-500">Status: {invite.status}</div>
                        {invite.expiresAt ? (
                          <div className="text-xs text-neutral-500">Expires: {new Date(invite.expiresAt).toLocaleString()}</div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="rounded border border-neutral-300 px-2 py-1 text-xs"
                          onClick={() => handleCopy(invite.link || invite.code)}
                        >
                          Copy
                        </button>
                        {invite.status === "active" ? (
                          <button
                            type="button"
                            className="rounded border border-red-300 px-2 py-1 text-xs text-red-600"
                            onClick={() => handleRevoke(invite.id)}
                          >
                            Revoke
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
