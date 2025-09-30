async function hydrateEnv() {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const envPath = join(__dirname, ".env.local");
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  await hydrateEnv();

  const adminModule = await import("firebase-admin");
  const admin = adminModule.default ?? adminModule;

  let credential;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    const svc = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    if (typeof svc.private_key === "string") {
      svc.private_key = svc.private_key.replace(/\\n/g, "\n");
    }
    credential = admin.credential.cert(svc);
  } else {
    credential = admin.credential.applicationDefault();
  }

  admin.initializeApp({
    credential,
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  });

  try {
    const bucketName =
      process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    const bucket = admin.storage().bucket(bucketName);
    const [files] = await bucket.getFiles({ maxResults: 1 });
    console.log("Storage OK, sample:", files[0]?.name);
  } catch (error) {
    console.error("Storage error", error);
  }
}

main().catch((error) => {
  console.error("diagnose-storage script failed", error);
  process.exit(1);
});
