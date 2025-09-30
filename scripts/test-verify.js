async function main() {
  const { resolve } = await import("node:path");
  const dotenvModule = await import("dotenv");
  const adminModule = await import("firebase-admin");

  const dotenv = dotenvModule.default ?? dotenvModule;
  const admin = adminModule.default ?? adminModule;

  dotenv.config({ path: resolve(__dirname, "..", ".env.local") });

  function ensureAdmin() {
    if (admin.apps.length) {
      return admin.app();
    }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
      return admin.initializeApp({ credential: admin.credential.cert(creds) });
    }
    if (process.env.GOOGLE_CREDENTIALS_B64) {
      const json = Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, "base64").toString("utf8");
      const creds = JSON.parse(json);
      return admin.initializeApp({ credential: admin.credential.cert(creds) });
    }
    throw new Error("No admin credentials in env");
  }

  const token = process.argv[2];
  if (!token) {
    console.error("Usage: node scripts/test-verify.js <Firebase ID token>");
    process.exit(1);
  }

  ensureAdmin();

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    console.log("verifyIdToken OK:", {
      sub: decoded.sub,
      aud: decoded.aud,
      iss: decoded.iss,
      exp: new Date(decoded.exp * 1000),
    });
  } catch (error) {
    console.error("verifyIdToken failed:", error);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
