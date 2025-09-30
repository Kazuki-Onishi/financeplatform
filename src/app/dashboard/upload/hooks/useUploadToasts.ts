import { useCallback, useEffect, useRef, useState } from "react";

import type { ToastMessage } from "../types";

const makeId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export function useUploadToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timeoutRef = useRef(new Map<string, number>());

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timeoutId = timeoutRef.current.get(id);
    if (typeof window !== "undefined" && typeof timeoutId === "number") {
      window.clearTimeout(timeoutId);
    }
    timeoutRef.current.delete(id);
  }, []);

  const addToast = useCallback(
    (type: ToastMessage["type"], message: string) => {
      const id = makeId();
      setToasts((prev) => [...prev, { id, type, message }]);
      if (typeof window !== "undefined") {
        const timeoutId = window.setTimeout(() => {
          removeToast(id);
        }, 5000);
        timeoutRef.current.set(id, timeoutId);
      }
      return id;
    },
    [removeToast],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const timeouts = timeoutRef.current;
    return () => {
      timeouts.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      timeouts.clear();
    };
  }, []);

  return { toasts, addToast, removeToast };
}

