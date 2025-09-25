
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  type Firestore,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";

type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

type ConfigResult = FirebaseConfig | null;

const REQUIRED_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

type EnvMap = Record<(typeof REQUIRED_ENV_KEYS)[number], string | undefined>;

let cachedConfig: ConfigResult = null;
let cachedFirestore: Firestore | null = null;

function readEnv(): EnvMap {
  return {
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
}

function logMissing(keys: string[]): void {
  if (!keys.length) {
    return;
  }

  const message =
    "[Firebase] Missing client configuration. Set the following environment variables in .env.local: " +
    keys.join(", ");

  console.error(message);
}

function resolveConfig(): ConfigResult {
  if (cachedConfig) {
    return cachedConfig;
  }

  const env = readEnv();
  const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key]);

  if (missing.length) {
    logMissing(missing);
    return null;
  }

  cachedConfig = {
    apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY!,
    authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
    projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
    storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
    messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
    appId: env.NEXT_PUBLIC_FIREBASE_APP_ID!,
  };

  return cachedConfig;
}

function initFirebaseApp(): FirebaseApp {
  const config = resolveConfig();
  if (!config) {
    throw new Error(
      "Firebase client SDK is not configured. Create .env.local with the NEXT_PUBLIC_FIREBASE_* keys and restart the dev server.",
    );
  }

  if (!getApps().length) {
    return initializeApp(config);
  }
  return getApp();
}

function initFirestore(app: FirebaseApp): Firestore {
  if (cachedFirestore) {
    return cachedFirestore;
  }

  try {
    cachedFirestore = initializeFirestore(app, { localCache: persistentLocalCache() });
  } catch (error) {
    console.warn("[Firebase] initializeFirestore failed, falling back to getFirestore", error);
    cachedFirestore = getFirestore(app);
  }

  return cachedFirestore;
}

export const firebaseApp = initFirebaseApp();
export const auth = getAuth(firebaseApp);
export const db = initFirestore(firebaseApp);
export const storage = getStorage(firebaseApp);

if (typeof window !== "undefined") {
  (window as unknown as { __firebaseAuth?: ReturnType<typeof getAuth> }).__firebaseAuth = auth;
}
