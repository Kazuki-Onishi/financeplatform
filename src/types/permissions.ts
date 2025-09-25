export type PermissionFlag =
  | "perm.upload"
  | "perm.editFields"
  | "perm.view"
  | "perm.exportCsv"
  | "perm.lock"
  | "perm.unlock"
  | "perm.manageCards"
  | "perm.manageVendors"
  | "perm.manageMembers";

/**
 * Firestore: /roleTemplates/{templateId}
 */
export interface RoleTemplateDoc {
  /** Human readable template name (e.g. inputter). */
  name: string;
  /** Flags granted when template applied to a user. */
  flags: PermissionFlag[];
}

export interface RoleTemplateRecord extends RoleTemplateDoc {
  id: string;
}

/**
 * Firestore: /userPermissions/{uid}
 */
export interface UserPermissionsDoc {
  /** Stores user can manage or view. */
  storeIds: string[];
  /** Active store context for default routing. */
  activeStoreId?: string | null;
  /** Fine grained permission flags (perm.*). */
  flags: PermissionFlag[];
}

export interface UserPermissionsRecord extends UserPermissionsDoc {
  id: string;
}

/** Runtime state shape used by hooks/components. */
export interface UserPermissionsState extends UserPermissionsDoc {
  userId: string;
}