
"use client";

import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import type { PermissionFlag, UserPermissionsDoc } from "../../types/permissions";
import type { StoreMemberRole } from "../../types/store";

export type OptimisticMembershipSource = "invite" | "store:create" | "manual";

export interface OptimisticMembership {
  storeId: string;
  role: StoreMemberRole;
  flags: PermissionFlag[];
  source: OptimisticMembershipSource;
  createdAt: number;
}

interface PermissionsPatch {
  storeIds: string[];
  flags: PermissionFlag[];
}

interface PermissionsStoreState {
  activeStoreId: string | null;
  optimisticMemberships: Record<string, OptimisticMembership>;
  patch: PermissionsPatch | null;
}

type PermissionsStoreAction =
  | { type: "set-active-store"; storeId: string | null }
  | { type: "upsert-membership"; membership: OptimisticMembership }
  | { type: "remove-memberships"; storeIds: string[] }
  | { type: "set-patch"; patch: PermissionsPatch | null; activeStoreId?: string | null; updateActive?: boolean }
  | { type: "clear-optimistic" }
  | { type: "reset"; activeStoreId: string | null };

interface PermissionsStoreContextValue {
  state: PermissionsStoreState;
  dispatch: Dispatch<PermissionsStoreAction>;
}

function mergeUnique<T>(values: Iterable<T>): T[] {
  return Array.from(new Set(values));
}

function reducer(state: PermissionsStoreState, action: PermissionsStoreAction): PermissionsStoreState {
  switch (action.type) {
    case "set-active-store": {
      if (state.activeStoreId === action.storeId) {
        return state;
      }
      return {
        ...state,
        activeStoreId: action.storeId,
      };
    }
    case "upsert-membership": {
      const existing = state.optimisticMemberships[action.membership.storeId];
      if (
        existing &&
        existing.role === action.membership.role &&
        existing.source === action.membership.source &&
        existing.flags.length === action.membership.flags.length &&
        existing.flags.every((flag, index) => flag === action.membership.flags[index])
      ) {
        return state;
      }
      return {
        ...state,
        optimisticMemberships: {
          ...state.optimisticMemberships,
          [action.membership.storeId]: action.membership,
        },
      };
    }
    case "remove-memberships": {
      if (!action.storeIds.length) {
        return state;
      }
      let changed = false;
      const next = { ...state.optimisticMemberships };
      for (const storeId of action.storeIds) {
        if (next[storeId]) {
          delete next[storeId];
          changed = true;
        }
      }
      if (!changed) {
        return state;
      }
      return {
        ...state,
        optimisticMemberships: next,
      };
    }
    case "set-patch": {
      const { patch, activeStoreId, updateActive = false } = action;
      if (!patch) {
        if (!state.patch && !updateActive) {
          return state;
        }
        return {
          ...state,
          patch: null,
          activeStoreId: updateActive ? (activeStoreId ?? null) : state.activeStoreId,
        };
      }
      const baseStoreIds = state.patch?.storeIds ?? [];
      const baseFlags = state.patch?.flags ?? [];
      const storeIds = mergeUnique([...baseStoreIds, ...patch.storeIds]);
      const flags = mergeUnique([...baseFlags, ...patch.flags]);
      return {
        ...state,
        patch: {
          storeIds,
          flags,
        },
        activeStoreId: updateActive ? (activeStoreId ?? null) : state.activeStoreId,
      };
    }
    case "clear-optimistic": {
      if (!state.patch && !Object.keys(state.optimisticMemberships).length) {
        return state;
      }
      return {
        ...state,
        patch: null,
        optimisticMemberships: {},
      };
    }
    case "reset": {
      return {
        activeStoreId: action.activeStoreId,
        optimisticMemberships: {},
        patch: null,
      };
    }
    default:
      return state;
  }
}

const PermissionsStoreContext = createContext<PermissionsStoreContextValue | undefined>(undefined);

function createInitialState(activeStoreId: string | null): PermissionsStoreState {
  return {
    activeStoreId,
    optimisticMemberships: {},
    patch: null,
  };
}

export function PermissionsStoreProvider({
  children,
  initialActiveStoreId = null,
}: {
  children: ReactNode;
  initialActiveStoreId?: string | null;
}): ReactNode {
  const [state, dispatch] = useReducer(reducer, initialActiveStoreId ?? null, createInitialState);

  const value = useMemo<PermissionsStoreContextValue>(
    () => ({ state, dispatch }),
    [state],
  );

  return <PermissionsStoreContext.Provider value={value}>{children}</PermissionsStoreContext.Provider>;
}

export function usePermissionsStore(): PermissionsStoreContextValue {
  const context = useContext(PermissionsStoreContext);
  if (!context) {
    throw new Error("PermissionsStoreProvider is required. Wrap your component tree with it.");
  }
  return context;
}

export function setActiveStoreId(storeId: string | null): PermissionsStoreAction {
  return { type: "set-active-store", storeId };
}

export function upsertMembership({
  storeId,
  role,
  flags,
  source = "manual",
  createdAt = Date.now(),
}: {
  storeId: string;
  role: StoreMemberRole;
  flags: PermissionFlag[];
  source?: OptimisticMembershipSource;
  createdAt?: number;
}): PermissionsStoreAction {
  return {
    type: "upsert-membership",
    membership: {
      storeId,
      role,
      flags,
      source,
      createdAt,
    },
  };
}

export function removeMemberships(storeIds: string[]): PermissionsStoreAction {
  return { type: "remove-memberships", storeIds };
}

export function applyPermissionsPatch(
  patch: { storeIds?: string[]; flags?: PermissionFlag[]; activeStoreId?: string | null } | null,
): PermissionsStoreAction {
  if (!patch) {
    return { type: "set-patch", patch: null };
  }
  const storeIds = mergeUnique(patch.storeIds ?? []);
  const flags = mergeUnique(patch.flags ?? []);
  const updateActive = Object.prototype.hasOwnProperty.call(patch, "activeStoreId");
  return {
    type: "set-patch",
    patch: {
      storeIds,
      flags,
    },
    activeStoreId: patch.activeStoreId ?? null,
    updateActive,
  };
}

export function clearOptimistic(): PermissionsStoreAction {
  return { type: "clear-optimistic" };
}

export function resetPermissionsStore(activeStoreId: string | null): PermissionsStoreAction {
  return { type: "reset", activeStoreId };
}

export function patchFromUserPermissions(doc: UserPermissionsDoc | null): PermissionsStoreAction {
  if (!doc) {
    return { type: "set-patch", patch: null, updateActive: true, activeStoreId: null };
  }
  return {
    type: "set-patch",
    patch: {
      storeIds: mergeUnique(doc.storeIds ?? []),
      flags: mergeUnique(doc.flags ?? []),
    },
    activeStoreId: doc.activeStoreId ?? null,
    updateActive: true,
  };
}



