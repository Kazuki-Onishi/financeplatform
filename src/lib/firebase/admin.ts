import { getApps, initializeApp, applicationDefault, cert, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

let firebaseAdminApp = getApps()[0];
function parseServiceAccount(json: string): ServiceAccount {
  try {
    const parsed = JSON.parse(json) as ServiceAccount & { private_key?: string };
    if (typeof parsed.private_key === "string") {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch (error) {
    throw new Error("Invalid Firebase service account JSON", { cause: error });
  }
}


function resolveCredential() {
  const json =
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ??
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (json) {
    const serviceAccount = parseServiceAccount(json);
    return cert(serviceAccount);
  }

  return applicationDefault();
}

function ensureApp() {
  if (!firebaseAdminApp) {
    firebaseAdminApp = initializeApp({
      credential: resolveCredential(),
      storageBucket:
        process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    });
  }
  return firebaseAdminApp;
}

export const adminApp = ensureApp();
export const adminAuth = getAuth(adminApp);
export const adminDb = getFirestore(adminApp);
export const adminStorage = getStorage(adminApp);
