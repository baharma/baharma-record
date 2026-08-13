// Shared "what language is being spoken" concern for both live transcription
// (Web Speech API, useRecordingSession.ts) and auto-transcription (Whisper,
// lib/transcription/whisper.worker.ts). Both APIs need an explicit language
// rather than a guess: the Web Speech API's `recognition.lang` and
// transformers.js's `language` pipeline option both silently produce wrong
// output when given the wrong language (or none at all) — they don't error,
// they just transcribe as if the wrong language was spoken. Relying on
// `navigator.language` alone isn't enough either, since a user's browser/OS
// locale frequently doesn't match the language they actually speak.
export const SPEECH_LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "zh", name: "Chinese" },
  { code: "de", name: "German" },
  { code: "es", name: "Spanish" },
  { code: "ru", name: "Russian" },
  { code: "ko", name: "Korean" },
  { code: "fr", name: "French" },
  { code: "ja", name: "Japanese" },
  { code: "pt", name: "Portuguese" },
  { code: "tr", name: "Turkish" },
  { code: "pl", name: "Polish" },
  { code: "ca", name: "Catalan" },
  { code: "nl", name: "Dutch" },
  { code: "ar", name: "Arabic" },
  { code: "sv", name: "Swedish" },
  { code: "it", name: "Italian" },
  { code: "id", name: "Indonesian" },
  { code: "hi", name: "Hindi" },
  { code: "fi", name: "Finnish" },
  { code: "vi", name: "Vietnamese" },
  { code: "he", name: "Hebrew" },
  { code: "uk", name: "Ukrainian" },
  { code: "el", name: "Greek" },
  { code: "ms", name: "Malay" },
  { code: "cs", name: "Czech" },
  { code: "ro", name: "Romanian" },
  { code: "da", name: "Danish" },
  { code: "hu", name: "Hungarian" },
  { code: "ta", name: "Tamil" },
  { code: "no", name: "Norwegian" },
  { code: "th", name: "Thai" },
  { code: "ur", name: "Urdu" },
  { code: "hr", name: "Croatian" },
  { code: "bg", name: "Bulgarian" },
  { code: "bn", name: "Bengali" },
  { code: "sr", name: "Serbian" },
  { code: "fa", name: "Persian" },
  { code: "sw", name: "Swahili" },
  { code: "tl", name: "Tagalog" },
];

/**
 * Best-guess default language code based on the browser's locale, falling
 * back to English. Always a concrete language, never "auto" — the user can
 * (and, for non-English audio, should) override it.
 */
export function defaultSpeechLanguageCode(): string {
  if (typeof navigator === "undefined") return "en";
  const primary = navigator.language?.split("-")[0]?.toLowerCase();
  return SPEECH_LANGUAGES.some((lang) => lang.code === primary) ? primary : "en";
}

// The Web Speech API's `lang` wants a full BCP-47 locale tag (e.g. "id-ID"),
// not just the 2-letter code. One reasonable default region per language.
const RECOGNITION_LOCALES: Record<string, string> = {
  en: "en-US",
  zh: "zh-CN",
  de: "de-DE",
  es: "es-ES",
  ru: "ru-RU",
  ko: "ko-KR",
  fr: "fr-FR",
  ja: "ja-JP",
  pt: "pt-BR",
  tr: "tr-TR",
  pl: "pl-PL",
  ca: "ca-ES",
  nl: "nl-NL",
  ar: "ar-SA",
  sv: "sv-SE",
  it: "it-IT",
  id: "id-ID",
  hi: "hi-IN",
  fi: "fi-FI",
  vi: "vi-VN",
  he: "he-IL",
  uk: "uk-UA",
  el: "el-GR",
  ms: "ms-MY",
  cs: "cs-CZ",
  ro: "ro-RO",
  da: "da-DK",
  hu: "hu-HU",
  ta: "ta-IN",
  no: "nb-NO",
  th: "th-TH",
  ur: "ur-PK",
  hr: "hr-HR",
  bg: "bg-BG",
  bn: "bn-BD",
  sr: "sr-RS",
  fa: "fa-IR",
  sw: "sw-KE",
  tl: "fil-PH",
};

/** BCP-47 locale tag for the Web Speech API's `lang`, e.g. "id" -> "id-ID". */
export function speechRecognitionLocale(code: string): string {
  return RECOGNITION_LOCALES[code] ?? "en-US";
}
