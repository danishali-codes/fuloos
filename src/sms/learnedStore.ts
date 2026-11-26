/* On-device persistence for learned SMS templates on web (IndexedDB with localStorage/memory fallback).
   Android uses SQLite (`learned_templates` in FuloosLocalDb.kt) via platformBridge.
   Learned templates NEVER sync to Supabase. */
import type { LearnedTemplate } from "./types.ts";

const DB_NAME = "fuloos-sms-learned-v1";
const DB_VERSION = 1;
const STORE_NAME = "templates";
const LS_PREFIX = "fuloos.sms.learnedTemplates.v1:";

interface StoredRecord {
  key: string;
  ownerKey: string;
  template: LearnedTemplate;
}

const memoryStore = new Map<string, LearnedTemplate>();

function recordKey(ownerKey: string, id: string): string {
  return `${ownerKey || "default"}::${id}`;
}

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("ownerKey", "ownerKey", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function readLocalFallback(ownerKey: string): LearnedTemplate[] {
  const normOwner = ownerKey || "default";
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const raw = window.localStorage.getItem(`${LS_PREFIX}${normOwner}`);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as LearnedTemplate[];
      }
    }
  } catch {
    /* fall through to memory */
  }
  const out: LearnedTemplate[] = [];
  const prefix = `${normOwner}::`;
  for (const [k, v] of memoryStore.entries()) {
    if (k.startsWith(prefix)) out.push(v);
  }
  return out;
}

function writeLocalFallback(ownerKey: string, list: LearnedTemplate[]): void {
  const normOwner = ownerKey || "default";
  const prefix = `${normOwner}::`;
  for (const k of [...memoryStore.keys()]) {
    if (k.startsWith(prefix)) memoryStore.delete(k);
  }
  for (const t of list) {
    memoryStore.set(recordKey(normOwner, t.id), t);
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(`${LS_PREFIX}${normOwner}`, JSON.stringify(list));
    }
  } catch {
    /* ignore storage quota errors */
  }
}

export async function listWebLearnedTemplates(
  ownerKey: string,
): Promise<LearnedTemplate[]> {
  const normOwner = ownerKey || "default";
  if (!hasIndexedDb()) {
    return readLocalFallback(normOwner);
  }
  try {
    const db = await openDb();
    return await new Promise<LearnedTemplate[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const idx = tx.objectStore(STORE_NAME).index("ownerKey");
      const req = idx.getAll(IDBKeyRange.only(normOwner));
      req.onsuccess = () => {
        const rows = (req.result as StoredRecord[]) ?? [];
        const templates = rows
          .map((r) => r.template)
          .filter((t) => t && t.template_version === 1)
          .sort((a, b) =>
            String(b.created_at || "").localeCompare(String(a.created_at || "")),
          );
        resolve(templates);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return readLocalFallback(normOwner);
  }
}

export async function saveWebLearnedTemplate(
  ownerKey: string,
  template: LearnedTemplate,
): Promise<void> {
  const normOwner = ownerKey || "default";
  if (!hasIndexedDb()) {
    const existing = readLocalFallback(normOwner).filter(
      (t) => t.id !== template.id && t.skeleton_hash !== template.skeleton_hash,
    );
    writeLocalFallback(normOwner, [template, ...existing]);
    return;
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const rec: StoredRecord = {
        key: recordKey(normOwner, template.id),
        ownerKey: normOwner,
        template,
      };
      store.put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    const existing = readLocalFallback(normOwner).filter((t) => t.id !== template.id);
    writeLocalFallback(normOwner, [template, ...existing]);
  }
}

export async function deleteWebLearnedTemplate(
  ownerKey: string,
  id: string,
): Promise<boolean> {
  const normOwner = ownerKey || "default";
  if (!hasIndexedDb()) {
    const prev = readLocalFallback(normOwner);
    const next = prev.filter((t) => t.id !== id);
    writeLocalFallback(normOwner, next);
    return next.length !== prev.length;
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(recordKey(normOwner, id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    const prev = readLocalFallback(normOwner);
    const next = prev.filter((t) => t.id !== id);
    writeLocalFallback(normOwner, next);
    return next.length !== prev.length;
  }
}

export async function recordWebLearnedTemplateHit(
  ownerKey: string,
  id: string,
): Promise<void> {
  const list = await listWebLearnedTemplates(ownerKey);
  const found = list.find((t) => t.id === id);
  if (!found) return;
  await saveWebLearnedTemplate(ownerKey, {
    ...found,
    hits: (found.hits || 0) + 1,
    last_hit_at: new Date().toISOString(),
  });
}
