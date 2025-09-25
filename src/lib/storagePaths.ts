import { genAssetPath, genReceiptPath, joinPath } from "./fileNamer";

export interface ReceiptStoragePaths {
  base: string;
  receiptId: string;
  originalPath: string;
  viewPath: string;
  thumbPath: string;
  metaPath: string;
}

export function buildReceiptStoragePaths(options: {
  storeId: string;
  now: Date;
  originalExt: string;
  receiptId?: string;
}): ReceiptStoragePaths {
  const { storeId, now, originalExt, receiptId } = options;
  const receiptPath = genReceiptPath(storeId, now, receiptId);
  const base = receiptPath.base;
  return {
    base,
    receiptId: receiptPath.id,
    originalPath: joinPath(base, `original${originalExt}`),
    viewPath: joinPath(base, "view.webp"),
    thumbPath: joinPath(base, "thumb.webp"),
    metaPath: joinPath(base, "meta.json"),
  };
}

export interface AssetStoragePaths {
  base: string;
  assetId: string;
  originalPath: string;
  viewPath: string;
  thumbPath: string;
  metaPath: string;
}

export function buildAssetStoragePaths(
  receiptBase: string,
  originalExt: string,
  assetId?: string,
): AssetStoragePaths {
  const assetPath = genAssetPath(receiptBase, assetId);
  const base = assetPath.base;
  return {
    base,
    assetId: assetPath.assetId,
    originalPath: joinPath(base, `original${originalExt}`),
    viewPath: joinPath(base, "view.webp"),
    thumbPath: joinPath(base, "thumb.webp"),
    metaPath: joinPath(base, "meta.json"),
  };
}
