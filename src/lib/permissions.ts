import type { PermissionFlag, UserPermissionsDoc, UserPermissionsState } from "../types/permissions";
import type { StoreMemberRole } from "../types/store";

const PERMISSION_FLAG_VALUES = [
  "perm.upload",
  "perm.editFields",
  "perm.view",
  "perm.exportCsv",
  "perm.lock",
  "perm.unlock",
  "perm.manageCards",
  "perm.manageVendors",
  "perm.manageMembers",
] as const satisfies readonly PermissionFlag[];

const PERMISSION_FLAG_SET = new Set<PermissionFlag>(PERMISSION_FLAG_VALUES);

const STORE_MEMBER_ROLE_VALUES = [
  "owner",
  "manager",
  "staff",
  "viewer",
] as const satisfies readonly StoreMemberRole[];

const STORE_MEMBER_ROLE_SET = new Set<StoreMemberRole>(STORE_MEMBER_ROLE_VALUES);

export function coercePermissionFlags(value: unknown): PermissionFlag[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((flag): flag is PermissionFlag => typeof flag === "string" && PERMISSION_FLAG_SET.has(flag as PermissionFlag));
}

export function normalizeStoreMemberRole(value: unknown, fallback: StoreMemberRole): StoreMemberRole {
  if (typeof value === "string" && STORE_MEMBER_ROLE_SET.has(value as StoreMemberRole)) {
    return value as StoreMemberRole;
  }
  return fallback;
}

type PermissionLike = (UserPermissionsDoc | UserPermissionsState) | null | undefined;

function hasFlagInternal(perms: PermissionLike, flag: PermissionFlag): boolean {
  const flags = perms?.flags ?? [];
  return flags.includes(flag);
}

export function hasFlag(perms: PermissionLike, flag: PermissionFlag): boolean {
  return hasFlagInternal(perms, flag);
}

export function hasAnyFlag(perms: PermissionLike, flags: PermissionFlag[]): boolean {
  if (!perms) {
    return false;
  }
  return flags.some((flag) => hasFlagInternal(perms, flag));
}

export function canView(perms: PermissionLike): boolean {
  return hasAnyFlag(perms, ["perm.view", "perm.editFields", "perm.lock", "perm.unlock"]);
}

export function canUpload(perms: PermissionLike): boolean {
  return hasFlag(perms, "perm.upload");
}

export function canEdit(perms: PermissionLike): boolean {
  return hasFlag(perms, "perm.editFields");
}

export function canExport(perms: PermissionLike): boolean {
  return hasFlag(perms, "perm.exportCsv");
}

export function canLock(perms: PermissionLike): boolean {
  return hasFlag(perms, "perm.lock");
}

export function canUnlock(perms: PermissionLike): boolean {
  return hasFlag(perms, "perm.unlock");
}

export function canManageCards(perms: PermissionLike): boolean {
  return hasFlag(perms, "perm.manageCards");
}

export function canManageVendors(perms: PermissionLike): boolean {
  return hasFlag(perms, "perm.manageVendors");
}

export function canManageMembers(perms: PermissionLike): boolean {
  return hasFlag(perms, "perm.manageMembers");
}

export function hasStoreAccess(perms: PermissionLike, storeId: string | null | undefined): boolean {
  if (!storeId) {
    return false;
  }
  const stores = perms?.storeIds ?? [];
  return stores.includes(storeId);
}
