"use client";

import { type ChangeEvent, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";

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
  fileInputRef: RefObject<HTMLInputElement>;
  captureInputRef: RefObject<HTMLInputElement>;
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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectFilesClick();
    }
  };

  return (
    <section className="space-y-4 rounded border border-neutral-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-neutral-700">Upload files</h2>
          <p className="text-xs text-neutral-500">Drag files into the area or use the buttons to select and capture.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onSelectFilesClick}
            disabled={disabled}
            className="rounded border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Select files
          </button>
          <button
            type="button"
            onClick={onCaptureClick}
            disabled={disabled}
            className="rounded border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Take photo
          </button>
          <button
            type="button"
            onClick={onUploadClick}
            disabled={!readyCount || uploading}
            className={clsx(
              "rounded px-4 py-2 text-sm font-medium text-white",
              readyCount && !uploading ? "bg-green-600 hover:bg-green-700" : "bg-neutral-400",
            )}
            title={!readyCount ? "No files ready" : uploading ? "Uploading..." : "Create drafts"}
          >
            Create Draft Receipts
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
          "flex flex-col items-center justify-center gap-2 rounded border-2 border-dashed px-6 py-10 text-center text-sm transition",
          disabled
            ? "cursor-not-allowed border-neutral-200 bg-neutral-100 text-neutral-400"
            : isDropActive
            ? "cursor-copy border-blue-500 bg-blue-50 text-blue-700"
            : "cursor-pointer border-neutral-300 bg-neutral-50 text-neutral-600 hover:border-blue-400 hover:bg-blue-50",
        )}
        aria-disabled={disabled}
      >
        <p className="text-sm font-medium text-neutral-700">Drop files to add them</p>
        <p className="text-xs text-neutral-500">Supported: JPG, PNG, HEIC, WebP, PDF</p>
        {showDropHint ? <p className="text-xs text-blue-600">Drop files onto this area</p> : null}
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
