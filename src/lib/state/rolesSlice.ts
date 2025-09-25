"use client";

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { PermissionFlag } from "@/types/permissions";

export interface UserStoreRole {
  id: string;
  uid: string;
  storeId: string;
  role: string;
  flags?: PermissionFlag[];
}

export interface RolesState {
  items: UserStoreRole[];
}

export const rolesInitialState: RolesState = {
  items: [],
};

const rolesSlice = createSlice({
  name: "roles",
  initialState: rolesInitialState,
  reducers: {
    setUserStoreRoles(state, action: PayloadAction<UserStoreRole[]>) {
      state.items = action.payload;
    },
    clearUserStoreRoles(state) {
      state.items = [];
    },
  },
});

export const { setUserStoreRoles, clearUserStoreRoles } = rolesSlice.actions;
export const rolesReducer = rolesSlice.reducer;
