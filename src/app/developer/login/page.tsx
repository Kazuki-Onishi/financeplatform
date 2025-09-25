"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { FirebaseError } from "firebase/app";
import { auth } from "@/lib/firebase/client";
import { useAppDispatch } from "@/lib/state/store";
import { clearUser } from "@/lib/state/userSlice";

interface StatusMessage {
  kind: "info" | "success" | "error";
  text: string;
}

const MIN_PASSWORD_LENGTH = 6;

function describeAuthError(error: unknown): string {
  const defaultMessage = "Email sign-in failed";
  if (!error || typeof error !== "object" || !("code" in (error as Record<string, unknown>))) {
    return defaultMessage;
  }

  const code = (error as FirebaseError).code ?? "";
  switch (code) {
    case "auth/invalid-email":
      return "Invalid email address format";
    case "auth/missing-email":
      return "Email is required";
    case "auth/missing-password":
      return "Password is required";
    case "auth/weak-password":
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    case "auth/invalid-credential":
    case "auth/wrong-password":
      return "Incorrect email or password";
    case "auth/user-disabled":
      return "This account is disabled";
    case "auth/email-already-in-use":
      return "This email address is already registered";
    case "auth/user-not-found":
      return "Account not found. Please create a new one.";
    default:
      return (error as FirebaseError).message ?? defaultMessage;
  }
}

export default function DeveloperLoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dispatch = useAppDispatch();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [tokenPreview, setTokenPreview] = useState<string | null>(null);

  const nextParam = searchParams.get("next");
  const nextUrl = useMemo(() => {
    if (!nextParam) {
      return "/splash";
    }
    return nextParam.startsWith("/") ? nextParam : "/splash";
  }, [nextParam]);

  const trimmedEmail = email.trim();
  const isPasswordValid = password.length >= MIN_PASSWORD_LENGTH;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setTokenPreview(null);
    }
  }, [user]);

  const displayName = useMemo(() => {
    if (!user) {
      return "Not signed in";
    }
    return user.displayName ?? user.email ?? user.uid;
  }, [user]);

  const runWithBusy = useCallback(
    async (action: () => Promise<void>) => {
      if (busy) {
        return;
      }
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const handleGoogleSignIn = useCallback(() => {
    runWithBusy(async () => {
      setStatus(null);
      try {
        await signInWithPopup(auth, new GoogleAuthProvider());
        setStatus({ kind: "success", text: "Signed in with Google" });
      } catch (error) {
        console.error("Google sign-in failed", error);
        setStatus({ kind: "error", text: "Google sign-in failed" });
      }
    });
  }, [runWithBusy]);

  const handleEmailSignIn = useCallback(() => {
    runWithBusy(async () => {
      setStatus(null);
      if (!trimmedEmail) {
        setStatus({ kind: "error", text: "Please enter your email address" });
        return;
      }
      if (!isPasswordValid) {
        setStatus({ kind: "error", text: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        return;
      }

      try {
        await signInWithEmailAndPassword(auth, trimmedEmail, password);
        setStatus({ kind: "success", text: "Signed in" });
      } catch (error) {
        const firebaseError = error as FirebaseError;
        if (firebaseError?.code === "auth/user-not-found") {
          try {
            await createUserWithEmailAndPassword(auth, trimmedEmail, password);
            setStatus({ kind: "success", text: "Account created and signed in" });
            return;
          } catch (createError) {
            console.error("Email sign-up failed", createError);
            setStatus({ kind: "error", text: describeAuthError(createError) });
            return;
          }
        }
        console.error("Email sign-in failed", error);
        setStatus({ kind: "error", text: describeAuthError(error) });
      }
    });
  }, [isPasswordValid, password, runWithBusy, trimmedEmail]);

  const handleSignOut = useCallback(() => {
    runWithBusy(async () => {
      setStatus(null);
      try {
        await signOut(auth);
        dispatch(clearUser());
        setStatus({ kind: "success", text: "Signed out" });
      } catch (error) {
        console.error("Sign out failed", error);
        setStatus({ kind: "error", text: "Sign out failed" });
      }
    });
  }, [dispatch, runWithBusy]);

  const handleRevealToken = useCallback(() => {
    runWithBusy(async () => {
      setStatus(null);
      if (!user) {
        setStatus({ kind: "error", text: "Sign in first" });
        return;
      }
      try {
        const token = await user.getIdToken(true);
        setTokenPreview(token);
        setStatus({ kind: "info", text: "ID token shown below. Hide it when you're done." });
      } catch (error) {
        console.error("Failed to fetch ID token", error);
        setStatus({ kind: "error", text: "Failed to fetch ID token" });
      }
    });
  }, [runWithBusy, user]);

  const handleClearToken = useCallback(() => {
    setTokenPreview(null);
    setStatus({ kind: "info", text: "ID token hidden" });
  }, []);

  const handleCopyToken = useCallback(() => {
    runWithBusy(async () => {
      setStatus(null);
      if (!user) {
        setStatus({ kind: "error", text: "Sign in first" });
        return;
      }
      try {
        const token = await user.getIdToken(true);
        await navigator.clipboard.writeText(token);
        setTokenPreview((current) => (current === null ? null : token));
        setStatus({ kind: "success", text: "ID token copied to clipboard" });
      } catch (error) {
        console.error("Failed to copy ID token", error);
        setStatus({ kind: "error", text: "Failed to copy ID token" });
      }
    });
  }, [runWithBusy, user]);

  const handleOpenNext = useCallback(() => {
    router.replace(nextUrl);
  }, [nextUrl, router]);

  return (
    <div className="mx-auto flex min-h-[80vh] w-full max-w-md flex-col justify-center gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Developer Login Helper</h1>
        <p className="text-sm text-neutral-500">
          Sign in and copy an ID token for manual API testing. Use the buttons below to manage your session.
        </p>
      </header>

      <section className="rounded border border-neutral-200 p-4">
        <p className="text-sm font-medium">Current user</p>
        <p className="text-sm text-neutral-600">{displayName}</p>
        {user ? <p className="text-xs text-neutral-400">UID: {user.uid}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleOpenNext}
            disabled={busy}
            className="rounded border border-blue-500 px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-60"
          >
            Open {nextUrl}
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={busy || !user}
            className="rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-700 disabled:opacity-60"
          >
            Sign out
          </button>
          <button
            type="button"
            onClick={handleCopyToken}
            disabled={busy || !user}
            className="rounded bg-neutral-800 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-900 disabled:opacity-60"
          >
            Copy ID token
          </button>
          <button
            type="button"
            onClick={handleRevealToken}
            disabled={busy || !user}
            className="rounded border border-amber-500 px-3 py-1 text-sm text-amber-700 hover:bg-amber-50 disabled:opacity-60"
          >
            Show ID token
          </button>
        </div>
        {tokenPreview ? (
          <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-amber-800">Visible ID token</p>
              <button
                type="button"
                onClick={handleClearToken}
                className="text-xs font-medium text-amber-700 hover:underline"
              >
                Hide token
              </button>
            </div>
            <textarea
              aria-label="Firebase ID token"
              readOnly
              value={tokenPreview}
              rows={6}
              spellCheck={false}
              className="mt-2 w-full resize-none rounded border border-amber-300 bg-amber-100 font-mono text-xs text-amber-900 focus:outline-none"
            />
            <p className="mt-2 text-xs text-amber-700">Keep this token private. It expires automatically after a short time.</p>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-4 rounded border border-neutral-200 p-4">
        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          Sign in with Google
        </button>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label className="text-sm font-medium" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="text-xs text-neutral-400">Password must be at least {MIN_PASSWORD_LENGTH} characters.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleEmailSignIn}
              disabled={busy || !trimmedEmail || !isPasswordValid}
              className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
            >
              Sign in with email
            </button>
          </div>
        </div>
      </section>

      {status ? (
        <div
          className={`rounded border px-3 py-2 text-sm ${
            status.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : status.kind === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-neutral-200 bg-neutral-50 text-neutral-600"
          }`}
        >
          {status.text}
        </div>
      ) : null}
    </div>
  );
}







