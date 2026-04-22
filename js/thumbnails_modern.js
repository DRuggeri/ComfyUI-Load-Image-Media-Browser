import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXT_NAME = "comfyui.load-image-media-browser";
const SETTINGS = {
  thumbs: "Load Image Media Browser.Show Thumbnails",
  names: "Load Image Media Browser.Show File Names",
  size: "Load Image Media Browser.Thumbnail Size",
  columns: "Load Image Media Browser.Grid Columns",
  deleteEnabled: "Load Image Media Browser.Enable Delete",
  fit: "Load Image Media Browser.Preview Fit",
  previewHeight: "Load Image Media Browser.Preview Height",
  autoplayVideos: "Load Image Media Browser.Autoplay Video Previews",
  sortMode: "Load Image Media Browser.Sort Mode",
};

let styleInjected = false;
let dialog = null;
let currentNode = null;
let currentData = null;
let currentFolder = ".";
let currentSearch = "";
let currentShowImages = true;
let currentShowVideos = true;
const STORAGE_KEY_LAST_FOLDER = "thumbnailsModern.lastFolder";

function getSettingValue(id, fallback) {
  try {
    const value = app.ui?.settings?.getSettingValue?.(id);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function widgetForNode(node) {
  const preferred = mediaModeForNode(node) === "video" ? ["video", "file"] : ["image", "file"];
  for (const name of preferred) {
    const found = node?.widgets?.find((w) => w.name === name);
    if (found) return found;
  }
  return node?.widgets?.find((w) => ["image", "video", "file"].includes(w.name));
}

function mediaModeForNode(node) {
  return node?.comfyClass === "LoadVideo" ? "video" : "image";
}

function normalizeFolder(value) {
  return value && value !== "" ? value : ".";
}

function folderFromRelpath(relpath) {
  const normalized = String(relpath || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx) : ".";
}

function getRememberedFolder(node) {
  const nodeFolder = normalizeFolder(node?.properties?.tmCurrentFolder);
  if (nodeFolder) return nodeFolder;
  try {
    return normalizeFolder(localStorage.getItem(STORAGE_KEY_LAST_FOLDER) || ".");
  } catch {
    return ".";
  }
}

function hasExplicitRememberedFolder(node) {
  return typeof node?.properties?.tmCurrentFolder === "string" && node.properties.tmCurrentFolder.length >= 0;
}

function rememberFolder(node, folder) {
  const normalized = normalizeFolder(folder);
  if (node) {
    node.properties = node.properties || {};
    node.properties.tmCurrentFolder = normalized;
  }
  try {
    localStorage.setItem(STORAGE_KEY_LAST_FOLDER, normalized);
  } catch {}
}

function listImagesForFolder(data, folder, node = currentNode) {
  const normalized = normalizeFolder(folder);
  return (data?.images || []).filter((item) => item.folder === normalized && canSelectItem(item, node));
}

function updateWidgetChoicesForFolder(node, folder, data = currentData) {
  const widget = widgetForNode(node);
  if (!widget || !data) return;
  const items = listImagesForFolder(data, folder, node);
  const values = items.map((item) => item.relpath);
  const currentValue = widget.value;
  widget.options = widget.options || {};
  if (values.length) {
    widget.options.values = values;
    if (currentValue && !values.includes(currentValue)) {
      widget.value = values[0];
    }
  }
}

function syncNodeFolderFromValue(node, data = currentData) {
  const widget = widgetForNode(node);
  const value = widget?.value;
  if (!value) return;
  const folder = folderFromRelpath(value);
  rememberFolder(node, folder);
  updateWidgetChoicesForFolder(node, folder, data);
}

function ensureStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .tm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;font-family:inherit}
    .tm-dialog{width:min(1180px,94vw);height:min(82vh,900px);background:var(--comfy-menu-bg, #1f1f1f);color:var(--input-text, #f2f2f2);border:1px solid var(--border-color, #444);border-radius:16px;display:flex;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.45)}
    .tm-sidebar{width:280px;border-right:1px solid var(--border-color, #444);display:flex;flex-direction:column;background:rgba(255,255,255,.02)}
    .tm-main{flex:1;display:flex;flex-direction:column;min-width:0}
    .tm-head{display:flex;gap:10px;align-items:center;padding:14px;border-bottom:1px solid var(--border-color, #444)}
    .tm-title{font-size:16px;font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tm-btn{border:1px solid var(--border-color, #555);background:var(--comfy-input-bg, #2c2c2c);color:inherit;border-radius:10px;padding:8px 12px;cursor:pointer}
    .tm-btn:hover{filter:brightness(1.08)}
    .tm-search{flex:1;min-width:180px;border:1px solid var(--border-color, #555);background:var(--comfy-input-bg, #2c2c2c);color:inherit;border-radius:10px;padding:8px 10px}
    .tm-folder-list{overflow:auto;padding:8px}
    .tm-folder{display:flex;justify-content:space-between;gap:8px;padding:10px 12px;border-radius:10px;cursor:pointer}
    .tm-folder:hover,.tm-folder.active{background:rgba(255,255,255,.08)}
    .tm-grid{padding:14px;overflow:auto;display:grid;gap:12px;grid-template-columns:repeat(var(--tm-cols, 4), minmax(0,1fr))}
    .tm-card{display:flex;flex-direction:column;gap:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:10px;cursor:pointer;min-width:0}
    .tm-card:hover{background:rgba(255,255,255,.06)}
    .tm-preview{position:relative;width:100%;height:var(--tm-preview-height, 160px);border-radius:10px;background:#111;overflow:hidden;display:flex;align-items:center;justify-content:center}
    .tm-preview img,.tm-preview video{width:100%;height:100%;object-fit:var(--tm-fit, contain);border-radius:10px;background:#111}
    .tm-badge{position:absolute;top:8px;right:8px;font-size:11px;padding:4px 8px;border-radius:999px;background:rgba(0,0,0,.65);border:1px solid rgba(255,255,255,.14)}
    .tm-card.not-selectable{cursor:default;opacity:.95}
    .tm-meta{font-size:12px;opacity:.8;display:flex;justify-content:space-between;gap:8px}
    .tm-name{font-size:12px;line-height:1.35;word-break:break-word}
    .tm-empty{padding:20px;opacity:.75}
    .tm-actions{display:flex;gap:8px;justify-content:flex-end}
    .tm-danger{border-color:#8f3d3d}
    .tm-toggle.active{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.28)}
    .tm-toggle.inactive{opacity:.65}
    .tm-spacer{flex:1}
  `;
  document.head.appendChild(style);
}

function ensureDialog() {
  ensureStyles();
  if (dialog) return dialog;

  const overlay = document.createElement("div");
  overlay.className = "tm-overlay";
  overlay.style.display = "none";
  overlay.innerHTML = `
    <div class="tm-dialog" role="dialog" aria-modal="true">
      <div class="tm-sidebar">
        <div class="tm-head"><div class="tm-title">Folders</div></div>
        <div class="tm-folder-list"></div>
      </div>
      <div class="tm-main">
        <div class="tm-head">
          <div class="tm-title">Media Browser</div>
          <input class="tm-search" type="search" placeholder="Search file or folder" />
          <button class="tm-btn tm-toggle tm-toggle-images active" type="button">Images</button>
          <button class="tm-btn tm-toggle tm-toggle-videos active" type="button">Videos</button>
          <select class="tm-btn tm-sort">
            <option value="date_desc">Date ↓</option>
            <option value="date_asc">Date ↑</option>
            <option value="name_asc">Name A–Z</option>
            <option value="name_desc">Name Z–A</option>
          </select>
          <button class="tm-btn tm-refresh">Refresh</button>
          <button class="tm-btn tm-close">Close</button>
        </div>
        <div class="tm-grid"></div>
      </div>
    </div>
  `;

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialog();
  });
  overlay.querySelector(".tm-close").addEventListener("click", closeDialog);
  overlay.querySelector(".tm-refresh").addEventListener("click", () => openDialog(currentNode, true));
  overlay.querySelector(".tm-search").addEventListener("input", (event) => {
    currentSearch = event.target.value?.toLowerCase?.() || "";
    renderGrid();
  });
  overlay.querySelector(".tm-sort").addEventListener("change", (event) => {
    try {
      app.ui?.settings?.setSettingValue?.(SETTINGS.sortMode, event.target.value);
    } catch {}
    renderGrid();
  });
  overlay.querySelector(".tm-toggle-images").addEventListener("click", () => {
    currentShowImages = !currentShowImages;
    renderGrid();
  });
  overlay.querySelector(".tm-toggle-videos").addEventListener("click", () => {
    currentShowVideos = !currentShowVideos;
    renderGrid();
  });
  document.body.appendChild(overlay);
  dialog = overlay;
  return dialog;
}

function closeDialog() {
  if (dialog) dialog.style.display = "none";
}

async function fetchListing(refresh = false) {
  const query = refresh ? "?refresh=1" : "";
  const response = await api.fetchApi(`/thumbnails-modern/list${query}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function canSelectItem(item, node = currentNode) {
  const mode = mediaModeForNode(node);
  if (mode === "video") return item?.media_type === "video";
  return item?.media_type === "image" && item?.selectable !== false;
}


function inferMediaTypeFromPath(relpath) {
  const value = String(relpath || "").toLowerCase();
  if (/\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(value)) return "video";
  return "image";
}

function resizeNodeForAspect(node, width, height) {
  const mediaWidth = Math.max(1, Number(width || 1));
  const mediaHeight = Math.max(1, Number(height || 1));
  const aspect = Math.max(0.05, mediaWidth / mediaHeight);

  const currentWidth = Math.max(320, Math.round(node?.size?.[0] || 320));
  const chromeWidth = 56;
  const chromeHeight = 170;

  const is169 = Math.abs(aspect - 16 / 9) < 0.12;
  const is916 = Math.abs(aspect - 9 / 16) < 0.08;
  const is11 = Math.abs(aspect - 1) < 0.08;
  const is43 = Math.abs(aspect - 4 / 3) < 0.08;
  const is34 = Math.abs(aspect - 3 / 4) < 0.08;

  let targetPreviewWidth;
  let targetPreviewHeight;

  if (is169) {
    targetPreviewWidth = 820;
    targetPreviewHeight = Math.round(targetPreviewWidth * 9 / 16);
  } else if (is916) {
    targetPreviewHeight = 640;
    targetPreviewWidth = Math.round(targetPreviewHeight * 9 / 16);
  } else if (is11) {
    targetPreviewWidth = 620;
    targetPreviewHeight = 620;
  } else if (is43) {
    targetPreviewWidth = 760;
    targetPreviewHeight = Math.round(targetPreviewWidth * 3 / 4);
  } else if (is34) {
    targetPreviewHeight = 620;
    targetPreviewWidth = Math.round(targetPreviewHeight * 3 / 4);
  } else if (aspect >= 1) {
    targetPreviewWidth = Math.max(620, Math.min(980, Math.round(mediaWidth * 0.42)));
    targetPreviewHeight = Math.round(targetPreviewWidth / aspect);
  } else {
    targetPreviewHeight = Math.max(360, Math.min(760, Math.round(mediaHeight * 0.42)));
    targetPreviewWidth = Math.round(targetPreviewHeight * aspect);
  }

  targetPreviewWidth = Math.max(280, Math.min(980, targetPreviewWidth));
  targetPreviewHeight = Math.max(180, Math.min(760, targetPreviewHeight));

  let targetWidth = Math.max(currentWidth, targetPreviewWidth + chromeWidth);
  let targetHeight = targetPreviewHeight + chromeHeight;

  if (aspect >= 1 && targetWidth < 760) {
    targetWidth = 760;
    targetPreviewWidth = targetWidth - chromeWidth;
    targetPreviewHeight = Math.max(180, Math.min(760, Math.round(targetPreviewWidth / aspect)));
    targetHeight = targetPreviewHeight + chromeHeight;
  }

  if (aspect < 1 && targetWidth < 420) {
    targetWidth = 420;
  }

  node.setSize?.([Math.round(targetWidth), Math.round(targetHeight)]);
  node.setDirtyCanvas?.(true, true);
}

async function fitNodePreviewToMedia(node, relpath, explicitType = null) {
  if (!node || !relpath) return;
  const mediaType = explicitType || inferMediaTypeFromPath(relpath);
  const url = mediaUrl(relpath);
  try {
    if (mediaType === "video") {
      await new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;
        video.onloadedmetadata = () => {
          resizeNodeForAspect(node, video.videoWidth || 16, video.videoHeight || 9);
          resolve();
        };
        video.onerror = () => reject(new Error("video metadata could not be loaded"));
        video.src = url;
      });
      return;
    }
    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resizeNodeForAspect(node, img.naturalWidth || 1, img.naturalHeight || 1);
        resolve();
      };
      img.onerror = () => reject(new Error("image size could not be loaded"));
      img.src = url;
    });
  } catch (err) {
    console.warn("Media Browser: preview aspect resize failed", err);
  }
}

async function setNodeMedia(node, relpath) {
  const widget = widgetForNode(node);
  if (!widget) return;
  const folder = folderFromRelpath(relpath);
  rememberFolder(node, folder);
  updateWidgetChoicesForFolder(node, folder, currentData);
  widget.value = relpath;
  if (Array.isArray(widget.options?.values) && !widget.options.values.includes(relpath)) {
    widget.options.values.unshift(relpath);
  }
  await fitNodePreviewToMedia(node, relpath);
  widget.callback?.(widget.value);
  node.setDirtyCanvas?.(true, true);
  closeDialog();
}

async function deleteImage(relpath) {
  const response = await api.fetchApi("/thumbnails-modern/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relpath }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  currentData.images = currentData.images.filter((item) => item.relpath !== relpath);
  renderFolders();
  renderGrid();
}

function filteredImages() {
  if (!currentData) return [];
  const sortMode = getSettingValue(SETTINGS.sortMode, "date_desc");
  const items = currentData.images.filter((item) => {
    const inFolder = item.folder === currentFolder;
    if (!inFolder) return false;
    if (item.media_type === "image" && !currentShowImages) return false;
    if (item.media_type === "video" && !currentShowVideos) return false;
    if (!currentSearch) return true;
    const hay = `${item.name} ${item.relpath} ${item.folder}`.toLowerCase();
    return hay.includes(currentSearch);
  });

  items.sort((a, b) => {
    if (sortMode === "name_asc") return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" });
    if (sortMode === "name_desc") return String(b.name).localeCompare(String(a.name), undefined, { numeric: true, sensitivity: "base" });
    const am = Number(a.mtime_ns || 0);
    const bm = Number(b.mtime_ns || 0);
    if (sortMode === "date_asc") return am - bm || String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" });
    return bm - am || String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" });
  });

  return items;
}

function mediaUrl(relpath) {
  const normalized = String(relpath || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  const filename = idx >= 0 ? normalized.slice(idx + 1) : normalized;
  const subfolder = idx >= 0 ? normalized.slice(0, idx) : "";
  const params = new URLSearchParams({ filename, type: "input" });
  if (subfolder) params.set("subfolder", subfolder);
  return api.apiURL(`/view?${params.toString()}`);
}

function renderFolders() {
  const list = dialog.querySelector(".tm-folder-list");
  list.innerHTML = "";
  const folders = currentData?.folders || [];
  for (const folder of folders) {
    const el = document.createElement("div");
    el.className = `tm-folder ${folder.path === currentFolder ? "active" : ""}`;
    el.innerHTML = `<span>${folder.label}</span><span>${folder.count}</span>`;
    el.addEventListener("click", () => {
      currentFolder = folder.path;
      rememberFolder(currentNode, currentFolder);
      updateWidgetChoicesForFolder(currentNode, currentFolder, currentData);
      renderFolders();
      renderGrid();
    });
    list.appendChild(el);
  }
}

function renderGrid() {
  const grid = dialog.querySelector(".tm-grid");
  const title = dialog.querySelector(".tm-main .tm-title");
  const showThumbs = getSettingValue(SETTINGS.thumbs, true);
  const showNames = getSettingValue(SETTINGS.names, true);
  const thumbSize = getSettingValue(SETTINGS.size, 120);
  const columns = getSettingValue(SETTINGS.columns, 4);
  const canDelete = getSettingValue(SETTINGS.deleteEnabled, true);
  const fitMode = getSettingValue(SETTINGS.fit, "contain");
  const previewHeight = getSettingValue(SETTINGS.previewHeight, 160);
  const autoplayVideos = getSettingValue(SETTINGS.autoplayVideos, true);
  const mode = mediaModeForNode(currentNode);
  title.textContent = currentFolder === "." ? `Media Browser · input (${mode} node)` : `Media Browser · ${currentFolder} (${mode} node)`;
  const imagesToggle = dialog.querySelector(".tm-toggle-images");
  const videosToggle = dialog.querySelector(".tm-toggle-videos");
  if (imagesToggle) imagesToggle.className = `tm-btn tm-toggle tm-toggle-images ${currentShowImages ? "active" : "inactive"}`;
  if (videosToggle) videosToggle.className = `tm-btn tm-toggle tm-toggle-videos ${currentShowVideos ? "active" : "inactive"}`;
  const sortSelect = dialog.querySelector(".tm-sort");
  if (sortSelect) sortSelect.value = getSettingValue(SETTINGS.sortMode, "date_desc");
  grid.style.setProperty("--tm-thumb-size", `${thumbSize}px`);
  grid.style.setProperty("--tm-cols", String(columns));
  grid.style.setProperty("--tm-fit", fitMode === "cover" ? "cover" : "contain");
  grid.style.setProperty("--tm-preview-height", `${previewHeight}px`);
  grid.innerHTML = "";

  const images = filteredImages();
  if (!images.length) {
    grid.innerHTML = `<div class="tm-empty">No matching media found in this folder.</div>`;
    return;
  }

  for (const item of images) {
    const card = document.createElement("div");
    card.className = "tm-card";
    const escapedName = item.name.replace(/[<>&"]/g, (m) => ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;"}[m]));
    let mediaHtml = "";
    if (showThumbs) {
      if (item.media_type === "video") {
        const autoplay = autoplayVideos ? "autoplay muted loop playsinline" : "controls muted playsinline";
        mediaHtml = `<div class="tm-preview"><video loading="lazy" src="${mediaUrl(item.relpath)}" ${autoplay}></video><div class="tm-badge">VIDEO</div></div>`;
      } else {
        mediaHtml = `<div class="tm-preview"><img loading="lazy" src="${mediaUrl(item.relpath)}" alt="${escapedName}" onerror="this.dataset.error=1;this.title='Thumbnail could not be loaded';" /></div>`;
      }
    }
    const nameHtml = showNames ? `<div class="tm-name">${escapedName}</div>` : "";
    const modified = item.mtime_ns ? new Date(Number(item.mtime_ns) / 1e6).toLocaleString() : "";
    const usableInNode = canSelectItem(item);
    const usageLabel = usableInNode ? "Selectable" : (mode === "video" ? "Image preview only" : "Video preview only");
    card.innerHTML = `${mediaHtml}${nameHtml}<div class="tm-meta"><span>${item.folder}</span><span>${Math.round(item.size / 1024)} KB</span></div><div class="tm-meta"><span>${modified}</span><span>${item.media_type === "video" ? "Video" : "Image"}</span></div><div class="tm-meta"><span>${usageLabel}</span><span></span></div>`;
    if (!usableInNode) card.classList.add("not-selectable");
    if (usableInNode) {
      card.addEventListener("click", () => setNodeMedia(currentNode, item.relpath));
    }

    if (canDelete) {
      const actions = document.createElement("div");
      actions.className = "tm-actions";
      const del = document.createElement("button");
      del.className = "tm-btn tm-danger";
      del.textContent = "Delete";
      del.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm(`Delete file?\n${item.relpath}`)) return;
        try {
          await deleteImage(item.relpath);
        } catch (err) {
          alert(`Delete failed: ${err.message || err}`);
        }
      });
      actions.appendChild(del);
      card.appendChild(actions);
    }

    grid.appendChild(card);
  }
}

async function openDialog(node, refresh = false) {
  ensureDialog();
  currentNode = node;
  currentData = await fetchListing(refresh);

  // Important: keep the last browsed folder when reopening the browser.
  // Only fall back to the image value's folder when the node has not remembered one yet.
  if (!hasExplicitRememberedFolder(node)) {
    syncNodeFolderFromValue(node, currentData);
  }

  currentFolder = getRememberedFolder(node);
  const hasFolder = (currentData?.folders || []).some((folder) => folder.path === currentFolder);
  if (!hasFolder) {
    currentFolder = folderFromRelpath(widgetForNode(node)?.value || ".") || ".";
  }
  const fallbackExists = (currentData?.folders || []).some((folder) => folder.path === currentFolder);
  if (!fallbackExists) currentFolder = ".";
  rememberFolder(node, currentFolder);
  updateWidgetChoicesForFolder(node, currentFolder, currentData);
  currentSearch = "";
  currentShowImages = true;
  currentShowVideos = true;
  dialog.querySelector(".tm-search").value = "";
  renderFolders();
  renderGrid();
  dialog.style.display = "flex";
}

function addBrowserButton(node) {
  if (node.__tmBrowserButton) return;
  node.__tmBrowserButton = true;
  if (!hasExplicitRememberedFolder(node)) {
    syncNodeFolderFromValue(node);
  }
  const imageWidget = widgetForNode(node);
  if (imageWidget && !imageWidget.__tmWrappedCallback) {
    const originalCallback = imageWidget.callback;
    imageWidget.callback = function (value, ...args) {
      const folder = folderFromRelpath(value);
      rememberFolder(node, folder);
      updateWidgetChoicesForFolder(node, folder, currentData);
      fitNodePreviewToMedia(node, value, mediaModeForNode(node));
      return typeof originalCallback === "function" ? originalCallback.call(this, value, ...args) : undefined;
    };
    imageWidget.__tmWrappedCallback = true;
  }
  const widget = node.addWidget?.("button", "Browse Media", null, async () => {
    try {
      await openDialog(node, false);
    } catch (err) {
      alert(`Media browser could not be opened: ${err.message || err}`);
    }
  });
  if (widget) widget.serialize = false;
}


async function refreshNodeFolderChoices(node, force = false) {
  try {
    const data = await fetchListing(force);
    const folder = getRememberedFolder(node);
    const exists = (data?.folders || []).some((item) => item.path === folder);
    const targetFolder = exists ? folder : folderFromRelpath(widgetForNode(node)?.value || ".") || ".";
    rememberFolder(node, targetFolder);
    updateWidgetChoicesForFolder(node, targetFolder, data);
    const currentValue = widgetForNode(node)?.value;
    if (currentValue) fitNodePreviewToMedia(node, currentValue, mediaModeForNode(node));
  } catch (err) {
    console.warn("Thumbnails Modern: could not refresh folder choices", err);
  }
}

app.registerExtension({
  name: EXT_NAME,
  settings: [
    { id: SETTINGS.thumbs, name: "Show thumbnails", type: "boolean", defaultValue: true },
    { id: SETTINGS.names, name: "Show file names", type: "boolean", defaultValue: true },
    { id: SETTINGS.size, name: "Thumbnail size", type: "slider", defaultValue: 120, attrs: { min: 72, max: 320, step: 8 } },
    { id: SETTINGS.previewHeight, name: "Preview height", type: "slider", defaultValue: 160, attrs: { min: 96, max: 360, step: 8 } },
    { id: SETTINGS.columns, name: "Grid columns", type: "slider", defaultValue: 4, attrs: { min: 2, max: 8, step: 1 } },
    { id: SETTINGS.fit, name: "Preview fit", type: "combo", options: ["contain", "cover"], defaultValue: "contain" },
    { id: SETTINGS.autoplayVideos, name: "Autoplay video previews", type: "boolean", defaultValue: true },
    { id: SETTINGS.deleteEnabled, name: "Enable delete button", type: "boolean", defaultValue: true },
    { id: SETTINGS.sortMode, name: "Sort mode", type: "combo", options: ["date_desc", "date_asc", "name_asc", "name_desc"], defaultValue: "date_desc" },
  ],
  async nodeCreated(node) {
    if (!["LoadImage", "LoadVideo"].includes(node.comfyClass)) return;
    addBrowserButton(node);
    refreshNodeFolderChoices(node, false);
  },
  async loadedGraphNode(node) {
    if (!["LoadImage", "LoadVideo"].includes(node.comfyClass)) return;
    addBrowserButton(node);
    refreshNodeFolderChoices(node, false);
  },
});
