"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { auth } from "@/lib/firebase/client";
import {
  createStoreInvite,
  fetchStoreInvites,
  peekCachedStoreInvites,
  revokeStoreInvite,
  type StoreInviteRecord,
} from "@/lib/api.client";
import { useDashboardPermissions } from "../../PermissionsProvider";
import type { PermissionFlag } from "@/types/permissions";
import type { StoreMemberRole } from "@/types/store";
import { useTranslations } from "@/lib/i18n/I18nProvider";

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
  targetUserId?: string | null;
  targetEmail?: string | null;
  targetDisplayName?: string | null;
}

interface InviteFormState {
  role: StoreMemberRole;
  flags: PermissionFlag[];
  maxUses: string;
  expiresInDays: string;
  note: string;
}

interface InviteSearchResult {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  status: "available" | "member" | "invited";
}



const ROLE_VALUES: StoreMemberRole[] = ["owner", "manager", "staff", "viewer"];

const FLAG_VALUES: PermissionFlag[] = [
  "perm.upload",
  "perm.editFields",
  "perm.view",
  "perm.exportCsv",
  "perm.lock",
  "perm.unlock",
  "perm.manageCards",
  "perm.manageVendors",
  "perm.manageMembers",
];

const EXPIRES_VALUES = ["7", "30", "90", "0"] as const;

function mapInviteRecord(record: StoreInviteRecord): InviteListItem {
  return {
    id: record.id,
    token: record.token ?? "",
    code: record.code ?? "",
    link: record.link ?? "",
    role: (record.role as StoreMemberRole) ?? "staff",
    flags: Array.isArray(record.flags) ? record.flags : [],
    status: record.status ?? "active",
    used: record.used ?? 0,
    maxUses: record.maxUses ?? 0,
    createdAt: record.createdAt ?? "",
    expiresAt: record.expiresAt ?? "",
    note: record.note ?? null,
    targetUserId: record.targetUserId ?? null,
    targetEmail: record.targetEmail ?? null,
    targetDisplayName: record.targetDisplayName ?? null,
  };
}

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

export default function SettingsInvitesPage() {
  const {
    permissions,
    loading: permissionsLoading,
    authReady,
  } = useDashboardPermissions();
  const t = useTranslations("settings.invites");

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
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [userSearchResults, setUserSearchResults] = useState<InviteSearchResult[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [userSearchError, setUserSearchError] = useState<string | null>(null);
  const [directInviteRole, setDirectInviteRole] = useState<StoreMemberRole>("staff");
  const [directInviteFlags, setDirectInviteFlags] = useState<PermissionFlag[]>(["perm.upload", "perm.view"]);
  const [directInviteSending, setDirectInviteSending] = useState<string | null>(null);

  const roleOptions = useMemo(
    () =>
      ROLE_VALUES.map((value) => ({
        value,
        label: t(`roles.${value}.label`),
        description: t(`roles.${value}.description`),
      })),
    [t],
  );

  const flagOptions = useMemo(
    () =>
      FLAG_VALUES.map((value) => ({
        value,
        label: t(`flags.${value}.label`),
        description: t(`flags.${value}.description`),
      })),
    [t],
  );

  const expiresOptions = useMemo(
    () =>
      EXPIRES_VALUES.map((value) => ({
        value,
        label: t(`expires.${value}`),
      })),
    [t],
  );

  const roleLabelMap = useMemo(() => {
    const map = new Map<StoreMemberRole, { label: string; description: string }>();
    roleOptions.forEach((option) => map.set(option.value, option));
    return map;
  }, [roleOptions]);

  const flagLabelMap = useMemo(() => {
    const map = new Map<PermissionFlag, string>();
    flagOptions.forEach((option) => map.set(option.value, option.label));
    return map;
  }, [flagOptions]);

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

  const storeName = useMemo(() => {
    if (!selectedStoreId) {
      return "";
    }
    const match = stores.find((store) => store.id === selectedStoreId);
    if (!match) {
      return selectedStoreId;
    }
    return match.name.replace(/^★\s*/, "");
  }, [selectedStoreId, stores]);
  const storeDisplayName = storeName || t("storePicker.none");

  const handleLoadInvites = useCallback(
    async (storeId: string, force = false) => {
      if (!storeId) {
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
        const message = (error as Error)?.message ?? t("errors.loadInvites");
        setInvitesError(message);
        if (message.includes("403")) {
          pushToast("error", t("errors.noPermission"));
        } else {
          pushToast("error", message);
        }
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

  useEffect(() => {
    setUserSearchResults([]);
    setUserSearchError(null);
    setUserSearchQuery("");
    setDirectInviteSending(null);
  }, [selectedStoreId]);

  const toggleFlag = useCallback((flag: PermissionFlag) => {
    setFormState((prev) => {
      const hasFlag = prev.flags.includes(flag);
      const nextFlags = hasFlag ? prev.flags.filter((item) => item !== flag) : [...prev.flags, flag];
      return { ...prev, flags: uniqueFlags(nextFlags) };
    });
  }, []);

  const toggleDirectFlag = useCallback((flag: PermissionFlag) => {
    setDirectInviteFlags((prev) => {
      const hasFlag = prev.includes(flag);
      const nextFlags = hasFlag ? prev.filter((item) => item !== flag) : uniqueFlags([...prev, flag]);
      return nextFlags;
    });
  }, []);

  const handleSearchUsers = useCallback(async () => {
    const storeId = selectedStoreId;
    if (!storeId) {
      pushToast("error", t("errors.selectStore"));
      return;
    }
    const query = userSearchQuery.trim();
    if (!query) {
      setUserSearchResults([]);
      setUserSearchError(null);
      return;
    }
    if (!auth.currentUser) {
      pushToast("error", t("errors.signIn"));
      return;
    }
    setSearchingUsers(true);
    setUserSearchError(null);
    try {
      const idToken = await user.getIdToken();
      const params = new URLSearchParams({ query, limit: "10" });
      const response = await fetch(
        `/api/stores/${encodeURIComponent(storeId)}/invites/search?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${idToken}`,
          },
        },
      );
      const payload = (await response.json().catch(() => null)) as { users?: InviteSearchResult[]; error?: string } | null;
      if (!response.ok || !payload?.users) {
        const message = payload?.error ?? t("errors.searchUsers");
        setUserSearchResults([]);
        setUserSearchError(message);
        return;
      }
      setUserSearchResults(payload.users);
    } catch (error) {
      console.error("[settings] failed to search users", error);
      setUserSearchResults([]);
      setUserSearchError(t("errors.searchUsersNetwork"));
    } finally {
      setSearchingUsers(false);
    }
  }, [pushToast, selectedStoreId, userSearchQuery]);

  const handleClearUserSearch = useCallback(() => {
    setUserSearchResults([]);
    setUserSearchError(null);
  }, []);

  const handleSendDirectInvite = useCallback(
    async (user: InviteSearchResult) => {
      const storeId = selectedStoreId;
      if (!storeId) {
        pushToast("error", t("errors.selectStore"));
        return;
      }
      if (user.status !== "available") {
        return;
      }
      if (!auth.currentUser) {
        pushToast("error", t("errors.signIn"));
        return;
      }
      setDirectInviteSending(user.uid);
      try {
        await createStoreInvite(storeId, {
          role: directInviteRole,
          flags: directInviteFlags,
          maxUses: 1,
          targetUserId: user.uid,
        });
        const recipient = user.email ?? user.displayName ?? user.uid;
        pushToast("success", t("toasts.directInviteSent", { recipient }));
        setUserSearchResults((prev) =>
          prev.map((item) => (item.uid === user.uid ? { ...item, status: "invited" } : item)),
        );
        await handleLoadInvites(storeId, true);
      } catch (error) {
        console.error("[settings] failed to create direct invite", error);
        const message = (error as Error)?.message ?? t("errors.createInvite");
        pushToast("error", message);
      } finally {
        setDirectInviteSending(null);
      }
    },
    [directInviteFlags, directInviteRole, handleLoadInvites, pushToast, selectedStoreId],
  );

  const handleCreateInvite = useCallback(async () => {
    const storeId = selectedStoreId;
    if (!storeId) {
      pushToast("error", t("errors.selectStore"));
      return;
    }
    if (!auth.currentUser) {
      pushToast("error", t("errors.signIn"));
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
      await createStoreInvite(storeId, {
        role: formState.role,
        flags: formState.flags,
        maxUses,
        expiresAt,
        note,
      });
      pushToast("success", t("toasts.createSuccess"));
      setFormState((prev) => ({
        ...prev,
        maxUses: "1",
        note: "",
      }));
      await handleLoadInvites(storeId, true);
    } catch (error) {
      console.error("[settings] failed to create invite", error);
      const message = (error as Error)?.message ?? t("errors.createInvite");
      pushToast("error", message);
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
        .then(() => pushToast("success", t("toasts.copySuccess")))
        .catch(() => pushToast("error", t("errors.copyLink")));
    } else {
      pushToast("info", t("toasts.copyFallback", { link: fullLink }));
    }
  }, [pushToast]);

  const handleRevoke = useCallback(
    async (invite: InviteListItem) => {
      if (!selectedStoreId) {
        return;
      }
      if (!auth.currentUser) {
        pushToast("error", t("errors.signIn"));
        return;
      }
      const confirm = window.confirm(t("confirm.revoke"));
      if (!confirm) {
        return;
      }
      setRevokingId(invite.id);
      try {
        await revokeStoreInvite(selectedStoreId, invite.id);
        pushToast("success", t("toasts.revokeSuccess"));
        await handleLoadInvites(selectedStoreId, true);
      } catch (error) {
        console.error("[settings] failed to revoke invite", error);
        const message = (error as Error)?.message ?? t("errors.revokeInvite");
        pushToast("error", message);
      } finally {
        setRevokingId(null);
      }
    },
    [handleLoadInvites, pushToast, selectedStoreId],
  );

  const hasStores = storeIds.length > 0;
  const disableActions = !authReady || permissionsLoading || !selectedStoreId;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-neutral-900">{t("page.title")}</h1>
        <p className="text-sm text-neutral-600">{t("page.description")}</p>
        <p className="text-xs text-neutral-500">{t("page.permissionHint")}</p>
      </div>

      {!hasStores ? (
        <div className="rounded border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
          {t("noStores")}
        </div>
      ) : null}

      {hasStores ? (
        <section
          className={`flex flex-col gap-3 rounded border p-4 ${
            selectedStoreId ? "border-blue-200 bg-blue-50/40" : "border-neutral-200 bg-white"
          }`}
        >
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-neutral-700" htmlFor="invite-store">
              {t("storePicker.label")}
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
          <div className="flex items-center gap-2 text-xs text-blue-700">
            <span>{t("storePicker.selectedLabel")}</span>
            <span className="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-sm font-semibold text-blue-700">
              {storeDisplayName}
            </span>
          </div>
        </section>
      ) : null}

      {hasStores ? (
        <section className="flex flex-col gap-4 rounded border border-neutral-200 bg-white p-4">
          <h2 className="text-lg font-semibold text-neutral-900">{t("form.title")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">{t("form.roleLabel")}</span>
              <select
                value={formState.role}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, role: event.target.value as StoreMemberRole }))
                }
                disabled={disableActions || creating}
                className="rounded border border-neutral-300 px-3 py-2"
              >
                {roleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-neutral-400">
                {roleOptions.find((option) => option.value === formState.role)?.description ?? ""}
              </span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">{t("form.maxUsesLabel")}</span>
              <input
                type="number"
                min={0}
                value={formState.maxUses}
                onChange={(event) => setFormState((prev) => ({ ...prev, maxUses: event.target.value }))}
                disabled={disableActions || creating}
                className="rounded border border-neutral-300 px-3 py-2"
              />
              <span className="text-xs text-neutral-400">{t("form.maxUsesHint")}</span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">{t("form.expiresLabel")}</span>
              <select
                value={formState.expiresInDays}
                onChange={(event) => setFormState((prev) => ({ ...prev, expiresInDays: event.target.value }))}
                disabled={disableActions || creating}
                className="rounded border border-neutral-300 px-3 py-2"
              >
                {expiresOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm md:col-span-2">
              <span className="text-neutral-500">{t("form.noteLabel")}</span>
              <input
                type="text"
                value={formState.note}
                onChange={(event) => setFormState((prev) => ({ ...prev, note: event.target.value }))}
                maxLength={160}
                disabled={disableActions || creating}
                className="rounded border border-neutral-300 px-3 py-2"
                placeholder={t("form.notePlaceholder")}
              />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-neutral-700">{t("form.flagsLabel")}</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {flagOptions.map((option) => {
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
              {creating ? t("form.submitting") : t("form.submit")}
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
        <section className="flex flex-col gap-4 rounded border border-neutral-200 bg-white p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-neutral-900">{t("direct.title")}</h2>
            <p className="text-xs text-neutral-500">{t("direct.description")}</p>
          </div>
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <label className="flex w-full flex-col gap-1 text-sm md:max-w-sm">
              <span className="text-neutral-500">{t("direct.searchLabel")}</span>
              <input
                type="text"
                value={userSearchQuery}
                onChange={(event) => setUserSearchQuery(event.target.value)}
                placeholder={t("direct.searchPlaceholder")}
                className="rounded border border-neutral-300 px-3 py-2"
                disabled={disableActions || searchingUsers}
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSearchUsers}
                disabled={disableActions || searchingUsers}
                className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
              >
                {searchingUsers ? t("direct.searching") : t("direct.searchButton")} 
              </button>
              <button
                type="button"
                onClick={handleClearUserSearch}
                disabled={userSearchResults.length === 0 && !userSearchError}
                className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("direct.clear")}
              </button>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-500">{t("direct.roleLabel")}</span>
              <select
                value={directInviteRole}
                onChange={(event) => setDirectInviteRole(event.target.value as StoreMemberRole)}
                disabled={disableActions || searchingUsers || directInviteSending !== null}
                className="rounded border border-neutral-300 px-3 py-2"
              >
                {roleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-neutral-400">
                {roleOptions.find((option) => option.value === directInviteRole)?.description ?? ""}
              </span>
            </label>
            <fieldset className="flex flex-col gap-2 text-sm md:col-span-1">
              <legend className="text-neutral-500">{t("direct.flagsLabel")}</legend>
              <div className="grid gap-2">
                {flagOptions.map((option) => {
                  const checked = directInviteFlags.includes(option.value);
                  return (
                    <label
                      key={option.value}
                      className="flex items-start gap-2 rounded border border-neutral-200 bg-neutral-50 p-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDirectFlag(option.value)}
                        disabled={disableActions || searchingUsers || directInviteSending !== null}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-medium text-neutral-700">{option.label}</span>
                        <span className="block text-[11px] text-neutral-500">{option.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
          {userSearchError ? (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{userSearchError}</div>
          ) : null}
          {searchingUsers && !userSearchResults.length ? (
            <p className="text-sm text-neutral-500">{t("direct.status.searching")}</p>
          ) : null}
          {!searchingUsers && !userSearchResults.length && !userSearchError ? (
            <p className="text-sm text-neutral-500">{t("direct.status.hint")}</p>
          ) : null}
          {userSearchResults.length ? (
            <div className="flex flex-col gap-2">
              {userSearchResults.map((user) => {
                const disabled = user.status !== "available" || disableActions || directInviteSending === user.uid;
                const statusLabel =
                  user.status === "available"
                    ? t("direct.userStatus.available")
                    : user.status === "member"
                    ? t("direct.userStatus.member")
                    : t("direct.userStatus.invited");
                return (
                  <div
                    key={user.uid}
                    className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-200 bg-white p-3"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-neutral-800">
                        {user.displayName ?? user.email ?? user.uid}
                      </span>
                      <span className="text-xs text-neutral-500">{user.email ?? t("direct.userStatus.emailUnknown")}</span>
                      <span className="text-[11px] text-neutral-400">{statusLabel}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSendDirectInvite(user)}
                      disabled={disabled}
                      className="rounded border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {directInviteSending === user.uid ? t("direct.sendInviteSending") : t("direct.sendInvite")}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {selectedStoreId ? (
        <section className="flex flex-col gap-3">
          <header className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900">{t("list.title")}</h2>
              <p className="text-xs text-neutral-500">{t("list.description", { store: storeDisplayName })}</p>
            </div>
            <button
              type="button"
              onClick={() => handleLoadInvites(selectedStoreId, true)}
              disabled={invitesLoading}
              className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {invitesLoading ? t("list.refreshing") : t("list.refresh")}
            </button>
          </header>

          {invitesError ? (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{invitesError}</div>
          ) : null}

          <div className="divide-y divide-neutral-200 rounded border border-neutral-200">
            {!invites.length && !invitesLoading ? (
              <p className="px-4 py-6 text-sm text-neutral-500">{t("list.empty")}</p>
            ) : null}
            {invites.map((invite) => {
              const statusLabel = t(`list.status.${invite.status}` as const, { defaultValue: invite.status });
              const roleLabel = roleLabelMap.get(invite.role)?.label ?? invite.role;
              const flagLabels = invite.flags.map((flag) => flagLabelMap.get(flag) ?? flag);
              const usesLabel =
                invite.maxUses === 0
                  ? t("list.usesUnlimited", { used: invite.used })
                  : t("list.uses", { used: invite.used, max: invite.maxUses });
              return (
                <div key={invite.id} className="flex flex-col gap-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-semibold text-neutral-900">{invite.code}</span>
                  <span className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600">{roleLabel}</span>
                  <span
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      invite.status === "active"
                        ? "bg-green-100 text-green-700"
                        : invite.status === "revoked"
                        ? "bg-red-100 text-red-700"
                        : "bg-neutral-100 text-neutral-600"
                    }`}
                  >
                    {statusLabel}
                  </span>
                  <span className="text-xs text-neutral-500">{usesLabel}</span>
                </div>

                {invite.flags.length ? (
                  <div className="flex flex-wrap gap-2 text-[11px] uppercase text-neutral-500">
                    {invite.flags.map((flag) => (
                      <span key={flag} className="rounded bg-neutral-100 px-2 py-1">
                        {flagLabelMap.get(flag) ?? flag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-neutral-400">{t("list.noFlags")}</span>
                )}

                {invite.targetUserId ? (
                  <p className="text-xs text-neutral-500">
                    {t("list.directFor", {
                      recipient: invite.targetEmail ?? invite.targetDisplayName ?? invite.targetUserId,
                    })}
                  </p>
                ) : null}

                {invite.note ? (
                  <p className="text-xs text-neutral-500">{t("list.note", { note: invite.note })}</p>
                ) : null}

                <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
                  <span>{t("list.created", { date: formatDate(invite.createdAt) })}</span>
                  <span>
                    {invite.expiresAt
                      ? t("list.expires", { date: formatDate(invite.expiresAt) })
                      : t("list.noExpiry")}
                  </span>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => handleCopyLink(invite)}
                    className="rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-100"
                  >
                    {t("list.copyLink")}
                  </button>
                  <Link
                    href={invite.link}
                    className="rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-100"
                    target="_blank"
                  >
                    {t("list.openLink")}
                  </Link>
                  <button
                    type="button"
                    onClick={() => handleRevoke(invite)}
                    disabled={invite.status === "revoked" || revokingId === invite.id}
                    className="rounded border border-red-300 px-3 py-1 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {revokingId === invite.id ? t("list.revoking") : t("list.revoke")}
                  </button>
                </div>
              </div>
            );
            })}
          </div>

          {invitesLoading ? <p className="text-xs text-neutral-500">{t("list.loading")}</p> : null}
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

















