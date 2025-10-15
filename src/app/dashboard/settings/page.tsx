"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchAdminMembers,
  updateStoreMember,
  type AdminMemberRecord,
  type AdminMembersResponse,
} from "@/lib/api.client";
import type { StoreMemberRole } from "@/types/store";
import type { PermissionFlag } from "@/types/permissions";
import { AdminMembersPanel } from "./components/AdminMembersPanel";
import { AdminInviteManager } from "./components/AdminInviteManager";
import { CardsPanel } from "./components/CardsPanel";
import type { StoreOption, ToastMessage } from "./types";

interface AdminSettingsState {
  stores: AdminMembersResponse["stores"];
  members: AdminMemberRecord[];
}

export default function SettingsPage() {
  const [state, setState] = useState<AdminSettingsState>({ stores: [], members: [] });
  const [selectedStoreId, setSelectedStoreId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchAdminMembers();
        if (!active) return;
        setState({ stores: data.stores, members: data.members });
        setSelectedStoreId((prev) => {
          if (prev && data.stores.some((store) => store.id === prev)) {
            return prev;
          }
          return data.stores[0]?.id ?? "";
        });
      } catch (err) {
        console.error("Failed to load admin settings", err);
        if (active) {
          setError((err as Error).message ?? "Failed to load data");
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
  }, []);

  const storeOptions: StoreOption[] = useMemo(
    () => state.stores.map((store) => ({ id: store.id, name: store.name })),
    [state.stores],
  );

  const storeIds = useMemo(() => state.stores.map((store) => store.id), [state.stores]);

  const selectedStoreName = useMemo(
    () => storeOptions.find((store) => store.id === selectedStoreId)?.name ?? "-",
    [storeOptions, selectedStoreId],
  );

  const pushToast = useCallback((type: ToastMessage["type"], message: string) => {
    setToasts((prev) => {
      const next = [...prev, { id: crypto.randomUUID(), type, message }];
      return next.slice(-4);
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const handleSelectStore = useCallback((storeId: string) => {
    setSelectedStoreId(storeId);
  }, []);

  const handleChangeRole = useCallback(
    async (userId: string, role: StoreMemberRole) => {
      if (!selectedStoreId) return;
      const key = `${userId}:${selectedStoreId}`;
      setBusyKey(key);
      setError(null);
      try {
        await updateStoreMember(selectedStoreId, userId, { role });
        setState((prev) => ({
          stores: prev.stores,
          members: prev.members.map((member) => {
            if (member.userId !== userId) return member;
            return {
              ...member,
              roles: member.roles.map((entry) =>
                entry.storeId === selectedStoreId ? { ...entry, role } : entry,
              ),
            };
          }),
        }));
        pushToast("success", "Member role updated.");
      } catch (err) {
        console.error("Failed to update member role", err);
        setError((err as Error).message ?? "Failed to update member");
        pushToast("error", "Failed to update member role.");
      } finally {
        setBusyKey(null);
      }
    },
    [pushToast, selectedStoreId],
  );

  const handleToggleFlag = useCallback(
    async (userId: string, flag: PermissionFlag) => {
      if (!selectedStoreId) return;
      const key = `${userId}:${selectedStoreId}:flags`;
      setBusyKey(key);
      setError(null);
      try {
        const member = state.members.find((entry) => entry.userId === userId);
        const current = member?.roles.find((entry) => entry.storeId === selectedStoreId);
        const currentFlags = current?.flags ?? [];
        const nextFlags = currentFlags.includes(flag)
          ? currentFlags.filter((value) => value !== flag)
          : [...currentFlags, flag];
        await updateStoreMember(selectedStoreId, userId, { flags: nextFlags });
        setState((prev) => ({
          stores: prev.stores,
          members: prev.members.map((entry) => {
            if (entry.userId !== userId) return entry;
            return {
              ...entry,
              roles: entry.roles.map((role) =>
                role.storeId === selectedStoreId ? { ...role, flags: nextFlags } : role,
              ),
            };
          }),
        }));
        pushToast("success", "Member permissions updated.");
      } catch (err) {
        console.error("Failed to update member flags", err);
        setError((err as Error).message ?? "Failed to update member");
        pushToast("error", "Failed to update member permissions.");
      } finally {
        setBusyKey(null);
      }
    },
    [pushToast, selectedStoreId, state.members],
  );

  if (loading) {
    return <div className="p-6 text-sm text-neutral-500">Loading settings…</div>;
  }

  return (
    <div className="space-y-8 p-6">
      <CardsPanel
        canManage
        storeIds={storeIds}
        storeOptions={storeOptions}
        selectedStoreId={selectedStoreId || null}
        selectedStoreName={selectedStoreName}
        pushToast={pushToast}
        loadingPermissions={false}
      />
      <AdminMembersPanel
        stores={state.stores}
        members={state.members}
        selectedStoreId={selectedStoreId}
        onSelectStore={handleSelectStore}
        onChangeRole={handleChangeRole}
        onToggleFlag={handleToggleFlag}
        busyKey={busyKey}
        error={error}
      />
      <AdminInviteManager
        stores={state.stores}
        selectedStoreId={selectedStoreId}
        onSelectStore={handleSelectStore}
      />

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
              <div className="flex items-center justify-between gap-2">
                <span>{toast.message}</span>
                <button
                  type="button"
                  className="text-xs text-neutral-500 hover:text-neutral-700"
                  onClick={() => dismissToast(toast.id)}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
