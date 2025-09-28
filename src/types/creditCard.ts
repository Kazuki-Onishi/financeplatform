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
  /** Optional single owner for legacy compatibility. */
  userId?: string | null;
  /** Optional list of owners allowed to use this card. */
  userIds?: string[] | null;
  /** Optional store-scoped card. */
  storeId?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreditCardRecord extends CreditCardDoc {
  id: string;
}
