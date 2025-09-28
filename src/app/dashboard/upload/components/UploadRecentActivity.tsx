import clsx from "clsx";

import { STATUS_CLASSES, STATUS_LABELS } from "../constants";
import type { UploadItem } from "../types";
import { humanFileSize } from "../utils";

interface UploadRecentActivityProps {
  items: UploadItem[];
  userName: string;
}

export function UploadRecentActivity({ items, userName }: UploadRecentActivityProps): JSX.Element {
  return (
    <section className="rounded border border-neutral-200 p-4">
      <h2 className="text-sm font-medium text-neutral-700">Recent activity</h2>
      <div className="mt-2 flex flex-col gap-1">
        {items.length ? (
          items.map((item) => (
            <div key={`recent-${item.id}`} className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
              <span className="flex-1 truncate font-medium text-neutral-700">{item.file.name}</span>
              <span className="w-28 text-right text-neutral-400">{userName}</span>
              <span className="w-20 text-right text-neutral-500">{humanFileSize(item.file.size)}</span>
              <span className={clsx("w-24 text-right", STATUS_CLASSES[item.status])}>{STATUS_LABELS[item.status]}</span>
              <span className="w-12 text-right text-neutral-500">{item.progress}%</span>
              <span className="w-20 text-right text-neutral-400">
                {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))
        ) : (
          <p className="text-xs text-neutral-500">No uploads yet.</p>
        )}
      </div>
    </section>
  );
}
