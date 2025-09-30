"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useTranslations } from "@/lib/i18n/I18nProvider";
import { useAppSelector } from "@/lib/state/store";
import { auth, firebaseApp } from "@/lib/firebase/client";
import { useUserPermissions } from "@/lib/hooks/useUserPermissions";

import { UploadInformationPanel } from "./components/UploadInformationPanel";
import { UploadDropzone } from "./components/UploadDropzone";
import { UploadQueueList } from "./components/UploadQueueList";
import { UploadRecentActivity } from "./components/UploadRecentActivity";
import { ToastContainer } from "./components/ToastContainer";
import { UploadGlyph, type UploadGlyphName } from "./components/UploadGlyph";
import { RECEIPTS_FLAG } from "./constants";
import { useUploadForm } from "./hooks/useUploadForm";
import { useUploadQueue } from "./hooks/useUploadQueue";
import { useUploadToasts } from "./hooks/useUploadToasts";

const SIGNED_IN_PLACEHOLDER = "__NAME__";

export default function UploadPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const t = useTranslations();
  const tPage = useTranslations("upload.page");

  const {
    permissions,
    loading: permissionsLoading,
    optimisticMemberships,
    confirmed,
    authReady,
    currentUid,
  } = useUserPermissions();

  const preload = useAppSelector((state) => state.permissions);
  const sameUserPreload =
    preload.hasData && (preload.userId === null || currentUid === null || preload.userId === currentUid);
  const preloadReady = sameUserPreload;

  const storeIds = preloadReady ? preload.storeIds : permissions?.storeIds ?? [];
  const activeStoreId = preloadReady ? preload.activeStoreId ?? null : permissions?.activeStoreId ?? null;
  const requestedStoreId = searchParams.get("store");

  const featureDisabled = !RECEIPTS_FLAG;

  const stepsStorageKey = currentUid ? `upload.steps.hidden:${currentUid}` : "upload.steps.hidden";
  const [showSteps, setShowSteps] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const stored = window.localStorage.getItem(stepsStorageKey);
      setShowSteps(stored !== "1");
    } catch {
      setShowSteps(true);
    }
  }, [stepsStorageKey]);

  const handleHideSteps = useCallback(() => {
    setShowSteps(false);
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(stepsStorageKey, "1");
    } catch {
      // ignore storage failures
    }
  }, [stepsStorageKey]);

  const handleShowSteps = useCallback(() => {
    setShowSteps(true);
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.removeItem(stepsStorageKey);
    } catch {
      // ignore storage failures
    }
  }, [stepsStorageKey]);

  const form = useUploadForm({
    storeIds,
    activeStoreId,
    requestedStoreId,
    permissions,
    optimisticMemberships,
    confirmed,
    authReady,
    permissionsLoading,
    preloadReady,
    featureDisabled,
    currentUid,
  });

  const { toasts, addToast } = useUploadToasts();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const captureInputRef = useRef<HTMLInputElement | null>(null);

  const queue = useUploadQueue({
    storeId: form.storeId,
    featureDisabled,
    addToast,
    buildEnqueueContext: form.buildEnqueueContext,
    getPurposeContext: form.getPurposeContext,
    getPurchasePurpose: form.getPurchasePurpose,
    getAdvancePayment: form.getAdvancePayment,
    getPaymentMethodContext: form.getPaymentMethodContext,
  });

  useEffect(() => {
    const runtimeProjectId = firebaseApp.options?.projectId ?? null;
    const envProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? null;
    if (runtimeProjectId && envProjectId && runtimeProjectId !== envProjectId) {
      console.warn("[firebase] project mismatch", { runtimeProjectId, envProjectId });
    }
  }, []);

  useEffect(() => {
    if (!authReady) {
      return;
    }
    const current = auth.currentUser;
    if (!current) {
      console.info("[auth] current user not available");
      return;
    }
    let cancelled = false;
    current
      .getIdTokenResult(true)
      .then((token) => {
        if (cancelled) return;
        console.info("[auth] token claims", token.claims);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[auth] failed to fetch token claims", error);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady]);

  useEffect(() => {
    const joined = searchParams.get("joined");
    const joinedStore = searchParams.get("store");
    if (joined === "1") {
      addToast("success", tPage("joined"));
      const target = joinedStore ? `/dashboard/upload?store=${encodeURIComponent(joinedStore)}` : "/dashboard/upload";
      router.replace(target, { scroll: false });
    }
  }, [addToast, router, searchParams, tPage]);

  const handleSelectFilesClick = useCallback(() => {
    if (!form.storeId) {
      addToast("error", tPage("storeRequired"));
      return;
    }
    fileInputRef.current?.click();
  }, [addToast, form.storeId, tPage]);

  const handleCaptureClick = useCallback(() => {
    if (!form.storeId) {
      addToast("error", tPage("storeRequired"));
      return;
    }
    captureInputRef.current?.click();
  }, [addToast, form.storeId, tPage]);

  const purposeContext = form.getPurposeContext();
  const showPurposeNoteInput = purposeContext.option?.requiresNote ?? false;

  const user = auth.currentUser;
  const userName = user?.displayName || user?.email || user?.uid || t("common.unknown");
  const signedInText = tPage("signedInAs", { name: SIGNED_IN_PLACEHOLDER });
  const [signedInBefore, signedInAfter] = signedInText.split(SIGNED_IN_PLACEHOLDER);

  const showSyncBanner = form.isSyncing;

  const stepTimeline: Array<{ id: string; icon: UploadGlyphName; label: string; hint: string }> = [
    {
      id: "information",
      icon: "information",
      label: tPage("steps.information"),
      hint: tPage("steps.informationHint"),
    },
    {
      id: "dropzone",
      icon: "dropzone",
      label: tPage("steps.dropzone"),
      hint: tPage("steps.dropzoneHint"),
    },
    {
      id: "activity",
      icon: "activity",
      label: tPage("steps.activity"),
      hint: tPage("steps.activityHint"),
    },
  ];

  if (!RECEIPTS_FLAG) {

    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6">
        <h1 className="text-xl font-semibold">{tPage("disabledTitle")}</h1>
        <p className="text-sm text-neutral-500">{tPage("disabledMessage")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-[60vh] bg-gradient-to-b from-slate-50 via-white to-slate-100 py-8 sm:py-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 sm:px-6 lg:px-8 md:gap-10">
        <div className="flex flex-col gap-4 text-center lg:flex-row lg:items-end lg:justify-between lg:text-left">
          <div className="flex flex-col gap-2">
            <span className="chip-accent w-fit">{tPage("badge")}</span>
            <h1 className="text-3xl font-semibold text-neutral-900">{tPage("title")}</h1>
            <p className="text-sm text-neutral-500">{tPage("description")}</p>
          </div>
          <p className="text-xs text-neutral-500 lg:self-end lg:text-right">
            {signedInBefore}
            <span className="font-medium text-neutral-700">{userName}</span>
            {signedInAfter}
          </p>
        </div>

      {showSyncBanner ? (
        <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-center text-xs text-blue-700 sm:mt-0 sm:text-left" aria-live="polite">
          {tPage("syncBanner")}
          {form.syncExceeded ? (
            <button
              type="button"
              className="ml-2 text-blue-600 underline"
              onClick={() => router.refresh()}
            >
              {tPage("reload")}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-center sm:justify-end">
        <button
          type="button"
          onClick={showSteps ? handleHideSteps : handleShowSteps}
          className="rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-600 transition hover:border-neutral-400 hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
          aria-pressed={showSteps}
        >
          {showSteps ? tPage("stepsToggle.hide") : tPage("stepsToggle.show")}
        </button>
      </div>

      {showSteps ? (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {stepTimeline.map((step, index) => (
            <div
              key={step.id}
              className="surface-card surface-card--interactive flex items-start gap-3 p-4 sm:p-5"
            >
              <span className="section-header__icon">
                <UploadGlyph name={step.icon} className="size-5" />
              </span>
              <div className="flex flex-col gap-1">
                <span className="chip-muted w-fit">{tPage("stepLabel", { index: index + 1 })}</span>
                <p className="text-sm font-medium text-neutral-800">{step.label}</p>
                <p className="text-xs text-neutral-500">{step.hint}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)] xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)]">
        <UploadInformationPanel
          isHydrated={form.isHydrated}
          featureDisabled={featureDisabled}
          storeId={form.storeId}
          storeOptions={form.storeOptions}
          storeQuickOptions={form.storeQuickOptions}
          storeSelectValue={form.storeSelectValue}
          storeSelectDisabled={form.storeSelectDisabled}
          storeSelectTitle={form.storeSelectTitle}
          hasStoresAvailable={form.hasStoresAvailable}
          onSelectStore={form.setStoreId}
          onResetInfo={form.resetForm}
          onAddStore={() => router.push("/stores/new")}
          sourceType={form.sourceType}
          onChangeSourceType={form.setSourceType}
          advancePayment={form.advancePayment}
          onChangeAdvancePayment={form.setAdvancePayment}
          paymentMethodChoices={form.paymentMethodChoices}
          paymentMethodKey={form.paymentMethodKey}
          onChangePaymentMethod={form.setPaymentMethodKey}
          paymentQuickChoices={form.paymentQuickChoices}
          purposeKey={form.purposeKey}
          onChangePurpose={form.setPurposeKey}
          purposeNote={form.purposeNote}
          onChangePurposeNote={form.setPurposeNote}
          purposeQuickOptions={form.purposeQuickOptions}
          showPurposeNoteInput={showPurposeNoteInput}
          purchasePurpose={form.purchasePurpose}
          onChangePurchasePurpose={form.setPurchasePurpose}
          onPurchasePurposeBlur={form.handlePurchasePurposeBlur}
          purchaseQuickValues={form.purchaseQuickValues}
          onPurposeQuickSelect={form.handlePurposeQuickSelect}
          onPurchaseQuickSelect={form.handlePurchaseQuickSelect}
        />
        <div className="flex flex-col gap-6">
          <UploadDropzone
            storeId={form.storeId}
            readyCount={queue.readyCount}
            uploading={queue.uploading}
            isDropActive={queue.isDropActive}
            showDropHint={queue.showDropHint}
            onSelectFilesClick={handleSelectFilesClick}
            onCaptureClick={handleCaptureClick}
            onUploadClick={queue.uploadReadyItems}
            onDragEnter={queue.handleDragEnter}
            onDragLeave={queue.handleDragLeave}
            onDragOver={queue.handleDragOver}
            onDrop={queue.handleDrop}
            fileInputRef={fileInputRef}
            captureInputRef={captureInputRef}
            onFileChange={queue.handleFiles}
            onCaptureChange={queue.handleCapture}
          />
          <UploadRecentActivity items={queue.recentItems} userName={userName} />
        </div>
      </div>

      <UploadQueueList items={queue.items} userName={userName} onCancel={queue.cancelItem} />
    </div>

    <ToastContainer toasts={toasts} />
  </div>
);
}
