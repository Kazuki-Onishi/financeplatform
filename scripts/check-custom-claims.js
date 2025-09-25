import admin from "firebase-admin";
import fs from "fs";

const [, , uid] = process.argv;
if (!uid) {
  console.error("Usage: node scripts/check-custom-claims.js <uid>");
  process.exit(1);
}

const keyPath = "c:/Users/onish/Downloads/finance-platform-362a5-c7cfbacbfa0a.json";
if (!fs.existsSync(keyPath)) {
  console.error(`Service account key not found at ${keyPath}`);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf-8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
});

admin
  .auth()
  .getUser(uid)
  .then((user) => {
    console.log("Custom claims:", user.customClaims || {});
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed to fetch user:", error);
    process.exit(1);
  });
