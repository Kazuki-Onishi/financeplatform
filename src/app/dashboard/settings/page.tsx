"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getDoc } from "firebase/firestore";
import { storeDoc } from "@/lib/firestoreRefs";
import { useUserPermissions } from "@/lib/hooks/useUserPermissions";
import { useAppSelector } from "@/lib/state/store";
import type { StoreDoc } from "@/types/store";
import { CardsPanel } from "./components/CardsPanel";
import { MembersPanel } from "./components/MembersPanel";
import { VendorsPanel } from "./components/VendorsPanel";
import type { StoreOption, ToastMessage } from "./types";

const RECEIPTS_FLAG = process.env.NEXT_PUBLIC_APPFLAG_RECEIPTS === "on";
const SYNC_TIMEOUT_MS = 10_000;
const STORE_HISTORY_STORAGE_KEY = "settings:store-history";
const STORE_HISTORY_LIMIT = 5;

type SettingsTab = "cards" | "vendors" | "members";

function persistStoreHistory(entries: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORE_HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn("[settings] failed to persist store history", error);
  }
}

export default function SettingsPage(): JSX.Element {
  const router = useRouter();
  const { permissions, loading: permissionsLoading, optimisticMemberships, confirmed, authReady } = useUserPermissions();
  const { profile: userProfile, status: userStatus } = useAppSelector((state) => state.user);

  const [activeTab, setActiveTab] = useState<SettingsTab>("cards");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);
  const [syncExceeded, setSyncExceeded] = useState(false);
  const [storeDetails, setStoreDetails] = useState<Record<string, { name: string }>>({});
  const [storeHistory, setStoreHistory] = useState<string[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>("all");
  const storeHistoryLoadedRef = useRef(false);
  const storeSelectionInitializedRef = useRef(false);

  const knownStoreIds = useMemo(() => {
    const ids = new Set<string>(permissions?.storeIds ?? []);
    optimisticMemberships.forEach((membership) => ids.add(membership.storeId));
    return Array.from(ids);
  }, [permissions?.storeIds, optimisticMemberships]);

  const resolvedActiveStoreId = useMemo(() => {
    if (permissions?.activeStoreId && knownStoreIds.includes(permissions.activeStoreId)) {
      return permissions.activeStoreId;
    }
    return knownStoreIds[0] ?? null;
  }, [knownStoreIds, permissions?.activeStoreId]);

  const permissionsBusy = !authReady || permissionsLoading;

  useEffect(() => {
    if (!confirmed || !knownStoreIds.length) {
      return;
    }
    const missing = knownStoreIds.filter((id) => !storeDetails[id]);
    if (!missing.length) {
      return;
    }
    let cancelled = false;
    (async () => {
      const updates: Record<string, { name: string }> = {};
      await Promise.all(
        missing.map(async (id) => {
          try {
            const snapshot = await getDoc(storeDoc(id));
            if (snapshot.exists()) {
              const data = snapshot.data() as Partial<StoreDoc> | undefined;
              const resolvedName =
                typeof data?.name === "string" && data.name.trim() ? data.name.trim() : id;
              updates[id] = { name: resolvedName };
            } else {
              updates[id] = { name: id };
            }
          } catch (error) {
            console.warn("[settings] failed to load store name", id, error);
            updates[id] = { name: id };
          }
        }),
      );
      if (!cancelled && Object.keys(updates).length) {
        setStoreDetails((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [confirmed, knownStoreIds, storeDetails]);

  useEffect(() => {
    if (!authReady) {
      return;
    }
    if (storeHistoryLoadedRef.current) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    storeHistoryLoadedRef.current = true;
    try {
      const raw = window.localStorage.getItem(STORE_HISTORY_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const entries = parsed.filter((id): id is string => typeof id === "string");
      if (!entries.length) {
        return;
      }
      setStoreHistory(entries.slice(0, STORE_HISTORY_LIMIT));
    } catch (error) {
      console.warn("[settings] failed to load store history", error);
    }
  }, [authReady]);

  useEffect(() => {
    setStoreHistory((prev) => {
      if (!prev.length) {
        return prev;
      }
      const filtered = prev.filter((id) => knownStoreIds.includes(id));
      if (filtered.length === prev.length && filtered.every((id, index) => id === prev[index])) {
        return prev;
      }
      persistStoreHistory(filtered);
      return filtered;
    });
  }, [knownStoreIds]);

  useEffect(() => {
    if (!selectedStoreId || selectedStoreId === "all") {
      return;
    }
    setStoreHistory((prev) => {
      const withoutCurrent = prev.filter((id) => id !== selectedStoreId);
      const next = [selectedStoreId, ...withoutCurrent].slice(0, STORE_HISTORY_LIMIT);
      const unchanged = next.length === prev.length && next.every((id, index) => id === prev[index]);
      if (unchanged) {
        return prev;
      }
      persistStoreHistory(next);
      return next;
    });
  }, [selectedStoreId]);

  useEffect(() => {
    if (!knownStoreIds.length) {
      if (selectedStoreId !== "all") {
        setSelectedStoreId("all");
      }
      return;
    }
    if (!storeSelectionInitializedRef.current) {
      const historyPreferred = storeHistory.find((id) => knownStoreIds.includes(id));
      const initialSelection = historyPreferred ?? resolvedActiveStoreId ?? knownStoreIds[0];
      if (initialSelection) {
        setSelectedStoreId(initialSelection);
      }
      storeSelectionInitializedRef.current = true;
      return;
    }
    if (selectedStoreId !== "all" && selectedStoreId && !knownStoreIds.includes(selectedStoreId)) {
      const fallback =
        storeHistory.find((id) => knownStoreIds.includes(id)) ?? resolvedActiveStoreId ?? knownStoreIds[0] ?? "all";
      setSelectedStoreId(fallback);
    }
  }, [knownStoreIds, resolvedActiveStoreId, selectedStoreId, storeHistory]);

  useEffect(() => {
    if (optimisticMemberships.length && !confirmed) {
      setSyncStartedAt((current) => current ?? Date.now());
    } else {
      setSyncStartedAt(null);
      setSyncExceeded(false);
    }
  }, [optimisticMemberships, confirmed]);

  useEffect(() => {
    if (!syncStartedAt) {
      return;
    }
    const timer = window.setTimeout(() => setSyncExceeded(true), SYNC_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [syncStartedAt]);

  const hasCardsPerm = useMemo(
    () => permissions?.flags.includes("perm.manageCards") ?? false,
    [permissions?.flags],
  );

  const hasVendorsPerm = useMemo(
    () => permissions?.flags.includes("perm.manageVendors") ?? false,
    [permissions?.flags],
  );

  const hasMembersPerm = useMemo(
    () => permissions?.flags.includes("perm.manageMembers") ?? false,
    [permissions?.flags],
  );

  useEffect(() => {
    const availableTabs: SettingsTab[] = [];
    if (hasCardsPerm) availableTabs.push("cards");
    if (hasMembersPerm) availableTabs.push("members");
    if (hasVendorsPerm) availableTabs.push("vendors");

    if (!availableTabs.length) {
      if (activeTab !== "cards") {
        setActiveTab("cards");
      }
      return;
    }

    if (!availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0]);
    }
  }, [activeTab, hasCardsPerm, hasMembersPerm, hasVendorsPerm]);

  const pushToast = useCallback((type: ToastMessage["type"], message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);

  if (!RECEIPTS_FLAG) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <h1 className="text-2xl font-semibold">Receipt Settings</h1>
        <p className="text-sm text-neutral-500">Set NEXT_PUBLIC_APPFLAG_RECEIPTS=on to access this feature.</p>
      </div>
    );
  }

  if (!permissionsBusy && !knownStoreIds.length) {
    router.replace("/onboarding");
  }

  const storeOptions: StoreOption[] = useMemo(
    () => knownStoreIds.map((id) => ({ id, name: storeDetails[id]?.name ?? id })),
    [knownStoreIds, storeDetails],
  );

  const storeQuickOptions = useMemo(() => {
    if (!storeOptions.length) {
      return [] as StoreOption[];
    }
    const index = new Map(storeOptions.map((option) => [option.id, option.name] as const));
    const historyIds = storeHistory.filter((id) => index.has(id));
    const fallbackIds = storeOptions.map((option) => option.id).filter((id) => !historyIds.includes(id));
    const ordered: string[] = [];
    for (const id of [...historyIds, ...fallbackIds]) {
      if (!ordered.includes(id)) {
        ordered.push(id);
      }
      if (ordered.length >= STORE_HISTORY_LIMIT) {
        break;
      }
    }
    return ordered.map((id) => ({ id, name: index.get(id) ?? id }));
  }, [storeHistory, storeOptions]);

  const selectedStoreName = useMemo(() => {
    if (selectedStoreId === "all" || !selectedStoreId) {
      return "Shared across stores";
    }
    return storeDetails[selectedStoreId]?.name ?? selectedStoreId;
  }, [selectedStoreId, storeDetails]);

  const effectiveStoreId = selectedStoreId === "all" ? null : selectedStoreId;
  const storeSelectDisabled = permissionsBusy || !storeOptions.length;

  const activeStoreName = useMemo(() => {
    if (!resolvedActiveStoreId) {
      return permissionsBusy ? "Loading..." : "No store selected";
    }
    return storeDetails[resolvedActiveStoreId]?.name ?? resolvedActiveStoreId;
  }, [permissionsBusy, resolvedActiveStoreId, storeDetails]);

  const userDisplayName = useMemo(() => {
    if (userStatus === "loading") {
      return "Loading...";
    }
    if (!userProfile) {
      return "Unknown user";
    }
    if (userProfile.displayName && userProfile.displayName.trim()) {
      return userProfile.displayName.trim();
    }
    if (userProfile.email && userProfile.email.trim()) {
      return userProfile.email.trim();
    }
    return userProfile.uid;
  }, [userProfile, userStatus]);

  const showSyncBanner = Boolean(syncStartedAt && !confirmed);
  const canAccessMembersTab = hasMembersPerm && Boolean(effectiveStoreId);

  useEffect(() => {
    if (!permissionsBusy && !knownStoreIds.length) {
      router.replace('/onboarding');
    }
  }, [permissionsBusy, knownStoreIds, router]);
  const noPermissions = !hasCardsPerm && !hasVendorsPerm && !hasMembersPerm;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Receipts Settings</h1>
        <p className="text-sm text-neutral-500">Manage shared payment cards, store members, and the vendor catalogue.</p>
        <div className="flex flex-wrap gap-4 text-xs text-neutral-500">
          <span>
            Active store:
            <span className="ml-1 font-medium text-neutral-900">{activeStoreName}</span>
          </span>
          <span>
            Selected store:
            <span className="ml-1 font-medium text-neutral-900">{selectedStoreName}</span>
          </span>
          <span>
            Signed in as:
            <span className="ml-1 font-medium text-neutral-900">{userDisplayName}</span>
          </span>
        </div>
      </div>

      <section className="rounded border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-medium text-neutral-700">Store selection</h2>
        <p className="mt-1 text-xs text-neutral-500">Choose which store you want to manage here.</p>
        {storeQuickOptions.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {storeQuickOptions.map(({ id, name }) => {
              const isActive = selectedStoreId === id;
              return (
                <button
                  key={`store-pill-${id}`}
                  type="button"
                  onClick={() => setSelectedStoreId(id)}
                  disabled={storeSelectDisabled}
                  className={`rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    isActive
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
                  } ${storeSelectDisabled ? "cursor-not-allowed opacity-60" : ""}`}
                  aria-pressed={isActive}
                >
                  {name}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="mt-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <label className="text-sm font-medium text-neutral-600" htmlFor="settings-store-select">
            Store
          </label>
          <select
            id="settings-store-select"
            value={selectedStoreId}
            onChange={(event) => setSelectedStoreId(event.target.value)}
            disabled={storeSelectDisabled}
            className="mt-1 rounded border border-neutral-300 px-3 py-2 text-sm sm:mt-0"
          >
            <option value="all">All stores</option>
            {storeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        {selectedStoreId === "all" ? (
          <p className="mt-2 text-xs text-neutral-500">Select a store to manage its members and store-scoped resources.</p>
        ) : null}
      </section>

      <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <button
          type="button"
          onClick={() => hasCardsPerm && setActiveTab("cards")}
          disabled={!hasCardsPerm}
          aria-pressed={activeTab === "cards"}
          className={`flex items-start gap-3 rounded border border-neutral-200 bg-white p-4 text-left shadow-sm transition ${
            hasCardsPerm ? "hover:border-neutral-300 hover:shadow" : "cursor-not-allowed opacity-50"
          }`}
        >
          <div className="rounded bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">Cards</div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-neutral-900">Manage payment cards</span>
            <span className="text-xs text-neutral-500">Add or update cards linked to each store.</span>
          </div>
        </button>
        <button
          type="button"
          onClick={() => canAccessMembersTab && setActiveTab("members")}
          disabled={!canAccessMembersTab}
          aria-pressed={activeTab === "members"}
          className={`flex items-start gap-3 rounded border border-neutral-200 bg-white p-4 text-left shadow-sm transition ${
            canAccessMembersTab ? "hover:border-neutral-300 hover:shadow" : "cursor-not-allowed opacity-50"
          }`}
        >
          <div className="rounded bg-green-100 px-2 py-1 text-xs font-semibold text-green-700">Members</div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-neutral-900">Team members</span>
            <span className="text-xs text-neutral-500">Review members and manage invitations for the selected store.</span>
          </div>
        </button>
        <button
          type="button"
          onClick={() => hasVendorsPerm && setActiveTab("vendors")}
          disabled={!hasVendorsPerm}
          aria-pressed={activeTab === "vendors"}
          className={`flex items-start gap-3 rounded border border-neutral-200 bg-white p-4 text-left shadow-sm transition ${
            hasVendorsPerm ? "hover:border-neutral-300 hover:shadow" : "cursor-not-allowed opacity-50"
          }`}
        >
          <div className="rounded bg-neutral-200 px-2 py-1 text-xs font-semibold text-neutral-700">Vendors</div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-neutral-900">Vendor catalogue</span>
            <span className="text-xs text-neutral-500">Maintain normalised vendor names and tags.</span>
          </div>
        </button>
      </section>

      {showSyncBanner ? (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
          Membership changes are syncing...
          {syncExceeded ? (
            <button type="button" className="ml-2 text-blue-600 underline" onClick={() => router.refresh()}>
              Reload
            </button>
          ) : null}
        </div>
      ) : null}

      {noPermissions ? (
        <p className="rounded border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
          You do not have permission to manage receipt settings.
        </p>
      ) : null}

      {activeTab === "cards" && hasCardsPerm ? (
        <CardsPanel
          canManage={hasCardsPerm}
          storeIds={permissions?.storeIds ?? []}
          storeOptions={storeOptions}
          selectedStoreId={effectiveStoreId}
          selectedStoreName={selectedStoreName}
          pushToast={pushToast}
          loadingPermissions={permissionsBusy}
        />
      ) : null}

      {activeTab === "members" ? (
        <MembersPanel
          canManage={hasMembersPerm}
          storeId={effectiveStoreId}
          storeName={selectedStoreName}
          pushToast={pushToast}
        />
      ) : null}

      {activeTab === "vendors" && hasVendorsPerm ? (
        <VendorsPanel canManage={hasVendorsPerm} pushToast={pushToast} />
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
