"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { auth } from "@/lib/firebase/client";

interface MemberItem {
  id: string;
  role: string;
  flags: string[];
  status: string;
  joinedAt: string | null;
  invitedBy: string | null;
}

export default function StoreMembersPage() {
  const params = useParams<{ storeId: string }>();
  const router = useRouter();
  const storeId = Array.isArray(params?.storeId) ? params?.storeId[0] : params?.storeId ?? "";

  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      if (!storeId) {
        setError("店舗IDが不正です");
        setLoading(false);
        return;
      }
      const user = auth.currentUser;
      if (!user) {
        setError("先にサインインしてください");
        setLoading(false);
        return;
      }
      try {
        const idToken = await user.getIdToken();
        const response = await fetch(`/api/stores/${storeId}/members`, {
          headers: {
            Authorization: `Bearer ${idToken}`,
          },
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setError(payload?.error ?? "メンバーの取得に失敗しました");
          setLoading(false);
          return;
        }
        setMembers(Array.isArray(payload.members) ? payload.members : []);
      } catch (err) {
        console.error(err);
        setError("ネットワークエラーが発生しました");
      } finally {
        setLoading(false);
      }
    };
    run().catch((err) => {
      console.error(err);
      setError("想定外のエラーが発生しました");
      setLoading(false);
    });
  }, [storeId]);

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">メンバー管理</h1>
        <p className="text-sm text-neutral-500">店舗 {storeId} のメンバーと権限を確認できます。</p>
        <button
          type="button"
          onClick={() => router.push(`/stores/${storeId}/invites`)}
          className="w-fit rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
        >
          招待を管理する
        </button>
      </header>

      {loading ? <p className="text-sm text-neutral-500">読み込み中...</p> : null}
      {error ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : null}

      {!loading && !error ? (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead className="bg-neutral-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">ユーザーID</th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">ロール</th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">権限</th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">状態</th>
                <th className="px-3 py-2 text-left font-medium text-neutral-600">参加日</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {members.map((member) => (
                <tr key={member.id} className="hover:bg-neutral-50/80">
                  <td className="px-3 py-2 font-mono text-xs text-neutral-700">{member.id}</td>
                  <td className="px-3 py-2 text-neutral-700">{member.role}</td>
                  <td className="px-3 py-2 text-neutral-500">{member.flags.join(", ") || "-"}</td>
                  <td className="px-3 py-2 text-neutral-500">{member.status}</td>
                  <td className="px-3 py-2 text-neutral-500">{member.joinedAt ?? "-"}</td>
                </tr>
              ))}
              {!members.length ? (
                <tr>
                  <td className="px-3 py-4 text-center text-neutral-400" colSpan={5}>
                    メンバーがまだ登録されていません。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}