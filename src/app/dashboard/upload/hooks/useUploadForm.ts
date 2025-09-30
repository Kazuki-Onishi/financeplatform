"use client";

import { useTranslations } from "@/lib/i18n/I18nProvider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { doc, getDoc, getDocs, limit, orderBy, query, where } from "firebase/firestore";

import { db } from "@/lib/firebase/client";
import { creditCardsCollection, receiptsCollection } from "@/lib/firestoreRefs";
import {
  PURPOSE_NOTE_MAX_LENGTH,
  findPurposeOption,
  getPurposeNoteBucket,
  type ReceiptPurposeOption,
} from "@/lib/purposeOptions";
import type { UserPermissionsState } from "@/types/permissions";
import type { ReceiptPaymentMethod, ReceiptSourceType } from "@/types/receipt";
import type { CreditCardRecord } from "@/types/creditCard";
import type { StoreDoc } from "@/types/store";
import type { OptimisticMembership } from "@/lib/state/userPermissionsStore";

import {
  DEFAULT_PAYMENT_METHODS,
  MAX_PAYMENT_METHOD_CHOICES,
  PURCHASE_HISTORY_STORAGE_KEY,
  PURCHASE_PURPOSE_MAX_LENGTH,
  PURPOSE_HISTORY_STORAGE_KEY,
  RECENT_PAYMENT_METHOD_LOOKBACK,
  STORE_HISTORY_LIMIT,
  STORE_HISTORY_STORAGE_KEY,
  SYNC_TIMEOUT_MS,
  CREDIT_CARD_FETCH_LIMIT,
} from "../constants";
import {
  createPaymentMethodKey,
  formatPaymentMethodLabel,
  isFirebasePermissionError,
  normalisePaymentMethod,
  persistStoreHistory,
} from "../utils";
import type { EnqueueContext, PaymentMethodChoice } from "../types";

interface StoreOption {
  id: string;
  name: string;
}

interface UseUploadFormParams {
  storeIds: string[];
  activeStoreId: string | null;
  requestedStoreId: string | null;
  permissions: UserPermissionsState | null;
  optimisticMemberships: OptimisticMembership[];
  confirmed: boolean;
  authReady: boolean;
  permissionsLoading: boolean;
  preloadReady: boolean;
  featureDisabled: boolean;
  currentUid: string | null;
}

interface PurposeContextResult {
  option: ReceiptPurposeOption | null;
  sanitizedNote: string;
  trimmedNote: string;
  bucket: string;
  label: string | null;
}

interface UseUploadFormResult {
  storeId: string;
  setStoreId: (storeId: string) => void;
  storeOptions: StoreOption[];
  storeQuickOptions: StoreOption[];
  storeSelectValue: string;
  storeSelectDisabled: boolean;
  storeSelectTitle?: string;
  hasStoresAvailable: boolean;
  isHydrated: boolean;
  sourceType: ReceiptSourceType;
  setSourceType: (source: ReceiptSourceType) => void;
  advancePayment: boolean;
  setAdvancePayment: (value: boolean) => void;
  purposeKey: string;
  setPurposeKey: (key: string) => void;
  purposeNote: string;
  setPurposeNote: (note: string) => void;
  purchasePurpose: string;
  setPurchasePurpose: (value: string) => void;
  purposeQuickOptions: ReceiptPurposeOption[];
  purchaseQuickValues: string[];
  paymentMethodKey: string;
  setPaymentMethodKey: (key: string) => void;
  paymentMethodChoices: PaymentMethodChoice[];
  paymentQuickChoices: PaymentMethodChoice[];
  getPurposeContext: () => PurposeContextResult;
  getPurchasePurpose: () => { sanitized: string; trimmed: string };
  getAdvancePayment: () => boolean;
  buildEnqueueContext: () => EnqueueContext;
  getPaymentMethodContext: () => PaymentMethodChoice;
  handlePurchasePurposeBlur: () => void;
  handlePurposeQuickSelect: (key: string) => void;
  handlePurchaseQuickSelect: (value: string) => void;
  resetForm: () => void;
  isSyncing: boolean;
  syncExceeded: boolean;
  permissionsBusy: boolean;
}

export function useUploadForm({
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
}: UseUploadFormParams): UseUploadFormResult {
  const tInfo = useTranslations("upload.information");
  const [storeId, setStoreId] = useState<string>("");
  const storeHistoryLoadedRef = useRef(false);

  const [storeDetails, setStoreDetails] = useState<Record<string, { name: string }>>({});
  const [storeHistory, setStoreHistory] = useState<string[]>([]);
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);
  const [syncExceeded, setSyncExceeded] = useState(false);
  const [sourceType, setSourceType] = useState<ReceiptSourceType>("receipt");
  const [advancePayment, setAdvancePayment] = useState<boolean>(false);
  const [purposeKey, setPurposeKey] = useState<string>("");
  const [purposeNote, setPurposeNote] = useState<string>("");
  const [purchasePurpose, setPurchasePurpose] = useState<string>("");
  const [purposeHistory, setPurposeHistory] = useState<string[]>([]);
  const [purchaseHistory, setPurchaseHistory] = useState<string[]>([]);
  const [recentPaymentMethods, setRecentPaymentMethods] = useState<ReceiptPaymentMethod[]>([]);
  const [availableCards, setAvailableCards] = useState<CreditCardRecord[]>([]);
  const [paymentMethodKey, setPaymentMethodKey] = useState<string>(() =>
    createPaymentMethodKey(DEFAULT_PAYMENT_METHODS[0]),
  );
  const [isHydrated, setIsHydrated] = useState(false);

  const permissionsBusy = (!preloadReady && !authReady) || (permissionsLoading && !preloadReady);
  const isSyncing = optimisticMemberships.length > 0 && !confirmed;

  const knownStoreIds = useMemo(() => {
    const ids = new Set<string>(storeIds);
    optimisticMemberships.forEach((membership) => ids.add(membership.storeId));
    return Array.from(ids);
  }, [storeIds, optimisticMemberships]);

  const paymentMethodChoices = useMemo<PaymentMethodChoice[]>(() => {
    const seen = new Set<string>();
    const choices: PaymentMethodChoice[] = [];

    const addChoice = (
      method: ReceiptPaymentMethod,
      source: PaymentMethodChoice["source"],
      labelOverride?: string,
    ) => {
      const normalized: ReceiptPaymentMethod = {
        type: method.type,
        cardId: typeof method.cardId === "string" && method.cardId.trim().length > 0 ? method.cardId.trim() : null,
      };
      const key = createPaymentMethodKey(normalized);
      if (seen.has(key)) {
        return;
      }
      if (choices.length >= MAX_PAYMENT_METHOD_CHOICES) {
        return;
      }
      seen.add(key);
      const displayLabel =
        typeof labelOverride === "string" && labelOverride.trim().length > 0
          ? labelOverride.trim()
          : formatPaymentMethodLabel(normalized);
      choices.push({
        key,
        label: displayLabel,
        method: normalized,
        source,
      });
    };

    const nicknameLabels = new Map<string, string>();
    availableCards.forEach((card) => {
      const nickname = card.nickname?.trim();
      const brand = card.brand?.trim();
      const base = nickname && nickname.length > 0 ? nickname : brand ?? "Credit card";
      const label = card.last4 ? `${base} (${card.last4})` : base;
      nicknameLabels.set(card.id, label);
    });

    recentPaymentMethods.forEach((method) => {
      const labelOverride = method.cardId ? nicknameLabels.get(method.cardId) ?? null : null;
      addChoice(method, "recent", labelOverride ?? undefined);
    });

    const sortedCards = [...availableCards].sort((a, b) => {
      const activeUidValue =
        typeof currentUid === "string" && currentUid.trim().length > 0 ? currentUid.trim() : "";
      const aOwners = Array.isArray(a.userIds) && a.userIds.length
        ? a.userIds
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter((value): value is string => value.length > 0)
        : a.userId && typeof a.userId === "string" && a.userId.trim().length > 0
        ? [a.userId.trim()]
        : [];
      const bOwners = Array.isArray(b.userIds) && b.userIds.length
        ? b.userIds
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter((value): value is string => value.length > 0)
        : b.userId && typeof b.userId === "string" && b.userId.trim().length > 0
        ? [b.userId.trim()]
        : [];
      const aIsMine = activeUidValue.length > 0 && aOwners.includes(activeUidValue);
      const bIsMine = activeUidValue.length > 0 && bOwners.includes(activeUidValue);
      if (aIsMine !== bIsMine) {
        return aIsMine ? -1 : 1;
      }
      const aLabel = (typeof a.nickname === "string" && a.nickname.trim().length > 0
        ? a.nickname.trim().toLowerCase()
        : `${a.brand ?? ""} ${a.last4 ?? ""}`.trim().toLowerCase());
      const bLabel = (typeof b.nickname === "string" && b.nickname.trim().length > 0
        ? b.nickname.trim().toLowerCase()
        : `${b.brand ?? ""} ${b.last4 ?? ""}`.trim().toLowerCase());
      return aLabel.localeCompare(bLabel);
    });
    sortedCards.forEach((card) => {
      const nickname = card.nickname?.trim();
      const brand = card.brand?.trim();
      const baseLabel = nickname && nickname.length > 0 ? nickname : brand ?? "Credit card";
      const label = card.last4 ? `${baseLabel} (${card.last4})` : baseLabel;
      addChoice({ type: "credit", cardId: card.id }, "card", label);
    });

    DEFAULT_PAYMENT_METHODS.forEach((method) => addChoice(method, "default"));
    return choices;
  }, [recentPaymentMethods, availableCards, currentUid]);

  const paymentQuickChoices = useMemo(
    () => paymentMethodChoices.filter((choice) => choice.source === "recent").slice(0, 2),
    [paymentMethodChoices],
  );

  const purposeQuickOptions = useMemo(
    () =>
      purposeHistory
        .map((key) => findPurposeOption(key))
        .filter((option): option is ReceiptPurposeOption => Boolean(option)),
    [purposeHistory],
  );

  const purchaseQuickValues = useMemo(() => purchaseHistory.slice(0, 2), [purchaseHistory]);

  useEffect(() => {
    if (!paymentMethodChoices.length) {
      const fallbackKey = createPaymentMethodKey(DEFAULT_PAYMENT_METHODS[0]);
      if (paymentMethodKey !== fallbackKey) {
        setPaymentMethodKey(fallbackKey);
      }
      return;
    }
    if (!paymentMethodChoices.some((choice) => choice.key === paymentMethodKey)) {
      setPaymentMethodKey(paymentMethodChoices[0].key);
    }
  }, [paymentMethodChoices, paymentMethodKey]);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (storeHistoryLoadedRef.current) {
      return;
    }
    if (!isHydrated) {
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
      const entries = parsed.filter((value): value is string => typeof value === "string");
      if (!entries.length) {
        return;
      }
      setStoreHistory(entries.slice(0, STORE_HISTORY_LIMIT));
    } catch (error) {
      console.warn("[upload] failed to load store history", error);
    }
  }, [isHydrated]);

  useEffect(() => {
    if (permissionsBusy) return;

    if (!knownStoreIds.length) {
      if (storeId) setStoreId("");
      return;
    }

    if (requestedStoreId && knownStoreIds.includes(requestedStoreId)) {
      if (storeId !== requestedStoreId) setStoreId(requestedStoreId);
      return;
    }

    const defaultStore = (activeStoreId ?? knownStoreIds[0]) ?? "";
    if (!storeId && defaultStore) {
      setStoreId(defaultStore);
      return;
    }
    if (storeId && !knownStoreIds.includes(storeId)) {
      setStoreId(defaultStore);
    }
  }, [permissionsBusy, knownStoreIds, requestedStoreId, storeId, activeStoreId]);

  useEffect(() => {
    if (!confirmed || !knownStoreIds.length) return;

    const missing = knownStoreIds.filter((id) => !storeDetails[id]);
    if (!missing.length) return;

    let cancelled = false;
    (async () => {
      const updates: Record<string, { name: string }> = {};
      await Promise.all(
        missing.map(async (id) => {
          try {
            const snapshot = await getDoc(doc(db, "stores", id));
            if (snapshot.exists()) {
              const data = snapshot.data() as Partial<StoreDoc>;
              const name =
                typeof data?.name === "string" && data.name.trim()
                  ? data.name.trim()
                  : id;
              updates[id] = { name };
            } else {
              updates[id] = { name: id };
            }
          } catch (error) {
            if (isFirebasePermissionError(error)) {
              console.debug("[upload] store name pending membership confirmation", id);
              updates[id] = { name: id };
              return;
            }
            console.warn("[upload] failed to load store name", id, error);
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
    if (!storeId || !knownStoreIds.includes(storeId)) {
      return;
    }
    setStoreHistory((prev) => {
      const withoutCurrent = prev.filter((id) => id !== storeId);
      const next = [storeId, ...withoutCurrent].slice(0, STORE_HISTORY_LIMIT);
      const unchanged = next.length === prev.length && next.every((id, index) => id === prev[index]);
      if (unchanged) {
        return prev;
      }
      persistStoreHistory(next);
      return next;
    });
  }, [storeId, knownStoreIds]);

  useEffect(() => {
    const activeStoreId = typeof storeId === "string" && storeId.trim().length > 0 ? storeId.trim() : null;
    const activeUid = typeof currentUid === "string" && currentUid.trim().length > 0 ? currentUid.trim() : null;
    if (!activeStoreId || !activeUid) {
      setRecentPaymentMethods([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await getDocs(
          query(
            receiptsCollection(),
            where("storeId", "==", activeStoreId),
            where("uploaderId", "==", activeUid),
            orderBy("createdAt", "desc"),
            limit(RECENT_PAYMENT_METHOD_LOOKBACK),
          ),
        );
        const seen = new Set<string>();
        const methods: ReceiptPaymentMethod[] = [];
        snapshot.docs.forEach((docSnap) => {
          const data = docSnap.data() as { paymentMethod?: unknown } | undefined;
          const normalized = normalisePaymentMethod(data?.paymentMethod);
          if (!normalized) {
            return;
          }
          const key = createPaymentMethodKey(normalized);
          if (seen.has(key)) {
            return;
          }
          seen.add(key);
          methods.push(normalized);
        });
        if (!cancelled) {
          setRecentPaymentMethods(methods.slice(0, MAX_PAYMENT_METHOD_CHOICES));
        }
      } catch (error) {
        console.warn("[upload] failed to load recent payment methods", { storeId: activeStoreId, currentUid: activeUid, error });
        if (!cancelled) {
          setRecentPaymentMethods([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, currentUid]);

  useEffect(() => {
    let cancelled = false;
    const activeStoreId = typeof storeId === "string" && storeId.trim().length > 0 ? storeId.trim() : null;
    const activeUid = typeof currentUid === "string" && currentUid.trim().length > 0 ? currentUid.trim() : null;
    (async () => {
      try {
        const fetches = [
          getDocs(
            query(
              creditCardsCollection(),
              where("storeId", "==", null),
              limit(CREDIT_CARD_FETCH_LIMIT),
            ),
          ),
          ...(activeStoreId
            ? [
                getDocs(
                  query(
                    creditCardsCollection(),
                    where("storeId", "==", activeStoreId),
                    limit(CREDIT_CARD_FETCH_LIMIT),
                  ),
                ),
              ]
            : []),
          ...(activeUid
            ? [
                getDocs(
                  query(
                    creditCardsCollection(),
                    where("userId", "==", activeUid),
                    limit(CREDIT_CARD_FETCH_LIMIT),
                  ),
                ),
                getDocs(
                  query(
                    creditCardsCollection(),
                    where("userIds", "array-contains", activeUid),
                    limit(CREDIT_CARD_FETCH_LIMIT),
                  ),
                ),
              ]
            : []),
        ];
        const snapshots = await Promise.all(fetches);
        if (cancelled) {
          return;
        }
        const cardsMap = new Map<string, CreditCardRecord>();
        snapshots.forEach((snapshot) => {
          snapshot.docs.forEach((docSnap) => {
            const data = docSnap.data();
            const storeRestriction = typeof data.storeId === "string" && data.storeId ? data.storeId.trim() : "";
            const ownerRestrictionArray = Array.isArray(data.userIds) && data.userIds.length
              ? data.userIds
                  .map((id: unknown) => (typeof id === "string" ? id.trim() : ""))
                  .filter((id): id is string => id.length > 0)
              : [];
            const legacyOwner = typeof data.userId === "string" && data.userId.trim().length > 0 ? data.userId.trim() : "";
            const effectiveOwners = ownerRestrictionArray.length ? ownerRestrictionArray : legacyOwner ? [legacyOwner] : [];
            if (storeRestriction && storeRestriction.length > 0 && storeRestriction !== (activeStoreId ?? "")) {
              return;
            }
            if (effectiveOwners.length && (!activeUid || !effectiveOwners.includes(activeUid))) {
              return;
            }
            const normalizedCard = {
              id: docSnap.id,
              ...data,
              userIds: effectiveOwners,
              userId: effectiveOwners.length === 1 ? effectiveOwners[0] : null,
            } as CreditCardRecord;
            cardsMap.set(docSnap.id, normalizedCard);
          });
        });
        const ownerKey = activeUid ?? "";
        const sortedCards = Array.from(cardsMap.values()).sort((a, b) => {
          const aOwner = typeof a.userId === "string" && a.userId ? a.userId.trim() : "";
          const bOwner = typeof b.userId === "string" && b.userId ? b.userId.trim() : "";
          const aMine = ownerKey.length > 0 && aOwner === ownerKey;
          const bMine = ownerKey.length > 0 && bOwner === ownerKey;
          if (aMine !== bMine) {
            return aMine ? -1 : 1;
          }
          const aLabel =
            typeof a.nickname === "string" && a.nickname.trim().length > 0
              ? a.nickname.trim().toLowerCase()
              : `${a.brand ?? ""} ${a.last4 ?? ""}`.trim().toLowerCase();
          const bLabel =
            typeof b.nickname === "string" && b.nickname.trim().length > 0
              ? b.nickname.trim().toLowerCase()
              : `${b.brand ?? ""} ${b.last4 ?? ""}`.trim().toLowerCase();
          return aLabel.localeCompare(bLabel);
        });
        setAvailableCards(sortedCards);
      } catch (error) {
        console.warn("[upload] failed to load saved cards", { storeId: activeStoreId, currentUid: activeUid, error });
        if (!cancelled) {
          setAvailableCards([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, currentUid]);

  useEffect(() => {
    if (isSyncing) {
      setSyncStartedAt((current) => current ?? Date.now());
      return;
    }
    setSyncStartedAt(null);
    setSyncExceeded(false);
  }, [isSyncing]);

  useEffect(() => {
    if (!syncStartedAt || !isSyncing) return;
    const timer = window.setTimeout(() => setSyncExceeded(true), SYNC_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [syncStartedAt, isSyncing]);

  useEffect(() => {
    if (!syncExceeded || !syncStartedAt) return;
    const delayMs = Date.now() - syncStartedAt;
    console.info("[sync-delay]", { delayMs, storeId });
  }, [syncExceeded, syncStartedAt, storeId]);

  useEffect(() => {
    if (featureDisabled) return;
    if (!storeId && knownStoreIds.length === 1) setStoreId(knownStoreIds[0]);
  }, [featureDisabled, knownStoreIds, storeId]);

  useEffect(() => {
    if (!purposeKey) {
      return;
    }
    const option = findPurposeOption(purposeKey);
    if (!option) {
      return;
    }
    setPurposeHistory((prev) => {
      const next = [option.key, ...prev.filter((item) => item !== option.key)].slice(0, 2);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(PURPOSE_HISTORY_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
          console.warn("[upload] failed to persist purpose history", error);
        }
      }
      return next;
    });
  }, [purposeKey]);

  const getPurposeContext = useCallback((): PurposeContextResult => {
    const option = findPurposeOption(purposeKey);
    const sanitizedNote = purposeNote.slice(0, PURPOSE_NOTE_MAX_LENGTH);
    const trimmedNote = option?.requiresNote ? sanitizedNote.trim() : "";
    const bucket = option?.requiresNote ? getPurposeNoteBucket(trimmedNote) : "0";
    return {
      option: option ?? null,
      sanitizedNote,
      trimmedNote,
      bucket,
      label: option?.label ?? null,
    };
  }, [purposeKey, purposeNote]);

  const getPurchasePurpose = useCallback(() => {
    const sanitized = purchasePurpose.slice(0, PURCHASE_PURPOSE_MAX_LENGTH);
    const trimmed = sanitized.trim();
    return { sanitized, trimmed };
  }, [purchasePurpose]);

  const handlePurchasePurposeBlur = useCallback(() => {
    const trimmed = purchasePurpose.trim();
    if (!trimmed) {
      return;
    }
    setPurchaseHistory((prev) => {
      const next = [trimmed, ...prev.filter((entry) => entry !== trimmed)].slice(0, 2);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(PURCHASE_HISTORY_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
          console.warn("[upload] failed to persist purchase history", error);
        }
      }
      return next;
    });
  }, [purchasePurpose]);

  const buildEnqueueContext = useCallback((): EnqueueContext => {
    const { option, bucket } = getPurposeContext();
    return {
      purposeKey: option?.key ?? null,
      purposeBucket: bucket,
      sourceType,
      advancePayment,
    };
  }, [advancePayment, getPurposeContext, sourceType]);

  const getAdvancePayment = useCallback(() => advancePayment, [advancePayment]);

  const getPaymentMethodContext = useCallback((): PaymentMethodChoice => {
    const fallbackMethod: ReceiptPaymentMethod = {
      type: DEFAULT_PAYMENT_METHODS[0].type,
      cardId: DEFAULT_PAYMENT_METHODS[0].cardId ?? null,
    };
    const fallbackChoice: PaymentMethodChoice = {
      key: createPaymentMethodKey(fallbackMethod),
      label: formatPaymentMethodLabel(fallbackMethod),
      method: fallbackMethod,
      source: "default",
    };
    return (
      paymentMethodChoices.find((option) => option.key === paymentMethodKey) ??
      paymentMethodChoices[0] ??
      fallbackChoice
    );
  }, [paymentMethodChoices, paymentMethodKey]);

  const handlePurposeQuickSelect = useCallback((key: string) => {
    setPurposeKey(key);
  }, []);

  const handlePurchaseQuickSelect = useCallback((value: string) => {
    setPurchasePurpose(value);
  }, []);

  const resetForm = useCallback(() => {
    setSourceType("receipt");
    setAdvancePayment(false);
    setPurposeKey("");
    setPurposeNote("");
    setPurchasePurpose("");
    const defaultKey = createPaymentMethodKey(DEFAULT_PAYMENT_METHODS[0]);
    setPaymentMethodKey(defaultKey);
  }, []);

  const storeOptions = useMemo<StoreOption[]>(
    () => knownStoreIds.map((id) => ({ id, name: storeDetails[id]?.name ?? id })),
    [knownStoreIds, storeDetails],
  );

  const storeQuickOptions = useMemo<StoreOption[]>(() => {
    if (!storeOptions.length) {
      return [];
    }
    const byId = new Map(storeOptions.map((option) => [option.id, option.name] as const));
    const historyIds = storeHistory.filter((id) => byId.has(id));
    const fallbackIds = storeOptions
      .map((option) => option.id)
      .filter((id) => !historyIds.includes(id));
    const combined = [...historyIds, ...fallbackIds];
    if (storeId && byId.has(storeId) && !combined.includes(storeId)) {
      combined.unshift(storeId);
    }
    const unique: string[] = [];
    for (const id of combined) {
      if (!unique.includes(id)) {
        unique.push(id);
      }
    }
    return unique.slice(0, STORE_HISTORY_LIMIT).map((id) => ({
      id,
      name: byId.get(id) ?? id,
    }));
  }, [storeOptions, storeHistory, storeId]);

  const storeSelectValue = isHydrated ? storeId : "";
  const hasStoresAvailable = isHydrated && storeOptions.length > 0;
  const storeSelectDisabled = !isHydrated || !storeOptions.length || (permissionsBusy && !permissions);
  const storeSelectTitle = !isHydrated
    ? tInfo("storeLoading")
    : !storeOptions.length
    ? tInfo("storeEmpty")
    : undefined;

  return {
    storeId,
    setStoreId,
    storeOptions,
    storeQuickOptions,
    storeSelectValue,
    storeSelectDisabled,
    storeSelectTitle,
    hasStoresAvailable,
    isHydrated,
    sourceType,
    setSourceType,
    advancePayment,
    setAdvancePayment,
    purposeKey,
    setPurposeKey,
    purposeNote,
    setPurposeNote,
    purchasePurpose,
    setPurchasePurpose,
    purposeQuickOptions,
    purchaseQuickValues,
    paymentMethodKey,
    setPaymentMethodKey,
    paymentMethodChoices,
    paymentQuickChoices,
    getPurposeContext,
    getPurchasePurpose,
    getAdvancePayment,
    buildEnqueueContext,
    getPaymentMethodContext,
    handlePurchasePurposeBlur,
    handlePurposeQuickSelect,
    handlePurchaseQuickSelect,
    resetForm,
    isSyncing,
    syncExceeded,
    permissionsBusy,
  };
}



