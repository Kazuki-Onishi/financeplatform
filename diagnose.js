const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env.local');
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq);
  const value = trimmed.slice(eq + 1);
  process.env[key] = value;
}

const admin = require('firebase-admin');

let credential;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const svc = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  if (typeof svc.private_key === 'string') {
    svc.private_key = svc.private_key.replace(/\\n/g, '\n');
  }
  credential = admin.credential.cert(svc);
} else {
  credential = admin.credential.applicationDefault();
}

admin.initializeApp({
  credential,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
});

(async () => {
  try {
    const auth = admin.auth();
    await auth.listUsers(1);
    console.log('Auth OK');
  } catch (error) {
    console.error('Auth error', error);
  }
  try {
    const db = admin.firestore();
    const doc = await db.collection('diagnostics').limit(1).get();
    console.log('Firestore OK, docs:', doc.size);
  } catch (error) {
    console.error('Firestore error', error);
  }
  try {
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    const bucket = admin.storage().bucket(bucketName);
    const [files] = await bucket.getFiles({ maxResults: 1 });
    console.log('Storage OK, sample:', files[0]?.name);
  } catch (error) {
    console.error('Storage error', error);
  }
})();
