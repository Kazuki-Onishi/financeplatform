import clsx from "clsx";

import { SOURCE_TYPE_LABELS, STATUS_LABELS } from "../constants";
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

export function UploadQueueList({ items, userName, onCancel }: UploadQueueListProps): JSX.Element {
  return (
    <section className="grid gap-3">
      {items.map((item) => {
        const isCancelable = CANCELABLE_STATUSES.includes(item.status);

        return (
          <div key={item.id} className="rounded border border-neutral-200 p-3">
            <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-medium">{item.file.name}</p>
                <p className="text-xs text-neutral-500">
                  {humanFileSize(item.file.size)} - {STATUS_LABELS[item.status]}
                </p>
                <p className="text-xs text-neutral-400">Uploaded by {userName}</p>
                <p className="text-xs text-neutral-400">
                  Source: {SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {item.error ? <p className="text-xs text-red-600">{item.error}</p> : null}
                {isCancelable ? (
                  <button type="button" onClick={() => onCancel(item.id)} className="text-xs text-red-600 hover:underline">
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>

            {item.badges.length ? (
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {item.badges.map((badge) => (
                  <span
                    key={badge}
                    className={clsx(
                      "rounded px-2 py-1",
                      badge === "DuplicateExact"
                        ? "bg-red-100 text-red-600"
                        : badge === "DuplicateLikely"
                        ? "bg-amber-100 text-amber-600"
                        : "bg-neutral-100 text-neutral-600",
                    )}
                  >
                    {badge}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="mt-2 h-2 rounded-full bg-neutral-100">
              <div
                className={clsx(
                  "h-2 rounded-full transition-all",
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

      {!items.length ? <p className="text-sm text-neutral-500">No files selected yet.</p> : null}
    </section>
  );
}
