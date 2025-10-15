"use client";

import Link from "next/link";
import clsx from "clsx";

import { useTranslations } from "@/lib/i18n/I18nProvider";
import {
  PURPOSE_NOTE_MAX_LENGTH,
  PURPOSE_OPTIONS,
  type ReceiptPurposeOption,
} from "@/lib/purposeOptions";
import type { ReceiptSourceType } from "@/types/receipt";

import {
  PURCHASE_PURPOSE_MAX_LENGTH,
  PURCHASE_PURPOSE_OPTION_DEFS,
  SOURCE_TYPE_DEFINITIONS,
  type PurchasePurposeOptionKey,
} from "../constants";
import type { PaymentMethodChoice } from "../types";

import { UploadGlyph } from "./UploadGlyph";

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
  purchasePurposeKey: PurchasePurposeOptionKey | "custom" | "none";
  onChangePurchasePurposeKey: (key: PurchasePurposeOptionKey | "custom" | "none") => void;
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
  purchasePurposeKey,
  onChangePurchasePurposeKey,
  purchasePurpose,
  onChangePurchasePurpose,
  onPurchasePurposeBlur,
  purchaseQuickValues,
  onPurposeQuickSelect,
  onPurchaseQuickSelect,
}: UploadInformationPanelProps) {
  const t = useTranslations();
  const tInfo = useTranslations("upload.information");
  const tPurchasePurposeOptions = useTranslations("upload.information.purchaseOptions");

  const getPurchasePurposeLabel = (key: PurchasePurposeOptionKey) => {
    const value = tPurchasePurposeOptions(key);
    if (value === key) {
      const fallback = PURCHASE_PURPOSE_OPTION_DEFS.find((option) => option.key === key)?.fallback ?? key;
      return fallback;
    }
    return value;
  };


  return (
    <section className="surface-card surface-card--interactive flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="section-header">
          <span className="section-header__icon">
            <UploadGlyph name="information" className="size-6" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="chip-accent self-start">{tInfo("step")}</span>
            <h2 className="text-lg font-semibold text-neutral-900">{tInfo("title")}</h2>
            <p className="text-sm text-neutral-500">{tInfo("description")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end">
          <button
            type="button"
            onClick={onResetInfo}
            className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs font-medium text-neutral-600 shadow-sm transition hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
          >
            {tInfo("reset")}
          </button>
          {isHydrated ? (
            <button
              type="button"
              onClick={onAddStore}
              className="rounded-lg border border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-600 shadow-sm transition hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
            >
              {tInfo("addStore")}
            </button>
          ) : null}
          <Link
            href="/dashboard/receipts"
            className="rounded-lg border border-purple-500 bg-white px-3 py-2 text-xs font-semibold text-purple-600 shadow-sm transition hover:bg-purple-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-200"
          >
            {tInfo("viewReceipts")}
          </Link>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-neutral-600" htmlFor="information-store">
            {tInfo("storeLabel")}
          </label>

          {isHydrated && storeQuickOptions.length ? (
            <div className="flex flex-wrap justify-center gap-2 rounded-xl bg-neutral-50 p-2 sm:justify-start">
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
                      "w-full rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:w-auto",
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
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-100"
            value={storeSelectValue}
            onChange={(event) => onSelectStore(event.target.value)}
            disabled={storeSelectDisabled}
            title={storeSelectTitle}
          >
            {(!isHydrated || !storeSelectValue || !hasStoresAvailable) ? (
              <option value="" disabled hidden>
                {isHydrated && storeOptions.length ? tInfo("storePlaceholder") : tInfo("storeLoading")}
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
            <p className="text-xs text-neutral-500">{tInfo("storeEmpty")}</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1 lg:col-span-1 xl:col-span-2">
          <span className="text-sm font-medium text-neutral-600">{tInfo("sourceLabel")}</span>
          <div className="flex flex-wrap gap-2 sm:gap-3">
            {SOURCE_TYPE_DEFINITIONS.map((definition) => {
              const isActive = definition.value === sourceType;
              return (
                <button
                  key={definition.value}
                  type="button"
                  onClick={() => onChangeSourceType(definition.value)}
                  disabled={featureDisabled}
                  className={clsx(
                    "flex w-full flex-col items-start gap-1 rounded border px-3 py-2 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:min-w-[140px] sm:w-auto",
                    isActive
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
                    featureDisabled ? "cursor-not-allowed opacity-60" : "",
                  )}
                  aria-pressed={isActive}
                >
                  <span className="font-medium">{t(definition.labelKey)}</span>
                  <span className="text-xs text-neutral-500">{t(definition.descriptionKey)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1 xl:col-span-3">
          <span className="text-sm font-medium text-neutral-600">{tInfo("paymentLabel")}</span>
          {paymentQuickChoices.length ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span className="font-medium text-neutral-500">{tInfo("paymentRecent")}</span>
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

          <div className="flex flex-wrap gap-2 sm:gap-3">
            {paymentMethodChoices.map((choice) => {
              const isActive = choice.key === paymentMethodKey;
              const badge =
                choice.source === "recent"
                  ? tInfo("paymentBadgeRecent")
                  : choice.source === "card"
                  ? tInfo("paymentBadgeSaved")
                  : null;
              return (
                <button
                  key={choice.key}
                  type="button"
                  onClick={() => onChangePaymentMethod(choice.key)}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:w-auto",
                    isActive
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
                  )}
                  aria-pressed={isActive}
                >
                  <span>{choice.label}</span>
                  {badge ? <span className="text-[11px] uppercase text-neutral-400">{badge}</span> : null}
                </button>
              );
            })}
          </div>

          <span className="text-xs text-neutral-500">{tInfo("paymentHint")}</span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-neutral-600">{tInfo("advanceLabel")}</span>
          <p className="text-xs text-neutral-500">{tInfo("advanceDescription")}</p>
          <div className="flex flex-wrap gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => onChangeAdvancePayment(true)}
              className={clsx(
                "w-full rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:w-auto",
                advancePayment
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400",
              )}
              aria-pressed={advancePayment}
            >
              {tInfo("advanceYes")}
            </button>
            <button
              type="button"
              onClick={() => onChangeAdvancePayment(false)}
              className={clsx(
                "w-full rounded-full border px-3 py-1 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:w-auto",
                advancePayment
                  ? "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
                  : "border-blue-500 bg-blue-50 text-blue-700",
              )}
              aria-pressed={!advancePayment}
            >
              {tInfo("advanceNo")}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-neutral-600" htmlFor="receipt-purpose">
            {tInfo("purposeLabel")}
          </label>
          <select
            id="receipt-purpose"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-100"
            value={purposeKey}
            onChange={(event) => onChangePurpose(event.target.value)}
          >
            <option value="">{tInfo("purposeNone")}</option>
            {PURPOSE_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          {purposeQuickOptions.length ? (
            <div className="flex flex-wrap justify-center gap-2 text-xs text-neutral-500 sm:justify-start">
              <span className="font-medium text-neutral-500">{tInfo("purposeRecent")}</span>
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
              onChange={(event) =>
                onChangePurposeNote(event.target.value.slice(0, PURPOSE_NOTE_MAX_LENGTH))
              }
              maxLength={PURPOSE_NOTE_MAX_LENGTH}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-100"
              placeholder={tInfo("purposeNotePlaceholder")}
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-1 xl:col-span-3">
          <label className="text-sm font-medium text-neutral-600" htmlFor="receipt-purchase-purpose-select">
            {tInfo("purchaseLabel")}
          </label>
          <select
            id="receipt-purchase-purpose-select"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-100"
            value={purchasePurposeKey}
            onChange={(event) =>
              onChangePurchasePurposeKey(
                event.target.value as PurchasePurposeOptionKey | "custom" | "none",
              )
            }
          >
            <option value="none">{tInfo("purchaseSelectPlaceholder")}</option>
            {PURCHASE_PURPOSE_OPTION_DEFS.map((option) => (
              <option key={option.key} value={option.key}>
                {getPurchasePurposeLabel(option.key)}
              </option>
            ))}
            <option value="custom">{tInfo("purchaseOptionCustom")}</option>
          </select>
          {purchasePurposeKey === "custom" ? (
            <>
              <input
                id="receipt-purchase-purpose-custom"
                type="text"
                value={purchasePurpose}
                onChange={(event) =>
                  onChangePurchasePurpose(event.target.value.slice(0, PURCHASE_PURPOSE_MAX_LENGTH))
                }
                onBlur={onPurchasePurposeBlur}
                maxLength={PURCHASE_PURPOSE_MAX_LENGTH}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-100"
                placeholder={tInfo("purchasePlaceholder")}
              />
              {purchaseQuickValues.length ? (
                <div className="flex flex-wrap justify-center gap-2 text-xs text-neutral-500 sm:justify-start">
                  <span className="font-medium text-neutral-500">{tInfo("purchaseRecent")}</span>
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
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
