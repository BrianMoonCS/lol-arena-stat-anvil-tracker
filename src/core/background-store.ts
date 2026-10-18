// Uploaded backgrounds live in IndexedDB so they survive reloads without re-uploading.
// Images are far too large for cookies (~4 KB) or comfortable localStorage use.

export interface StoredBackground {
  id: string;
  name: string;
  blob: Blob;
  addedAt: number;
}

const DATABASE_NAME = "stat-anvil-tracker";
const STORE_NAME = "backgrounds";
const SELECTED_KEY = "stat-anvil-selected-background";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export async function listStoredBackgrounds(): Promise<StoredBackground[]> {
  try {
    const all = await withStore("readonly", (store) => store.getAll() as IDBRequest<StoredBackground[]>);
    return all.sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [];
  }
}

export async function saveBackground(file: File): Promise<StoredBackground> {
  const background: StoredBackground = {
    id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name.replace(/\.[^.]+$/, "") || "Background",
    blob: file,
    addedAt: Date.now(),
  };
  await withStore("readwrite", (store) => store.put(background));
  return background;
}

export async function deleteBackground(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

export function loadSelectedBackgroundId(): string | undefined {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveSelectedBackgroundId(id: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    // Selection is a convenience; ignore storage failures (private mode, blocked storage).
  }
}
