import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { RecordingEntry } from "./types";

const DB_NAME = "baharma-record-db";
const DB_VERSION = 1;
const STORE_NAME = "recordings";

interface RecordingsDBSchema extends DBSchema {
  recordings: {
    key: string;
    value: RecordingEntry;
    indexes: { "by-created-at": number };
  };
}

let dbPromise: Promise<IDBPDatabase<RecordingsDBSchema>> | null = null;

function getDB(): Promise<IDBPDatabase<RecordingsDBSchema>> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment.");
  }
  if (!dbPromise) {
    dbPromise = openDB<RecordingsDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("by-created-at", "createdAt");
      },
    });
  }
  return dbPromise;
}

export async function addRecording(entry: RecordingEntry): Promise<void> {
  const db = await getDB();
  await db.put(STORE_NAME, entry);
}

export async function updateRecording(
  id: string,
  patch: Partial<RecordingEntry>,
): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORE_NAME, id);
  if (!existing) {
    throw new Error(`Recording ${id} was not found.`);
  }
  await db.put(STORE_NAME, { ...existing, ...patch });
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
}

export async function getRecording(
  id: string,
): Promise<RecordingEntry | undefined> {
  const db = await getDB();
  return db.get(STORE_NAME, id);
}

export async function getAllRecordings(): Promise<RecordingEntry[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORE_NAME, "by-created-at");
  return all.reverse();
}
