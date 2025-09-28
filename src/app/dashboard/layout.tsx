"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV_ITEMS: Array<{ href: string; label: string }> = [
  { href: "/dashboard/receipts", label: "Receipts" },
  { href: "/dashboard/passbooks", label: "Passbooks" },
  { href: "/dashboard/upload", label: "Upload" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/analytics", label: "Analytics" },
];

function resolveActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/dashboard/receipts" || href === "/dashboard/passbooks") {
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link
            href="/dashboard/receipts"
            className="text-lg font-semibold text-neutral-900"
          >
            Kazuki Finance
          </Link>
          <nav className="flex items-center gap-2">
            {NAV_ITEMS.map((item) => {
              const active = resolveActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded px-3 py-1 text-sm font-medium transition-colors ${
                    active
                      ? "bg-neutral-900 text-white"
                      : "text-neutral-700 hover:bg-neutral-100"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
