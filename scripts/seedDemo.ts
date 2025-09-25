import { randomUUID } from "node:crypto";
import { cert, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

interface SeedOptions {
  uid: string;
  storeId: string;
  storeName: string;
  receiptId: string;
  vendorId: string;
  vendorName: string;
  skipImage: boolean;
}

const OWNER_FLAGS = [
  "perm.upload",
  "perm.editFields",
  "perm.view",
  "perm.exportCsv",
  "perm.lock",
  "perm.unlock",
  "perm.manageCards",
  "perm.manageVendors",
] as const;

const SAMPLE_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/Pmkw3wAAAABJRU5ErkJggg==";

function parseArgs(): SeedOptions {
  const args = new Map<string, string>();
  for (const entry of process.argv.slice(2)) {
    const [key, value] = entry.split("=");
    if (key && value) {
      args.set(key.replace(/^--/, ""), value);
    }
  }

  const uid = args.get("uid") ?? process.env.DEMO_USER_UID;
  if (!uid) {
    throw new Error("Provide --uid=<firebase-uid> or set DEMO_USER_UID");
  }

  const storeId = args.get("store") ?? "store-demo";

  return {
    uid,
    storeId,
    storeName: args.get("storeName") ?? "デモ店舗",
    receiptId: args.get("receipt") ?? "demo-receipt",
    vendorId: args.get("vendor") ?? "lawson-demo",
    vendorName: args.get("vendorName") ?? "ローソン (Demo)",
    skipImage: args.has("skipImage"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs();

  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credentialsJson) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is required to seed demo data");
  }

  const serviceAccount = JSON.parse(credentialsJson);

  const bucketName =
    process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!bucketName) {
    throw new Error("FIREBASE_STORAGE_BUCKET or NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET must be set");
  }

  initializeApp({
    credential: cert(serviceAccount),
    storageBucket: bucketName,
  });

  const db = getFirestore();
  const storage = getStorage().bucket();

  const { uid, storeId, storeName, receiptId, vendorId, vendorName, skipImage } = options;

  const now = FieldValue.serverTimestamp();

  const storeRef = db.collection("stores").doc(storeId);
  const storeSnap = await storeRef.get();
  if (!storeSnap.exists) {
    await storeRef.set(
      {
        name: storeName,
        currency: "JPY",
        timezone: "Asia/Tokyo",
        createdAt: now,
        createdBy: uid,
        updatedAt: now,
        inviteEnabled: true,
      },
      { merge: true },
    );
  }

  await storeRef
    .collection("members")
    .doc(uid)
    .set(
      {
        role: "owner",
        flags: OWNER_FLAGS,
        joinedAt: now,
        invitedBy: uid,
        status: "active",
      },
      { merge: true },
    );

  await db
    .collection("userPermissions")
    .doc(uid)
    .set(
      {
        storeIds: FieldValue.arrayUnion(storeId),
        activeStoreId: storeId,
        flags: FieldValue.arrayUnion(...OWNER_FLAGS),
      },
      { merge: true },
    );

  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) {
    await vendorRef.set({
      displayName: vendorName,
      normalized: vendorName.replace(/\s+/g, "").toLowerCase(),
      createdAt: now,
      updatedAt: now,
    });
  }

  const objectPath = `receipts/${storeId}/${receiptId}.png`;
  if (!skipImage) {
    const file = storage.file(objectPath);
    const [exists] = await file.exists();
    if (!exists) {
      const buffer = Buffer.from(SAMPLE_IMAGE_BASE64, "base64");
      await file.save(buffer, {
        contentType: "image/png",
        metadata: {
          metadata: {
            demo: "true",
            source: "seedDemo",
          },
        },
      });
    }
  }

  const receiptRef = db.collection("receipts").doc(receiptId);

  await receiptRef.set(
    {
      storeId,
      uploaderId: uid,
      uploaderName: "Demo User",
      companyName: null,
      createdBy: {
        uid,
        email: null,
      },
      createdAt: now,
      updatedAt: now,
      status: "draft",
      lockedBy: null,
      lockedAt: null,
      sourceType: "receipt",
      filePath: objectPath,
      viewPath: null,
      thumbPath: null,
      file: {
        bucket: bucketName,
        path: objectPath,
        gcsUri: `gs://${bucketName}/${objectPath}`,
      },
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
      purpose: null,
      memo: null,
      paymentMethod: { type: "cash" },
      ocr: {
        date: null,
        vendorId: null,
        vendorName: null,
        vendor: null,
        rawText: "レシートサンプル\nローソン\nコーヒー 200円",
        amount: 200,
        currency: "JPY",
        tax: 20,
        memo: "Demo seed",
        source: "seed",
        confidenceGemini: null,
        confidenceFinal: 0.2,
        confidence: 0.2,
      },
      summary: {
        date: null,
        vendor: "ローソン",
        amount: 200,
        tax: 20,
        currency: "JPY",
        memo: "種データ",
        source: "seed",
        edited: false,
        language: "ja",
        keywords: ["デモ", "ローソン"],
        usage: null,
        modelVersion: null,
      },
      meta: {
        sha256: randomUUID().replace(/-/g, ""),
        phash: null,
        width: 0,
        height: 0,
        exifShotAt: null,
        originalTranscoded: false,
        manualEdits: false,
      },
      fraudFlags: [],
      assetsCount: 0,
      lastAssetAt: null,
    },
    { merge: true },
  );

  console.log("Demo data seeded:");
  console.log(`- stores/${storeId}`);
  console.log(`- stores/${storeId}/members/${uid}`);
  console.log(`- userPermissions/${uid}`);
  console.log(`- vendors/${vendorId}`);
  console.log(`- receipts/${receiptId}`);
  if (!skipImage) {
    console.log(`- storage gs://${bucketName}/${objectPath}`);
  }
}

main().catch((error) => {
  console.error("Failed to seed demo data", error);
  process.exitCode = 1;
});