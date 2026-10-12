// IndexedDB storage layer: albums + photos (blobs) kept in the browser.
const DB_NAME = "anuki-gallery";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("albums")) {
        db.createObjectStore("albums", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("photos")) {
        const ps = db.createObjectStore("photos", { keyPath: "id" });
        ps.createIndex("albumId", "albumId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try {
      result = fn(s);
    } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && "result" in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function makeThumb(blob, size = 400) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const thumb = await new Promise(r => c.toBlob(r, "image/jpeg", 0.8));
  const dims = { w: bmp.width, h: bmp.height };
  bmp.close();
  return { thumb, ...dims };
}

export const DB = {
  async listAlbums() {
    const db = await openDB();
    const albums = await tx(db, "albums", "readonly", s => s.getAll());
    return albums.sort((a, b) => b.created - a.created);
  },
  async getAlbum(id) {
    const db = await openDB();
    return tx(db, "albums", "readonly", s => s.get(id));
  },
  async createAlbum(name) {
    const db = await openDB();
    const album = { id: uid(), name: name.trim() || "ახალი ალბომი", created: Date.now() };
    await tx(db, "albums", "readwrite", s => s.put(album));
    return album;
  },
  async renameAlbum(id, name) {
    const db = await openDB();
    const album = await tx(db, "albums", "readonly", s => s.get(id));
    if (!album) return;
    album.name = name.trim() || album.name;
    await tx(db, "albums", "readwrite", s => s.put(album));
    return album;
  },
  async deleteAlbum(id) {
    const db = await openDB();
    const photos = await this.listPhotos(id);
    await tx(db, "photos", "readwrite", s => { photos.forEach(p => s.delete(p.id)); });
    await tx(db, "albums", "readwrite", s => s.delete(id));
  },
  async listPhotos(albumId) {
    const db = await openDB();
    const photos = await tx(db, "photos", "readonly", s => s.index("albumId").getAll(albumId));
    return photos.sort((a, b) => a.created - b.created);
  },
  async countPhotos(albumId) {
    const db = await openDB();
    return tx(db, "photos", "readonly", s => s.index("albumId").count(albumId));
  },
  async getPhoto(id) {
    const db = await openDB();
    return tx(db, "photos", "readonly", s => s.get(id));
  },
  async addPhoto(albumId, blob, name) {
    const db = await openDB();
    const { thumb, w, h } = await makeThumb(blob);
    const photo = { id: uid(), albumId, name: name || "photo.jpg", blob, thumb, w, h, created: Date.now(), edited: null };
    await tx(db, "photos", "readwrite", s => s.put(photo));
    return photo;
  },
  async updatePhotoBlob(id, blob, name) {
    const db = await openDB();
    const photo = await tx(db, "photos", "readonly", s => s.get(id));
    if (!photo) throw new Error("ფოტო ვერ მოიძებნა");
    const { thumb, w, h } = await makeThumb(blob);
    Object.assign(photo, { blob, thumb, w, h, edited: Date.now() });
    if (name) photo.name = name;
    await tx(db, "photos", "readwrite", s => s.put(photo));
    return photo;
  },
  async deletePhoto(id) {
    const db = await openDB();
    await tx(db, "photos", "readwrite", s => s.delete(id));
  },
  async firstPhotoThumb(albumId) {
    const photos = await this.listPhotos(albumId);
    return photos.length ? photos[photos.length - 1].thumb : null;
  },
};

// Small shared UI helpers
export function toast(msg, ms = 2200) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

export function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

/* ---------- Extra DB helpers (favorites, move, bulk delete) ---------- */
DB.updatePhotoMeta = async function (id, patch) {
  const db = await openDB();
  const photo = await tx(db, "photos", "readonly", s => s.get(id));
  if (!photo) return null;
  Object.assign(photo, patch);
  await tx(db, "photos", "readwrite", s => s.put(photo));
  return photo;
};
DB.movePhotos = async function (ids, albumId) {
  for (const id of ids) await DB.updatePhotoMeta(id, { albumId });
};
DB.deletePhotos = async function (ids) {
  const db = await openDB();
  await tx(db, "photos", "readwrite", s => { ids.forEach(id => s.delete(id)); });
};

/* ---------- In-page dialogs (browser confirm/prompt are blocked in embedded views) ---------- */
function dialog(build) {
  return new Promise(resolve => {
    const bg = document.createElement("div");
    bg.className = "modal-bg open";
    const box = document.createElement("div");
    box.className = "modal";
    bg.appendChild(box);
    document.body.appendChild(bg);
    const close = v => { bg.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = e => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey, true);
    bg.addEventListener("pointerdown", e => { if (e.target === bg) close(null); });
    build(box, close);
  });
}
export function askConfirm(message, okLabel = "დიახ", danger = true) {
  return dialog((box, close) => {
    box.innerHTML = `<h3></h3><div class="row"><button class="btn" data-no>გაუქმება</button><button class="btn ${danger ? "danger" : "primary"}" data-yes></button></div>`;
    box.querySelector("h3").textContent = message;
    box.querySelector("[data-yes]").textContent = okLabel;
    box.querySelector("[data-no]").onclick = () => close(false);
    box.querySelector("[data-yes]").onclick = () => close(true);
    box.querySelector("[data-yes]").focus();
  }).then(v => v === true);
}
export function askText(title, value = "", okLabel = "შენახვა", placeholder = "") {
  return dialog((box, close) => {
    box.innerHTML = `<h3></h3><input type="text"><div class="row"><button class="btn" data-no>გაუქმება</button><button class="btn primary" data-yes></button></div>`;
    box.querySelector("h3").textContent = title;
    const input = box.querySelector("input");
    input.value = value; input.placeholder = placeholder;
    box.querySelector("[data-yes]").textContent = okLabel;
    box.querySelector("[data-no]").onclick = () => close(null);
    box.querySelector("[data-yes]").onclick = () => close(input.value);
    input.addEventListener("keydown", e => { if (e.key === "Enter") close(input.value); });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
export function askChoice(title, options) {
  // options: [{id, label}] -> resolves selected id or null
  return dialog((box, close) => {
    box.innerHTML = `<h3></h3><div class="choice-list"></div><div class="row"><button class="btn" data-no>გაუქმება</button></div>`;
    box.querySelector("h3").textContent = title;
    const list = box.querySelector(".choice-list");
    options.forEach(o => {
      const b = document.createElement("button");
      b.className = "btn"; b.textContent = o.label; b.onclick = () => close(o.id);
      list.appendChild(b);
    });
    box.querySelector("[data-no]").onclick = () => close(null);
  });
}
