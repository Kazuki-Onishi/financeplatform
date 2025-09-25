import type { Timestamp } from "firebase/firestore";

/**
 * Firestore: /creditCards/{cardId}
 */
export interface CreditCardDoc {
  /** Card brand (Visa, Master, etc.). */
  brand: string;
  /** Last four digits for identification. */
  last4: string;
  /** Friendly display name. */
  nickname: string;
  /** Optional owner user id (null for shared cards). */
  userId?: string | null;
  /** Optional store-scoped card. */
  storeId?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreditCardRecord extends CreditCardDoc {
  id: string;
}
