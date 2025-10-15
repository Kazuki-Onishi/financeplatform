"use client";

import { useMemo } from "react";
import type { AdminMemberRecord } from "@/lib/api.client";
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

interface AdminMembersPanelProps {
  stores: Array<{ id: string; name: string }>;
  members: AdminMemberRecord[];
  selectedStoreId: string;
  onSelectStore: (storeId: string) => void;
  onChangeRole: (userId: string, role: StoreMemberRole) => void;
  onToggleFlag: (userId: string, flag: PermissionFlag) => void;
  busyKey: string | null;
  error: string | null;
  className?: string;
}

export function AdminMembersPanel({
  stores,
  members,
  selectedStoreId,
  onSelectStore,
  onChangeRole,
  onToggleFlag,
  busyKey,
  error,
  className,
}: AdminMembersPanelProps) {
  const membersForStore = useMemo(() => {
    if (!selectedStoreId) {
      return [];
    }
    return members
      .map((member) => {
        const role = member.roles.find((entry) => entry.storeId === selectedStoreId);
        if (!role) {
          return null;
        }
        return { member, role };
      })
      .filter((entry): entry is { member: AdminMemberRecord; role: AdminMemberRecord["roles"][number] } => Boolean(entry))
      .sort((a, b) => (a.member.displayName ?? a.member.email ?? a.member.userId).localeCompare(b.member.displayName ?? b.member.email ?? b.member.userId));
  }, [members, selectedStoreId]);

  return (
    <section className={className}>
      <header className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">Team members</h2>
          <p className="text-sm text-neutral-500">Manage roles and permissions across stores.</p>
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
        <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-6 text-sm text-neutral-600">No stores available.</div>
      ) : !membersForStore.length ? (
        <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-6 text-sm text-neutral-600">No members for this store.</div>
      ) : (
        <div className="overflow-x-auto rounded border border-neutral-200">
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead className="bg-neutral-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">User</th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">Role</th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">Flags</th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {membersForStore.map(({ member, role }) => {
                const label = member.displayName ?? member.email ?? member.userId;
                const busy = busyKey !== null && busyKey.includes(member.userId);
                return (
                  <tr key={member.userId}>
                    <td className="px-3 py-3">
                      <div className="font-medium text-neutral-900">{label}</div>
                      <div className="text-xs text-neutral-500">{member.email ?? "–"}</div>
                    </td>
                    <td className="px-3 py-3">
                      <select
                        value={role.role}
                        onChange={(event) => onChangeRole(member.userId, event.target.value as StoreMemberRole)}
                        className="rounded border border-neutral-300 px-2 py-1"
                        disabled={busy}
                      >
                        {ROLE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-2">
                        {FLAG_OPTIONS.map((flag) => {
                          const checked = role.flags.includes(flag.value);
                          return (
                            <label key={flag.value} className="flex items-center gap-1 text-xs">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => onToggleFlag(member.userId, flag.value)}
                                disabled={busy}
                              />
                              <span>{flag.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-neutral-600">
                      <div className="capitalize">{role.status}</div>
                      <div className="text-xs text-neutral-400">
                        {role.joinedAt ? new Date(role.joinedAt).toLocaleString() : "Joined date unknown"}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
