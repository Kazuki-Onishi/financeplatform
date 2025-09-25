"use client";

import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector, type TypedUseSelectorHook } from "react-redux";
import { userReducer, initialUserState, type UserState } from "./userSlice";
import { rolesReducer, rolesInitialState, type RolesState } from "./rolesSlice";
import { storeSelectionReducer, storeSelectionInitialState, type StoreSelectionState } from "./storeSlice";
import { permissionsReducer, permissionsInitialState, type PermissionsPreloadState } from "./permissionsSlice";

const PERSIST_KEY = "app:user";

type PersistedState = {
  user: UserState;
  roles: RolesState;
  storeSelection: StoreSelectionState;
  permissions: PermissionsPreloadState;
};

function loadPersistedState(): PersistedState | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedState> | null;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const userState: UserState =
      parsed.user && typeof parsed.user === "object"
        ? (parsed.user as UserState)
        : { ...initialUserState };
    const rolesState: RolesState =
      parsed.roles && typeof parsed.roles === "object" && Array.isArray((parsed.roles as RolesState).items)
        ? { items: [...(parsed.roles as RolesState).items] }
        : { items: [...rolesInitialState.items] };
    const storeSelectionState: StoreSelectionState =
      parsed.storeSelection && typeof parsed.storeSelection === "object"
        ? { ...(parsed.storeSelection as StoreSelectionState) }
        : { ...storeSelectionInitialState };
    const permissionsState: PermissionsPreloadState =
      parsed.permissions && typeof parsed.permissions === "object"
        ? { ...(parsed.permissions as PermissionsPreloadState) }
        : { ...permissionsInitialState };

    return {
      user: userState,
      roles: rolesState,
      storeSelection: storeSelectionState,
      permissions: permissionsState,
    };
  } catch (error) {
    console.warn("[store] failed to parse persisted user state", error);
    return undefined;
  }
}

const preloadedState = loadPersistedState();

export const store = configureStore({
  reducer: {
    user: userReducer,
    roles: rolesReducer,
    storeSelection: storeSelectionReducer,
    permissions: permissionsReducer,
  },
  preloadedState: preloadedState as PersistedState | undefined,
});

if (typeof window !== "undefined") {
  store.subscribe(() => {
    const state = store.getState();
    try {
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          user: state.user,
          roles: state.roles,
          storeSelection: state.storeSelection,
          permissions: state.permissions,
        }),
      );
    } catch (error) {
      console.warn("[store] failed to persist user state", error);
    }
  });
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
