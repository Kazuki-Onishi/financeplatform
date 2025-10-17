"use client";

import { createContext, useContext, type ReactNode } from "react";

import { useUserPermissions, type UseUserPermissionsResult } from "@/lib/hooks/useUserPermissions";

const DashboardPermissionsContext = createContext<UseUserPermissionsResult | null>(null);

export function DashboardPermissionsProvider({ children }: { children: ReactNode }) {
  const permissions = useUserPermissions();
  return (
    <DashboardPermissionsContext.Provider value={permissions}>
      {children}
    </DashboardPermissionsContext.Provider>
  );
}

export function useDashboardPermissions(): UseUserPermissionsResult {
  const context = useContext(DashboardPermissionsContext);
  if (!context) {
    throw new Error("useDashboardPermissions must be used within DashboardPermissionsProvider");
  }
  return context;
}
