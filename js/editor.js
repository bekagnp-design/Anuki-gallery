import { DB, toast, downloadBlob, fmtBytes, askConfirm, askText } from "./db.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* =====================================================================
   State
   ===================================================================== */
const DEFAULT_PARAMS = {
  brightness: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, sharpen: 0,
  temperature: 0, tint: 0, saturation: 0, vibrance: 0, hue: 0, grayscale: 0, sepia: 0,
  vignette: 0, grain: 0, fade: 0, blur: 0, invert: 0,
};

const state = {
  base: null,          // full-res canvas (destructive ops create a new one)
  original: null,      // untouched original image canvas
  mask: null,          // bg blur mask (white = sharp), same size as base
  draw: null,          // drawing layer, same size as base
  params: { ...DEFAULT_PARAMS },
  bg: { enabled: false, radius: 12, feather: 20, mode: "paint", brush: 60, rx: 40, ry: 55, cx: 0.5, cy: 0.5 },
  texts: [],
  activeText: null,
  frame: { width: 0, radius: 0, color: "#ffffff", pad: 0 },
  drawTool: { mode: "brush", size: 12, opacity: 100, color: "#3b82f6" },
  tool: "adjust",
  fileName: "anuki-photo",
  photoId: null,
  albumId: null,
  showMask: true,
  compare: false,
};

const history = { undo: [], redo: [], max: 25 };

const preview = $("#preview");
const overlay = $("#overlay");
const stage = $("#stage");
const pctx = preview.getContext("2d");
const octx = overlay.getContext("2d");
const view = { z: 1, x: 0, y: 0 };   // zoom + pan of the photo on screen
const panelEl = $("#panel");

/* =====================================================================
   Helpers
   ===================================================================== */
function mkCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function cloneCanvas(src) {
  const c = mkCanvas(src.width, src.height);
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
const hasImage = () => !!state.base;

function snapshot() {
  return {
    base: state.base, mask: state.mask, draw: state.draw,
    params: { ...state.params }, bg: { ...state.bg }, frame: { ...state.frame },
    texts: state.texts.map(t => ({ ...t })),
  };
}
function restore(s) {
  state.base = s.base; state.mask = s.mask; state.draw = s.draw;
  state.params = { ...s.params }; state.bg = { ...s.bg }; state.frame = { ...s.frame };
  state.texts = s.texts.map(t => ({ ...t }));
  state.activeText = state.texts.length ? state.texts[state.texts.length - 1].id : null;
  syncUI();
  fitPreview(true);
  render();
}
// Call BEFORE mutating. Layers that will be mutated in place must be cloned by caller.
function pushHistory() {
  history.undo.push(snapshot());
  if (history.undo.length > history.max) history.undo.shift();
  history.redo.length = 0;
  updateHistoryButtons();
}
function undo() {
  if (!history.undo.length) return;
  history.redo.push(snapshot());
  restore(history.undo.pop());
  updateHistoryButtons();
}
function redo() {
  if (!history.redo.length) return;
  history.undo.push(snapshot());
  restore(history.redo.pop());
  updateHistoryButtons();
}
function updateHistoryButtons() {
  $("#btn-undo").disabled = !history.undo.length;
  $("#btn-redo").disabled = !history.redo.length;
}

/* =====================================================================
   Loading
   ===================================================================== */
async function loadBlob(blob, name, photoId = null, albumId = null) {
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch { toast("ფაილი ვერ წაიკითხა — სურათი არ არის?"); return; }
  const c = mkCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  state.base = c;
  state.original = cloneCanvas(c);
  state.mask = mkCanvas(c.width, c.height);
  state.draw = mkCanvas(c.width, c.height);
  state.params = { ...DEFAULT_PARAMS };
  state.bg = { ...state.bg, enabled: false, cx: 0.5, cy: 0.5 };
  state.texts = []; state.activeText = null;
  state.frame = { width: 0, radius: 0, color: "#ffffff", pad: 0 };
  state.fileName = (name || "anuki-photo").replace(/\.[^.]+$/, "");
  state.photoId = photoId; state.albumId = albumId;
  history.undo.length = 0; history.redo.length = 0; updateHistoryButtons();
  $("#fname").textContent = name || "photo";
  $("#ex-name").value = state.fileName;
  $("#ex-save-over").disabled = !photoId;
  $("#drop-empty").style.display = "none";
  preview.style.display = "";
  syncUI();
  fitPreview();
  render();
  toast("ფოტო ჩაიტვირთა");
}

$("#btn-open").addEventListener("click", () => $("#file-input").click());
$("#btn-open-2").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", e => {
  const f = e.target.files[0];
  if (f) loadBlob(f, f.name);
  e.target.value = "";
});
["dragenter", "dragover"].forEach(ev => stage.addEventListener(ev, e => e.preventDefault()));
stage.addEventListener("drop", e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith("image/")) loadBlob(f, f.name);
});

/* =====================================================================
   Rendering pipeline
   ===================================================================== */
function filterString(p, scale) {
  const parts = [];
  if (p.brightness) parts.push(`brightness(${1 + p.brightness / 100})`);
  if (p.contrast) parts.push(`contrast(${1 + p.contrast / 100})`);
  if (p.saturation) parts.push(`saturate(${Math.max(0, 1 + p.saturation / 100)})`);
  if (p.hue) parts.push(`hue-rotate(${p.hue}deg)`);
  if (p.grayscale) parts.push(`grayscale(${p.grayscale / 100})`);
  if (p.sepia) parts.push(`sepia(${p.sepia / 100})`);
  if (p.invert) parts.push(`invert(${p.invert / 100})`);
  if (p.blur) parts.push(`blur(${(p.blur * scale).toFixed(2)}px)`);
  return parts.length ? parts.join(" ") : "none";
}

function needsPixelPass(p) {
  return p.exposure || p.highlights || p.shadows || p.temperature || p.tint || p.vibrance || p.fade || p.grain || p.sharpen;
}

function pixelPass(ctx, W, H, p) {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const expMul = Math.pow(2, p.exposure / 50);
  const temp = p.temperature * 0.5, tint = p.tint * 0.4;
  const hl = p.highlights / 100, sh = p.shadows / 100, vib = p.vibrance / 100, fade = p.fade / 100, grain = p.grain * 0.8;
  const n = d.length;
  for (let i = 0; i < n; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (p.exposure) { r *= expMul; g *= expMul; b *= expMul; }
    if (p.temperature) { r += temp; b -= temp; }
    if (p.tint) { g -= tint; r += tint * 0.5; b += tint * 0.5; }
    if (p.highlights || p.shadows) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum > 128 && p.highlights) { const k = hl * ((lum - 128) / 127) * 60; r += k; g += k; b += k; }
      if (lum < 128 && p.shadows) { const k = sh * (1 - lum / 128) * 60; r += k; g += k; b += k; }
    }
    if (p.vibrance) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const amt = vib * (1 - sat) * 1.2;
      const avg = (r + g + b) / 3;
      r += (r - avg) * amt; g += (g - avg) * amt; b += (b - avg) * amt;
    }
    if (p.fade) { r = r * (1 - 0.35 * fade) + 70 * fade; g = g * (1 - 0.35 * fade) + 70 * fade; b = b * (1 - 0.35 * fade) + 75 * fade; }
    if (p.grain) { const k = (Math.random() - 0.5) * grain; r += k; g += k; b += k; }
    d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  if (p.sharpen) sharpen(img, W, H, p.sharpen / 100);
  ctx.putImageData(img, 0, 0);
}

function sharpen(img, W, H, amount) {
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const a = amount * 1.2, c = 1 + 4 * a;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = src[i + k] * c - a * (src[i - 4 + k] + src[i + 4 + k] + src[i - W * 4 + k] + src[i + W * 4 + k]);
        d[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
}

// Render the whole image to a target canvas sized W×H (W = base.width*scale).
function renderTo(target, W, H, opts = {}) {
  const { base, params: p, bg, texts, frame, draw, mask } = state;
  const scale = W / base.width;
  const ctx = target.getContext("2d");
  target.width = W; target.height = H;
  ctx.imageSmoothingQuality = "high";

  if (opts.original) { ctx.drawImage(state.original, 0, 0, W, H); return; }

  const fs = filterString(p, scale);

  // 1. sharp pass
  const sharp = mkCanvas(W, H);
  const sctx = sharp.getContext("2d");
  sctx.imageSmoothingQuality = "high";
  sctx.filter = fs;
  sctx.drawImage(base, 0, 0, W, H);
  sctx.filter = "none";

  // 2. background blur
  if (bg.enabled && bg.radius > 0) {
    const blurred = mkCanvas(W, H);
    const bctx = blurred.getContext("2d");
    bctx.drawImage(sharp, 0, 0); // fill edges so the blur does not fade to transparent
    bctx.filter = `blur(${(bg.radius * scale).toFixed(2)}px)`;
    bctx.drawImage(sharp, 0, 0);
    bctx.filter = "none";
    // mask scaled + feathered
    const m = mkCanvas(W, H);
    const mctx = m.getContext("2d");
    if (bg.feather) mctx.filter = `blur(${(bg.feather * 0.3 * scale * (base.width / 1000 + 0.3)).toFixed(2)}px)`;
    mctx.drawImage(mask, 0, 0, W, H);
    mctx.filter = "none";
    // sharp through mask
    sctx.globalCompositeOperation = "destination-in";
    sctx.drawImage(m, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    ctx.drawImage(blurred, 0, 0);
    ctx.drawImage(sharp, 0, 0);
  } else {
    ctx.drawImage(sharp, 0, 0);
  }

  // 3. pixel adjustments
  if (needsPixelPass(p)) pixelPass(ctx, W, H, p);

  // 4. vignette
  if (p.vignette) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${(p.vignette / 100).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // 5. drawing layer
  if (draw) ctx.drawImage(draw, 0, 0, W, H);

  // 6. text layers
  for (const t of texts) drawText(ctx, t, scale);

  // 7. frame (inner border, rounded corners)
  if (frame.width > 0 || frame.radius > 0) {
    const fw = frame.width * scale, r = frame.radius * scale;
    if (r > 0) {
      // cut rounded corners by painting frame color outside a rounded rect
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      roundedRect(ctx, fw, fw, W - 2 * fw, H - 2 * fw, Math.max(0, r - fw));
      ctx.fillStyle = frame.color;
      ctx.fill("evenodd");
      ctx.restore();
    } else if (fw > 0) {
      ctx.lineWidth = fw * 2;
      ctx.strokeStyle = frame.color;
      ctx.strokeRect(0, 0, W, H);
    }
  }

  // 8. padding (expand canvas)
  if (frame.pad > 0) {
    const pad = frame.pad * scale;
    const out = mkCanvas(W + pad * 2, H + pad * 2);
    const o = out.getContext("2d");
    o.fillStyle = frame.color;
    o.fillRect(0, 0, out.width, out.height);
    o.drawImage(target, pad, pad);
    target.width = out.width; target.height = out.height;
    ctx.drawImage(out, 0, 0);
  }
}

function roundedRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawText(ctx, t, scale) {
  ctx.save();
  ctx.translate(t.x * scale, t.y * scale);
  ctx.rotate((t.rot || 0) * Math.PI / 180);
  ctx.globalAlpha = t.opacity / 100;
  ctx.font = `${t.italic ? "italic " : ""}${t.bold ? "700 " : "400 "}${t.size * scale}px ${t.font}`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const lines = t.text.split("\n");
  const lh = t.size * scale * 1.2;
  const y0 = -((lines.length - 1) * lh) / 2;
  lines.forEach((line, i) => {
    const y = y0 + i * lh;
    if (t.shadow) { ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = t.size * scale * 0.15; ctx.shadowOffsetY = t.size * scale * 0.04; }
    if (t.outline) { ctx.lineWidth = Math.max(1, t.size * scale * 0.08); ctx.strokeStyle = "#000"; ctx.lineJoin = "round"; ctx.strokeText(line, 0, y); }
    ctx.fillStyle = t.color;
    ctx.fillText(line, 0, y);
    ctx.shadowColor = "transparent";
  });
  ctx.restore();
}

function textBounds(t, scale) {
  // approx bounding box in preview px (unrotated)
  pctx.font = `${t.bold ? "700 " : ""}${t.size * scale}px ${t.font}`;
  const lines = t.text.split("\n");
  const w = Math.max(...lines.map(l => pctx.measureText(l).width), 10);
  const h = lines.length * t.size * scale * 1.2;
  return { x: t.x * scale - w / 2, y: t.y * scale - h / 2, w, h };
}

/* ---------- Preview sizing + zoom/pan ---------- */
let previewScale = 1;   // css px per photo px when the photo fits the screen
let renderScale = 1;    // backing-store resolution (grows when zoomed in)
let viewSize = { w: 0, h: 0 }, lastKey = "";
const viewEl = $("#view");
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

function applyView() {
  viewEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  $("#zoom-val").textContent = Math.round(view.z * 100) + "%";
}
function clampView() {
  const SW = stage.clientWidth, SH = stage.clientHeight, m = 80;
  view.x = clamp(view.x, m - viewSize.w * view.z, SW - m);
  view.y = clamp(view.y, m - viewSize.h * view.z, SH - m);
}
let resTimer = 0;
function scheduleRes() { clearTimeout(resTimer); resTimer = setTimeout(() => { if (hasImage()) render(); }, 160); }
function resetView() {
  view.z = 1;
  view.x = (stage.clientWidth - viewSize.w) / 2;
  view.y = (stage.clientHeight - viewSize.h) / 2;
  applyView(); scheduleRes();
}
function zoomAt(z, cx, cy) {
  z = clamp(z, 0.5, 12);
  const k = z / view.z;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.z = z;
  clampView(); applyView(); scheduleRes();
}
function fitPreview(keep = false) {
  if (!hasImage()) return;
  const SW = stage.clientWidth, SH = stage.clientHeight;
  const pad = state.frame.pad * 2;
  const bw = state.base.width + pad, bh = state.base.height + pad;
  previewScale = Math.min(SW / bw, SH / bh, 4);
  const cssW = Math.round(bw * previewScale), cssH = Math.round(bh * previewScale);
  viewSize = { w: cssW, h: cssH };
  for (const c of [preview, overlay, viewEl]) { c.style.width = cssW + "px"; c.style.height = cssH + "px"; }
  overlay.width = cssW; overlay.height = cssH;
  const key = bw + "x" + bh;
  if (!keep || key !== lastKey || view.z === 1) { lastKey = key; resetView(); }
  else { clampView(); applyView(); }
  updateInfo();
}
window.addEventListener("resize", () => fitPreview(true));

let renderQueued = false;
function render() {
  if (!hasImage() || renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!hasImage()) return;
    const pad = state.frame.pad * 2;
    const maxDim = Math.max(state.base.width + pad, state.base.height + pad);
    renderScale = Math.max(0.02, Math.min(previewScale * Math.max(1, view.z) * dpr(), 2600 / maxDim, 1));
    const W = Math.max(1, Math.round(state.base.width * renderScale));
    const H = Math.max(1, Math.round(state.base.height * renderScale));
    renderTo(preview, W, H, { original: state.compare });
    drawOverlay();
  });
}

function updateInfo() {
  if (!hasImage()) return;
  $("#info").textContent = `${state.base.width} × ${state.base.height} px`;
  $("#rs-w").value = state.base.width; $("#rs-h").value = state.base.height;
  $("#rs-info").textContent = "";
}

/* =====================================================================
   Overlay (crop box, mask tint, text selection, brush cursor)
   ===================================================================== */
const crop = { active: false, x: 0, y: 0, w: 0, h: 0, ratio: null, drag: null };
let cursorPos = null;

function drawOverlay() {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  if (!hasImage()) return;
  const padPx = state.frame.pad * previewScale;

  if (state.tool === "bgblur" && state.showMask && !state.compare) {
    // red tint where mask is white (sharp area)
    const m = mkCanvas(W, H);
    const mc = m.getContext("2d");
    mc.drawImage(state.mask, padPx, padPx, W - 2 * padPx, H - 2 * padPx);
    mc.globalCompositeOperation = "source-in";
    mc.fillStyle = "rgba(240,60,60,0.45)";
    mc.fillRect(0, 0, W, H);
    octx.drawImage(m, 0, 0);
    if (state.bg.mode === "radial") {
      octx.strokeStyle = "#fff"; octx.lineWidth = 1.5; octx.setLineDash([6, 4]);
      octx.beginPath();
      octx.ellipse(state.bg.cx * W, state.bg.cy * H, state.bg.rx / 100 * W / 2, state.bg.ry / 100 * H / 2, 0, 0, Math.PI * 2);
      octx.stroke(); octx.setLineDash([]);
    }
  }

  if ((state.tool === "bgblur" && state.bg.mode !== "radial" || state.tool === "draw") && cursorPos) {
    const r = (state.tool === "draw" ? state.drawTool.size : state.bg.brush) * previewScale / 2;
    octx.beginPath(); octx.arc(cursorPos.x, cursorPos.y, r, 0, Math.PI * 2);
    octx.strokeStyle = "rgba(255,255,255,0.9)"; octx.lineWidth = 1.5; octx.stroke();
    octx.strokeStyle = "rgba(0,0,0,0.6)"; octx.lineWidth = 1; octx.stroke();
  }

  if (state.tool === "text" && state.activeText) {
    const t = state.texts.find(t => t.id === state.activeText);
    if (t) {
      const b = textBounds(t, previewScale);
      octx.save();
      octx.translate(b.x + b.w / 2 + padPx, b.y + b.h / 2 + padPx);
      octx.rotate((t.rot || 0) * Math.PI / 180);
      octx.strokeStyle = "#3b82f6"; octx.lineWidth = 1.5; octx.setLineDash([5, 4]);
      octx.strokeRect(-b.w / 2 - 6, -b.h / 2 - 4, b.w + 12, b.h + 8);
      octx.restore();
    }
  }

  if (crop.active) {
    octx.fillStyle = "rgba(0,0,0,0.55)";
    octx.beginPath(); octx.rect(0, 0, W, H); octx.rect(crop.x, crop.y, crop.w, crop.h); octx.fill("evenodd");
    octx.strokeStyle = "#fff"; octx.lineWidth = 1.5; octx.strokeRect(crop.x, crop.y, crop.w, crop.h);
    octx.strokeStyle = "rgba(255,255,255,0.35)"; octx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      octx.beginPath(); octx.moveTo(crop.x + crop.w * i / 3, crop.y); octx.lineTo(crop.x + crop.w * i / 3, crop.y + crop.h); octx.stroke();
      octx.beginPath(); octx.moveTo(crop.x, crop.y + crop.h * i / 3); octx.lineTo(crop.x + crop.w, crop.y + crop.h * i / 3); octx.stroke();
    }
    octx.fillStyle = "#3b82f6";
    { const hz = 16 / Math.max(view.z, 0.6); for (const [hx, hy] of cropHandles()) octx.fillRect(hx - hz / 2, hy - hz / 2, hz, hz); }
    const rw = Math.round(crop.w / previewScale), rh = Math.round(crop.h / previewScale);
    $("#crop-info").textContent = `${rw} × ${rh} px`;
  }
}
function cropHandles() {
  const { x, y, w, h } = crop;
  return [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]];
}

/* =====================================================================
   Tools switching
   ===================================================================== */
function setTool(name) {
  if (crop.active && name !== "crop") cancelCrop();
  state.tool = name;
  $$("#tools .tool").forEach(b => b.classList.toggle("active", b.dataset.tool === name));
  $$("#panel section").forEach(s => s.classList.toggle("active", s.dataset.panel === name));
  const interactive = ["crop", "bgblur", "text", "draw"].includes(name);
  stage.classList.toggle("tool-cursor", ["bgblur", "draw"].includes(name));
  $("#panel-title").textContent = $(`#tools [data-tool="${name}"]`)?.title || "";
  const hints = {
    crop: "გადაათრიე ჩარჩო ან კუთხეები · Enter — კადრირება · Esc — გაუქმება",
    bgblur: "შეღებე ის, რაც მკვეთრი უნდა დარჩეს · ჩართე „ჩართვა“ შედეგის სანახავად",
    text: "დააწკაპუნე ტექსტზე ასარჩევად და გადაათრიე",
    draw: "ხატე სურათზე მაუსით ან თითით",
  };
  $("#hint").style.display = hints[name] && hasImage() ? "" : "none";
  $("#hint").textContent = hints[name] || "";
  if (name === "crop" && hasImage()) startCrop();
  if (name === "export") refreshExport();
  drawOverlay();
}
function openTool(name) { setTool(name); panelEl.classList.remove("collapsed"); }
$$("#tools .tool").forEach(b => b.addEventListener("click", () => {
  const name = b.dataset.tool;
  if (name === state.tool && name !== "crop" && !panelEl.classList.contains("collapsed")) { panelEl.classList.add("collapsed"); return; }
  openTool(name);
}));
$("#panel-hide").addEventListener("click", () => {
  if (state.tool === "crop") { cancelCrop(); setTool("adjust"); }
  panelEl.classList.add("collapsed");
});
$("#btn-export-top").addEventListener("click", () => openTool("export"));

/* =====================================================================
   Sliders (params)
   ===================================================================== */
let sliderHistoryArmed = true;
$$("input[data-param]").forEach(inp => {
  const key = inp.dataset.param;
  inp.addEventListener("pointerdown", () => { if (hasImage()) { pushHistory(); } });
  inp.addEventListener("input", () => {
    state.params[key] = +inp.value;
    $(`[data-val="${key}"]`).textContent = inp.value;
    render();
  });
  inp.addEventListener("dblclick", () => { pushHistory(); state.params[key] = 0; syncUI(); render(); });
});
$$("[data-reset-group]").forEach(b => b.addEventListener("click", () => {
  if (!hasImage()) return;
  pushHistory();
  b.dataset.resetGroup.split(",").forEach(k => state.params[k] = 0);
  syncUI(); render();
}));

function syncUI() {
  for (const k in state.params) {
    const inp = $(`input[data-param="${k}"]`);
    if (inp) { inp.value = state.params[k]; $(`[data-val="${k}"]`).textContent = state.params[k]; }
  }
  $("#bg-enabled").checked = state.bg.enabled;
  $("#bg-radius").value = state.bg.radius; $("#bg-radius-val").textContent = state.bg.radius;
  $("#bg-feather").value = state.bg.feather; $("#bg-feather-val").textContent = state.bg.feather;
  $("#f-width").value = state.frame.width; $("#f-width-val").textContent = state.frame.width;
  $("#f-radius").value = state.frame.radius; $("#f-radius-val").textContent = state.frame.radius;
  $("#f-pad").value = state.frame.pad; $("#f-pad-val").textContent = state.frame.pad;
  $("#f-color").value = state.frame.color;
  renderTextList();
  updateInfo();
}

/* =====================================================================
   Presets
   ===================================================================== */
const PRESETS = {
  "ორიგინალი": {},
  "ნათელი": { brightness: 10, contrast: 8, vibrance: 15 },
  "კონტრასტული": { contrast: 30, saturation: 10, shadows: -10 },
  "თბილი": { temperature: 30, saturation: 8, vibrance: 10 },
  "ცივი": { temperature: -30, tint: -5, contrast: 5 },
  "შავ-თეთრი": { grayscale: 100, contrast: 15 },
  "დრამატული B&W": { grayscale: 100, contrast: 40, shadows: -20, highlights: -10, vignette: 40 },
  "სეპია": { sepia: 80, contrast: 5, vignette: 20 },
  "ვინტაჟი": { fade: 40, sepia: 25, saturation: -15, vignette: 35, grain: 25 },
  "ფილმი": { fade: 25, contrast: 10, temperature: 10, grain: 30, vibrance: 10 },
  "მატოვი": { fade: 50, contrast: -10, saturation: -10 },
  "კინო": { contrast: 20, temperature: -10, tint: 5, saturation: -10, vignette: 30, shadows: 10 },
  "პასტელი": { brightness: 10, saturation: -25, fade: 30, temperature: 10 },
  "მზის ჩასვლა": { temperature: 45, tint: 10, vibrance: 25, highlights: -15 },
  "პორტრეტი": { brightness: 5, contrast: -5, temperature: 8, vibrance: 10, highlights: -10, shadows: 10 },
};
const presetsEl = $("#presets");
for (const name in PRESETS) {
  const b = document.createElement("button");
  b.className = "btn sm"; b.textContent = name;
  b.addEventListener("click", () => {
    if (!hasImage()) return;
    pushHistory();
    const keep = { vignette: 0, grain: 0, fade: 0, blur: 0, invert: 0 };
    state.params = { ...DEFAULT_PARAMS, ...PRESETS[name] };
    presetsEl.querySelectorAll(".btn").forEach(x => x.classList.toggle("active", x === b));
    syncUI(); render();
  });
  presetsEl.appendChild(b);
}

/* =====================================================================
   Crop
   ===================================================================== */
function startCrop() {
  const W = overlay.width, H = overlay.height;
  crop.active = true; crop.ratio = null;
  crop.x = W * 0.1; crop.y = H * 0.1; crop.w = W * 0.8; crop.h = H * 0.8;
  $$("#crop-presets .btn").forEach(b => b.classList.toggle("active", b.dataset.ratio === "free"));
  drawOverlay();
}
function cancelCrop() { crop.active = false; drawOverlay(); }
function applyCropRatio(r) {
  const W = overlay.width, H = overlay.height;
  if (r === "free") { crop.ratio = null; drawOverlay(); return; }
  const ratio = r === "orig" ? W / H : +r;
  crop.ratio = ratio;
  let w = W * 0.9, h = w / ratio;
  if (h > H * 0.9) { h = H * 0.9; w = h * ratio; }
  crop.w = w; crop.h = h; crop.x = (W - w) / 2; crop.y = (H - h) / 2;
  drawOverlay();
}
$$("#crop-presets .btn").forEach(b => b.addEventListener("click", () => {
  if (!crop.active) startCrop();
  $$("#crop-presets .btn").forEach(x => x.classList.toggle("active", x === b));
  applyCropRatio(b.dataset.ratio);
}));
$("#crop-cancel").addEventListener("click", () => { cancelCrop(); setTool("adjust"); });
$("#crop-apply").addEventListener("click", applyCrop);

function applyCrop() {
  if (!crop.active || !hasImage()) return;
  const pad = state.frame.pad * previewScale;
  const s = 1 / previewScale;
  const x = clamp(Math.round((crop.x - pad) * s), 0, state.base.width - 1);
  const y = clamp(Math.round((crop.y - pad) * s), 0, state.base.height - 1);
  const w = clamp(Math.round(crop.w * s), 1, state.base.width - x);
  const h = clamp(Math.round(crop.h * s), 1, state.base.height - y);
  pushHistory();
  const cut = src => { const c = mkCanvas(w, h); c.getContext("2d").drawImage(src, x, y, w, h, 0, 0, w, h); return c; };
  state.base = cut(state.base); state.mask = cut(state.mask); state.draw = cut(state.draw);
  state.texts.forEach(t => { t.x -= x; t.y -= y; });
  crop.active = false;
  fitPreview(); render();
  toast("კადრირებულია");
  setTool("adjust");
}

// crop pointer interaction
function cropHit(px, py) {
  const hs = cropHandles();
  const r = 22 / Math.max(view.z, 0.6);
  for (let i = 0; i < hs.length; i++) if (Math.abs(hs[i][0] - px) < r && Math.abs(hs[i][1] - py) < r) return i;
  if (px > crop.x && px < crop.x + crop.w && py > crop.y && py < crop.y + crop.h) return "move";
  return null;
}
function cropDragMove(px, py) {
  const d = crop.drag, W = overlay.width, H = overlay.height;
  const dx = px - d.sx, dy = py - d.sy;
  let { x, y, w, h } = d.start;
  if (d.hit === "move") {
    x = clamp(x + dx, 0, W - w); y = clamp(y + dy, 0, H - h);
  } else {
    const i = d.hit;
    const left = [0, 6, 7].includes(i), right = [2, 3, 4].includes(i), top = [0, 1, 2].includes(i), bottom = [4, 5, 6].includes(i);
    if (left) { x += dx; w -= dx; }
    if (right) { w += dx; }
    if (top) { y += dy; h -= dy; }
    if (bottom) { h += dy; }
    if (crop.ratio) {
      if (left || right) { const nh = w / crop.ratio; if (top) y += h - nh; else if (!bottom) y += (h - nh) / 2; h = nh; }
      else { const nw = h * crop.ratio; if (left) x += w - nw; else x += (w - nw) / 2; w = nw; }
    }
    if (w < 20) { w = 20; } if (h < 20) { h = 20; }
    x = clamp(x, 0, W - w); y = clamp(y, 0, H - h);
    w = Math.min(w, W - x); h = Math.min(h, H - y);
  }
  Object.assign(crop, { x, y, w, h });
  drawOverlay();
}

/* =====================================================================
   Resize
   ===================================================================== */
const rsW = $("#rs-w"), rsH = $("#rs-h"), rsLock = $("#rs-lock");
rsW.addEventListener("input", () => { if (rsLock.checked && hasImage()) rsH.value = Math.max(1, Math.round(+rsW.value * state.base.height / state.base.width)); rsInfo(); });
rsH.addEventListener("input", () => { if (rsLock.checked && hasImage()) rsW.value = Math.max(1, Math.round(+rsH.value * state.base.width / state.base.height)); rsInfo(); });
function rsInfo() { if (hasImage()) $("#rs-info").textContent = `${state.base.width}×${state.base.height} → ${rsW.value}×${rsH.value} (${Math.round(+rsW.value / state.base.width * 100)}%)`; }
$$("[data-scale]").forEach(b => b.addEventListener("click", () => { if (!hasImage()) return; rsW.value = Math.round(state.base.width * +b.dataset.scale); rsH.value = Math.round(state.base.height * +b.dataset.scale); rsInfo(); }));
$$("[data-width]").forEach(b => b.addEventListener("click", () => { if (!hasImage()) return; rsW.value = +b.dataset.width; rsH.value = Math.round(+b.dataset.width * state.base.height / state.base.width); rsInfo(); }));
$("#rs-apply").addEventListener("click", () => {
  if (!hasImage()) return;
  const w = clamp(Math.round(+rsW.value), 1, 12000), h = clamp(Math.round(+rsH.value), 1, 12000);
  if (w === state.base.width && h === state.base.height) return;
  pushHistory();
  const sx = w / state.base.width, sy = h / state.base.height;
  state.base = resampleCanvas(state.base, w, h);
  state.mask = resampleCanvas(state.mask, w, h);
  state.draw = resampleCanvas(state.draw, w, h);
  state.texts.forEach(t => { t.x *= sx; t.y *= sy; t.size *= (sx + sy) / 2; });
  fitPreview(); render();
  toast(`ზომა შეიცვალა: ${w}×${h}`);
});
// High quality step-down resampling
function resampleCanvas(src, w, h) {
  let cur = src;
  while (cur.width / 2 > w && cur.height / 2 > h) {
    const c = mkCanvas(cur.width / 2, cur.height / 2);
    const cx = c.getContext("2d"); cx.imageSmoothingQuality = "high";
    cx.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
  }
  const out = mkCanvas(w, h);
  const ox = out.getContext("2d"); ox.imageSmoothingQuality = "high";
  ox.drawImage(cur, 0, 0, w, h);
  return out;
}

/* =====================================================================
   Transform
   ===================================================================== */
function transformAll(fn) {
  pushHistory();
  state.base = fn(state.base); state.mask = fn(state.mask); state.draw = fn(state.draw);
}
$$("[data-rot]").forEach(b => b.addEventListener("click", () => {
  if (!hasImage()) return;
  const deg = +b.dataset.rot;
  const W = state.base.width, H = state.base.height;
  transformAll(src => {
    const c = mkCanvas(H, W);
    const ctx = c.getContext("2d");
    ctx.translate(H / 2, W / 2); ctx.rotate(deg * Math.PI / 180); ctx.drawImage(src, -W / 2, -H / 2);
    return c;
  });
  state.texts.forEach(t => {
    const nx = deg > 0 ? H - t.y : t.y, ny = deg > 0 ? t.x : W - t.x;
    t.x = nx; t.y = ny; t.rot = ((t.rot || 0) + deg);
  });
  fitPreview(); render();
}));
$$("[data-flip]").forEach(b => b.addEventListener("click", () => {
  if (!hasImage()) return;
  const horiz = b.dataset.flip === "h";
  const W = state.base.width, H = state.base.height;
  transformAll(src => {
    const c = mkCanvas(W, H);
    const ctx = c.getContext("2d");
    if (horiz) { ctx.translate(W, 0); ctx.scale(-1, 1); } else { ctx.translate(0, H); ctx.scale(1, -1); }
    ctx.drawImage(src, 0, 0);
    return c;
  });
  state.texts.forEach(t => { if (horiz) t.x = W - t.x; else t.y = H - t.y; });
  render();
}));
$("#straighten").addEventListener("input", e => $("#straighten-val").textContent = e.target.value + "°");
$("#straighten-apply").addEventListener("click", () => {
  if (!hasImage()) return;
  const a = +$("#straighten").value;
  if (!a) return;
  const rad = a * Math.PI / 180, W = state.base.width, H = state.base.height;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const s = Math.max((W * cos + H * sin) / W, (W * sin + H * cos) / H);
  transformAll(src => {
    const c = mkCanvas(W, H);
    const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high";
    ctx.translate(W / 2, H / 2); ctx.rotate(rad); ctx.scale(s, s); ctx.drawImage(src, -W / 2, -H / 2);
    return c;
  });
  $("#straighten").value = 0; $("#straighten-val").textContent = "0°";
  render(); toast("გასწორებულია");
});

/* =====================================================================
   Background blur
   ===================================================================== */
$("#bg-enabled").addEventListener("change", e => { if (!hasImage()) return; pushHistory(); state.bg.enabled = e.target.checked; render(); });
$("#bg-radius").addEventListener("input", e => { state.bg.radius = +e.target.value; $("#bg-radius-val").textContent = e.target.value; render(); });
$("#bg-feather").addEventListener("input", e => { state.bg.feather = +e.target.value; $("#bg-feather-val").textContent = e.target.value; render(); });
$("#bg-brush").addEventListener("input", e => { state.bg.brush = +e.target.value; $("#bg-brush-val").textContent = e.target.value; });
$$("[data-bgmode]").forEach(b => b.addEventListener("click", () => {
  state.bg.mode = b.dataset.bgmode;
  $$("[data-bgmode]").forEach(x => x.classList.toggle("active", x === b));
  $("#bg-brush-ctl").style.display = state.bg.mode === "radial" ? "none" : "";
  $("#bg-radial-ctl").style.display = state.bg.mode === "radial" ? "" : "none";
  if (state.bg.mode === "radial" && hasImage()) applyRadialMask();
  drawOverlay();
}));
["rx", "ry"].forEach(k => $(`#bg-${k}`).addEventListener("input", e => {
  state.bg[k] = +e.target.value; $(`#bg-${k}-val`).textContent = e.target.value;
  if (hasImage()) applyRadialMask();
}));
function applyRadialMask(push = false) {
  if (push) pushHistory();
  const W = state.base.width, H = state.base.height;
  const m = mkCanvas(W, H);
  const ctx = m.getContext("2d");
  const rx = state.bg.rx / 100 * W / 2, ry = state.bg.ry / 100 * H / 2;
  ctx.save();
  ctx.translate(state.bg.cx * W, state.bg.cy * H);
  ctx.scale(rx, ry);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0.7, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  state.mask = m;
  if (!state.bg.enabled) { state.bg.enabled = true; $("#bg-enabled").checked = true; }
  render();
}
$("#bg-invert").addEventListener("click", () => {
  if (!hasImage()) return;
  pushHistory();
  const m = mkCanvas(state.mask.width, state.mask.height);
  const ctx = m.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, m.width, m.height);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(state.mask, 0, 0);
  state.mask = m; render();
});
$("#bg-clear").addEventListener("click", () => {
  if (!hasImage()) return;
  pushHistory();
  state.mask = mkCanvas(state.base.width, state.base.height); render();
});
$("#bg-showmask").addEventListener("change", e => { state.showMask = e.target.checked; drawOverlay(); });

function paintMask(from, to) {
  const ctx = state.mask.getContext("2d");
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.lineWidth = state.bg.brush;
  ctx.globalCompositeOperation = state.bg.mode === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = "#fff";
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
}

/* =====================================================================
   Draw
   ===================================================================== */
const SWATCHES = ["#ffffff", "#000000", "#3b82f6", "#e5584f", "#4fbf8a", "#4f8fe5", "#e54fb3", "#ffe14f"];
const swEl = $("#d-swatches");
SWATCHES.forEach(c => {
  const s = document.createElement("div"); s.className = "swatch"; s.style.background = c;
  s.addEventListener("click", () => { state.drawTool.color = c; $("#d-color").value = c; swEl.querySelectorAll(".swatch").forEach(x => x.classList.toggle("active", x === s)); });
  swEl.appendChild(s);
});
$("#d-color").addEventListener("input", e => state.drawTool.color = e.target.value);
$("#d-size").addEventListener("input", e => { state.drawTool.size = +e.target.value; $("#d-size-val").textContent = e.target.value; });
$("#d-opacity").addEventListener("input", e => { state.drawTool.opacity = +e.target.value; $("#d-opacity-val").textContent = e.target.value; });
$$("[data-drawmode]").forEach(b => b.addEventListener("click", () => { state.drawTool.mode = b.dataset.drawmode; $$("[data-drawmode]").forEach(x => x.classList.toggle("active", x === b)); }));
$("#d-clear").addEventListener("click", () => { if (!hasImage()) return; pushHistory(); state.draw = mkCanvas(state.base.width, state.base.height); render(); });

function paintDraw(from, to) {
  const ctx = state.draw.getContext("2d");
  const t = state.drawTool;
  ctx.lineCap = t.mode === "marker" ? "square" : "round"; ctx.lineJoin = "round";
  ctx.lineWidth = t.size;
  ctx.globalAlpha = t.mode === "marker" ? Math.min(0.5, t.opacity / 100) : t.opacity / 100;
  ctx.globalCompositeOperation = t.mode === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = t.color;
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
}

/* =====================================================================
   Text
   ===================================================================== */
function activeText() { return state.texts.find(t => t.id === state.activeText); }
$("#text-add").addEventListener("click", () => {
  if (!hasImage()) return;
  pushHistory();
  const t = {
    id: Date.now().toString(36), text: "შენი ტექსტი", x: state.base.width / 2, y: state.base.height / 2,
    size: Math.max(16, Math.round(state.base.width / 15)), color: "#ffffff", font: "'Noto Sans Georgian', sans-serif",
    bold: true, italic: false, shadow: true, outline: false, opacity: 100, rot: 0,
  };
  state.texts.push(t); state.activeText = t.id;
  renderTextList(); render();
});
function renderTextList() {
  const list = $("#text-list");
  list.innerHTML = "";
  state.texts.forEach(t => {
    const el = document.createElement("div");
    el.className = "text-item" + (t.id === state.activeText ? " active" : "");
    el.innerHTML = `<span>T</span><span class="t"></span>`;
    el.querySelector(".t").textContent = t.text;
    el.addEventListener("click", () => { state.activeText = t.id; renderTextList(); drawOverlay(); });
    list.appendChild(el);
  });
  const t = activeText();
  $("#text-props").style.display = t ? "flex" : "none";
  if (t) {
    $("#t-text").value = t.text; $("#t-font").value = t.font; $("#t-color").value = t.color;
    $("#t-size").value = t.size; $("#t-size-val").textContent = Math.round(t.size);
    $("#t-opacity").value = t.opacity; $("#t-opacity-val").textContent = t.opacity;
    $("#t-rot").value = t.rot || 0; $("#t-rot-val").textContent = (t.rot || 0) + "°";
    $("#t-bold").checked = t.bold; $("#t-italic").checked = t.italic; $("#t-shadow").checked = t.shadow; $("#t-outline").checked = t.outline;
  }
}
function bindText(id, key, ev = "input", get = e => e.target.value) {
  $(id).addEventListener(ev, e => {
    const t = activeText(); if (!t) return;
    t[key] = get(e);
    if (key === "size") $("#t-size-val").textContent = t.size;
    if (key === "opacity") $("#t-opacity-val").textContent = t.opacity;
    if (key === "rot") $("#t-rot-val").textContent = t.rot + "°";
    if (key === "text") renderTextList();
    render();
  });
  $(id).addEventListener("pointerdown", () => { if (activeText()) pushHistory(); });
  $(id).addEventListener("focus", () => { if (activeText() && ev === "input" && $(id).tagName !== "INPUT") pushHistory(); });
}
bindText("#t-text", "text");
bindText("#t-font", "font", "change");
bindText("#t-color", "color");
bindText("#t-size", "size", "input", e => +e.target.value);
bindText("#t-opacity", "opacity", "input", e => +e.target.value);
bindText("#t-rot", "rot", "input", e => +e.target.value);
bindText("#t-bold", "bold", "change", e => e.target.checked);
bindText("#t-italic", "italic", "change", e => e.target.checked);
bindText("#t-shadow", "shadow", "change", e => e.target.checked);
bindText("#t-outline", "outline", "change", e => e.target.checked);
$("#text-delete").addEventListener("click", () => {
  if (!activeText()) return;
  pushHistory();
  state.texts = state.texts.filter(t => t.id !== state.activeText);
  state.activeText = state.texts.length ? state.texts[state.texts.length - 1].id : null;
  renderTextList(); render();
});
function textHit(px, py) {
  // px,py in base coords
  for (let i = state.texts.length - 1; i >= 0; i--) {
    const t = state.texts[i];
    const b = textBounds(t, 1);
    const dx = px - t.x, dy = py - t.y, r = -(t.rot || 0) * Math.PI / 180;
    const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
    if (Math.abs(lx) <= b.w / 2 + 10 && Math.abs(ly) <= b.h / 2 + 10) return t;
  }
  return null;
}

/* =====================================================================
   Frame
   ===================================================================== */
$("#f-width").addEventListener("input", e => { state.frame.width = +e.target.value; $("#f-width-val").textContent = e.target.value; render(); });
$("#f-radius").addEventListener("input", e => { state.frame.radius = +e.target.value; $("#f-radius-val").textContent = e.target.value; render(); });
$("#f-pad").addEventListener("input", e => { state.frame.pad = +e.target.value; $("#f-pad-val").textContent = e.target.value; fitPreview(); render(); });
$("#f-color").addEventListener("input", e => { state.frame.color = e.target.value; render(); });
$$("[data-fcolor]").forEach(b => b.addEventListener("click", () => { state.frame.color = b.dataset.fcolor; $("#f-color").value = b.dataset.fcolor; render(); }));
["#f-width", "#f-radius", "#f-pad", "#f-color"].forEach(id => $(id).addEventListener("pointerdown", () => hasImage() && pushHistory()));

/* =====================================================================
   Pointer interaction: tools on the photo, pan + pinch/wheel zoom
   ===================================================================== */
let pointer = { last: null, textDrag: null };
const pts = new Map();
let gest = null;           // {type: "pan" | "pinch" | "tool"}
let pushedFlag = false, spaceDown = false, lastTap = 0;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function toLocal(e) {
  const r = overlay.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (overlay.width / r.width), y: (e.clientY - r.top) * (overlay.height / r.height) };
}
function toBase(p) {
  const pad = state.frame.pad * previewScale;
  return { x: (p.x - pad) / previewScale, y: (p.y - pad) / previewScale };
}
function inImage(e) {
  const r = overlay.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}
const isToolActive = () => ["crop", "bgblur", "text", "draw"].includes(state.tool);

// Returns true when the tool takes this touch; false lets it pan the photo instead.
function toolDown(p, b) {
  pointer.last = b; pushedFlag = false;
  if (state.tool === "crop" && crop.active) {
    const hit = cropHit(p.x, p.y);
    if (hit === null) return false;
    crop.drag = { hit, sx: p.x, sy: p.y, start: { ...crop } };
    return true;
  }
  if (state.tool === "bgblur") {
    pushHistory(); pushedFlag = true;
    if (state.bg.mode === "radial") {
      state.bg.cx = clamp(b.x / state.base.width, 0, 1); state.bg.cy = clamp(b.y / state.base.height, 0, 1);
      applyRadialMask();
    } else {
      state.mask = cloneCanvas(state.mask);
      paintMask(b, b); render();
    }
    return true;
  }
  if (state.tool === "draw") {
    pushHistory(); pushedFlag = true;
    state.draw = cloneCanvas(state.draw);
    paintDraw(b, { x: b.x + 0.01, y: b.y + 0.01 }); render();
    return true;
  }
  if (state.tool === "text") {
    const t = textHit(b.x, b.y);
    if (!t) return false;
    state.activeText = t.id; renderTextList();
    pushHistory(); pushedFlag = true;
    pointer.textDrag = { t, ox: b.x - t.x, oy: b.y - t.y };
    drawOverlay();
    return true;
  }
  return false;
}
function toolMove(p, b) {
  if (state.tool === "crop" && crop.drag) cropDragMove(p.x, p.y);
  else if (state.tool === "bgblur" && state.bg.mode !== "radial") { paintMask(pointer.last, b); render(); }
  else if (state.tool === "draw") { paintDraw(pointer.last, b); render(); }
  else if (state.tool === "text" && pointer.textDrag) { const d = pointer.textDrag; d.t.x = b.x - d.ox; d.t.y = b.y - d.oy; render(); }
  pointer.last = b;
}
// A second finger landed: undo whatever the first finger had started painting.
function cancelStroke() {
  if (gest?.type !== "tool") return;
  if (gest.pushed && history.undo.length) { restore(history.undo.pop()); updateHistoryButtons(); }
  crop.drag = null; pointer.textDrag = null;
}
function startPinch() {
  const [a, b] = [...pts.values()];
  gest = { type: "pinch", d: Math.max(dist(a, b), 1), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  stage.classList.add("panning");
}
function doPinch() {
  const [a, b] = [...pts.values()];
  const d = Math.max(dist(a, b), 1), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  view.x += cx - gest.cx; view.y += cy - gest.cy;
  zoomAt(view.z * d / gest.d, cx, cy);
  gest.d = d; gest.cx = cx; gest.cy = cy;
}

stage.addEventListener("pointerdown", e => {
  if (!hasImage()) return;
  stage.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 2) { cancelStroke(); startPinch(); return; }
  if (pts.size > 2) return;
  let handled = false;
  if (isToolActive() && e.button === 0 && !spaceDown && inImage(e)) { const p = toLocal(e); handled = toolDown(p, toBase(p)); }
  if (handled) gest = { type: "tool", pushed: pushedFlag };
  else { gest = { type: "pan", lx: e.clientX, ly: e.clientY, moved: false }; stage.classList.add("panning"); }
});
stage.addEventListener("pointermove", e => {
  if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!hasImage()) return;
  if (gest?.type === "pinch") { if (pts.size === 2) doPinch(); return; }
  const p = toLocal(e);
  cursorPos = p;
  if (gest?.type === "pan") {
    const dx = e.clientX - gest.lx, dy = e.clientY - gest.ly;
    if (Math.abs(dx) + Math.abs(dy) > 0) gest.moved = gest.moved || Math.abs(dx) + Math.abs(dy) > 2;
    view.x += dx; view.y += dy; gest.lx = e.clientX; gest.ly = e.clientY;
    clampView(); applyView();
  } else if (gest?.type === "tool") {
    toolMove(p, toBase(p));
  } else if (state.tool === "crop" && crop.active) {
    const hit = cropHit(p.x, p.y);
    stage.style.cursor = hit === "move" ? "move" : hit === null ? "" : ([0, 4].includes(hit) ? "nwse-resize" : [2, 6].includes(hit) ? "nesw-resize" : [1, 5].includes(hit) ? "ns-resize" : "ew-resize");
  }
  if (state.tool === "draw" || state.tool === "bgblur") drawOverlay();
});
function endPointer(e) {
  pts.delete(e.pointerId);
  if (gest?.type === "pinch") { if (pts.size < 2) { gest = null; stage.classList.remove("panning"); } return; }
  if (gest?.type === "pan" && !gest.moved && e.type === "pointerup") {
    const now = performance.now();
    if (now - lastTap < 320) {           // double tap / double click: zoom in or back to fit
      if (view.z > 1.05) resetView(); else zoomAt(2.5, e.clientX, e.clientY);
      lastTap = 0;
    } else lastTap = now;
  }
  gest = null; crop.drag = null; pointer.textDrag = null; pointer.last = null;
  stage.classList.remove("panning");
}
stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);
stage.addEventListener("pointerleave", () => { cursorPos = null; if (hasImage()) drawOverlay(); });
stage.addEventListener("wheel", e => {
  if (!hasImage()) return;
  e.preventDefault();
  zoomAt(view.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY);
}, { passive: false });
$("#zoom-in").addEventListener("click", () => zoomAt(view.z * 1.3, stage.clientWidth / 2, stage.clientHeight / 2));
$("#zoom-out").addEventListener("click", () => zoomAt(view.z / 1.3, stage.clientWidth / 2, stage.clientHeight / 2));
$("#zoom-fit").addEventListener("click", resetView);
document.addEventListener("keydown", e => {
  if (e.target.matches("input, textarea, select")) return;
  if (e.code === "Space") { spaceDown = true; e.preventDefault(); }
  else if (e.key === "+" || e.key === "=") $("#zoom-in").click();
  else if (e.key === "-") $("#zoom-out").click();
  else if (e.key === "0") resetView();
});
document.addEventListener("keyup", e => { if (e.code === "Space") spaceDown = false; });

/* =====================================================================
   Top bar: undo/redo/compare/reset
   ===================================================================== */
$("#btn-undo").addEventListener("click", undo);
$("#btn-redo").addEventListener("click", redo);
const cmp = $("#btn-compare");
const compareOn = () => { if (!hasImage()) return; state.compare = true; render(); };
const compareOff = () => { if (!state.compare) return; state.compare = false; render(); };
cmp.addEventListener("pointerdown", compareOn);
cmp.addEventListener("pointerup", compareOff);
cmp.addEventListener("pointerleave", compareOff);
$("#btn-reset").addEventListener("click", async () => {
  if (!hasImage()) return;
  if (!(await askConfirm("გავაუქმო ყველა ცვლილება და დავბრუნდე ორიგინალზე?", "გაუქმება"))) return;
  pushHistory();
  state.base = cloneCanvas(state.original);
  state.mask = mkCanvas(state.base.width, state.base.height);
  state.draw = mkCanvas(state.base.width, state.base.height);
  state.params = { ...DEFAULT_PARAMS }; state.texts = []; state.activeText = null;
  state.bg.enabled = false; state.frame = { width: 0, radius: 0, color: "#ffffff", pad: 0 };
  syncUI(); fitPreview(); render();
});
document.addEventListener("keydown", e => {
  if (e.target.matches("input, textarea, select")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (e.key === "Enter" && crop.active) applyCrop();
  else if (e.key === "Escape" && crop.active) { cancelCrop(); setTool("adjust"); }
  else if (e.key === "Delete" && state.tool === "text" && activeText()) $("#text-delete").click();
});

/* =====================================================================
   Export
   ===================================================================== */
async function renderFull() {
  const c = mkCanvas(state.base.width, state.base.height);
  renderTo(c, state.base.width, state.base.height);
  return c;
}
async function exportBlob() {
  const c = await renderFull();
  const type = $("#ex-format").value;
  const q = +$("#ex-q").value / 100;
  return new Promise(r => c.toBlob(r, type, q));
}
function extFor(type) { return type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"; }
$("#ex-q").addEventListener("input", e => { $("#ex-q-val").textContent = e.target.value; });
$("#ex-format").addEventListener("change", () => { $("#ex-q").parentElement.style.opacity = $("#ex-format").value === "image/png" ? 0.4 : 1; });
async function refreshExport() {
  if (!hasImage()) return;
  const pad = state.frame.pad * 2;
  $("#ex-info").textContent = `საბოლოო ზომა: ${state.base.width + pad} × ${state.base.height + pad} px`;
  const albums = await DB.listAlbums();
  const sel = $("#ex-album");
  sel.innerHTML = albums.map(a => `<option value="${a.id}">${a.name.replace(/</g, "&lt;")}</option>`).join("") + `<option value="__new">＋ ახალი ალბომი…</option>`;
  if (state.albumId) sel.value = state.albumId;
}
$("#ex-download").addEventListener("click", async () => {
  if (!hasImage()) return;
  toast("მზადდება…");
  const blob = await exportBlob();
  const name = ($("#ex-name").value.trim() || "anuki-photo") + "." + extFor(blob.type);
  downloadBlob(blob, name);
  toast(`ჩამოიტვირთა · ${fmtBytes(blob.size)}`);
});
async function targetAlbumId() {
  let id = $("#ex-album").value;
  if (id === "__new" || !id) {
    const name = await askText("ახალი ალბომის სახელი", "ჩემი ფოტოები", "შექმნა");
    if (name === null) return null;
    const a = await DB.createAlbum(name);
    id = a.id;
    await refreshExport();
    $("#ex-album").value = id;
  }
  return id;
}
$("#ex-save-copy").addEventListener("click", async () => {
  if (!hasImage()) return;
  const albumId = await targetAlbumId();
  if (!albumId) return;
  toast("ინახება…");
  const blob = await exportBlob();
  const name = ($("#ex-name").value.trim() || "anuki-photo") + "." + extFor(blob.type);
  const p = await DB.addPhoto(albumId, blob, name);
  state.photoId = p.id; state.albumId = albumId; $("#ex-save-over").disabled = false;
  toast("შენახულია ალბომში ✓");
});
$("#ex-save-over").addEventListener("click", async () => {
  if (!hasImage() || !state.photoId) return;
  if (!(await askConfirm("გადავაწერო ორიგინალ ფოტოს ალბომში?", "გადაწერა", false))) return;
  toast("ინახება…");
  const blob = await exportBlob();
  const name = ($("#ex-name").value.trim() || "anuki-photo") + "." + extFor(blob.type);
  await DB.updatePhotoBlob(state.photoId, blob, name);
  toast("გადაწერილია ✓");
});

/* =====================================================================
   Init: open ?photo=ID from album
   ===================================================================== */
(async function init() {
  updateHistoryButtons();
  if (innerWidth <= 960) panelEl.classList.add("collapsed");
  const id = new URLSearchParams(location.search).get("photo");
  if (id) {
    const p = await DB.getPhoto(id);
    if (p) await loadBlob(p.blob, p.name, p.id, p.albumId);
    else toast("ფოტო ვერ მოიძებნა");
  }
  setTool("adjust");
})();
