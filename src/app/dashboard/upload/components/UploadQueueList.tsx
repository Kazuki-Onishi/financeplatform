import clsx from "clsx";

import { useTranslations } from "@/lib/i18n/I18nProvider";

import { SOURCE_TYPE_LABEL_KEYS, STATUS_LABEL_KEYS } from "../constants";
import { UploadGlyph } from "./UploadGlyph";
import type { UploadItem, UploadStatus } from "../types";
import { humanFileSize } from "../utils";

interface UploadQueueListProps {
  items: UploadItem[];
  userName: string;
  onCancel: (id: string) => void;
}

const CANCELABLE_STATUSES: UploadStatus[] = [
  "pending",
  "hashing",
  "ready",
  "blocked",
  "uploading",
];

export function UploadQueueList({ items, userName, onCancel }: UploadQueueListProps) {
  const t = useTranslations();
  const tQueue = useTranslations("upload.queue");

  const hasItems = items.length > 0;

  return (
    <section className="surface-card surface-card--interactive flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="section-header">
          <span className="section-header__icon">
            <UploadGlyph name="queue" className="size-6" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="chip-muted self-start">{tQueue("step")}</span>
            <h2 className="text-lg font-semibold text-neutral-900">{tQueue("title")}</h2>
            <p className="text-sm text-neutral-500">
              {hasItems ? tQueue("subtitle") : tQueue("emptyHeader")}
            </p>
          </div>
        </div>
        {hasItems ? (
          <span className="chip-muted">{tQueue("countBadge", { count: items.length })}</span>
        ) : null}
      </div>

      {hasItems ? (
        <div className="mt-4 space-y-3">
          {items.map((item) => {
            const isCancelable = CANCELABLE_STATUSES.includes(item.status);
            const statusLabel = t(STATUS_LABEL_KEYS[item.status]);
            const sourceLabelKey = SOURCE_TYPE_LABEL_KEYS[item.sourceType] ?? null;
            const sourceLabel = sourceLabelKey ? t(sourceLabelKey) : item.sourceType;
            const uploadedBy = tQueue("uploadedBy", { name: userName });
            const sourceText = tQueue("source", { source: sourceLabel });

            return (
              <div
                key={item.id}
                className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:p-5"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-neutral-900">{item.file.name}</p>
                    <p className="text-xs text-neutral-500">
                      {humanFileSize(item.file.size)} · {statusLabel}
                    </p>
                    <p className="text-xs text-neutral-400">{uploadedBy}</p>
                    <p className="text-xs text-neutral-400 sm:text-right">{sourceText}</p>
                  </div>
                  <div className="flex flex-col items-start gap-2 text-left lg:items-end lg:text-right">
                    {item.error ? <p className="text-xs text-red-600">{item.error}</p> : null}
                    {isCancelable ? (
                      <button
                        type="button"
                        onClick={() => onCancel(item.id)}
                        className="text-xs font-medium text-red-600 hover:text-red-700 hover:underline"
                      >
                        {tQueue("cancel")}
                      </button>
                    ) : null}
                  </div>
                </div>

                {item.badges.length ? (
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    {item.badges.map((badge) => {
                      const badgeKey = `badges.${badge}`;
                      const label = tQueue(badgeKey);
                      const badgeLabel = label === badgeKey ? tQueue("badges.default") : label;

                      return (
                        <span
                          key={badge}
                          className={clsx(
                            "rounded-full px-3 py-1",
                            badge === "DuplicateExact"
                              ? "bg-red-100 text-red-600"
                              : badge === "DuplicateLikely"
                              ? "bg-amber-100 text-amber-600"
                              : "bg-neutral-200 text-neutral-700",
                          )}
                        >
                          {badgeLabel}
                        </span>
                      );
                    })}
                  </div>
                ) : null}

                <div className="mt-3 h-2 rounded-full bg-slate-200/70">
                  <div
                    className={clsx(
                      "h-2 rounded-full transition-[width] duration-300 ease-out",
                      item.status === "success"
                        ? "bg-green-500"
                        : item.status === "error"
                        ? "bg-red-500"
                        : item.status === "cancelled"
                        ? "bg-neutral-400"
                        : "bg-blue-500",
                    )}
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-6 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-6 py-10 text-center text-sm text-neutral-500">
          <span>{tQueue("empty")}</span>
        </div>
      )}
    </section>
  );
}
