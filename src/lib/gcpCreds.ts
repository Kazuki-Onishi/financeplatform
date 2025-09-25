import fs from "fs";
import os from "os";
import path from "path";

export function ensureGcpCredsFile(): void {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return;
  }

  const encoded = process.env.GOOGLE_CREDENTIALS_B64;
  if (!encoded) {
    return;
  }

  const targetPath = path.join(os.tmpdir(), "gcp-key.json");
  const json = Buffer.from(encoded, "base64").toString("utf8");
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, json, "utf8");
  }
  process.env.GOOGLE_APPLICATION_CREDENTIALS = targetPath;
}
