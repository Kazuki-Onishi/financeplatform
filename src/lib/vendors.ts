const NON_ALPHANUM = /[^a-z0-9]+/g;

export function normalizeVendorName(name: string): string {
  return name.toLowerCase().replace(NON_ALPHANUM, "").trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

export interface VendorCandidate<T> {
  record: T;
  distance: number;
}

export function findBestVendorMatch<T extends { normalized: string }>(
  vendors: T[],
  name: string,
  threshold = 2,
): VendorCandidate<T> | null {
  const normalized = normalizeVendorName(name);
  if (!normalized) {
    return null;
  }
  let best: VendorCandidate<T> | null = null;
  for (const vendor of vendors) {
    const distance = levenshtein(normalized, vendor.normalized);
    if (distance <= threshold && (!best || distance < best.distance)) {
      best = { record: vendor, distance };
    }
  }
  return best;
}
