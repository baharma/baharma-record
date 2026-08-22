import type { TranscriptSegment } from "@/lib/types";

/** MIC/TAB tag for a "mixed" recording's segments — shared by the saved-transcript view (TranscriptPanel) and the live in-progress view (ActiveSessionCard) so both render it identically. */
export function TranscriptSourceBadge({ source }: { source: TranscriptSegment["source"] }) {
  if (!source) return null;
  const isMic = source === "mic";
  return (
    <span
      className={`mr-2 rounded px-1 py-0.5 text-[10px] font-semibold ${
        isMic
          ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
          : "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400"
      }`}
    >
      {isMic ? "MIC" : "TAB"}
    </span>
  );
}
