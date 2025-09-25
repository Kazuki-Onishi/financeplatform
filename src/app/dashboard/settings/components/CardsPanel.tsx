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
import { creditCardDoc, creditCardsCollection, receiptsCollection } from "@/lib/firestoreRefs";
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
  userId: string;
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
    userId: "",
    storeId: selectedStoreId ?? "",
  });
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);

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
        const limited = mapped.slice(0, 20);
        const hasExtra = mapped.length > 20;
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
      userId: "",
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

    const payload = {
      brand: formState.brand,
      last4: formState.last4.trim(),
      nickname: formState.nickname.trim(),
      userId: formState.userId.trim() || null,
      storeId: formState.storeId.trim() || null,
      updatedAt: serverTimestamp(),
    };

    if (payload.storeId && !storeIds.includes(payload.storeId)) {
      pushToast("error", "You can only manage cards for stores you have access to.");
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
  }, [canEditCard, canManage, cards, formState, loadCards, pushToast, resetForm, storeIds, validateCard]);

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
      if (!window.confirm("Deleting this card can affect receipts that reference it. Do you want to continue?")) {
        return;
      }
      setDeletingId(card.id);
      try {
        const receiptsSnap = await getDocs(
          query(receiptsCollection(), where("paymentMethod.cardId", "==", card.id), limit(1)),
        );
        if (!receiptsSnap.empty) {
          pushToast("error", "Cannot delete: card is referenced by existing receipts.");
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
          <span className="text-xs text-neutral-500">{storeFilterDescription}</span>
        </div>
        {loadingPermissions ? <span className="text-xs text-neutral-500">Checking permissions...</span> : null}
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Brand</span>
          <select
            value={formState.brand}
            onChange={(event) => setFormState((prev) => ({ ...prev, brand: event.target.value }))}
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
            onChange={(event) => setFormState((prev) => ({ ...prev, last4: event.target.value }))}
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
            onChange={(event) => setFormState((prev) => ({ ...prev, nickname: event.target.value }))}
            disabled={!canManage || !!savingId || creating}
            maxLength={50}
            className="rounded border border-neutral-300 px-3 py-2"
            placeholder="Company Gold Card"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Owner User ID (optional)</span>
          <input
            type="text"
            value={formState.userId}
            onChange={(event) => setFormState((prev) => ({ ...prev, userId: event.target.value }))}
            disabled={!canManage || !!savingId || creating}
            className="rounded border border-neutral-300 px-3 py-2"
            placeholder="user_123"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Store (optional)</span>
          <select
            value={formState.storeId}
            onChange={(event) => setFormState((prev) => ({ ...prev, storeId: event.target.value }))}
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
            Restricts availability to teammates assigned to the selected store. Choose “Shared across stores Eto make it
            global.
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
          {formState.id ? (savingId ? "Saving..." : "Save Changes") : creating ? "Creating..." : "Add Card"}
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
          {!cards.length && !loading ? <p className="px-4 py-6 text-sm text-neutral-500">No cards found.</p> : null}
          {cards.map((card) => {
            const editable = canEditCard(card);
            return (
              <div key={card.id} className="flex flex-col gap-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-4">
                  <p className="font-medium text-neutral-900">
                    {card.nickname} ({card.brand} · {card.last4})
                  </p>
                  {card.storeId ? (
                    <span className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600">Store: {card.storeId}</span>
                  ) : (
                    <span className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600">Shared</span>
                  )}
                  {card.userId ? (
                    <span className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600">User: {card.userId}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500">
                  <span>Created: {formatTimestamp(card.createdAt)}</span>
                  <span>Updated: {formatTimestamp(card.updatedAt)}</span>
                </div>
                <div className="flex gap-3 text-sm">
                  <button
                    type="button"
                    onClick={() => handleEdit(card)}
                    disabled={!canManage || !editable || savingId === card.id || deletingId === card.id}
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
      {loading ? <p className="text-sm text-neutral-500">Loading cards...</p> : null}
    </section>
  );
}
