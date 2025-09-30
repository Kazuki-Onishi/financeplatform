"use client";

import type { ReactNode } from "react";
import { Provider as ReduxProvider } from "react-redux";

import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { store } from "@/lib/state/store";
import { PermissionsStoreProvider } from "@/lib/state/userPermissionsStore";

interface AppProvidersProps {
  children: ReactNode;
  initialActiveStoreId: string | null;
  initialLocale: string | null;
}

export function AppProviders({ children, initialActiveStoreId, initialLocale }: AppProvidersProps): ReactNode {
  return (
    <I18nProvider initialLocale={initialLocale}>
      <ReduxProvider store={store}>
        <PermissionsStoreProvider initialActiveStoreId={initialActiveStoreId}>
          {children}
        </PermissionsStoreProvider>
      </ReduxProvider>
    </I18nProvider>
  );
}
