"use client";

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { PermissionFlag } from "@/types/permissions";

export interface PermissionsPreloadState {
  userId: string | null;
  storeIds: string[];
  flags: PermissionFlag[];
  activeStoreId: string | null;
  lastUpdatedAt: number | null;
  hasData: boolean;
}

const initialState: PermissionsPreloadState = {
  userId: null,
  storeIds: [],
  flags: [],
  activeStoreId: null,
  lastUpdatedAt: null,
  hasData: false,
};

interface PermissionsPayload {
  userId?: string | null;
  storeIds?: string[];
  flags?: Array<PermissionFlag | string> | Record<string, unknown> | null;
  activeStoreId?: string | null;
  fetchedAt?: number | null;
}

function normalizeFlags(flags?: Array<PermissionFlag | string> | Record<string, unknown> | null): PermissionFlag[] {
  if (!flags) {
    return [];
  }
  if (Array.isArray(flags)) {
    return flags.filter((flag): flag is PermissionFlag => typeof flag === "string") as PermissionFlag[];
  }
  return Object.entries(flags)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key)
    .filter((key): key is PermissionFlag => typeof key === "string");
}

const permissionsSlice = createSlice({
  name: "permissions",
  initialState,
  reducers: {
    setPermissionsPreload(state, action: PayloadAction<PermissionsPayload | null>) {
      const payload = action.payload;
      if (!payload) {
        state.userId = null;
        state.storeIds = [];
        state.flags = [];
        state.activeStoreId = null;
        state.lastUpdatedAt = Date.now();
        state.hasData = false;
        return;
      }
      state.userId = typeof payload.userId === "string" ? payload.userId : payload.userId ?? state.userId ?? null;
      state.storeIds = Array.isArray(payload.storeIds)
        ? payload.storeIds.filter((id): id is string => typeof id === "string")
        : [];
      state.flags = normalizeFlags(payload.flags);
      state.activeStoreId =
        typeof payload.activeStoreId === "string" || payload.activeStoreId === null
          ? payload.activeStoreId ?? null
          : null;
      state.lastUpdatedAt = (typeof payload.fetchedAt === "number" ? payload.fetchedAt : Date.now()) ?? Date.now();
      state.hasData = true;
    },
    clearPermissionsPreload(state) {
      state.userId = null;
      state.storeIds = [];
      state.flags = [];
      state.activeStoreId = null;
      state.lastUpdatedAt = null;
      state.hasData = false;
    },
  },
});

export const permissionsInitialState = initialState;
export const permissionsReducer = permissionsSlice.reducer;
export const { setPermissionsPreload, clearPermissionsPreload } = permissionsSlice.actions;
