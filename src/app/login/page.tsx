"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  updateProfile,
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

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dispatch = useAppDispatch();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [fullName, setFullName] = useState("");
  const [isLineInAppBrowser, setIsLineInAppBrowser] = useState(false);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);

  const nextParam = searchParams.get("next");
  const nextUrl = useMemo(() => {
    if (!nextParam) {
      return "/splash";
    }
    return nextParam.startsWith("/") ? nextParam : "/splash";
  }, [nextParam]);

  const trimmedEmail = email.trim();
  const trimmedName = fullName.trim();
  const isNameValid = Boolean(trimmedName);
  const isPasswordValid = password.length >= MIN_PASSWORD_LENGTH;
  const isSignedIn = Boolean(user);
  const ensuredUserRef = useRef<string | null>(null);
  const nameRef = useRef<string>("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    nameRef.current = fullName;
  });

  useEffect(() => {
    if (!user?.displayName) {
      return;
    }
    setFullName((prev) => (prev ? prev : user.displayName ?? ""));
  }, [user?.displayName]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const userAgent = window.navigator.userAgent || "";
    if (/Line\//i.test(userAgent)) {
      setIsLineInAppBrowser(true);
    }
    setCurrentUrl(window.location.href);
  }, []);

  const ensureUserProfile = useCallback(
    async (currentUser: User | null, preferredName?: string | null): Promise<string | null> => {
      if (!currentUser) {
        return preferredName?.trim() || null;
      }
      const desiredName = preferredName?.trim() || currentUser.displayName?.trim() || "";
      const finalName = desiredName || null;

      if (finalName && currentUser.displayName !== finalName) {
        try {
          await updateProfile(currentUser, { displayName: finalName });
        } catch (error) {
          console.warn("[login] failed to update auth profile name", error);
        }
      }

      return finalName;
    },
    [],
  );

  useEffect(() => {
    if (!user) {
      ensuredUserRef.current = null;
      return;
    }
    if (ensuredUserRef.current === user.uid) {
      return;
    }
    ensuredUserRef.current = user.uid;
    ensureUserProfile(user, user.displayName ?? null).catch((error) => {
      console.error('[login] ensure user profile failed', error);
    });
  }, [ensureUserProfile, user]);

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
    if (isLineInAppBrowser) {
      setStatus({
        kind: "error",
        text: "Google sign-in is disabled inside the LINE in-app browser. Please open this page in your device's browser.",
      });
      return;
    }
    runWithBusy(async () => {
      setStatus(null);
      try {
        const credential = await signInWithPopup(auth, new GoogleAuthProvider());
        if (credential.user) {
          ensuredUserRef.current = credential.user.uid;
        }
        const ensuredName = await ensureUserProfile(credential.user, credential.user?.displayName ?? null);
        if (ensuredName) {
          setFullName(ensuredName);
        } else if (credential.user?.displayName) {
          setFullName(credential.user.displayName);
        }
        setStatus({ kind: "success", text: "Signed in with Google" });
        router.replace(nextUrl);
      } catch (error) {
        console.error("Google sign-in failed", error);
        setStatus({ kind: "error", text: "Google sign-in failed" });
      }
    });
  }, [ensureUserProfile, isLineInAppBrowser, nextUrl, router, runWithBusy]);

  const handleEmailSignIn = useCallback(() => {
    runWithBusy(async () => {
      setStatus(null);
      const nameForAuth = nameRef.current.trim();
      if (!nameForAuth) {
        setStatus({ kind: "error", text: "Please enter your name" });
        return;
      }
      if (!trimmedEmail) {
        setStatus({ kind: "error", text: "Please enter your email address" });
        return;
      }
      if (!isPasswordValid) {
        setStatus({ kind: "error", text: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        return;
      }

      try {
        const credential = await signInWithEmailAndPassword(auth, trimmedEmail, password);
        if (credential.user) {
          ensuredUserRef.current = credential.user.uid;
        }
        const ensuredName = await ensureUserProfile(credential.user, nameForAuth);
        if (ensuredName) {
          setFullName(ensuredName);
        } else {
          setFullName(nameForAuth);
        }
        setStatus({ kind: "success", text: "Signed in" });
        router.replace(nextUrl);
      } catch (error) {
        const firebaseError = error as FirebaseError;
        if (firebaseError?.code === "auth/user-not-found") {
          setStatus({ kind: "error", text: "Account not found. Please create a new one." });
          return;
        }
        console.error("Email sign-in failed", error);
        setStatus({ kind: "error", text: describeAuthError(error) });
      }
    });
  }, [ensureUserProfile, isPasswordValid, nextUrl, password, router, runWithBusy, trimmedEmail]);


  const handleEmailSignUp = useCallback(() => {
    runWithBusy(async () => {
      setStatus(null);
      const nameForAuth = nameRef.current.trim();
      if (!nameForAuth) {
        setStatus({ kind: "error", text: "Please enter your name" });
        return;
      }
      if (!trimmedEmail) {
        setStatus({ kind: "error", text: "Please enter your email address" });
        return;
      }
      if (!isPasswordValid) {
        setStatus({ kind: "error", text: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        return;
      }

      try {
        const credential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
        if (credential.user) {
          ensuredUserRef.current = credential.user.uid;
        }
        const ensuredName = await ensureUserProfile(credential.user, nameForAuth);
        if (ensuredName) {
          setFullName(ensuredName);
        } else {
          setFullName(nameForAuth);
        }
        setStatus({ kind: "success", text: "Account created and signed in" });
        router.replace(nextUrl);
      } catch (error) {
        console.error("Email sign-up failed", error);
        setStatus({ kind: "error", text: describeAuthError(error) });
      }
    });
  }, [ensureUserProfile, isPasswordValid, nextUrl, password, router, runWithBusy, trimmedEmail]);


  const handleSignOut = useCallback(() => {
    runWithBusy(async () => {
      setStatus(null);
      try {
        await signOut(auth);
        ensuredUserRef.current = null;
        setFullName("");
        dispatch(clearUser());
        setStatus({ kind: "success", text: "Signed out" });
      } catch (error) {
        console.error("Sign out failed", error);
        setStatus({ kind: "error", text: "Sign out failed" });
      }
    });
  }, [dispatch, runWithBusy]);


  const handleGoToDashboard = useCallback(() => {
    router.replace(nextUrl);
  }, [nextUrl, router]);

  return (
    <div className="mx-auto flex min-h-[80vh] w-full max-w-md flex-col justify-center gap-6 p-6">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold">Sign in to Finance Platform</h1>
        <p className="text-sm text-neutral-500">
          Access your receipts workspace by signing in with Google or your email and password.
        </p>
      </header>

      {isSignedIn ? (
        <section className="rounded border border-neutral-200 p-4">
          <p className="text-sm font-medium text-neutral-700">Signed in as</p>
          <p className="text-sm text-neutral-600">{displayName}</p>
          {user ? <p className="text-xs text-neutral-400">UID: {user.uid}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleGoToDashboard}
              disabled={busy}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              Go to dashboard
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={busy}
              className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 disabled:opacity-60"
            >
              Sign out
            </button>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-4 rounded border border-neutral-200 p-4">
        <h2 className="text-lg font-medium text-neutral-800">Sign in with Google</h2>
        {isLineInAppBrowser ? (
          <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <p className="font-medium">Google sign-in is not available inside the LINE in-app browser.</p>
            <p className="mt-1">
              Please open this page in your device&apos;s browser (menu -&gt; &quot;Open in external browser&quot;) or use the link
              below.
            </p>
            {currentUrl ? (
              <a
                className="mt-3 inline-block rounded border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-100"
                href={currentUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in external browser
              </a>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={busy || isLineInAppBrowser}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          Continue with Google
        </button>
        <div className="h-px bg-neutral-200" />
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-medium text-neutral-800">Sign in with email</h2>
          <label className="text-sm font-medium" htmlFor="name">
            Name
          </label>
          <input
            id="name"
            type="text"
            className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            placeholder="Your full name"
            autoComplete="name"
          />
          <label className="text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
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
            placeholder="Enter your password"
          />
          <p className="text-xs text-neutral-400">
            Password must be at least {MIN_PASSWORD_LENGTH} characters.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleEmailSignIn}
              disabled={busy || !trimmedEmail || !isPasswordValid || !isNameValid}
              className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
            >
              Sign in with email
            </button>
            <button
              type="button"
              onClick={handleEmailSignUp}
              disabled={busy || !trimmedEmail || !isPasswordValid || !isNameValid}
              className="rounded border border-green-600 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-60"
            >
              Create an account
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










