"use client";

import clsx from "clsx";

import type { ToastMessage } from "../types";

interface ToastContainerProps {
  toasts: ToastMessage[];
}

export function ToastContainer({ toasts }: ToastContainerProps) {
  if (!toasts.length) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 bottom-4 flex justify-center">
      <div className="flex w-full max-w-sm flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(
              "rounded border px-3 py-2 text-sm shadow",
              toast.type === "success"
                ? "border-green-200 bg-green-50 text-green-800"
                : toast.type === "error"
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-neutral-200 bg-neutral-50 text-neutral-700",
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
