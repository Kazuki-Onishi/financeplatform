import { sha256Of } from "../src/lib/imageUtil";
import { genReceiptPath, chooseExt, sanitize } from "../src/lib/fileNamer";

async function main(): Promise<void> {
  const blob = new Blob(["smoke-test"], { type: "text/plain" });
  const hash = await sha256Of(blob);
  const pathInfo = genReceiptPath("demo-store", new Date("2025-01-01T00:00:00Z"));
  const ext = chooseExt("image/jpeg", "Receipt.JPG");
  const safe = sanitize("Demo Store 01");

  console.log(`sha256=${hash.slice(0, 16)} base=${pathInfo.base} ext=${ext} safe=${safe}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
