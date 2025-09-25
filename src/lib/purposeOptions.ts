export interface ReceiptPurposeOption {
  key: string;
  label: string;
  requiresNote?: boolean;
}

export const PURPOSE_NOTE_MAX_LENGTH = 60;

export const PURPOSE_OPTIONS: ReadonlyArray<ReceiptPurposeOption> = [
  { key: "raw_materials", label: "Raw materials (food & drinks)" },
  { key: "supplies_equipment", label: "Supplies & equipment" },
  { key: "advertising_promotion", label: "Advertising & promotion" },
  { key: "transport_delivery", label: "Transport & delivery" },
  { key: "client_entertainment", label: "Client entertainment & meetings" },
  { key: "utilities_communications", label: "Utilities & communications" },
  { key: "leases_subscriptions", label: "Leases & subscriptions" },
  { key: "repairs_maintenance", label: "Repairs & maintenance" },
  { key: "miscellaneous", label: "Miscellaneous" },
  { key: "other", label: "Other (free text)", requiresNote: true },
] as const;

export function findPurposeOption(key: string | null | undefined): ReceiptPurposeOption | undefined {
  if (!key) {
    return undefined;
  }
  return PURPOSE_OPTIONS.find((option) => option.key === key);
}

export type PurposeNoteBucket = "0" | "1-20" | "21-60";

export function getPurposeNoteBucket(note: string | null | undefined): PurposeNoteBucket {
  const length = note?.trim().length ?? 0;
  if (length === 0) {
    return "0";
  }
  if (length <= 20) {
    return "1-20";
  }
  return "21-60";
}
