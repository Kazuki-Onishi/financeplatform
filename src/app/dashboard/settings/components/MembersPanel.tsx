"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { auth } from "@/lib/firebase/client";
import {
  createStoreInvite,
  fetchStoreInvites,
  peekCachedStoreInvites,
  revokeStoreInvite,
  type StoreInviteRecord,
} from "@/lib/api.client";
import type { PermissionFlag } from "@/types/permissions";
import type { StoreMemberRole } from "@/types/store";
import type { ToastMessage } from "../types";

interface MembersPanelProps {
  canManage: boolean;
  storeId: string | null;
  storeName: string;
  pushToast: (type: ToastMessage["type"], message: string) => void;
}

interface MemberRow {
  id: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  role: StoreMemberRole;
  flags: PermissionFlag[];
  status: "active" | "pending";
  resigned: boolean;
  joinedAt: string | null;
  invitedBy: string | null;
}

interface InviteRow {
  id: string;
  code: string;
  role: StoreMemberRole;
  flags: PermissionFlag[];
  status: string;
  maxUses: number;
  used: number;
  note: string | null;
  link: string;
  createdAt?: string | null;
  expiresAt?: string | null;
  targetUserId?: string | null;
  targetEmail?: string | null;
  targetDisplayName?: string | null;
}

interface MemberFormState {
  role: StoreMemberRole;
  flags: PermissionFlag[];
  status: "active" | "pending";
  resigned: boolean;
}

function mapInviteRecord(record: StoreInviteRecord): InviteRow {
  const rawFlags = Array.isArray(record.flags) ? record.flags : [];
  const filteredFlags = rawFlags.filter((flag): flag is PermissionFlag =>
    FLAG_LABELS.some((entry) => entry.value === flag),
  );
  return {
    id: record.id,
    code: record.code ?? "",
    role: (record.role as StoreMemberRole) ?? "staff",
    flags: filteredFlags,
    status: record.status ?? "active",
    maxUses: record.maxUses ?? 0,
    used: record.used ?? 0,
    note: record.note ?? null,
    link: record.link ?? "",
    createdAt: record.createdAt ?? null,
    expiresAt: record.expiresAt ?? null,
    targetUserId: record.targetUserId ?? null,
    targetEmail: record.targetEmail ?? null,
    targetDisplayName: record.targetDisplayName ?? null,
  };
}

const MEMBER_ROLE_LABELS: Record<StoreMemberRole, string> = {
  owner: "Owner",
  manager: "Manager",
  staff: "Staff",
  viewer: "Viewer",
};

const MEMBER_STATUS_OPTIONS: Array<{
  value: "active" | "pending";
  label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "pending", label: "Pending" },
];

const FLAG_LABELS: Array<{ value: PermissionFlag; label: string }> = [
  { value: "perm.upload", label: "Upload receipts" },
  { value: "perm.editFields", label: "Edit receipts" },
  { value: "perm.view", label: "View receipts" },
  { value: "perm.exportCsv", label: "Export CSV" },
  { value: "perm.lock", label: "Lock receipts" },
  { value: "perm.unlock", label: "Unlock receipts" },
  { value: "perm.manageCards", label: "Manage cards" },
  { value: "perm.manageVendors", label: "Manage vendors" },
  { value: "perm.manageMembers", label: "Manage members" },
];

function formatIsoDatetime(value: string | null): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
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

export function MembersPanel({
  canManage,
  storeId,
  storeName,
  pushToast,
}: MembersPanelProps) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [role, setRole] = useState<StoreMemberRole>("staff");
  const [inviteFlags, setInviteFlags] = useState<PermissionFlag[]>([]);
  const [maxUses, setMaxUses] = useState<number>(1);
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [canManageMembersServer, setCanManageMembersServer] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [memberForm, setMemberForm] = useState<MemberFormState | null>(null);
  const [savingMember, setSavingMember] = useState(false);
  const editingMemberIdRef = useRef<string | null>(null);

  const effectiveCanManage = canManage && canManageMembersServer;
  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) {
      return members;
    }
    return members.filter((member) => {
      const name = member.displayName?.toLowerCase() ?? "";
      const email = member.email?.toLowerCase() ?? "";
      const id = member.id.toLowerCase();
      return (
        name.includes(query) || email.includes(query) || id.includes(query)
      );
    });
  }, [memberSearch, members]);

  const loadMembers = useCallback(async () => {
    if (!storeId) {
      setMembers([]);
      setMembersError(null);
      setCanManageMembersServer(false);
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      setMembersError("Sign in to view members.");
      setMembers([]);
      setCanManageMembersServer(false);
      return;
    }
    setMembersLoading(true);
    setMembersError(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch(
        `/api/stores/${encodeURIComponent(storeId)}/members`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMembersError(payload?.error ?? "Failed to load members.");
        setMembers([]);
        setCanManageMembersServer(false);
        return;
      }
      const list = Array.isArray(payload?.members)
        ? (payload.members as MemberRow[])
        : [];
      setMembers(list);
      setMembersError(null);
      setCanManageMembersServer(Boolean(payload?.canManageMembers));
      const editingId = editingMemberIdRef.current;
      if (editingId) {
        const current = list.find((member) => member.id === editingId);
        if (current) {
          setMemberForm({
            role: current.role,
            flags: [...current.flags],
            status: current.status,
            resigned: current.resigned,
          });
        } else {
          setEditingMemberId(null);
          setMemberForm(null);
        }
      }
    } catch (error) {
      console.error("[settings] failed to load members", error);
      setMembersError("Network error while loading members.");
      setMembers([]);
      setCanManageMembersServer(false);
    } finally {
      setMembersLoading(false);
    }
  }, [storeId]);

  const loadInvites = useCallback(
    async (force = false) => {
      if (!storeId || !effectiveCanManage) {
        setInvites([]);
        setInvitesError(null);
        setInvitesLoading(false);
        return;
      }

      if (!force) {
        const cached = peekCachedStoreInvites(storeId);
        if (cached) {
          setInvites(cached.map(mapInviteRecord));
          setInvitesError(null);
          setInvitesLoading(false);
          return;
        }
      }

      setInvitesLoading(true);
      setInvitesError(null);
      try {
        const records = await fetchStoreInvites(storeId, { force });
        setInvites(records.map(mapInviteRecord));
      } catch (error) {
        console.error("[settings] failed to load invites", error);
        const message = (error as Error)?.message ?? "Failed to load invites.";
        setInvitesError(message);
        setInvites([]);
      } finally {
        setInvitesLoading(false);
      }
    },
    [effectiveCanManage, storeId],
  );

  useEffect(() => {
    editingMemberIdRef.current = editingMemberId;
  }, [editingMemberId]);

  useEffect(() => {
    setEditingMemberId(null);
    setMemberForm(null);
  }, [storeId]);

  useEffect(() => {
    setInvites([]);
    setInvitesError(null);
    setMembers([]);
    setMembersError(null);
    if (!storeId) {
      return;
    }
    loadMembers().catch((error) =>
      console.error("[settings] member load error", error),
    );
  }, [storeId, loadMembers]);

  useEffect(() => {
    if (effectiveCanManage) {
      loadInvites().catch((error) =>
        console.error("[settings] invite load error", error),
      );
    } else {
      setInvites([]);
      setInvitesError(null);
    }
  }, [effectiveCanManage, loadInvites]);

  const toggleInviteFlag = useCallback((flag: PermissionFlag) => {
    setInviteFlags((prev) =>
      prev.includes(flag)
        ? prev.filter((entry) => entry !== flag)
        : [...prev, flag],
    );
  }, []);

  const toggleMemberFlag = useCallback((flag: PermissionFlag) => {
    setMemberForm((prev) => {
      if (!prev) {
        return prev;
      }
      const nextFlags = prev.flags.includes(flag)
        ? prev.flags.filter((entry) => entry !== flag)
        : [...prev.flags, flag];
      return { ...prev, flags: nextFlags };
    });
  }, []);

  const handleCreateInvite = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!storeId) {
        pushToast("error", "Select a store before creating an invite.");
        return;
      }
      if (!effectiveCanManage) {
        pushToast(
          "error",
          "You do not have permission to create invites for this store.",
        );
        return;
      }
      if (!auth.currentUser) {
        pushToast("error", "Sign in again to continue.");
        return;
      }
      setCreatingInvite(true);
      try {
        await createStoreInvite(storeId, {
          role,
          flags: inviteFlags,
          maxUses,
          expiresAt: expiresAt || null,
          note: note ? note.slice(0, 160) : null,
        });
        pushToast("success", "Invite created.");
        setNote("");
        setExpiresAt("");
        setRole("staff");
        setMaxUses(1);
        setInviteFlags([]);
        await loadInvites(true);
      } catch (error) {
        console.error("[settings] failed to create invite", error);
        const message = (error as Error)?.message ?? "Network error while creating invite.";
        pushToast("error", message);
      } finally {
        setCreatingInvite(false);
      }
    },
    [
      effectiveCanManage,
      expiresAt,
      inviteFlags,
      loadInvites,
      maxUses,
      note,
      pushToast,
      role,
      storeId,
    ],
  );

  const handleRevokeInvite = useCallback(
    async (inviteId: string) => {
      if (!storeId) {
        pushToast("error", "Select a store first.");
        return;
      }
      if (!effectiveCanManage) {
        pushToast("error", "You do not have permission to revoke invites.");
        return;
      }
      if (!auth.currentUser) {
        pushToast("error", "Sign in again to continue.");
        return;
      }
      try {
        await revokeStoreInvite(storeId, inviteId);
        pushToast("success", "Invite revoked.");
        await loadInvites(true);
      } catch (error) {
        console.error("[settings] failed to revoke invite", error);
        const message = (error as Error)?.message ?? "Network error while revoking invite.";
        pushToast("error", message);
      }
    },
    [effectiveCanManage, loadInvites, pushToast, storeId],
  );

  const beginEditMember = useCallback((member: MemberRow) => {
    setEditingMemberId(member.id);
    setMemberForm({
      role: member.role,
      flags: [...member.flags],
      status: member.status,
      resigned: member.resigned,
    });
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMemberId(null);
    setMemberForm(null);
  }, []);

  const handleMemberSave = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!storeId || !editingMemberId || !memberForm) {
        return;
      }
      if (!effectiveCanManage) {
        pushToast("error", "You do not have permission to update members.");
        return;
      }
      const user = auth.currentUser;
      if (!user) {
        pushToast("error", "Sign in again to continue.");
        return;
      }
      setSavingMember(true);
      try {
        const token = await user.getIdToken();
        const response = await fetch(
          `/api/stores/${encodeURIComponent(storeId)}/members/${encodeURIComponent(editingMemberId)}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              role: memberForm.role,
              flags: memberForm.flags,
              status: memberForm.status,
              resigned: memberForm.resigned,
            }),
          },
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          pushToast("error", payload?.error ?? "Failed to update member.");
          return;
        }
        const updated = payload?.member as MemberRow | undefined;
        if (updated) {
          setMembers((prev) =>
            prev.map((member) => (member.id === updated.id ? updated : member)),
          );
          setEditingMemberId(updated.id);
          setMemberForm({
            role: updated.role,
            flags: [...updated.flags],
            status: updated.status,
            resigned: updated.resigned,
          });
        }
        pushToast("success", "Member updated.");
      } catch (error) {
        console.error("[settings] failed to update member", error);
        pushToast("error", "Network error while updating member.");
      } finally {
        setSavingMember(false);
      }
    },
    [effectiveCanManage, editingMemberId, memberForm, pushToast, storeId],
  );

  const inviteFlagOptions = useMemo(() => FLAG_LABELS, []);

  if (!storeId) {
    return (
      <section className="rounded border border-neutral-200 bg-white p-4 text-sm text-neutral-500">
        Select a store to view and manage members.
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6 rounded border border-neutral-200 bg-white p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Members</h2>
        <p className="text-xs text-neutral-500">{storeName}</p>
      </div>

      <div className="space-y-2">
        {membersError ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {membersError}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-neutral-500">
            {filteredMembers.length} of {members.length} teammates
          </span>
          <input
            type="text"
            value={memberSearch}
            onChange={(event) => setMemberSearch(event.target.value)}
            placeholder="Search by name, email, or user ID"
            className="w-full max-w-xs rounded border border-neutral-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="overflow-x-auto rounded border border-neutral-200">
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead className="bg-neutral-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">
                  Member
                </th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">
                  Role
                </th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">
                  Flags
                </th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">
                  Status
                </th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">
                  Resigned
                </th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">
                  Joined
                </th>
                {effectiveCanManage ? (
                  <th className="px-3 py-2 text-left font-medium text-neutral-600">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {membersLoading ? (
                <tr>
                  <td
                    className="px-3 py-4 text-center text-neutral-500"
                    colSpan={effectiveCanManage ? 7 : 6}
                  >
                    Loading members...
                  </td>
                </tr>
              ) : null}
              {!membersLoading && !filteredMembers.length ? (
                <tr>
                  <td
                    className="px-3 py-4 text-center text-neutral-500"
                    colSpan={effectiveCanManage ? 7 : 6}
                  >
                    {memberSearch.trim()
                      ? `No members match "${memberSearch.trim()}".`
                      : "No members found."}
                  </td>
                </tr>
              ) : null}
              {filteredMembers.map((member) => (
                <tr key={member.id} className="hover:bg-neutral-50/80">
                  <td className="px-3 py-2">
                    <div className="text-sm font-medium text-neutral-800">
                      {member.displayName ?? "Unknown user"}
                    </div>
                    <div className="text-xs text-neutral-500">
                      {member.email ?? "?"}
                    </div>
                    <div className="text-xs font-mono text-neutral-400">
                      {member.id}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-neutral-700">
                    {MEMBER_ROLE_LABELS[member.role]}
                  </td>
                  <td className="px-3 py-2 text-neutral-500">
                    {member.flags.length ? member.flags.join(", ") : "-"}
                  </td>
                  <td className="px-3 py-2 text-neutral-500">
                    {member.status}
                  </td>
                  <td className="px-3 py-2 text-neutral-500">
                    {member.resigned ? "Yes" : "No"}
                  </td>
                  <td className="px-3 py-2 text-neutral-500">
                    {formatIsoDatetime(member.joinedAt)}
                  </td>
                  {effectiveCanManage ? (
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => beginEditMember(member)}
                        className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
                      >
                        {editingMemberId === member.id ? "Editing" : "Edit"}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {effectiveCanManage ? (
        <form
          className="flex flex-col gap-3 rounded border border-neutral-200 bg-neutral-50 p-4"
          onSubmit={handleMemberSave}
        >
          <h3 className="text-sm font-semibold text-neutral-700">
            Update member
          </h3>
          {!editingMemberId || !memberForm ? (
            <p className="text-xs text-neutral-500">
              Choose a member from the table to edit their role, flags, or
              status.
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label
                  className="flex flex-col gap-1 text-sm"
                  htmlFor="member-edit-role"
                >
                  <span className="font-medium text-neutral-600">Role</span>
                  <select
                    id="member-edit-role"
                    value={memberForm.role}
                    onChange={(event) =>
                      setMemberForm((prev) =>
                        prev
                          ? {
                              ...prev,
                              role: event.target.value as StoreMemberRole,
                            }
                          : prev,
                      )
                    }
                    className="rounded border border-neutral-300 px-3 py-2"
                    disabled={savingMember}
                  >
                    {Object.entries(MEMBER_ROLE_LABELS).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label
                  className="flex flex-col gap-1 text-sm"
                  htmlFor="member-edit-status"
                >
                  <span className="font-medium text-neutral-600">Status</span>
                  <select
                    id="member-edit-status"
                    value={memberForm.status}
                    onChange={(event) =>
                      setMemberForm((prev) =>
                        prev
                          ? {
                              ...prev,
                              status: event.target.value as
                                | "active"
                                | "pending",
                            }
                          : prev,
                      )
                    }
                    className="rounded border border-neutral-300 px-3 py-2"
                    disabled={savingMember}
                  >
                    {MEMBER_STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <fieldset className="flex flex-col gap-2 text-sm">
                <legend className="font-medium text-neutral-600">Flags</legend>
                <div className="flex flex-wrap gap-2">
                  {inviteFlagOptions.map((option) => {
                    const checked = memberForm.flags.includes(option.value);
                    return (
                      <label
                        key={option.value}
                        className="flex items-center gap-2 text-xs text-neutral-600"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleMemberFlag(option.value)}
                          disabled={savingMember}
                          className="rounded border-neutral-300"
                        />
                        {option.label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={memberForm.resigned}
                  onChange={(event) =>
                    setMemberForm((prev) =>
                      prev ? { ...prev, resigned: event.target.checked } : prev,
                    )
                  }
                  disabled={savingMember}
                  className="rounded border-neutral-300"
                />
                <span className="text-neutral-600">Mark as resigned</span>
              </label>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={savingMember}
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {savingMember ? "Saving..." : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  disabled={savingMember}
                  className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </form>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {effectiveCanManage ? (
          <form
            className="flex flex-col gap-3 rounded border border-neutral-200 p-4"
            onSubmit={handleCreateInvite}
          >
            <h3 className="text-sm font-semibold text-neutral-700">
              Create invite
            </h3>
            {invitesError ? (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {invitesError}
              </div>
            ) : null}
            <label
              className="flex flex-col gap-1 text-sm"
              htmlFor="members-invite-role"
            >
              <span className="font-medium text-neutral-600">Role</span>
              <select
                id="members-invite-role"
                value={role}
                onChange={(event) =>
                  setRole(event.target.value as StoreMemberRole)
                }
                className="rounded border border-neutral-300 px-3 py-2"
                disabled={creatingInvite}
              >
                {Object.entries(MEMBER_ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="font-medium text-neutral-600">Flags</legend>
              <div className="flex flex-wrap gap-2">
                {inviteFlagOptions.map((option) => {
                  const checked = inviteFlags.includes(option.value);
                  return (
                    <label
                      key={option.value}
                      className="flex items-center gap-2 text-xs text-neutral-600"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleInviteFlag(option.value)}
                        disabled={creatingInvite}
                        className="rounded border-neutral-300"
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <label
              className="flex flex-col gap-1 text-sm"
              htmlFor="members-invite-max"
            >
              <span className="font-medium text-neutral-600">Maximum uses</span>
              <input
                id="members-invite-max"
                type="number"
                min={0}
                value={maxUses}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  setMaxUses(Number.isFinite(next) ? Math.max(0, next) : 0);
                }}
                className="w-32 rounded border border-neutral-300 px-3 py-2"
                disabled={creatingInvite}
              />
              <span className="text-xs text-neutral-400">
                Use 0 for unlimited.
              </span>
            </label>

            <label
              className="flex flex-col gap-1 text-sm"
              htmlFor="members-invite-expires"
            >
              <span className="font-medium text-neutral-600">
                Expires at (optional)
              </span>
              <input
                id="members-invite-expires"
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                className="rounded border border-neutral-300 px-3 py-2"
                disabled={creatingInvite}
              />
            </label>

            <label
              className="flex flex-col gap-1 text-sm"
              htmlFor="members-invite-note"
            >
              <span className="font-medium text-neutral-600">
                Note (optional)
              </span>
              <input
                id="members-invite-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className="rounded border border-neutral-300 px-3 py-2"
                maxLength={160}
                disabled={creatingInvite}
              />
            </label>

            <button
              type="submit"
              disabled={creatingInvite}
              className="w-fit rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creatingInvite ? "Creating..." : "Create invite"}
            </button>
          </form>
        ) : (
          <div className="rounded border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
            You can view members of {storeName}, but you do not have permission
            to manage invites.
          </div>
        )}

        <section className="flex flex-col gap-3 rounded border border-neutral-200 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-700">Invites</h3>
            {invitesLoading ? (
              <span className="text-xs text-neutral-500">Loading...</span>
            ) : null}
          </div>
          {!invites.length ? (
            <p className="text-sm text-neutral-500">No invites yet.</p>
          ) : (
            <div className="space-y-3">
              {invites.map((invite) => (
                <div
                  key={invite.id}
                  className="rounded border border-neutral-200 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-neutral-700">
                        Role: {MEMBER_ROLE_LABELS[invite.role]}
                      </span>
                      <span className="text-xs text-neutral-500">
                        Code: {invite.code || "-"}
                      </span>
                      <span className="text-xs text-neutral-500">
                        Uses: {invite.used}/{invite.maxUses || "unlimited"}
                      </span>
                      <span className="text-xs text-neutral-500">
                        Flags:{" "}
                        {invite.flags.length ? invite.flags.join(", ") : "-"}
                      </span>
                      <span className="text-xs text-neutral-500">
                        Created: {formatIsoDatetime(invite.createdAt ?? null)}
                      </span>
                      <span className="text-xs text-neutral-500">
                        Expires: {formatIsoDatetime(invite.expiresAt ?? null)}
                      </span>
                      <span className="text-xs text-neutral-500">
                        Link: {invite.link}
                      </span>
                      {invite.targetUserId ? (
                        <span className="text-xs text-neutral-500">
                          Direct invite for {invite.targetEmail ?? invite.targetDisplayName ?? invite.targetUserId}
                        </span>
                      ) : null}
                      {invite.note ? (
                        <span className="text-xs text-neutral-500">
                          Note: {invite.note}
                        </span>
                      ) : null}
                    </div>
                    {effectiveCanManage ? (
                      <button
                        type="button"
                        onClick={() => handleRevokeInvite(invite.id)}
                        disabled={invite.status === "revoked"}
                        className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {invite.status === "revoked"
                          ? "Revoked"
                          : "Revoke invite"}
                      </button>
                    ) : null}
                  </div>
                  <div className="mt-2 text-xs text-neutral-500">
                    Status: {invite.status}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}




