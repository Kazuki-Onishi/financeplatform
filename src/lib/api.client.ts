import { auth } from "@/lib/firebase/client";
import { fetchWithApiCache, invalidateApiCache, peekApiCacheValue } from "./apiCache";

export type OcrMode = "document" | "text" | "label";

interface OcrResponseBody {
  text: string;
  raw: unknown;
  ocr?: unknown;
  vendorMatch?: unknown;
  confidence?: number;
  updatedAt?: string | null;
}

interface SummarizeResponseBody {
  summary: {
    date: string | null;
    vendor: string | null;
    amount: number | null;
    tax: number | null;
    currency: string | null;
    memo: string | null;
  };
  language?: string;
  keywords?: string[];
  usage?: Record<string, unknown> | null;
  modelVersion?: string | null;
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const message = await response.text();
  throw new Error(message || `Request failed (${response.status})`);
}


const ADMIN_MEMBERS_CACHE_KEY = "adminMembers";
const STORE_INVITES_CACHE_PREFIX = "storeInvites:";

function storeInvitesCacheKey(storeId: string): string {
  return `${STORE_INVITES_CACHE_PREFIX}${storeId}`;
}

export function peekCachedAdminMembers(): AdminMembersResponse | undefined {
  return peekApiCacheValue<AdminMembersResponse>(ADMIN_MEMBERS_CACHE_KEY);
}

export function invalidateAdminMembersCache(): void {
  invalidateApiCache(ADMIN_MEMBERS_CACHE_KEY);
}

export function peekCachedStoreInvites(storeId: string): StoreInviteRecord[] | undefined {
  return peekApiCacheValue<StoreInviteRecord[]>(storeInvitesCacheKey(storeId));
}

export function invalidateStoreInvitesCache(storeId: string): void {
  invalidateApiCache(storeInvitesCacheKey(storeId));
}
export async function callOCR(
  gcsUri: string,
  mode: OcrMode = "document",
  receiptId?: string,
): Promise<OcrResponseBody> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("signin required");
  }
  const idToken = await user.getIdToken();
  const response = await fetch("/api/ocr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ gsUri: gcsUri, mode, receiptId }),
  });
  await assertOk(response);
  return (await response.json()) as OcrResponseBody;
}

export async function callSummarize(text: string): Promise<SummarizeResponseBody> {
  const response = await fetch("/api/ai/summarize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  await assertOk(response);
  return (await response.json()) as SummarizeResponseBody;
}

export interface AdminMemberRole {
  storeId: string;
  role: string;
  flags: string[];
  status: string;
  joinedAt: string | null;
  invitedBy: string | null;
  resigned: boolean;
}

export interface AdminMemberRecord {
  userId: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  roles: AdminMemberRole[];
}

export interface AdminMembersResponse {
  stores: Array<{ id: string; name: string; currency: string; timezone: string }>;
  members: AdminMemberRecord[];
}

export async function fetchAdminMembers(
  options?: { force?: boolean; ttlMs?: number },
): Promise<AdminMembersResponse> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("signin required");
  }
  return fetchWithApiCache(
    ADMIN_MEMBERS_CACHE_KEY,
    async () => {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/admin/members", {
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });
      await assertOk(response);
      return (await response.json()) as AdminMembersResponse;
    },
    options,
  );
}

export async function updateStoreMember(
  storeId: string,
  memberId: string,
  payload: Partial<{ role: string; flags: string[]; status: string; resigned: boolean }>,
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("signin required");
  }
  const idToken = await user.getIdToken();
  const response = await fetch(
    `/api/stores/${encodeURIComponent(storeId)}/members/${encodeURIComponent(memberId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(payload),
    },
  );
  await assertOk(response);
  invalidateAdminMembersCache();
}

export interface StoreInviteRecord {
  id: string;
  code: string;
  role: string;
  flags: string[];
  status: string;
  maxUses: number;
  used: number;
  note: string | null;
  link: string;
  createdAt?: string | null;
  expiresAt?: string | null;
  targetUserId?: string | null;
  targetEmail?: string | null;
  targetDisplayName?: string | null;
}

export interface CreateInvitePayload {
  role: string;
  flags: string[];
  maxUses: number;
  expiresAt?: string | null;
  note?: string | null;
  targetUserId?: string | null;
}

export async function fetchStoreInvites(
  storeId: string,
  options?: { force?: boolean; ttlMs?: number },
): Promise<StoreInviteRecord[]> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("signin required");
  }
  const cacheKey = storeInvitesCacheKey(storeId);
  return fetchWithApiCache(
    cacheKey,
    async () => {
      const idToken = await user.getIdToken();
      const response = await fetch(`/api/stores/${encodeURIComponent(storeId)}/invites`, {
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });
      await assertOk(response);
      const data = await response.json();
      return Array.isArray(data?.invites) ? (data.invites as StoreInviteRecord[]) : [];
    },
    options,
  );
}

export async function createStoreInvite(
  storeId: string,
  payload: CreateInvitePayload,
): Promise<StoreInviteRecord> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("signin required");
  }
  const idToken = await user.getIdToken();
  const response = await fetch(`/api/stores/${encodeURIComponent(storeId)}/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(payload),
  });
  await assertOk(response);
  const data = await response.json();
  invalidateStoreInvitesCache(storeId);
  return {
    id: data.id,
    code: data.code,
    role: data.role,
    flags: data.flags ?? [],
    status: data.status ?? "active",
    maxUses: data.maxUses ?? 1,
    used: data.used ?? 0,
    note: data.note ?? null,
    link: data.link ?? "",
    createdAt: data.createdAt ?? null,
    expiresAt: data.expiresAt ?? null,
    targetUserId: data.targetUserId ?? null,
    targetEmail: data.targetEmail ?? null,
    targetDisplayName: data.targetDisplayName ?? null,
  };
}

export async function revokeStoreInvite(storeId: string, inviteId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("signin required");
  }
  const idToken = await user.getIdToken();
  const response = await fetch(
    `/api/stores/${encodeURIComponent(storeId)}/invites/${encodeURIComponent(inviteId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  await assertOk(response);
  invalidateStoreInvitesCache(storeId);
}

export interface BulkAnalysisResult {
  success: string[];
  failed: Array<{ receiptId: string; error: string }>;
}

export async function runBulkAnalysis(receiptIds: string[]): Promise<BulkAnalysisResult> {
  if (!Array.isArray(receiptIds) || !receiptIds.length) {
    throw new Error("No receipts selected");
  }
  const user = auth.currentUser;
  if (!user) {
    throw new Error("signin required");
  }
  const idToken = await user.getIdToken();
  const response = await fetch("/api/receipts/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ receiptIds }),
  });
  await assertOk(response);
  return (await response.json()) as BulkAnalysisResult;
}







