import type { Timestamp } from "firebase/firestore";

/**
 * Firestore: /vendors/{vendorId}
 */
export interface VendorDoc {
  /** Display name used in UI (e.g. receipt header). */
  displayName: string;
  /** Full-width kana reading for search; optional. */
  kana?: string | null;
  /** Normalised value used for fuzzy matching. */
  normalized: string;
  /** Optional free-form labels (e.g. categories). */
  tags?: string[];
  /** External identifiers (accounting system ids, etc.). */
  externalIds?: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface VendorRecord extends VendorDoc {
  id: string;
}
