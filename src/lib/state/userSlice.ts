
"use client";

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

type AuthProviderId = string;

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerIds: AuthProviderId[];
  lastLoginAt?: string | null;
}

export interface UserState {
  profile: UserProfile | null;
  status: "idle" | "loading" | "ready" | "error";
  lastFetchedAt: number | null;
  error?: string | null;
}

export const initialUserState: UserState = {
  profile: null,
  status: "idle",
  lastFetchedAt: null,
  error: null,
};

const userSlice = createSlice({
  name: "user",
  initialState: initialUserState,
  reducers: {
    setUser(state, action: PayloadAction<UserProfile>) {
      state.profile = action.payload;
      state.status = "ready";
      state.lastFetchedAt = Date.now();
      state.error = null;
    },
    setUserLoading(state) {
      state.status = "loading";
      state.error = null;
    },
    setUserError(state, action: PayloadAction<string>) {
      state.status = "error";
      state.error = action.payload;
    },
    clearUser(state) {
      state.profile = null;
      state.status = "idle";
      state.lastFetchedAt = null;
      state.error = null;
    },
  },
});

export const { setUser, setUserLoading, setUserError, clearUser } = userSlice.actions;
export const userReducer = userSlice.reducer;


