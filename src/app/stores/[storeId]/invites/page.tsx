"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { auth } from "@/lib/firebase/client";

interface InviteItem {
  id: string;
  token: string;
  code: string;
  role: string;
  flags: string[];
  status: string;
  maxUses: number;
  used: number;
  note: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  link: string;
}

const ROLE_OPTIONS = [
  { value: "owner", label: "オーナー" },
  { value: "manager", label: "マネージャー" },
  { value: "staff", label: "スタッフ" },
  { value: "viewer", label: "閲覧のみ" },
];

export default function StoreInvitesPage() {
  const params = useParams<{ storeId: string }>();
  const storeId = Array.isArray(params?.storeId) ? params?.storeId[0] : params?.storeId ?? "";

  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState("staff");
  const [maxUses, setMaxUses] = useState(1);
  const [expiresAt, setExpiresAt] = useState<string | "">("");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);

  const loadInvites = useMemo(
    () =>
      async () => {
        const user = auth.currentUser;
        if (!user) {
          setError("先にサインインしてください");
          setLoading(false);
          return;
        }
        try {
          const idToken = await user.getIdToken();
          const response = await fetch(`/api/stores/${storeId}/invites`, {
            headers: {
              Authorization: `Bearer ${idToken}`,
            },
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            setError(payload?.error ?? "招待の取得に失敗しました");
            setLoading(false);
            return;
          }
          setInvites(Array.isArray(payload.invites) ? payload.invites : []);
          setError(null);
        } catch (err) {
          console.error(err);
          setError("ネットワークエラーが発生しました");
        } finally {
          setLoading(false);
        }
      },
    [storeId],
  );

  useEffect(() => {
    if (!storeId) {
      setError("店舗IDが不正です");
      setLoading(false);
      return;
    }
    loadInvites().catch((err) => {
      console.error(err);
      setError("想定外のエラーが発生しました");
      setLoading(false);
    });
  }, [storeId, loadInvites]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const user = auth.currentUser;
    if (!user) {
      setError("先にサインインしてください");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch(`/api/stores/${storeId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          role,
          maxUses,
          expiresAt: expiresAt || null,
          note: note || null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? "招待の作成に失敗しました");
        return;
      }
      setNote("");
      setExpiresAt("");
      await loadInvites();
    } catch (err) {
      console.error(err);
      setError("ネットワークエラーが発生しました");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (inviteId: string) => {
    const user = auth.currentUser;
    if (!user) {
      setError("先にサインインしてください");
      return;
    }
    try {
      const idToken = await user.getIdToken();
      const response = await fetch(`/api/stores/${storeId}/invites/${inviteId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error ?? "招待の失効に失敗しました");
        return;
      }
      await loadInvites();
    } catch (err) {
      console.error(err);
      setError("ネットワークエラーが発生しました");
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">招待管理</h1>
        <p className="text-sm text-neutral-500">店舗 {storeId} の招待リンク・コードを発行します。</p>
      </header>

      <form className="flex flex-col gap-3 rounded border border-neutral-200 p-4" onSubmit={handleCreate}>
        <h2 className="text-lg font-medium">新しい招待を発行</h2>
        <label className="flex flex-col gap-1 text-sm" htmlFor="invite-role">
          <span className="font-medium">ロール</span>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
            disabled={creating}
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm" htmlFor="invite-max">
          <span className="font-medium">使用回数</span>
          <input
            id="invite-max"
            type="number"
            min={0}
            value={maxUses}
            onChange={(event) => setMaxUses(Number.parseInt(event.target.value || "1", 10))}
            className="w-32 rounded border border-neutral-300 px-3 py-2"
            disabled={creating}
          />
          <span className="text-xs text-neutral-400">0 で無制限</span>
        </label>

        <label className="flex flex-col gap-1 text-sm" htmlFor="invite-expires">
          <span className="font-medium">有効期限</span>
          <input
            id="invite-expires"
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
            disabled={creating}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm" htmlFor="invite-note">
          <span className="font-medium">メモ (任意)</span>
          <input
            id="invite-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
            disabled={creating}
          />
        </label>

        <button
          type="submit"
          disabled={creating}
          className="w-fit rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creating ? "発行中..." : "招待を発行"}
        </button>
      </form>

      {error ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : null}

      <section className="rounded border border-neutral-200 p-4">
        <h2 className="text-lg font-medium">発行済みの招待</h2>
        {loading ? <p className="text-sm text-neutral-500">読み込み中...</p> : null}
        {!loading && !invites.length ? (
          <p className="text-sm text-neutral-500">まだ招待はありません。</p>
        ) : null}
        {!loading && invites.length ? (
          <div className="mt-4 space-y-3">
            {invites.map((invite) => (
              <div key={invite.id} className="rounded border border-neutral-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-neutral-700">{invite.role}</p>
                    <p className="text-xs text-neutral-500">コード: {invite.code || "-"}</p>
                    <p className="text-xs text-neutral-500">リンク: {invite.link}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRevoke(invite.id)}
                    disabled={invite.status === "revoked"}
                    className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {invite.status === "revoked" ? "失効済み" : "招待を失効"}
                  </button>
                </div>
                <div className="mt-2 text-xs text-neutral-500">
                  <span>状態: {invite.status}</span>
                  <span className="ml-4">使用: {invite.used}/{invite.maxUses || "∞"}</span>
                  {invite.expiresAt ? <span className="ml-4">期限: {invite.expiresAt}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}