export function normaliseStoragePath(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  if (value.startsWith("gs://")) {
    const withoutScheme = value.slice(5);
    const slash = withoutScheme.indexOf("/");
    if (slash === -1) {
      return "";
    }
    value = withoutScheme.slice(slash + 1);
  }
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}