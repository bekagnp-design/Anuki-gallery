import { DB, toast, downloadBlob, fmtBytes } from "./db.js";

const $ = s => document.querySelector(s);
const viewHome = $("#view-home");
const viewAlbum = $("#view-album");
const albumsEl = $("#albums");
const photosEl = $("#photos");
const fileInput = $("#file-input");

let currentAlbum = null;
const objectUrls = [];

function freeUrls() {
  while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
}
function url(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.push(u);
  return u;
}

/* ---------- Modal prompt ---------- */
function prompt(title, value = "", okLabel = "შენახვა") {
  return new Promise(resolve => {
    const modal = $("#modal"), input = $("#modal-input");
    $("#modal-title").textContent = title;
    $("#modal-ok").textContent = okLabel;
    input.value = value;
    modal.classList.add("open");
    setTimeout(() => { input.focus(); input.select(); }, 30);
    const done = v => { modal.classList.remove("open"); cleanup(); resolve(v); };
    const onOk = () => done(input.value);
    const onCancel = () => done(null);
    const onKey = e => { if (e.key === "Enter") onOk(); if (e.key === "Escape") onCancel(); };
    const onBg = e => { if (e.target === modal) onCancel(); };
    function cleanup() {
      $("#modal-ok").removeEventListener("click", onOk);
      $("#modal-cancel").removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      modal.removeEventListener("click", onBg);
    }
    $("#modal-ok").addEventListener("click", onOk);
    $("#modal-cancel").addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
    modal.addEventListener("click", onBg);
  });
}

/* ---------- Home: albums ---------- */
async function renderAlbums() {
  freeUrls();
  const albums = await DB.listAlbums();
  albumsEl.innerHTML = "";
  if (!albums.length) {
    albumsEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><strong>ალბომები ჯერ არ გაქვს</strong>დააჭირე „ახალი ალბომი“ და დაიწყე ფოტოების ატვირთვა.</div>`;
    return;
  }
  for (const a of albums) {
    const count = await DB.countPhotos(a.id);
    const thumb = await DB.firstPhotoThumb(a.id);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="cover ${thumb ? "" : "empty"}">${thumb ? `<img src="${url(thumb)}" alt="">` : "🗂️"}</div>
      <div class="meta"><div class="name"></div><div class="count">${count} ფოტო</div></div>
      <div class="actions">
        <button class="btn sm icon" data-act="rename" title="გადარქმევა">✏️</button>
        <button class="btn sm icon danger" data-act="delete" title="წაშლა">🗑</button>
      </div>`;
    card.querySelector(".name").textContent = a.name;
    card.addEventListener("click", async e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "rename") {
        e.stopPropagation();
        const name = await prompt("ალბომის გადარქმევა", a.name);
        if (name !== null) { await DB.renameAlbum(a.id, name); renderAlbums(); }
        return;
      }
      if (act === "delete") {
        e.stopPropagation();
        if (confirm(`წავშალო ალბომი „${a.name}“ და მისი ${count} ფოტო?`)) { await DB.deleteAlbum(a.id); toast("ალბომი წაიშალა"); renderAlbums(); }
        return;
      }
      location.hash = "album/" + a.id;
    });
    albumsEl.appendChild(card);
  }
}

async function newAlbum() {
  const name = await prompt("ახალი ალბომი", "", "შექმნა");
  if (name === null) return;
  const a = await DB.createAlbum(name);
  toast("ალბომი შეიქმნა");
  location.hash = "album/" + a.id;
}
$("#btn-new-album").addEventListener("click", newAlbum);
$("#btn-new-album-2").addEventListener("click", newAlbum);

/* ---------- Album view ---------- */
async function renderAlbum(id) {
  freeUrls();
  currentAlbum = await DB.getAlbum(id);
  if (!currentAlbum) { location.hash = ""; return; }
  $("#album-title").textContent = currentAlbum.name;
  const photos = await DB.listPhotos(id);
  const total = photos.reduce((s, p) => s + (p.blob?.size || 0), 0);
  $("#album-sub").textContent = `${photos.length} ფოტო · ${fmtBytes(total)} · დააგდე ფაილები აქ ან დააჭირე „ატვირთვას“`;
  photosEl.innerHTML = "";
  if (!photos.length) {
    photosEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><strong>ალბომი ცარიელია</strong>ჩააგდე ფოტოები აქ ან დააჭირე „ფოტოების ატვირთვა“.</div>`;
  }
  for (const p of photos) {
    const card = document.createElement("div");
    card.className = "card photo";
    card.innerHTML = `
      <div class="cover"><img src="${url(p.thumb)}" alt=""></div>
      <div class="actions">
        <button class="btn sm icon" data-act="download" title="ჩამოტვირთვა">⬇</button>
        <button class="btn sm icon danger" data-act="delete" title="წაშლა">🗑</button>
      </div>`;
    card.title = `${p.name} · ${p.w}×${p.h}${p.edited ? " · რედაქტირებული" : ""}`;
    card.addEventListener("click", async e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "download") { e.stopPropagation(); downloadBlob(p.blob, p.name); return; }
      if (act === "delete") {
        e.stopPropagation();
        if (confirm("წავშალო ეს ფოტო?")) { await DB.deletePhoto(p.id); renderAlbum(id); }
        return;
      }
      location.href = `editor.html?photo=${p.id}`;
    });
    photosEl.appendChild(card);
  }
}

async function addFiles(files) {
  if (!currentAlbum) return;
  const imgs = [...files].filter(f => f.type.startsWith("image/"));
  if (!imgs.length) { toast("აირჩიე სურათის ფაილები"); return; }
  toast(`იტვირთება ${imgs.length} ფოტო…`);
  let ok = 0;
  for (const f of imgs) {
    try { await DB.addPhoto(currentAlbum.id, f, f.name); ok++; }
    catch (err) { console.error(err); }
  }
  toast(`დაემატა ${ok} ფოტო`);
  renderAlbum(currentAlbum.id);
}

$("#btn-upload").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });

$("#btn-rename").addEventListener("click", async () => {
  const name = await prompt("ალბომის გადარქმევა", currentAlbum.name);
  if (name !== null) { await DB.renameAlbum(currentAlbum.id, name); renderAlbum(currentAlbum.id); }
});
$("#btn-del-album").addEventListener("click", async () => {
  if (confirm(`წავშალო ალბომი „${currentAlbum.name}“ ყველა ფოტოსთან ერთად?`)) {
    await DB.deleteAlbum(currentAlbum.id);
    toast("ალბომი წაიშალა");
    location.hash = "";
  }
});

// Drag & drop onto album
["dragenter", "dragover"].forEach(ev => viewAlbum.addEventListener(ev, e => { e.preventDefault(); photosEl.classList.add("drag"); }));
["dragleave", "drop"].forEach(ev => viewAlbum.addEventListener(ev, e => { e.preventDefault(); photosEl.classList.remove("drag"); }));
viewAlbum.addEventListener("drop", e => addFiles(e.dataTransfer.files));

/* ---------- Router ---------- */
function route() {
  const h = location.hash.replace(/^#/, "");
  const m = h.match(/^album\/(.+)$/);
  if (m) {
    viewHome.style.display = "none";
    viewAlbum.style.display = "";
    renderAlbum(m[1]);
  } else {
    viewAlbum.style.display = "none";
    viewHome.style.display = "";
    currentAlbum = null;
    renderAlbums();
  }
}
window.addEventListener("hashchange", route);
route();
