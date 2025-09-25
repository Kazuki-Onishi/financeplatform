"use client";

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export interface StoreSelectionState {
  selectedStoreId: string | null;
}

export const storeSelectionInitialState: StoreSelectionState = {
  selectedStoreId: null,
};

const storeSelectionSlice = createSlice({
  name: "storeSelection",
  initialState: storeSelectionInitialState,
  reducers: {
    setSelectedStoreId(state, action: PayloadAction<string | null>) {
      state.selectedStoreId = action.payload;
    },
    clearSelectedStoreId(state) {
      state.selectedStoreId = null;
    },
  },
});

export const { setSelectedStoreId, clearSelectedStoreId } = storeSelectionSlice.actions;
export const storeSelectionReducer = storeSelectionSlice.reducer;
