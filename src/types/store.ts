import type { Timestamp } from "firebase/firestore";
import type { PermissionFlag } from "./permissions";

export type StoreMemberRole = "owner" | "manager" | "staff" | "viewer";

export interface StoreDoc {
  name: string;
  currency: string;
  timezone: string;
  createdAt: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  inviteEnabled?: boolean;
}

export interface StoreRecord extends StoreDoc {
  id: string;
}

export interface StoreMemberDoc {
  role: StoreMemberRole;
  flags: PermissionFlag[];
  joinedAt: Timestamp;
  invitedBy?: string | null;
  status: "active" | "pending";
  isResigned?: boolean;
}

export interface StoreMemberRecord extends StoreMemberDoc {
  id: string;
}

export type StoreInviteStatus = "active" | "expired" | "revoked" | "consumed";

export interface StoreInviteDoc {
  token: string;
  code: string;
  storeId: string;
  createdBy: string;
  createdAt: Timestamp;
  expiresAt?: Timestamp | null;
  maxUses: number;
  used: number;
  role: StoreMemberRole;
  flags: PermissionFlag[];
  status: StoreInviteStatus;
  note?: string | null;
}

export interface StoreInviteRecord extends StoreInviteDoc {
  id: string;
}
