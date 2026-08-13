"use client";

import dynamic from "next/dynamic";

const AppClient = dynamic(() => import("./AppClient"), {
  ssr: false,
  loading: () => (
    <main className="mx-auto flex w-full max-w-5xl flex-1 items-center justify-center px-4 py-8">
      <p className="text-sm text-zinc-500">Loading…</p>
    </main>
  ),
});

export default function AppClientLoader() {
  return <AppClient />;
}
