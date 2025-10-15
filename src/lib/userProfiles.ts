import { adminAuth } from "./firebase/admin";

export interface UserProfile {
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
}

interface CachedProfile {
  profile: UserProfile;
  expiresAt: number;
}

const USER_BATCH_LIMIT = 100;
const PROFILE_TTL_MS = 5 * 60 * 1000;
const PROFILE_MISS_TTL_MS = 60 * 1000;

const cache = new Map<string, CachedProfile>();

function readCache(uid: string): UserProfile | null {
  const entry = cache.get(uid);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(uid);
    return null;
  }
  return entry.profile;
}

function writeCache(uid: string, profile: UserProfile, ttl: number): void {
  cache.set(uid, { profile, expiresAt: Date.now() + ttl });
}

function placeholderProfile(): UserProfile {
  return { displayName: null, email: null, photoURL: null };
}

export interface FetchProfilesOptions {
  missTtlMs?: number;
  ttlMs?: number;
  onBatchError?: (uids: string[], error: unknown) => void;
}

export async function fetchUserProfiles(uids: string[], options: FetchProfilesOptions = {}): Promise<Map<string, UserProfile>> {
  const ttlMs = options.ttlMs ?? PROFILE_TTL_MS;
  const missTtlMs = options.missTtlMs ?? PROFILE_MISS_TTL_MS;
  const result = new Map<string, UserProfile>();
  const toFetch: string[] = [];

  for (const uid of uids) {
    const cached = readCache(uid);
    if (cached) {
      result.set(uid, cached);
    } else {
      toFetch.push(uid);
    }
  }

  if (!toFetch.length) {
    return result;
  }

  for (let index = 0; index < toFetch.length; index += USER_BATCH_LIMIT) {
    const batch = toFetch.slice(index, index + USER_BATCH_LIMIT);
    try {
      const response = await adminAuth.getUsers(batch.map((uid) => ({ uid })));
      response.users.forEach((user) => {
        const profile: UserProfile = {
          displayName: user.displayName ?? null,
          email: user.email ?? null,
          photoURL: user.photoURL ?? null,
        };
        writeCache(user.uid, profile, ttlMs);
        result.set(user.uid, profile);
      });
      response.notFound.forEach((missing) => {
        if (!missing.uid) return;
        const empty = placeholderProfile();
        writeCache(missing.uid, empty, missTtlMs);
        result.set(missing.uid, empty);
      });
    } catch (error) {
      options.onBatchError?.(batch, error);
      batch.forEach((uid) => {
        const empty = placeholderProfile();
        writeCache(uid, empty, missTtlMs);
        if (!result.has(uid)) {
          result.set(uid, empty);
        }
      });
    }
  }

  return result;
}
