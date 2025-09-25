
"use client";

import type { ReactNode } from "react";
import { Provider as ReduxProvider } from "react-redux";
import { store } from "@/lib/state/store";
import { PermissionsStoreProvider } from "@/lib/state/userPermissionsStore";

interface AppProvidersProps {
  children: ReactNode;
  initialActiveStoreId: string | null;
}

export function AppProviders({ children, initialActiveStoreId }: AppProvidersProps): ReactNode {
  return (
    <ReduxProvider store={store}>
      <PermissionsStoreProvider initialActiveStoreId={initialActiveStoreId}>
        {children}
      </PermissionsStoreProvider>
    </ReduxProvider>
  );
}

