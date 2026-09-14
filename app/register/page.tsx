"use client";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const r = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(j.error ?? "Could not register");
      setLoading(false);
      return;
    }
    await signIn("credentials", { email, password, redirect: false });
    router.push("/dashboard");
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-md bg-neutral-900/70 backdrop-blur border border-neutral-800 rounded-2xl p-8 shadow-2xl">
        <h1 className="text-3xl font-bold mb-1">Create account</h1>
        <p className="text-neutral-400 mb-6">Free. Your data syncs to your account.</p>
        <form onSubmit={submit} className="space-y-4">
          <input
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
          />
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="Password (min 6 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
          />
          {err && <p className="text-rose-400 text-sm">{err}</p>}
          <button
            disabled={loading}
            className="w-full py-3 rounded-xl bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 font-semibold shadow-lg shadow-red-950/50 transition disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create account"}
          </button>
        </form>
        <p className="text-sm text-neutral-400 mt-6 text-center">
          Already have one?{" "}
          <Link href="/login" className="text-red-400 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
