export const CSV_BOM = "\ufeff"; // UTF-8 BOM for Excel compatibility

function escapeCsvValue(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function csvLine(values: Array<string | number | null | undefined>): string {
  return values
    .map((value) => {
      if (value === null || value === undefined) {
        return "";
      }
      if (typeof value === "number") {
        return escapeCsvValue(Number.isFinite(value) ? String(value) : "");
      }
      return escapeCsvValue(String(value));
    })
    .join(",");
}

export function encodeCsvLines(lines: string[]): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(CSV_BOM + lines.join("\n"));
}
