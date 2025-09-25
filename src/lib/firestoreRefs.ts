import {
  collection,
  doc,
  type CollectionReference,
  type DocumentReference,
} from "firebase/firestore";
import { db } from "./firebase/client";
import type { ReceiptAssetDoc, ReceiptDoc } from "../types/receipt";
import type { CreditCardDoc } from "../types/creditCard";
import type { RoleTemplateDoc, UserPermissionsDoc } from "../types/permissions";
import type { StoreDoc, StoreInviteDoc, StoreMemberDoc } from "../types/store";
import type { VendorDoc } from "../types/vendor";

export function receiptsCollection(): CollectionReference<ReceiptDoc> {
  return collection(db, "receipts") as CollectionReference<ReceiptDoc>;
}

export function receiptDoc(receiptId: string): DocumentReference<ReceiptDoc> {
  return doc(db, "receipts", receiptId) as DocumentReference<ReceiptDoc>;
}

export function receiptAssetsCollection(
  receiptId: string,
): CollectionReference<ReceiptAssetDoc> {
  return collection(db, "receipts", receiptId, "assets") as CollectionReference<ReceiptAssetDoc>;
}

export function receiptAssetDoc(
  receiptId: string,
  assetId: string,
): DocumentReference<ReceiptAssetDoc> {
  return doc(db, "receipts", receiptId, "assets", assetId) as DocumentReference<ReceiptAssetDoc>;
}

export function creditCardsCollection(): CollectionReference<CreditCardDoc> {
  return collection(db, "creditCards") as CollectionReference<CreditCardDoc>;
}

export function creditCardDoc(cardId: string): DocumentReference<CreditCardDoc> {
  return doc(db, "creditCards", cardId) as DocumentReference<CreditCardDoc>;
}

export function vendorsCollection(): CollectionReference<VendorDoc> {
  return collection(db, "vendors") as CollectionReference<VendorDoc>;
}

export function vendorDoc(vendorId: string): DocumentReference<VendorDoc> {
  return doc(db, "vendors", vendorId) as DocumentReference<VendorDoc>;
}

export function roleTemplatesCollection(): CollectionReference<RoleTemplateDoc> {
  return collection(db, "roleTemplates") as CollectionReference<RoleTemplateDoc>;
}

export function roleTemplateDoc(id: string): DocumentReference<RoleTemplateDoc> {
  return doc(db, "roleTemplates", id) as DocumentReference<RoleTemplateDoc>;
}

export function userPermissionsDoc(userId: string): DocumentReference<UserPermissionsDoc> {
  return doc(db, "userPermissions", userId) as DocumentReference<UserPermissionsDoc>;
}

export function storesCollection(): CollectionReference<StoreDoc> {
  return collection(db, "stores") as CollectionReference<StoreDoc>;
}

export function storeDoc(storeId: string): DocumentReference<StoreDoc> {
  return doc(db, "stores", storeId) as DocumentReference<StoreDoc>;
}

export function storeMembersCollection(storeId: string): CollectionReference<StoreMemberDoc> {
  return collection(db, "stores", storeId, "members") as CollectionReference<StoreMemberDoc>;
}

export function storeMemberDoc(storeId: string, userId: string): DocumentReference<StoreMemberDoc> {
  return doc(db, "stores", storeId, "members", userId) as DocumentReference<StoreMemberDoc>;
}

export function storeInvitesCollection(storeId: string): CollectionReference<StoreInviteDoc> {
  return collection(db, "stores", storeId, "invites") as CollectionReference<StoreInviteDoc>;
}

export function storeInviteDoc(storeId: string, inviteId: string): DocumentReference<StoreInviteDoc> {
  return doc(db, "stores", storeId, "invites", inviteId) as DocumentReference<StoreInviteDoc>;
}
