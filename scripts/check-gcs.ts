import { Storage } from "@google-cloud/storage";
import crypto from "node:crypto";

const GS_URI = process.argv[2]; // 引数で gs://... を渡す

function parseGsUri(uri: string) {
  if (!uri?.startsWith("gs://")) return null;
  const rest = uri.slice(5);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  return { bucket: rest.slice(0, slash), object: rest.slice(slash + 1) };
}
function normaliseBucket(b: string) {
  return b.endsWith(".firebasestorage.app")
    ? b.replace(/\.firebasestorage\.app$/, ".appspot.com")
    : b;
}

async function main() {
  if (!GS_URI) throw new Error("Usage: ts-node check-gcs.ts gs://<bucket>/<object>");
  const parsed = parseGsUri(GS_URI);
  if (!parsed) throw new Error("Invalid gsUri");
  const bucketName = normaliseBucket(parsed.bucket);

  const storage = new Storage(); // GOOGLE_APPLICATION_CREDENTIALS が指していること
  const file = storage.bucket(bucketName).file(parsed.object);

  const [exists] = await file.exists();
  if (!exists) throw new Error("File not found");

  const [meta] = await file.getMetadata();
  const [buf] = await file.download();

  const headHex = buf.slice(0, 32).toString("hex");
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

  console.log({
    ok: true,
    gsUri: `gs://${bucketName}/${parsed.object}`,
    sizeBytes: buf.length,
    contentType: meta.contentType ?? null,
    headHex,
    sha256,
  });
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
