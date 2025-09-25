/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const [, , uid] = process.argv;
if (!uid) {
  console.error('Usage: node scripts/update-custom-claims.js <uid>');
  process.exit(1);
}

const keyPath = path.resolve('c:/Users/onish/Downloads/finance-platform-362a5-c7cfbacbfa0a.json');
if (!fs.existsSync(keyPath)) {
  console.error(`Service account key not found at ${keyPath}`);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
}

async function main() {
  try {
    const firestore = admin.firestore();
    const snap = await firestore.collection('userPermissions').doc(uid).get();
    if (!snap.exists) {
      console.error(`userPermissions/${uid} not found`);
      process.exit(1);
    }

    const data = snap.data() || {};
    const storeIds = Array.isArray(data.storeIds) ? data.storeIds : [];
    const flags = Array.isArray(data.flags) ? data.flags : [];

    await admin.auth().setCustomUserClaims(uid, {
      storeIds,
      flags,
    });

    console.log('Custom claims updated for', uid, { storeIds, flags });
    process.exit(0);
  } catch (error) {
    console.error('Failed to update custom claims:', error);
    process.exit(1);
  }
}

main();
