"use client";

interface DeepgramKeysFieldProps {
  /** Newline-joined keys — the same string stored under DEEPGRAM_KEY_STORAGE_KEY. */
  value: string;
  onChange: (value: string) => void;
}

/**
 * One masked input per Deepgram key, with an "Add key" button. Backed by the
 * single newline-joined string that deepgramLive.ts's `parseDeepgramKeys`
 * reads, so blank rows are harmless and old single-key values still load.
 */
export default function DeepgramKeysField({ value, onChange }: DeepgramKeysFieldProps) {
  const rows = value.split("\n");

  function update(index: number, next: string) {
    // A pasted list (multiple lines) expands into one row per key.
    const pasted = next.split(/[\s,;]+/).filter(Boolean);
    const copy = [...rows];
    copy.splice(index, 1, ...(pasted.length > 1 ? pasted : [next.trim()]));
    onChange(copy.join("\n"));
  }

  function remove(index: number) {
    const copy = rows.filter((_, i) => i !== index);
    onChange(copy.join("\n"));
  }

  return (
    <div className="mt-2 space-y-1.5">
      {rows.map((row, index) => (
        <div key={index} className="flex gap-1.5">
          <input
            type="password"
            value={row}
            onChange={(event) => update(index, event.target.value)}
            placeholder={`Deepgram API key ${index + 1}`}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
          />
          {rows.length > 1 && (
            <button
              type="button"
              onClick={() => remove(index)}
              aria-label={`Remove key ${index + 1}`}
              className="rounded-md border border-zinc-300 px-2.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange(`${value}\n`)}
        className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        + Add key
      </button>
      {rows.length > 1 && (
        <p className="text-xs text-zinc-500">
          Keys are tried in order — if one fails or runs out of credit, the next is used
          automatically.
        </p>
      )}
    </div>
  );
}
