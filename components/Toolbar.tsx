"use client";

import { useRef } from "react";

interface Props {
  onNewSource: () => void;
  onExportAll: () => void;
  onImportFile: (file: File) => void;
  onOpenSettings: () => void;
  exportDisabled: boolean;
  busy: boolean;
}

export function Toolbar({
  onNewSource,
  onExportAll,
  onImportFile,
  onOpenSettings,
  exportDisabled,
  busy,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={onNewSource}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:opacity-90 dark:bg-zinc-100 dark:text-zinc-900"
      >
        + Record New Source
      </button>
      <button
        onClick={onExportAll}
        disabled={exportDisabled || busy}
        className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Export All
      </button>
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={busy}
        className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        {busy ? "Importing…" : "Import"}
      </button>
      <button
        onClick={onOpenSettings}
        className="ml-auto rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Settings
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onImportFile(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}
