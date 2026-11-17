// Small IndexedDB store: keeps analysis results per video file so re-opening the same
// file does not spend quota again.
const DB_NAME = 'klipded';
const STORE = 'sessions';
let dbp;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

export async function saveSession(key, data) {
  try {
    await tx('readwrite', (s) => s.put({ ...data, savedAt: Date.now() }, key));
    await prune();
  } catch (e) {
    console.warn('saveSession failed', e);
  }
}

export async function loadSession(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch { return null; }
}

async function prune(max = 25) {
  const d = await db();
  const all = await new Promise((resolve) => {
    const out = [];
    const t = d.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out.push({ key: c.key, at: c.value?.savedAt || 0 }); c.continue(); } else resolve(out);
    };
    req.onerror = () => resolve(out);
  });
  if (all.length <= max) return;
  all.sort((a, b) => b.at - a.at);
  await tx('readwrite', (s) => { for (const x of all.slice(max)) s.delete(x.key); });
}
