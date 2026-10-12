import { DB, toast, downloadBlob, fmtBytes, askConfirm, askText, askChoice } from "./db.js";

const $ = s => document.querySelector(s);
const viewHome = $("#view-home"), viewAlbum = $("#view-album");
const albumsEl = $("#albums"), photosEl = $("#photos"), fileInput = $("#file-input");

let currentAlbum = null;
let allPhotos = [];                 // photos of the open album
let list = [];                      // after search / filter / sort
const ui = { q: "", fav: false, sort: "new", select: false, selected: new Set() };
const urls = [];
const url = blob => { const u = URL.createObjectURL(blob); urls.push(u); return u; };
const freeUrls = () => { while (urls.length) URL.revokeObjectURL(urls.pop()); };

/* ---------- Home: albums ---------- */
async function renderAlbums() {
  freeUrls();
  const albums = await DB.listAlbums();
  albumsEl.innerHTML = "";
  const add = document.createElement("div");
  add.className = "card";
  add.innerHTML = `<div class="cover empty" style="aspect-ratio:4/3;font-size:44px;color:var(--accent)">＋</div><div class="meta"><div class="name">ახალი ალბომი</div><div class="count">შექმნა და ფოტოების დამატება</div></div>`;
  add.addEventListener("click", newAlbum);
  albumsEl.appendChild(add);
  for (const a of albums) {
    const count = await DB.countPhotos(a.id);
    const thumb = await DB.firstPhotoThumb(a.id);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="cover ${thumb ? "" : "empty"}">${thumb ? `<img src="${url(thumb)}" alt="">` : "🗂️"}</div>
      <div class="meta"><div class="name"></div><div class="count">${count} ფოტო</div></div>`;
    card.querySelector(".name").textContent = a.name;
    card.addEventListener("click", () => { location.hash = "album/" + a.id; });
    albumsEl.appendChild(card);
  }
}
async function newAlbum() {
  const name = await askText("ახალი ალბომი", "", "შექმნა", "მაგ. ზაფხული 2026");
  if (name === null) return;
  const a = await DB.createAlbum(name);
  location.hash = "album/" + a.id;
}
$("#btn-new-album").addEventListener("click", newAlbum);
$("#btn-new-album-2").addEventListener("click", newAlbum);

/* ---------- Album: load, filter, render ---------- */
async function openAlbum(id) {
  currentAlbum = await DB.getAlbum(id);
  if (!currentAlbum) { location.hash = ""; return; }
  ui.q = ""; ui.fav = false; ui.select = false; ui.selected.clear();
  $("#search").value = ""; $("#f-all").classList.add("active"); $("#f-fav").classList.remove("active");
  await reloadPhotos();
}
async function reloadPhotos() {
  allPhotos = await DB.listPhotos(currentAlbum.id);
  $("#album-title").textContent = currentAlbum.name;
  renderPhotos();
}
function applyFilters() {
  const q = ui.q.trim().toLowerCase();
  list = allPhotos.filter(p => (!ui.fav || p.fav) && (!q || p.name.toLowerCase().includes(q)));
  if (ui.sort === "new") list.sort((a, b) => b.created - a.created);
  else if (ui.sort === "old") list.sort((a, b) => a.created - b.created);
  else list.sort((a, b) => a.name.localeCompare(b.name));
}
function renderPhotos() {
  freeUrls();
  applyFilters();
  const total = allPhotos.reduce((s, p) => s + (p.blob?.size || 0), 0);
  $("#album-sub").textContent = `${allPhotos.length} ფოტო · ${fmtBytes(total)}` + (list.length !== allPhotos.length ? ` · ნაჩვენებია ${list.length}` : "");
  $("#toolbar").style.display = allPhotos.length ? "" : "none";
  photosEl.classList.toggle("select-mode", ui.select);
  $("#btn-select").classList.toggle("active", ui.select);
  photosEl.innerHTML = "";
  if (!allPhotos.length) {
    photosEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><strong>ალბომი ცარიელია</strong>ჩააგდე ფოტოები აქ ან დააჭირე ღილაკს.<div style="margin-top:14px"><button class="btn primary" id="empty-upload">⬆ ფოტოების დამატება</button></div></div>`;
    $("#empty-upload").addEventListener("click", () => fileInput.click());
  } else if (!list.length) {
    photosEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><strong>ვერაფერი მოიძებნა</strong>სცადე სხვა სიტყვა ან „ყველა“.</div>`;
  }
  list.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "card photo" + (ui.selected.has(p.id) ? " selected" : "");
    card.innerHTML = `<div class="cover"><img src="${url(p.thumb)}" alt="" loading="lazy"></div><div class="check">✓</div>${p.fav ? '<div class="star">⭐</div>' : ""}`;
    card.title = `${p.name} · ${p.w}×${p.h}`;
    let timer = 0, longPressed = false;
    card.addEventListener("pointerdown", () => {
      longPressed = false;
      timer = setTimeout(() => { longPressed = true; if (!ui.select) { ui.select = true; } toggleSel(p.id); renderPhotos(); updateSelbar(); }, 480);
    });
    ["pointerup", "pointerleave", "pointercancel", "pointermove"].forEach(ev => card.addEventListener(ev, () => clearTimeout(timer)));
    card.addEventListener("click", () => {
      if (longPressed) return;
      if (ui.select) { toggleSel(p.id); card.classList.toggle("selected", ui.selected.has(p.id)); updateSelbar(); }
      else openViewer(i);
    });
    photosEl.appendChild(card);
  });
  updateSelbar();
}

/* ---------- Toolbar ---------- */
$("#search").addEventListener("input", e => { ui.q = e.target.value; renderPhotos(); });
$("#sort").addEventListener("change", e => { ui.sort = e.target.value; renderPhotos(); });
$("#f-all").addEventListener("click", () => { ui.fav = false; $("#f-all").classList.add("active"); $("#f-fav").classList.remove("active"); renderPhotos(); });
$("#f-fav").addEventListener("click", () => { ui.fav = true; $("#f-fav").classList.add("active"); $("#f-all").classList.remove("active"); renderPhotos(); });
$("#btn-select").addEventListener("click", () => { ui.select = !ui.select; if (!ui.select) ui.selected.clear(); renderPhotos(); });
$("#btn-upload").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
$("#btn-rename").addEventListener("click", async () => {
  const name = await askText("ალბომის გადარქმევა", currentAlbum.name);
  if (name === null) return;
  currentAlbum = await DB.renameAlbum(currentAlbum.id, name);
  $("#album-title").textContent = currentAlbum.name;
});
$("#btn-del-album").addEventListener("click", async () => {
  if (!(await askConfirm(`წავშალო ალბომი „${currentAlbum.name}“ ყველა ფოტოსთან ერთად?`, "წაშლა"))) return;
  await DB.deleteAlbum(currentAlbum.id);
  toast("ალბომი წაიშალა");
  location.hash = "";
});

async function addFiles(files) {
  if (!currentAlbum) return;
  const imgs = [...files].filter(f => f.type.startsWith("image/"));
  if (!imgs.length) { toast("აირჩიე სურათის ფაილები"); return; }
  let ok = 0;
  for (const f of imgs) {
    toast(`იტვირთება ${ok + 1} / ${imgs.length}…`, 4000);
    try { await DB.addPhoto(currentAlbum.id, f, f.name); ok++; } catch (err) { console.error(err); }
  }
  toast(`დაემატა ${ok} ფოტო`);
  reloadPhotos();
}
["dragenter", "dragover"].forEach(ev => viewAlbum.addEventListener(ev, e => { e.preventDefault(); photosEl.classList.add("drag"); }));
["dragleave", "drop"].forEach(ev => viewAlbum.addEventListener(ev, e => { e.preventDefault(); photosEl.classList.remove("drag"); }));
viewAlbum.addEventListener("drop", e => addFiles(e.dataTransfer.files));

/* ---------- Selection bar ---------- */
function toggleSel(id) { ui.selected.has(id) ? ui.selected.delete(id) : ui.selected.add(id); }
function updateSelbar() {
  $("#selbar").classList.toggle("show", ui.select);
  $("#sel-count").textContent = ui.selected.size + " არჩეული";
}
const selPhotos = () => allPhotos.filter(p => ui.selected.has(p.id));
$("#sel-close").addEventListener("click", () => { ui.select = false; ui.selected.clear(); renderPhotos(); });
$("#sel-all").addEventListener("click", () => {
  if (ui.selected.size === list.length) ui.selected.clear(); else list.forEach(p => ui.selected.add(p.id));
  renderPhotos();
});
$("#sel-fav").addEventListener("click", async () => {
  const sel = selPhotos(); if (!sel.length) return;
  const value = !sel.every(p => p.fav);
  for (const p of sel) await DB.updatePhotoMeta(p.id, { fav: value });
  toast(value ? "დაემატა ფავორიტებში" : "ამოღებულია ფავორიტებიდან");
  await reloadPhotos();
});
$("#sel-move").addEventListener("click", async () => {
  const sel = selPhotos(); if (!sel.length) return;
  const others = (await DB.listAlbums()).filter(a => a.id !== currentAlbum.id);
  const options = [...others.map(a => ({ id: a.id, label: "📁 " + a.name })), { id: "__new", label: "＋ ახალი ალბომი" }];
  let target = await askChoice(`გადავიტანო ${sel.length} ფოტო სად?`, options);
  if (!target) return;
  if (target === "__new") {
    const name = await askText("ახალი ალბომი", "", "შექმნა");
    if (name === null) return;
    target = (await DB.createAlbum(name)).id;
  }
  await DB.movePhotos(sel.map(p => p.id), target);
  ui.selected.clear(); ui.select = false;
  toast("გადატანილია");
  await reloadPhotos();
});
$("#sel-dl").addEventListener("click", () => selPhotos().forEach(p => downloadBlob(p.blob, p.name)));
$("#sel-del").addEventListener("click", async () => {
  const sel = selPhotos(); if (!sel.length) return;
  if (!(await askConfirm(`წავშალო ${sel.length} ფოტო?`, "წაშლა"))) return;
  await DB.deletePhotos(sel.map(p => p.id));
  ui.selected.clear(); ui.select = false;
  toast("წაიშალა");
  await reloadPhotos();
});

/* ---------- Full-screen viewer ---------- */
const viewer = $("#viewer"), vImg = $("#v-img");
let vIdx = -1, vUrl = null;
function showViewer() {
  const p = list[vIdx]; if (!p) return closeViewer();
  if (vUrl) URL.revokeObjectURL(vUrl);
  vUrl = URL.createObjectURL(p.blob);
  vImg.src = vUrl;
  $("#v-name").textContent = `${vIdx + 1} / ${list.length} · ${p.name}`;
  $("#v-fav").textContent = p.fav ? "⭐" : "☆";
}
function openViewer(i) { vIdx = i; viewer.classList.remove("hide-ui"); viewer.classList.add("open"); showViewer(); }
function closeViewer() { viewer.classList.remove("open"); if (vUrl) URL.revokeObjectURL(vUrl); vUrl = null; vImg.removeAttribute("src"); }
function step(d) { if (!list.length) return; vIdx = (vIdx + d + list.length) % list.length; showViewer(); }
$("#v-close").addEventListener("click", closeViewer);
$("#v-prev").addEventListener("click", () => step(-1));
$("#v-next").addEventListener("click", () => step(1));
$("#v-edit").addEventListener("click", () => { location.href = `editor.html?photo=${list[vIdx].id}`; });
$("#v-dl").addEventListener("click", () => { const p = list[vIdx]; downloadBlob(p.blob, p.name); toast("თუ ჩამოტვირთვა არ დაიწყო, დააჭირე ფოტოს დიდხანს და აირჩიე შენახვა", 5000); });
$("#v-fav").addEventListener("click", async () => {
  const p = list[vIdx];
  await DB.updatePhotoMeta(p.id, { fav: !p.fav });
  p.fav = !p.fav; $("#v-fav").textContent = p.fav ? "⭐" : "☆";
  renderPhotos();
});
$("#v-del").addEventListener("click", async () => {
  const p = list[vIdx];
  if (!(await askConfirm("წავშალო ეს ფოტო?", "წაშლა"))) return;
  await DB.deletePhoto(p.id);
  allPhotos = allPhotos.filter(x => x.id !== p.id);
  renderPhotos();
  if (!list.length) closeViewer(); else { vIdx = Math.min(vIdx, list.length - 1); showViewer(); }
  toast("წაიშალა");
});
// swipe left/right to change photo, tap to hide/show buttons
let sx = 0, sy = 0, st = 0;
viewer.addEventListener("pointerdown", e => { sx = e.clientX; sy = e.clientY; st = Date.now(); });
viewer.addEventListener("pointerup", e => {
  if (e.target.closest(".vbar, .vnav")) return;
  const dx = e.clientX - sx, dy = e.clientY - sy;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  else if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - st < 400) viewer.classList.toggle("hide-ui");
});
document.addEventListener("keydown", e => {
  if (!viewer.classList.contains("open") || document.querySelector(".modal-bg")) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
});

/* ---------- Router ---------- */
function route() {
  closeViewer();
  const m = location.hash.replace(/^#/, "").match(/^album\/(.+)$/);
  if (m) { viewHome.style.display = "none"; viewAlbum.style.display = ""; openAlbum(m[1]); }
  else { viewAlbum.style.display = "none"; viewHome.style.display = ""; currentAlbum = null; $("#selbar").classList.remove("show"); renderAlbums(); }
}
window.addEventListener("hashchange", route);
route();
