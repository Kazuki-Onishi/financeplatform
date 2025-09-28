"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addDoc,
  deleteDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  Timestamp,
  updateDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type QueryConstraint,
} from "firebase/firestore";
import {
  creditCardDoc,
  creditCardsCollection,
  receiptsCollection,
} from "@/lib/firestoreRefs";
import { auth } from "@/lib/firebase/client";
import type { CreditCardRecord } from "@/types/creditCard";
import { formatTimestamp } from "../utils";
import type { StoreOption, ToastMessage } from "../types";

const CARD_BRANDS = [
  "Visa",
  "Mastercard",
  "JCB",
  "American Express",
  "Diners Club",
  "Discover",
  "UnionPay",
  "Other",
];

interface CardFormState {
  id?: string;
  brand: string;
  last4: string;
  nickname: string;
  ownerIds: string[];
  storeId: string;
}

interface CardsPanelProps {
  canManage: boolean;
  storeIds: string[];
  storeOptions: StoreOption[];
  selectedStoreId: string | null;
  selectedStoreName: string;
  pushToast: (type: ToastMessage["type"], message: string) => void;
  loadingPermissions: boolean;
}

interface MemberOption {
  id: string;
  label: string;
  email: string | null;
}

export function CardsPanel({
  canManage,
  storeIds,
  storeOptions,
  selectedStoreId,
  selectedStoreName,
  pushToast,
  loadingPermissions,
}: CardsPanelProps): JSX.Element {
  const [cards, setCards] = useState<CreditCardRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formState, setFormState] = useState<CardFormState>({
    brand: CARD_BRANDS[0] ?? "Visa",
    last4: "",
    nickname: "",
    ownerIds: [],
    storeId: selectedStoreId ?? "",
  });
  const [cursor, setCursor] =
    useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [memberOptions, setMemberOptions] = useState<MemberOption[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [ownerModalOpen, setOwnerModalOpen] = useState(false);
  const [ownerSearch, setOwnerSearch] = useState("");

  const memberLabelById = useMemo(() => {
    const map = new Map<string, string>();
    memberOptions.forEach((option) => map.set(option.id, option.label));
    return map;
  }, [memberOptions]);

  const ownerSelectOptions = useMemo(() => {
    const map = new Map<string, MemberOption>();
    memberOptions.forEach((option) => map.set(option.id, option));
    formState.ownerIds.forEach((id) => {
      if (!map.has(id)) {
        map.set(id, { id, label: id, email: null });
      }
    });
    cards.forEach((card) => {
      const owners =
        Array.isArray(card.userIds) && card.userIds.length
          ? card.userIds
              .map((value) => (typeof value === "string" ? value.trim() : ""))
              .filter((value): value is string => value.length > 0)
          : card.userId &&
              typeof card.userId === "string" &&
              card.userId.trim().length > 0
            ? [card.userId.trim()]
            : [];
      owners.forEach((ownerId) => {
        if (!map.has(ownerId)) {
          map.set(ownerId, { id: ownerId, label: ownerId, email: null });
        }
      });
    });
    return Array.from(map.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [memberOptions, formState.ownerIds, cards]);
  const ownerSummaryLabels = useMemo(() => {
    if (!formState.ownerIds.length) {
      return [];
    }
    return formState.ownerIds.map((id) => memberLabelById.get(id) ?? id);
  }, [formState.ownerIds, memberLabelById]);

  const filteredOwnerOptions = useMemo(() => {
    const query = ownerSearch.trim().toLowerCase();
    if (!query) {
      return ownerSelectOptions;
    }
    return ownerSelectOptions.filter((option) => {
      const label = option.label.toLowerCase();
      const email = option.email?.toLowerCase() ?? "";
      return label.includes(query) || email.includes(query);
    });
  }, [ownerSearch, ownerSelectOptions]);

  const toggleOwner = useCallback((ownerId: string) => {
    setFormState((prev) => {
      const exists = prev.ownerIds.includes(ownerId);
      const next = exists
        ? prev.ownerIds.filter((value) => value !== ownerId)
        : [...prev.ownerIds, ownerId];
      return { ...prev, ownerIds: next };
    });
  }, []);

  useEffect(() => {
    if (!ownerModalOpen) {
      setOwnerSearch("");
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOwnerModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [ownerModalOpen]);

  useEffect(() => {
    const targetStoreId =
      selectedStoreId && selectedStoreId.length > 0
        ? selectedStoreId
        : (storeIds[0] ?? null);
    if (!targetStoreId) {
      setMemberOptions([]);
      setMembersError(null);
      setMembersLoading(false);
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      setMemberOptions([]);
      setMembersError("Sign in to view members.");
      return;
    }
    let cancelled = false;
    setMembersLoading(true);
    setMembersError(null);
    (async () => {
      try {
        const token = await user.getIdToken();
        const response = await fetch(
          `/api/stores/${encodeURIComponent(targetStoreId)}/members`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          if (!cancelled) {
            setMembersError(payload?.error ?? "Failed to load members.");
            setMemberOptions([]);
          }
          return;
        }
        const list = Array.isArray(payload?.members)
          ? (payload.members as Array<{
              id: string;
              displayName?: string | null;
              email?: string | null;
            }>)
          : [];
        if (cancelled) {
          return;
        }
        const options: MemberOption[] = list
          .map((member) => ({
            id: member.id,
            label:
              member.displayName?.trim() || member.email?.trim() || member.id,
            email: member.email ?? null,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
        setMemberOptions(options);
        setMembersError(null);
      } catch (error) {
        console.error("[settings] failed to load member options", error);
        if (!cancelled) {
          setMembersError("Failed to load members.");
          setMemberOptions([]);
        }
      } finally {
        if (!cancelled) {
          setMembersLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, storeIds]);

  const loadCards = useCallback(
    async (after?: QueryDocumentSnapshot<DocumentData>) => {
      try {
        setLoading(true);
        const constraints: QueryConstraint[] = [orderBy("createdAt", "desc")];
        if (selectedStoreId) {
          constraints.push(where("storeId", "==", selectedStoreId));
        } else {
          constraints.push(where("storeId", "==", null));
        }
        if (after) {
          constraints.push(startAfter(after));
        }
        constraints.push(limit(21));

        const cardsQuery = query(creditCardsCollection(), ...constraints);
        const snapshot = await getDocs(cardsQuery);
        const mapped = snapshot.docs.map((docSnapshot) => ({
          id: docSnapshot.id,
          ...docSnapshot.data(),
        })) as CreditCardRecord[];
        const normalized = mapped.map((card) => {
          const owners =
            Array.isArray(card.userIds) && card.userIds.length
              ? card.userIds
                  .map((id) => (typeof id === "string" ? id.trim() : ""))
                  .filter((id): id is string => id.length > 0)
              : card.userId &&
                  typeof card.userId === "string" &&
                  card.userId.trim().length > 0
                ? [card.userId.trim()]
                : [];
          return {
            ...card,
            userIds: owners,
            userId: owners.length === 1 ? owners[0] : null,
          };
        });
        const limited = normalized.slice(0, 20);
        const hasExtra = normalized.length > 20;
        setHasMore(hasExtra);
        setCursor(hasExtra ? snapshot.docs[snapshot.docs.length - 1] : null);
        setCards((prev) => (after ? [...prev, ...limited] : limited));
      } catch (err) {
        console.error("Failed to load cards", err);
        pushToast("error", "Failed to load cards.");
      } finally {
        setLoading(false);
      }
    },
    [pushToast, selectedStoreId],
  );

  useEffect(() => {
    setCursor(null);
    setHasMore(false);
  }, [selectedStoreId]);

  useEffect(() => {
    if (!canManage) {
      setCards([]);
      setLoading(false);
      return;
    }
    void loadCards();
  }, [canManage, loadCards]);

  const resetForm = useCallback(() => {
    setFormState({
      id: undefined,
      brand: CARD_BRANDS[0] ?? "Visa",
      last4: "",
      nickname: "",
      ownerIds: [],
      storeId: selectedStoreId ?? "",
    });
    setSavingId(null);
  }, [selectedStoreId]);

  useEffect(() => {
    if (formState.id) {
      return;
    }
    const next = selectedStoreId ?? "";
    if (formState.storeId !== next) {
      setFormState((prev) => ({ ...prev, storeId: next }));
    }
  }, [formState.id, formState.storeId, selectedStoreId]);

  useEffect(() => {
    const targetStoreId =
      selectedStoreId && selectedStoreId.length > 0
        ? selectedStoreId
        : (storeIds[0] ?? null);
    if (!targetStoreId) {
      setMemberOptions([]);
      setMembersError(null);
      setMembersLoading(false);
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      setMemberOptions([]);
      setMembersError("Sign in to view members.");
      return;
    }
    let cancelled = false;
    setMembersLoading(true);
    setMembersError(null);
    (async () => {
      try {
        const token = await user.getIdToken();
        const response = await fetch(
          `/api/stores/${encodeURIComponent(targetStoreId)}/members`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          if (!cancelled) {
            setMembersError(payload?.error ?? "Failed to load members.");
            setMemberOptions([]);
          }
          return;
        }
        const list = Array.isArray(payload?.members)
          ? (payload.members as Array<{
              id: string;
              displayName?: string | null;
              email?: string | null;
            }>)
          : [];
        if (cancelled) {
          return;
        }
        const options: MemberOption[] = list
          .map((member) => ({
            id: member.id,
            label:
              member.displayName?.trim() || member.email?.trim() || member.id,
            email: member.email ?? null,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
        setMemberOptions(options);
        setMembersError(null);
      } catch (error) {
        console.error("[settings] failed to load member options", error);
        if (!cancelled) {
          setMembersError("Failed to load members.");
          setMemberOptions([]);
        }
      } finally {
        if (!cancelled) {
          setMembersLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, storeIds]);

  const validateCard = useCallback((state: CardFormState): string | null => {
    if (!CARD_BRANDS.includes(state.brand)) {
      return "Brand is not supported.";
    }
    if (!/^\d{4}$/.test(state.last4.trim())) {
      return "Last four digits must be exactly four numerals.";
    }
    if (!state.nickname.trim()) {
      return "Nickname is required.";
    }
    if (state.nickname.trim().length > 50) {
      return "Nickname must be 50 characters or fewer.";
    }
    return null;
  }, []);

  const canEditCard = useCallback(
    (card: CreditCardRecord) => {
      if (!card.storeId) {
        return true;
      }
      return storeIds.includes(card.storeId);
    },
    [storeIds],
  );

  const handleSubmit = useCallback(async () => {
    const error = validateCard(formState);
    if (error) {
      pushToast("error", error);
      return;
    }
    if (!canManage) {
      pushToast("error", "You do not have permission to manage cards.");
      return;
    }

    const ownerIds = Array.from(
      new Set(
        formState.ownerIds.map((id) => id.trim()).filter((id) => id.length > 0),
      ),
    );
    const payload = {
      brand: formState.brand,
      last4: formState.last4.trim(),
      nickname: formState.nickname.trim(),
      userId: ownerIds.length === 1 ? ownerIds[0] : null,
      userIds: ownerIds,
      storeId: formState.storeId.trim() || null,
      updatedAt: serverTimestamp(),
    };

    if (payload.storeId && !storeIds.includes(payload.storeId)) {
      pushToast(
        "error",
        "You can only manage cards for stores you have access to.",
      );
      return;
    }

    if (formState.id) {
      const existing = cards.find((card) => card.id === formState.id);
      if (existing && !canEditCard(existing)) {
        pushToast("error", "You cannot edit a card outside your stores.");
        return;
      }
      setSavingId(formState.id);
      try {
        await updateDoc(creditCardDoc(formState.id), payload);
        setCards((prev) =>
          prev.map((card) =>
            card.id === formState.id
              ? {
                  ...card,
                  ...payload,
                  userId: payload.userId ?? undefined,
                  userIds: payload.userIds ?? [],
                  storeId: payload.storeId ?? undefined,
                  updatedAt: Timestamp.now(),
                }
              : card,
          ),
        );
        pushToast("success", "Card updated.");
        resetForm();
      } catch (err) {
        console.error("Failed to update card", err);
        pushToast("error", "Failed to update card.");
      } finally {
        setSavingId(null);
      }
      return;
    }

    setCreating(true);
    try {
      await addDoc(creditCardsCollection(), {
        ...payload,
        createdAt: serverTimestamp(),
      });
      pushToast("success", "Card added.");
      resetForm();
      await loadCards();
    } catch (err) {
      console.error("Failed to add card", err);
      pushToast("error", "Failed to add card.");
    } finally {
      setCreating(false);
    }
  }, [
    canEditCard,
    canManage,
    cards,
    formState,
    loadCards,
    pushToast,
    resetForm,
    storeIds,
    validateCard,
  ]);

  const handleEdit = useCallback(
    (card: CreditCardRecord) => {
      const ownerIds =
        Array.isArray(card.userIds) && card.userIds.length
          ? card.userIds
              .map((id) => (typeof id === "string" ? id.trim() : ""))
              .filter((id): id is string => id.length > 0)
          : card.userId &&
              typeof card.userId === "string" &&
              card.userId.trim().length > 0
            ? [card.userId.trim()]
            : [];
      setFormState({
        id: card.id,
        brand: card.brand,
        last4: card.last4,
        nickname: card.nickname,
        ownerIds,
        storeId: card.storeId ?? "",
      });
    },
    [setFormState],
  );

  const handleDelete = useCallback(
    async (card: CreditCardRecord) => {
      if (!canManage) {
        pushToast("error", "You do not have permission to manage cards.");
        return;
      }
      if (!canEditCard(card)) {
        pushToast("error", "You cannot delete a card outside your stores.");
        return;
      }
      if (
        !window.confirm(
          "Deleting this card can affect receipts that reference it. Do you want to continue?",
        )
      ) {
        return;
      }
      setDeletingId(card.id);
      try {
        const receiptsSnap = await getDocs(
          query(
            receiptsCollection(),
            where("paymentMethod.cardId", "==", card.id),
            limit(1),
          ),
        );
        if (!receiptsSnap.empty) {
          pushToast(
            "error",
            "Cannot delete: card is referenced by existing receipts.",
          );
          setDeletingId(null);
          return;
        }
        await deleteDoc(creditCardDoc(card.id));
        setCards((prev) => prev.filter((item) => item.id !== card.id));
        pushToast("success", "Card deleted.");
      } catch (err) {
        console.error("Failed to delete card", err);
        pushToast("error", "Failed to delete card.");
      } finally {
        setDeletingId(null);
      }
    },
    [canEditCard, canManage, pushToast],
  );

  const storeFilterDescription = selectedStoreId
    ? `Filtered to ${selectedStoreName}`
    : "Shared across stores";

  return (
    <section className="flex flex-col gap-4 rounded border border-neutral-200 bg-white p-4">
      <header className="flex items-center justify-between border-b border-neutral-200 pb-3">
        <div className="flex flex-col">
          <h2 className="text-lg font-semibold">Cards</h2>
          <span className="text-xs text-neutral-500">
            {storeFilterDescription}
          </span>
        </div>
        {loadingPermissions ? (
          <span className="text-xs text-neutral-500">
            Checking permissions...
          </span>
        ) : null}
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Brand</span>
          <select
            value={formState.brand}
            onChange={(event) =>
              setFormState((prev) => ({ ...prev, brand: event.target.value }))
            }
            disabled={!canManage || !!savingId || creating}
            className="rounded border border-neutral-300 px-3 py-2"
          >
            {CARD_BRANDS.map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Last 4 digits</span>
          <input
            type="text"
            value={formState.last4}
            onChange={(event) =>
              setFormState((prev) => ({ ...prev, last4: event.target.value }))
            }
            disabled={!canManage || !!savingId || creating}
            maxLength={4}
            className="rounded border border-neutral-300 px-3 py-2"
            placeholder="1234"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Nickname</span>
          <input
            type="text"
            value={formState.nickname}
            onChange={(event) =>
              setFormState((prev) => ({
                ...prev,
                nickname: event.target.value,
              }))
            }
            disabled={!canManage || !!savingId || creating}
            maxLength={50}
            className="rounded border border-neutral-300 px-3 py-2"
            placeholder="Company Gold Card"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Owners (optional)</span>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                setFormState((prev) => ({ ...prev, ownerIds: [] }))
              }
              disabled={!canManage || !!savingId || creating}
              className={[
                "rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                formState.ownerIds.length === 0
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
              ].join(" ")}
            >
              All teammates
            </button>
            {ownerSummaryLabels.length ? (
              ownerSummaryLabels.slice(0, 3).map((label, index) => (
                <span
                  key={`owner-summary-${index}`}
                  className="rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-700"
                >
                  {label}
                </span>
              ))
            ) : (
              <span className="text-xs text-neutral-500">All teammates</span>
            )}
            {ownerSummaryLabels.length > 3 ? (
              <span className="text-xs text-neutral-500">
                +{ownerSummaryLabels.length - 3} more
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setOwnerModalOpen(true)}
              disabled={!canManage || !!savingId || creating}
              className="rounded-full border px-3 py-1 text-sm text-blue-600 transition hover:border-blue-400 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Manage owners
            </button>
          </div>
          <span className="text-xs text-neutral-400">
            Leave empty to share the card with all teammates.
          </span>
          {ownerModalOpen ? (
            <div
              className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
              onClick={() => setOwnerModalOpen(false)}
            >
              <div
                className="w-full max-w-lg rounded-lg bg-white p-4 shadow-lg"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-neutral-900">
                      Select owners
                    </h3>
                    <p className="text-xs text-neutral-500">
                      Choose teammates who can use this card.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOwnerModalOpen(false)}
                    className="rounded border border-neutral-300 px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
                  >
                    Close
                  </button>
                </div>
                <input
                  type="text"
                  value={ownerSearch}
                  onChange={(event) => setOwnerSearch(event.target.value)}
                  placeholder="Search teammates"
                  className="mt-3 w-full rounded border border-neutral-300 px-3 py-2 text-sm"
                />
                <div className="mt-3 max-h-64 overflow-y-auto rounded border border-neutral-200">
                  {filteredOwnerOptions.length ? (
                    filteredOwnerOptions.map((option) => {
                      const selected = formState.ownerIds.includes(option.id);
                      return (
                        <button
                          key={`owner-modal-option-${option.id}`}
                          type="button"
                          onClick={() => toggleOwner(option.id)}
                          className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition hover:bg-blue-50 ${
                            selected
                              ? "bg-blue-50 text-blue-700"
                              : "bg-white text-neutral-700"
                          }`}
                        >
                          <span>
                            {option.label}
                            {option.email ? (
                              <span className="ml-1 text-xs text-neutral-400">
                                ({option.email})
                              </span>
                            ) : null}
                          </span>
                          {selected ? (
                            <span className="text-xs font-medium text-blue-600">
                              Selected
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  ) : (
                    <p className="px-3 py-4 text-sm text-neutral-500">
                      No teammates match your search.
                    </p>
                  )}
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-neutral-500">
                    {formState.ownerIds.length
                      ? `${formState.ownerIds.length} selected`
                      : "All teammates selected"}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setFormState((prev) => ({ ...prev, ownerIds: [] }))
                      }
                      className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setOwnerModalOpen(false)}
                      className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Done
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {membersLoading ? (
            <span className="text-xs text-neutral-500">Loading members...</span>
          ) : membersError ? (
            <span className="text-xs text-red-600">{membersError}</span>
          ) : null}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Store (optional)</span>
          <select
            value={formState.storeId}
            onChange={(event) =>
              setFormState((prev) => ({ ...prev, storeId: event.target.value }))
            }
            disabled={!canManage || !!savingId || creating}
            className="rounded border border-neutral-300 px-3 py-2"
          >
            <option value="">Shared across stores</option>
            {storeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-400">
            Restricts availability to teammates assigned to the selected store.
            Choose “Shared across stores Eto make it global.
          </span>
        </label>
      </div>

      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canManage || creating || !!savingId}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
        >
          {formState.id
            ? savingId
              ? "Saving..."
              : "Save Changes"
            : creating
              ? "Creating..."
              : "Add Card"}
        </button>
        {formState.id ? (
          <button
            type="button"
            onClick={resetForm}
            disabled={creating || !!savingId}
            className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
          >
            Cancel
          </button>
        ) : null}
      </div>

      <div className="rounded border border-neutral-200">
        <div className="divide-y divide-neutral-200">
          {!cards.length && !loading ? (
            <p className="px-4 py-6 text-sm text-neutral-500">
              No cards found.
            </p>
          ) : null}
          {cards.map((card) => {
            const editable = canEditCard(card);
            const ownerIds =
              Array.isArray(card.userIds) && card.userIds.length
                ? card.userIds
                    .map((value) =>
                      typeof value === "string" ? value.trim() : "",
                    )
                    .filter((value): value is string => value.length > 0)
                : card.userId &&
                    typeof card.userId === "string" &&
                    card.userId.trim().length > 0
                  ? [card.userId.trim()]
                  : [];
            return (
              <div
                key={card.id}
                className="flex flex-col gap-2 px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-4">
                  <p className="font-medium text-neutral-900">
                    {card.nickname} ({card.brand} · {card.last4})
                  </p>
                  {card.storeId ? (
                    <span className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600">
                      Store: {card.storeId}
                    </span>
                  ) : (
                    <span className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600">
                      Shared
                    </span>
                  )}
                  {ownerIds.map((ownerId) => (
                    <span
                      key={`card-owner-${card.id}-${ownerId}`}
                      className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600"
                    >
                      Owner: {memberLabelById.get(ownerId) ?? ownerId}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500">
                  <span>Created: {formatTimestamp(card.createdAt)}</span>
                  <span>Updated: {formatTimestamp(card.updatedAt)}</span>
                </div>
                <div className="flex gap-3 text-sm">
                  <button
                    type="button"
                    onClick={() => handleEdit(card)}
                    disabled={
                      !canManage ||
                      !editable ||
                      savingId === card.id ||
                      deletingId === card.id
                    }
                    className="rounded border border-neutral-300 px-3 py-1 text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(card)}
                    disabled={!canManage || !editable || deletingId === card.id}
                    className="rounded border border-red-300 px-3 py-1 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deletingId === card.id ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {hasMore ? (
          <button
            type="button"
            onClick={() => cursor && loadCards(cursor)}
            disabled={loading || !cursor}
            className="w-full border-t border-neutral-200 px-4 py-2 text-sm text-blue-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Loading..." : "Load more"}
          </button>
        ) : null}
      </div>
      {loading ? (
        <p className="text-sm text-neutral-500">Loading cards...</p>
      ) : null}
    </section>
  );
}
