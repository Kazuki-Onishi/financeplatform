const FULL_WIDTH_OFFSET = 0xFEE0;
const SYMBOL_MAP: Record<string, string> = {
  "\u2212": "-",
  "\uFF0D": "-",
  "\u2015": "-",
  "\uFFE5": "\u00A5",
};

export function toHalfWidth(value: string): string {
  if (!value) {
    return "";
  }
  let result = value.replace(/[\uFF01-\uFF5E]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - FULL_WIDTH_OFFSET),
  );
  result = result.replace(/\u3000/g, " ");
  result = result.replace(/[\u2212\uFF0D\u2015\uFFE5]/g, (char) => SYMBOL_MAP[char] ?? char);
  return result;
}