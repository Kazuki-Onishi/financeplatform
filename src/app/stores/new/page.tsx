"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/firebase/client";
import { useUserPermissions } from "@/lib/hooks/useUserPermissions";
import { coercePermissionFlags, normalizeStoreMemberRole } from "@/lib/permissions";
import {
  applyPermissionsPatch,
  setActiveStoreId,
  upsertMembership,
  usePermissionsStore,
} from "@/lib/state/userPermissionsStore";
import { useTranslations } from "@/lib/i18n/I18nProvider";

interface CreateStoreResponse {
  storeId: string;
  role: string;
  perms: string[];
  userPermissions?: {
    storeIds?: string[];
    activeStoreId?: string | null;
    flags?: string[];
  };
}

function isCreateStoreResponse(v: unknown): v is CreateStoreResponse {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const permsOk = Array.isArray(o.perms) && o.perms.every((p) => typeof p === "string");
  return typeof o.storeId === "string" && typeof o.role === "string" && permsOk;
}

const SYNC_TIMEOUT_MS = 10_000;
const CURRENCY_OPTIONS = [
  "JPY", "USD", "EUR", "GBP", "AUD", "CAD", "CHF", "CNY", "HKD", "KRW",
];
const TIMEZONE_OPTIONS = [
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Bangkok",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
];

export default function CreateStorePage() {
  const router = useRouter();
  const t = useTranslations("stores.new");
  const { confirmed } = useUserPermissions();
  const { dispatch } = usePermissionsStore();
  const [mode, setMode] = useState<"choice" | "create">("choice");
  const isCreating = mode === "create";
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState(CURRENCY_OPTIONS[0]);
  const [timezone, setTimezone] = useState(TIMEZONE_OPTIONS[0]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);
  const [syncExceeded, setSyncExceeded] = useState(false);

  const isSyncing = isCreating && Boolean(syncStartedAt && !confirmed);

  useEffect(() => {
    if (mode === "choice") {
      setName("");
      setCurrency(CURRENCY_OPTIONS[0]);
      setTimezone(TIMEZONE_OPTIONS[0]);
      setSubmitting(false);
      setSyncStartedAt(null);
      setSyncExceeded(false);
      setError(null);
      setInfo(null);
    }
  }, [mode]);

  useEffect(() => {
    if (!isCreating) {
      return;
    }
    if (confirmed) {
      setSyncStartedAt(null);
    }
  }, [confirmed, isCreating]);

  useEffect(() => {
    if (!isCreating) {
      setSyncExceeded(false);
      return;
    }
    if (!isSyncing) {
      setSyncExceeded(false);
      return;
    }
    const timer = window.setTimeout(() => setSyncExceeded(true), SYNC_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [isCreating, isSyncing]);

  useEffect(() => {
    if (!isCreating || !syncExceeded || !syncStartedAt) {
      return;
    }
    const delayMs = Date.now() - syncStartedAt;
    console.info("[sync-delay]", { delayMs });
  }, [isCreating, syncExceeded, syncStartedAt]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isCreating) {
      return;
    }
    setError(null);
    setInfo(null);

    if (!name.trim()) {
      setError(t("errors.nameRequired"));
      return;
    }

    const user = auth.currentUser;
    if (!user) {
      setError(t("errors.signInRequired"));
      return;
    }

    setSubmitting(true);
    try {
      const idToken = await user.getIdToken();
      console.info("[create-store] submit", { name, currency, timezone, uid: user.uid, idTokLen: idToken.length });

      const response = await fetch("/api/stores", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ name, currency, timezone }),
      });

      const text = await response.text().catch(() => "");
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        // JSON でないレスポンスも許容
      }
      console.info("[create-store] resp", { status: response.status, payload });

      const payloadObj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      if (!response.ok || !payloadObj || !isCreateStoreResponse(payloadObj)) {
        const message =
          typeof (payloadObj as Record<string, unknown> | null)?.message === "string"
            ? ((payloadObj as Record<string, unknown>).message as string)
            : undefined;
        const errorMsg =
          typeof (payloadObj as Record<string, unknown> | null)?.error === "string"
            ? ((payloadObj as Record<string, unknown>).error as string)
            : undefined;
        const fallbackMessage = t("errors.createFailed", { status: response.status });
        setError(message ?? errorMsg ?? fallbackMessage);
        return;
      }

      const { storeId, role, perms, userPermissions } = payloadObj;
      const flags = coercePermissionFlags(perms);
      const fallbackFlags = coercePermissionFlags(userPermissions?.flags ?? null);
      const effectiveFlags = fallbackFlags.length ? fallbackFlags : flags;
      const normalizedRole = normalizeStoreMemberRole(role, "owner");

      const storeIds = Array.isArray(userPermissions?.storeIds)
        ? userPermissions.storeIds.filter((v): v is string => typeof v === "string")
        : undefined;
      const activeRaw = userPermissions?.activeStoreId;
      const nextActive = typeof activeRaw === "string" || activeRaw === null ? (activeRaw as string | null) : storeId;

      dispatch(setActiveStoreId(storeId));
      dispatch(
        applyPermissionsPatch({
          storeIds: storeIds ?? [storeId],
          flags: effectiveFlags,
          activeStoreId: nextActive,
        }),
      );
      dispatch(
        upsertMembership({
          storeId,
          role: normalizedRole,
          flags,
          source: "store:create",
        }),
      );

      setInfo(t("status.created"));
      setSyncStartedAt(Date.now());
      setSyncExceeded(false);

      router.replace(`/dashboard/upload?store=${encodeURIComponent(storeId)}&joined=1`);
    } catch (err) {
      console.error("[create-store] network error", err);
      setError(t("errors.network"));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isCreating) {
    return (
      <div className="mx-auto flex min-h-[70vh] w-full max-w-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">{t("choice.title")}</h1>
          <p className="text-sm text-neutral-500">{t("choice.description")}</p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => router.push("/onboarding?intent=join")}
            className="flex flex-col gap-2 rounded border border-neutral-200 p-4 text-left text-sm font-medium text-blue-600 hover:border-blue-400 hover:bg-blue-50"
          >
            <span className="text-base font-semibold text-blue-700">{t("choice.joinTitle")}</span>
            <span className="text-xs font-normal text-neutral-500">{t("choice.joinDescription")}</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("create")}
            className="flex flex-col gap-2 rounded border border-neutral-200 p-4 text-left text-sm font-medium text-green-600 hover:border-green-400 hover:bg-green-50"
          >
            <span className="text-base font-semibold text-green-700">{t("choice.createTitle")}</span>
            <span className="text-xs font-normal text-neutral-500">{t("choice.createDescription")}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t("form.title")}</h1>
        <p className="text-sm text-neutral-500">{t("form.description")}</p>
      </header>

      <form className="flex flex-col gap-4 rounded border border-neutral-200 p-4" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1 text-sm" htmlFor="store-name">
          <span className="font-medium">{t("form.nameLabel")}</span>
          <input
            id="store-name"
            className="rounded border border-neutral-300 px-3 py-2"
            placeholder={t("form.namePlaceholder")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm" htmlFor="store-currency">
          <span className="font-medium">{t("form.currencyLabel")}</span>
          <select
            id="store-currency"
            className="rounded border border-neutral-300 px-3 py-2 uppercase"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            disabled={submitting}
          >
            {CURRENCY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm" htmlFor="store-timezone">
          <span className="font-medium">{t("form.timezoneLabel")}</span>
          <select
            id="store-timezone"
            className="rounded border border-neutral-300 px-3 py-2"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            disabled={submitting}
          >
            {TIMEZONE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? t("form.submitting") : t("form.submit")}
          </button>
          <button
            type="button"
            onClick={() => setMode("choice")}
            disabled={submitting}
            className="inline-flex items-center rounded border border-neutral-300 px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100"
          >
            {t("form.back")}
          </button>
        </div>
      </form>

      {isSyncing ? (
        <div className="flex items-center gap-2 text-xs text-neutral-500" aria-live="polite">
          <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700">{t("form.syncing")}</span>
          {syncExceeded ? (
            <button type="button" className="text-blue-600 underline" onClick={() => router.refresh()}>
              {t("form.reload")}
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
    </div>
  );
}

