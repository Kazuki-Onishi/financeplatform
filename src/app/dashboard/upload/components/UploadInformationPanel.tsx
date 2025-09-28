"use client";

import Link from "next/link";
import clsx from "clsx";

import {
  PURPOSE_NOTE_MAX_LENGTH,
  PURPOSE_OPTIONS,
  type ReceiptPurposeOption,
} from "@/lib/purposeOptions";
import type { ReceiptSourceType } from "@/types/receipt";

import {
  PURCHASE_PURPOSE_MAX_LENGTH,
  SOURCE_TYPE_OPTIONS,
} from "../constants";
import type { PaymentMethodChoice } from "../types";

interface StoreOption {
  id: string;
  name: string;
}

interface UploadInformationPanelProps {
  isHydrated: boolean;
  featureDisabled: boolean;
  storeId: string;
  storeOptions: StoreOption[];
  storeQuickOptions: StoreOption[];
  storeSelectValue: string;
  storeSelectDisabled: boolean;
  storeSelectTitle?: string;
  hasStoresAvailable: boolean;
  onSelectStore: (id: string) => void;
  onResetInfo: () => void;
  onAddStore: () => void;
  sourceType: ReceiptSourceType;
  onChangeSourceType: (value: ReceiptSourceType) => void;
  advancePayment: boolean;
  onChangeAdvancePayment: (value: boolean) => void;
  paymentMethodChoices: PaymentMethodChoice[];
  paymentMethodKey: string;
  onChangePaymentMethod: (key: string) => void;
  paymentQuickChoices: PaymentMethodChoice[];
  purposeKey: string;
  onChangePurpose: (key: string) => void;
  purposeNote: string;
  onChangePurposeNote: (value: string) => void;
  purposeQuickOptions: ReceiptPurposeOption[];
  showPurposeNoteInput: boolean;
  purchasePurpose: string;
  onChangePurchasePurpose: (value: string) => void;
  onPurchasePurposeBlur: () => void;
  purchaseQuickValues: string[];
  onPurposeQuickSelect: (key: string) => void;
  onPurchaseQuickSelect: (value: string) => void;
}

export function UploadInformationPanel({
  isHydrated,
  featureDisabled,
  storeId,
  storeOptions,
  storeQuickOptions,
  storeSelectValue,
  storeSelectDisabled,
  storeSelectTitle,
  hasStoresAvailable,
  onSelectStore,
  onResetInfo,
  onAddStore,
  sourceType,
  onChangeSourceType,
  advancePayment,
  onChangeAdvancePayment,
  paymentMethodChoices,
  paymentMethodKey,
  onChangePaymentMethod,
  paymentQuickChoices,
  purposeKey,
  onChangePurpose,
  purposeNote,
  onChangePurposeNote,
  purposeQuickOptions,
  showPurposeNoteInput,
  purchasePurpose,
  onChangePurchasePurpose,
  onPurchasePurposeBlur,
  purchaseQuickValues,
  onPurposeQuickSelect,
  onPurchaseQuickSelect,
}: UploadInformationPanelProps) {
  return (
    <section className="space-y-4 rounded border border-neutral-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-neutral-700">Information</h2>
          <p className="text-xs text-neutral-500">Select store and defaults before uploading.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onResetInfo}
            className="rounded border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
          >
            Reset info
          </button>
          {isHydrated ? (
            <button
              type="button"
              onClick={onAddStore}
              className="rounded border border-blue-600 px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-50"
            >
              + Add store
            </button>
          ) : null}
          <Link
            href="/dashboard/receipts"
            className="rounded border border-purple-600 px-3 py-2 text-xs font-medium text-purple-600 hover:bg-purple-50"
          >
            View receipts
          </Link>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-neutral-600" htmlFor="information-store">
            Store
          </label>
          {isHydrated && storeQuickOptions.length ? (
            <div className="flex flex-wrap gap-2">
              {storeQuickOptions.map(({ id, name }) => {
                const isActive = storeId === id;
                const disabled = storeSelectDisabled;
                return (
                  <button
                    key={`store-pill-${id}`}
                    type="button"
                    onClick={() => onSelectStore(id)}
                    disabled={disabled}
                    className={clsx(
                      "rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                      isActive
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
                      disabled ? "cursor-not-allowed opacity-60" : "",
                    )}
                    aria-pressed={isActive}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          ) : null}
          <select
            id="information-store"
            className="rounded border border-neutral-300 px-3 py-2 text-sm"
            value={storeSelectValue}
            onChange={(event) => onSelectStore(event.target.value)}
            disabled={storeSelectDisabled}
            title={storeSelectTitle}
          >
            {(!isHydrated || !storeSelectValue || !hasStoresAvailable) ? (
              <option value="" disabled hidden>
                {isHydrated && storeOptions.length ? "Select a store" : "Loading stores..."}
              </option>
            ) : null}
            {hasStoresAvailable
              ? storeOptions.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))
              : null}
          </select>
          {isHydrated && !storeOptions.length ? (
            <p className="text-xs text-neutral-500">No stores yet. Add one to start uploading.</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1 lg:col-span-1 xl:col-span-2">
          <span className="text-sm font-medium text-neutral-600">Upload type</span>
          <div className="flex flex-wrap gap-2">
            {SOURCE_TYPE_OPTIONS.map((option) => {
              const isActive = option.value === sourceType;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChangeSourceType(option.value)}
                  disabled={featureDisabled}
                  className={clsx(
                    "flex min-w-[140px] flex-col items-start gap-1 rounded border px-3 py-2 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                    isActive
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
                    featureDisabled ? "cursor-not-allowed opacity-60" : "",
                  )}
                  aria-pressed={isActive}
                >
                  <span className="font-medium">{option.label}</span>
                  <span className="text-xs text-neutral-500">{option.description}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1 xl:col-span-3">
          <span className="text-sm font-medium text-neutral-600">Payment method</span>
          {paymentQuickChoices.length ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span className="font-medium text-neutral-500">Recent:</span>
              {paymentQuickChoices.map((choice) => {
                const isActive = choice.key === paymentMethodKey;
                return (
                  <button
                    key={`quick-payment-${choice.key}`}
                    type="button"
                    onClick={() => onChangePaymentMethod(choice.key)}
                    className={clsx(
                      "rounded-full border px-3 py-1 text-xs",
                      isActive
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
                    )}
                  >
                    {choice.label}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {paymentMethodChoices.map((choice) => {
              const isActive = choice.key === paymentMethodKey;
              return (
                <button
                  key={choice.key}
                  type="button"
                  onClick={() => onChangePaymentMethod(choice.key)}
                  className={clsx(
                    "flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                    isActive
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
                  )}
                  aria-pressed={isActive}
                >
                  <span>{choice.label}</span>
                  {choice.source === "recent" ? (
                    <span className="text-[11px] uppercase text-neutral-400">Recent</span>
                  ) : choice.source === "card" ? (
                    <span className="text-[11px] uppercase text-neutral-400">Saved</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-neutral-500">We&apos;ll remember the last few methods you used for this store.</span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-neutral-600">Advance payment</span>
          <p className="text-xs text-neutral-500">Mark if you fronted this expense and need reimbursement.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onChangeAdvancePayment(true)}
              className={clsx(
                "rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                advancePayment
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
              )}
              aria-pressed={advancePayment}
            >
              Yes (建て替え)
            </button>
            <button
              type="button"
              onClick={() => onChangeAdvancePayment(false)}
              className={clsx(
                "rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                advancePayment
                  ? "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
                  : "border-blue-500 bg-blue-50 text-blue-700",
              )}
              aria-pressed={!advancePayment}
            >
              No
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-neutral-600" htmlFor="receipt-purpose">
            Purpose
          </label>
          <select
            id="receipt-purpose"
            className="rounded border border-neutral-300 px-3 py-2 text-sm"
            value={purposeKey}
            onChange={(event) => onChangePurpose(event.target.value)}
          >
            <option value="">No purpose</option>
            {PURPOSE_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          {purposeQuickOptions.length ? (
            <div className="flex flex-wrap gap-2 text-xs text-neutral-500">
              <span className="font-medium text-neutral-500">Recent:</span>
              {purposeQuickOptions.map((option) => (
                <button
                  key={`purpose-${option.key}`}
                  type="button"
                  onClick={() => onPurposeQuickSelect(option.key)}
                  className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-400"
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {showPurposeNoteInput ? (
            <input
              type="text"
              value={purposeNote}
              onChange={(event) => onChangePurposeNote(event.target.value.slice(0, PURPOSE_NOTE_MAX_LENGTH))}
              maxLength={PURPOSE_NOTE_MAX_LENGTH}
              className="rounded border border-neutral-300 px-3 py-2 text-sm"
              placeholder="Add a short note (optional)"
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-1 xl:col-span-3">
          <label className="text-sm font-medium text-neutral-600" htmlFor="receipt-purchase-purpose">
            Purchase purpose
          </label>
          <input
            id="receipt-purchase-purpose"
            type="text"
            value={purchasePurpose}
            onChange={(event) => onChangePurchasePurpose(event.target.value.slice(0, PURCHASE_PURPOSE_MAX_LENGTH))}
            onBlur={onPurchasePurposeBlur}
            maxLength={PURCHASE_PURPOSE_MAX_LENGTH}
            className="rounded border border-neutral-300 px-3 py-2 text-sm"
            placeholder="e.g. store supplies or equipment purchase"
          />
          {purchaseQuickValues.length ? (
            <div className="flex flex-wrap gap-2 text-xs text-neutral-500">
              <span className="font-medium text-neutral-500">Recent:</span>
              {purchaseQuickValues.map((value) => (
                <button
                  key={`purchase-${value}`}
                  type="button"
                  onClick={() => onPurchaseQuickSelect(value)}
                  className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-400"
                >
                  {value}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
