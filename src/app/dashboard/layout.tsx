"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { AVAILABLE_LOCALES, isLocale } from "@/lib/i18n";
import { useLocale, useTranslations } from "@/lib/i18n/I18nProvider";
import { DashboardPermissionsProvider } from "./PermissionsProvider";

const NAV_ITEMS: Array<{ href: string; labelKey: string }> = [
  { href: "/dashboard/receipts", labelKey: "receipts" },
  { href: "/dashboard/passbooks", labelKey: "passbooks" },
  { href: "/dashboard/upload", labelKey: "upload" },
  { href: "/dashboard/settings", labelKey: "settings" },
  { href: "/dashboard/analytics", labelKey: "analytics" },
];

function resolveActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/dashboard/receipts" || href === "/dashboard/passbooks") {
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function LocaleSwitcher() {
  const { locale, setLocale } = useLocale();
  const tCommon = useTranslations("common");

  return (
    <div className="flex items-center gap-1 text-xs text-neutral-500">
      <span className="hidden sm:inline" aria-hidden="true">
        {tCommon("language")}:
      </span>
      <label className="sr-only" htmlFor="dashboard-locale-select">
        {tCommon("language")}
      </label>
      <select
        id="dashboard-locale-select"
        value={locale}
        onChange={(event) => {
          const next = event.target.value;
          if (isLocale(next)) {
            setLocale(next);
          }
        }}
        className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 shadow-sm focus:border-blue-400 focus:outline-none"
      >
        {AVAILABLE_LOCALES.map((option) => (
          <option key={option} value={option}>
            {tCommon(`languages.${option}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const tNav = useTranslations("dashboard.nav");

  return (
    <DashboardPermissionsProvider>
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/dashboard/receipts" className="text-lg font-semibold text-neutral-900">
            Kazuki Finance
          </Link>
          <div className="flex items-center gap-3">
            <nav className="flex items-center gap-2">
              {NAV_ITEMS.map((item) => {
                const active = resolveActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded px-3 py-1 text-sm font-medium transition-colors ${
                      active ? "bg-neutral-900 text-white" : "text-neutral-700 hover:bg-neutral-100"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    {tNav(item.labelKey)}
                  </Link>
                );
              })}
            </nav>
            <LocaleSwitcher />
          </div>
        </div>
        </header>
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">{children}</main>
    </div>
    </DashboardPermissionsProvider>
  );
}






