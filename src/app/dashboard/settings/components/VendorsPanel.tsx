"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Timestamp,
  addDoc,
  deleteDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { vendorsCollection, vendorDoc } from "@/lib/firestoreRefs";
import { normalizeVendorName } from "@/lib/vendors";
import type { VendorRecord } from "@/types/vendor";
import type { ToastMessage } from "../types";
import { formatTimestamp } from "../utils";

interface VendorFormState {
  id?: string;
  displayName: string;
  normalized: string;
  tags: string;
}

interface VendorsPanelProps {
  canManage: boolean;
  pushToast: (type: ToastMessage["type"], message: string) => void;
}

export function VendorsPanel({ canManage, pushToast }: VendorsPanelProps) {
  const [vendors, setVendors] = useState<VendorRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formState, setFormState] = useState<VendorFormState>({
    displayName: "",
    normalized: "",
    tags: "",
  });
  const [search, setSearch] = useState("");

  const loadVendors = useCallback(async () => {
    try {
      setLoading(true);
      const snapshot = await getDocs(query(vendorsCollection(), orderBy("updatedAt", "desc"), limit(200)));
      const docs = snapshot.docs.map((docSnapshot) => ({
        id: docSnapshot.id,
        ...docSnapshot.data(),
      })) as VendorRecord[];
      setVendors(docs);
    } catch (err) {
      console.error("Failed to load vendors", err);
      pushToast("error", "Failed to load vendors.");
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void loadVendors();
  }, [loadVendors]);

  const filteredVendors = useMemo(() => {
    if (!search.trim()) {
      return vendors;
    }
    const lowered = search.trim().toLowerCase();
    return vendors.filter((vendor) => {
      return (
        vendor.displayName?.toLowerCase().includes(lowered) ||
        vendor.normalized?.toLowerCase().includes(lowered) ||
        vendor?.tags?.some((tag) => tag.toLowerCase().includes(lowered))
      );
    });
  }, [search, vendors]);

  const resetForm = useCallback(() => {
    setFormState({
      id: undefined,
      displayName: "",
      normalized: "",
      tags: "",
    });
    setSavingId(null);
  }, []);

  const handleVendorEdit = useCallback((vendor: VendorRecord) => {
    setFormState({
      id: vendor.id,
      displayName: vendor.displayName,
      normalized: vendor.normalized,
      tags: vendor.tags?.join(", ") ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleVendorSubmit = useCallback(async () => {
    if (!canManage) {
      pushToast("error", "You do not have permission to manage vendors.");
      return;
    }
    const trimmedName = formState.displayName.trim();
    if (!trimmedName) {
      pushToast("error", "Display name is required.");
      return;
    }
    const trimmedNormalized = formState.normalized.trim();
    if (!trimmedNormalized) {
      pushToast("error", "Normalized name is required.");
      return;
    }
    const normalized = normalizeVendorName(trimmedNormalized);
    const tags = formState.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    const payload = {
      displayName: trimmedName,
      normalized,
      tags,
      updatedAt: serverTimestamp(),
    };

    if (formState.id) {
      setSavingId(formState.id);
      try {
        await updateDoc(vendorDoc(formState.id), payload);
        pushToast("success", "Vendor updated.");
        setVendors((prev) =>
          prev.map((vendor) =>
            vendor.id === formState.id
              ? {
                  ...vendor,
                  ...payload,
                  tags,
                  updatedAt: Timestamp.now(),
                }
              : vendor,
          ),
        );
        resetForm();
      } catch (err) {
        console.error("Failed to update vendor", err);
        pushToast("error", "Failed to update vendor.");
      } finally {
        setSavingId(null);
      }
      return;
    }

    setCreating(true);
    try {
      await addDoc(vendorsCollection(), {
        ...payload,
        createdAt: serverTimestamp(),
      });
      pushToast("success", "Vendor added.");
      resetForm();
      await loadVendors();
    } catch (err) {
      console.error("Failed to add vendor", err);
      pushToast("error", "Failed to add vendor.");
    } finally {
      setCreating(false);
    }
  }, [canManage, formState.displayName, formState.id, formState.normalized, formState.tags, loadVendors, pushToast, resetForm]);

  const handleVendorDelete = useCallback(
    async (vendor: VendorRecord) => {
      if (!canManage) {
        pushToast("error", "You do not have permission to manage vendors.");
        return;
      }
      if (!window.confirm(`Delete ${vendor.displayName}?`)) {
        return;
      }
      setDeletingId(vendor.id);
      try {
        await deleteDoc(vendorDoc(vendor.id));
        setVendors((prev) => prev.filter((item) => item.id !== vendor.id));
        pushToast("success", "Vendor deleted.");
      } catch (err) {
        console.error("Failed to delete vendor", err);
        pushToast("error", "Failed to delete vendor.");
      } finally {
        setDeletingId(null);
      }
    },
    [canManage, pushToast],
  );

  return (
    <section className="flex flex-col gap-6 rounded border border-neutral-200 bg-white p-4">
      <div className="rounded border border-neutral-200 p-4">
        <h2 className="text-lg font-semibold">{formState.id ? "Edit Vendor" : "Add Vendor"}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Display name</span>
            <input
              type="text"
              value={formState.displayName}
              onChange={(event) => {
                const value = event.target.value;
                setFormState((prev) => ({
                  ...prev,
                  displayName: value,
                  normalized: prev.id ? prev.normalized : normalizeVendorName(value),
                }));
              }}
              disabled={!canManage || creating || !!savingId}
              className="rounded border border-neutral-300 px-3 py-2"
              placeholder="e.g. Lawson Shibuya"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Normalized</span>
            <input
              type="text"
              value={formState.normalized}
              onChange={(event) => setFormState((prev) => ({ ...prev, normalized: event.target.value }))}
              disabled={!canManage || creating || !!savingId}
              className="rounded border border-neutral-300 px-3 py-2"
              placeholder="lawsonshibuya"
            />
            <span className="text-xs text-neutral-400">Lowercase alphanumeric only. Must be unique.</span>
          </label>

          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-neutral-500">Tags (comma separated)</span>
            <input
              type="text"
              value={formState.tags}
              onChange={(event) => setFormState((prev) => ({ ...prev, tags: event.target.value }))}
              disabled={!canManage || creating || !!savingId}
              className="rounded border border-neutral-300 px-3 py-2"
              placeholder="convenience, 24h"
            />
          </label>
        </div>

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={handleVendorSubmit}
            disabled={!canManage || creating || !!savingId}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
          >
            {formState.id ? (savingId ? "Saving..." : "Save Changes") : creating ? "Creating..." : "Add Vendor"}
          </button>
          {formState.id ? (
            <button
              type="button"
              onClick={resetForm}
              className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Vendors</h2>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search vendors..."
            className="w-full max-w-md rounded border border-neutral-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="rounded border border-neutral-200">
          <div className="divide-y divide-neutral-200">
            {!filteredVendors.length && !loading ? (
              <p className="px-4 py-6 text-sm text-neutral-500">No vendors found.</p>
            ) : null}
            {filteredVendors.map((vendor) => (
              <div key={vendor.id} className="flex flex-col gap-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-4">
                  <p className="font-medium text-neutral-900">{vendor.displayName}</p>
                  <span className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600">{vendor.normalized}</span>
                  {vendor.tags?.length ? (
                    <span className="text-xs text-neutral-500">Tags: {vendor.tags.join(", ")}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500">
                  <span>Created: {formatTimestamp(vendor.createdAt)}</span>
                  <span>Updated: {formatTimestamp(vendor.updatedAt)}</span>
                </div>
                <div className="flex gap-3 text-sm">
                  <button
                    type="button"
                    onClick={() => handleVendorEdit(vendor)}
                    disabled={!canManage || savingId === vendor.id || deletingId === vendor.id}
                    className="rounded border border-neutral-300 px-3 py-1 text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleVendorDelete(vendor)}
                    disabled={!canManage || deletingId === vendor.id}
                    className="rounded border border-red-300 px-3 py-1 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deletingId === vendor.id ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {loading ? <p className="text-sm text-neutral-500">Loading vendors...</p> : null}
    </section>
  );
}

