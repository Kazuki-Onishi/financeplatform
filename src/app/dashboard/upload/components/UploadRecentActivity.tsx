import clsx from "clsx";

import { useTranslations } from "@/lib/i18n/I18nProvider";

import { SOURCE_TYPE_LABEL_KEYS, STATUS_CLASSES, STATUS_LABEL_KEYS } from "../constants";
import { UploadGlyph } from "./UploadGlyph";
import type { UploadItem } from "../types";
import { humanFileSize } from "../utils";

interface UploadRecentActivityProps {
  items: UploadItem[];
  userName: string;
}

export function UploadRecentActivity({ items, userName }: UploadRecentActivityProps) {
  const t = useTranslations();
  const tRecent = useTranslations("upload.recent");
  const tQueue = useTranslations("upload.queue");

  return (
    <section className="surface-card surface-card--interactive flex flex-col gap-4 p-4 sm:p-6">
      <div className="section-header">
        <span className="section-header__icon">
          <UploadGlyph name="activity" className="size-6" />
        </span>
        <div className="flex flex-col gap-1">
          <span className="chip-muted self-start">{tRecent("step")}</span>
          <h2 className="text-lg font-semibold text-neutral-900">{tRecent("title")}</h2>
          <p className="text-sm text-neutral-500">{tRecent("subtitle")}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-3">
        {items.length ? (
          items.map((item) => {
            const statusLabel = t(STATUS_LABEL_KEYS[item.status]);
            const statusClass = STATUS_CLASSES[item.status];
            const sourceLabelKey = SOURCE_TYPE_LABEL_KEYS[item.sourceType] ?? null;
            const sourceLabel = sourceLabelKey ? t(sourceLabelKey) : item.sourceType;
            const uploadedBy = tQueue("uploadedBy", { name: userName });
            const sourceText = tQueue("source", { source: sourceLabel });
            const sizeLabel = tRecent("metaSize", { size: humanFileSize(item.file.size) });
            const progressLabel = tRecent("metaProgress", { progress: item.progress });
            const timeLabel = tRecent("metaTime", {
              time: new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            });

            const meta = [
              { id: "uploadedBy", value: uploadedBy },
              { id: "size", value: sizeLabel },
              { id: "source", value: sourceText },
              { id: "progress", value: progressLabel },
              { id: "time", value: timeLabel },
            ];

            return (
              <div
                key={`recent-${item.id}`}
                className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:p-5"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <p className="truncate text-sm font-semibold text-neutral-900 sm:text-base">{item.file.name}</p>
                  <span className={clsx("text-xs font-semibold sm:text-sm", statusClass)}>{statusLabel}</span>
                </div>
                <div className="mt-3 grid gap-1 text-xs text-neutral-500 sm:grid-cols-2 sm:gap-2">
                  {meta.map(({ id, value }) => (
                    <span
                      key={`${item.id}-${id}`}
                      className={id === "progress" ? "font-medium text-neutral-600" : undefined}
                    >
                      {value}
                    </span>
                  ))}
                </div>
                {item.error ? <p className="mt-2 text-xs text-red-600">{item.error}</p> : null}
              </div>
            );
          })
        ) : (
          <p className="rounded-lg border border-dashed border-neutral-200 bg-neutral-50 px-4 py-6 text-center text-xs text-neutral-500">
            {tRecent("empty")}
          </p>
        )}
      </div>
    </section>
  );
}
