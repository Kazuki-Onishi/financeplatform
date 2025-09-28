"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useAppSelector } from "@/lib/state/store";
import { auth, firebaseApp } from "@/lib/firebase/client";
import { useUserPermissions } from "@/lib/hooks/useUserPermissions";

import { UploadInformationPanel } from "./components/UploadInformationPanel";
import { UploadDropzone } from "./components/UploadDropzone";
import { UploadQueueList } from "./components/UploadQueueList";
import { UploadRecentActivity } from "./components/UploadRecentActivity";
import { ToastContainer } from "./components/ToastContainer";
import { RECEIPTS_FLAG } from "./constants";
import { useUploadForm } from "./hooks/useUploadForm";
import { useUploadQueue } from "./hooks/useUploadQueue";
import { useUploadToasts } from "./hooks/useUploadToasts";

export default function UploadPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

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
      addToast("success", "Joined the store");
      const target = joinedStore ? `/dashboard/upload?store=${encodeURIComponent(joinedStore)}` : "/dashboard/upload";
      router.replace(target, { scroll: false });
    }
  }, [addToast, router, searchParams]);

  const handleSelectFilesClick = useCallback(() => {
    if (!form.storeId) {
      addToast("error", "Select a store before uploading files");
      return;
    }
    fileInputRef.current?.click();
  }, [addToast, form.storeId]);

  const handleCaptureClick = useCallback(() => {
    if (!form.storeId) {
      addToast("error", "Select a store before uploading files");
      return;
    }
    captureInputRef.current?.click();
  }, [addToast, form.storeId]);

  const purposeContext = form.getPurposeContext();
  const showPurposeNoteInput = purposeContext.option?.requiresNote ?? false;

  const user = auth.currentUser;
  const userName = user?.displayName || user?.email || user?.uid || "you";

  const showSyncBanner = form.isSyncing;

  if (!RECEIPTS_FLAG) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6">
        <h1 className="text-xl font-semibold">Receipts upload is disabled</h1>
        <p className="text-sm text-neutral-500">Set NEXT_PUBLIC_APPFLAG_RECEIPTS=on to access this feature.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold">Upload Receipts</h1>
          <p className="text-sm text-neutral-500">
            Select image files (max 20MB each). Duplicate receipts are blocked using SHA-256 and perceptual hash.
          </p>
        </div>
        <p className="text-xs text-neutral-500">
          Signed in as <span className="font-medium text-neutral-700">{userName}</span>
        </p>
      </div>

      {showSyncBanner ? (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700" aria-live="polite">
          Membership changes are syncing...
          {form.syncExceeded ? (
            <button type="button" className="ml-2 text-blue-600 underline" onClick={() => router.refresh()}>
              Reload
            </button>
          ) : null}
        </div>
      ) : null}

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

      <UploadQueueList items={queue.items} userName={userName} onCancel={queue.cancelItem} />

      <UploadRecentActivity items={queue.recentItems} userName={userName} />

      <ToastContainer toasts={toasts} />
    </div>
  );
}
