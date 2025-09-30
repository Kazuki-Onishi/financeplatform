"use client";

import { type ChangeEvent, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";

import { useTranslations } from "@/lib/i18n/I18nProvider";

import { UploadGlyph } from "./UploadGlyph";

interface UploadDropzoneProps {
  storeId: string;
  readyCount: number;
  uploading: boolean;
  isDropActive: boolean;
  showDropHint: boolean;
  onSelectFilesClick: () => void;
  onCaptureClick: () => void;
  onUploadClick: () => void | Promise<void>;
  onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  captureInputRef: RefObject<HTMLInputElement | null>;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onCaptureChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export function UploadDropzone({
  storeId,
  readyCount,
  uploading,
  isDropActive,
  showDropHint,
  onSelectFilesClick,
  onCaptureClick,
  onUploadClick,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  fileInputRef,
  captureInputRef,
  onFileChange,
  onCaptureChange,
}: UploadDropzoneProps) {
  const disabled = !storeId;
  const tDropzone = useTranslations("upload.dropzone");

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectFilesClick();
    }
  };

  const buttonTitle = !readyCount
    ? tDropzone("noFiles")
    : uploading
    ? tDropzone("uploading")
    : tDropzone("createDraftsTitle");

  return (
    <section className="surface-card surface-card--interactive flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="section-header">
          <span className="section-header__icon">
            <UploadGlyph name="dropzone" className="size-6" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="chip-accent self-start">{tDropzone("step")}</span>
            <h2 className="text-lg font-semibold text-neutral-900">{tDropzone("title")}</h2>
            <p className="text-sm text-neutral-500">{tDropzone("description")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end">
          <button
            type="button"
            onClick={onSelectFilesClick}
            disabled={disabled}
            className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            {tDropzone("select")}
          </button>
          <button
            type="button"
            onClick={onCaptureClick}
            disabled={disabled}
            className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            {tDropzone("capture")}
          </button>
          <button
            type="button"
            onClick={onUploadClick}
            disabled={!readyCount || uploading}
            className={clsx(
              "w-full rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-green-200 sm:w-auto",
              readyCount && !uploading ? "bg-green-600 hover:bg-green-700" : "bg-neutral-400",
            )}
            title={buttonTitle}
          >
            {tDropzone("createDrafts")}
          </button>
        </div>
      </div>

      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={() => {
          if (!disabled) {
            onSelectFilesClick();
          }
        }}
        onKeyDown={handleKeyDown}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={clsx(
          "dropzone-visual border-2 border-dashed transition",
          disabled
            ? "cursor-not-allowed border-slate-200/70 bg-slate-100 text-slate-400"
            : isDropActive
            ? "is-active cursor-copy border-blue-500/80 text-blue-700"
            : "cursor-pointer border-slate-300/80 text-slate-600 hover:border-blue-400/80",
        )}
        aria-disabled={disabled}
      >
        <div className="dropzone-visual__inner flex flex-col items-center justify-center gap-3 px-4 py-12 text-center sm:px-6 sm:py-14">
          <p className="text-base font-semibold text-neutral-700">{tDropzone("drop")}</p>
          <p className="text-sm text-neutral-500">{tDropzone("supported")}</p>
          {showDropHint ? <p className="text-xs font-medium text-blue-600">{tDropzone("hint")}</p> : null}
        </div>
      </div>

      <input
        ref={fileInputRef}
        id="upload-file-input"
        type="file"
        accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif,.pdf"
        multiple
        className="hidden"
        onChange={onFileChange}
        disabled={disabled}
      />
      <input
        ref={captureInputRef}
        id="upload-capture-input"
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onCaptureChange}
        disabled={disabled}
      />
    </section>
  );
}
