import { Engine } from "@babylonjs/core";
import { UNCATEGORIZED, type Barrier, type DecorItem, type DecorLayer, type MapSlotSummary, type UploadedImage } from "@bug-game/shared";
import {
  deleteMapSlot,
  getCurrentUser,
  getMap,
  googleLoginUrl,
  listMapSlots,
  listUploads,
  logout,
  resolveImageUrl,
  saveMap,
  uploadImage,
} from "./api";
import { BARRIER_BASE_HINT, DECORATE_BASE_HINT, type EditorMode, WorldEditor } from "./editor";

const TRAY_ITEM_MIME = "application/x-item-url";
const ALL_CATEGORY = "All";
const RECENTLY_USED = "Recently Used";
const RECENT_STORAGE_KEY = "bug-game-recent-decor";
const RECENT_LIMIT = 20;
const AUTOSAVE_SLOT = "autosave";
const AUTOSAVE_INTERVAL_MS = 45_000;
const DEFAULT_SLOT = "default";

const MODES: { id: EditorMode; label: string }[] = [
  { id: "decorate", label: "Decorate" },
  { id: "barrier", label: "Barrier" },
];

const loginGate = document.getElementById("login-gate") as HTMLDivElement;
const topToolbar = document.getElementById("top-toolbar") as HTMLDivElement;
const modeRow = document.getElementById("toolbox-row") as HTMLDivElement;
const inspectPanel = document.getElementById("inspect-panel") as HTMLDivElement;
const statusLine = document.getElementById("status-line") as HTMLDivElement;
const categoryRow = document.getElementById("category-row") as HTMLDivElement;
const trayRow = document.getElementById("tray-row") as HTMLDivElement;
const addItemPanel = document.getElementById("add-item-panel") as HTMLDivElement;
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const itemTray = document.getElementById("item-tray") as HTMLDivElement;
const searchInput = document.getElementById("search-items") as HTMLInputElement;
const addBtn = document.getElementById("add-btn") as HTMLButtonElement;
const showBarriersToggle = document.getElementById("show-barriers-toggle") as HTMLInputElement;
const dropZone = document.getElementById("drop-zone") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const itemNameInput = document.getElementById("item-name") as HTMLInputElement;
const itemCategoryInput = document.getElementById("item-category") as HTMLInputElement;
const categoryOptionsList = document.getElementById("category-options") as HTMLDataListElement;
const itemDefaultLayerSelect = document.getElementById("item-default-layer") as HTMLSelectElement;
const uploadBtn = document.getElementById("upload-btn") as HTMLButtonElement;
const uploadStatus = document.getElementById("upload-status") as HTMLDivElement;
const slotModal = document.getElementById("slot-modal") as HTMLDivElement;
const slotModalClose = document.getElementById("slot-modal-close") as HTMLButtonElement;
const slotList = document.getElementById("slot-list") as HTMLDivElement;

function getRecentlyUsedUrls(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function recordRecentlyUsed(url: string): void {
  try {
    const current = getRecentlyUsedUrls().filter((u) => u !== url);
    current.unshift(url);
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(current.slice(0, RECENT_LIMIT)));
  } catch {
    // Per-viewer convenience only — fine to silently no-op if storage is unavailable.
  }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("error");

  const { user } = await getCurrentUser();

  if (!user) {
    renderLoginGate(authError);
    return;
  }

  loginGate.classList.add("hidden");
  startEditor();
}

function renderLoginGate(error: string | null): void {
  loginGate.innerHTML = "";

  const heading = document.createElement("h1");
  heading.textContent = "World Editor";
  heading.style.margin = "0";

  const message = document.createElement("p");
  message.textContent =
    error === "unauthorized"
      ? "That Google account isn't on the admin allowlist."
      : error === "oauth_not_configured"
        ? "Google OAuth isn't configured on the server yet (missing GOOGLE_CLIENT_ID/SECRET in .env)."
        : "Sign in with an admin Google account to edit the world.";

  const button = document.createElement("button");
  button.textContent = "Sign in with Google";
  button.onclick = () => {
    window.location.href = googleLoginUrl();
  };

  loginGate.append(heading, message, button);
}

function startEditor(): void {
  const engine = new Engine(canvas, true);

  let inspectedItem: DecorItem | Barrier | null = null;
  let inspectedKind: "decor" | "barrier" | null = null;
  let editingEnabled = false;
  let libraryImages: UploadedImage[] = [];
  let pendingFile: File | null = null;
  let draggingImageUrl: string | null = null;
  let activeCategory = ALL_CATEGORY;
  let currentSlot = DEFAULT_SLOT;
  let hasUnsavedChanges = false;
  let hasChangesSinceAutosave = false;

  const setStatus = (message: string) => {
    statusLine.textContent = message;
    statusLine.classList.remove("hidden");
  };

  const editor = new WorldEditor(engine, canvas, {
    onInspect: (item, kind) => {
      inspectedItem = item;
      inspectedKind = kind;
      renderInspectPanel();
    },
    onStatusChange: setStatus,
    onHistoryChange: (canUndo, canRedo) => {
      const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement | null;
      const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement | null;
      if (undoBtn) undoBtn.disabled = !canUndo;
      if (redoBtn) redoBtn.disabled = !canRedo;
      hasUnsavedChanges = true;
      hasChangesSinceAutosave = true;
      updateSlotLabel();
    },
    onModeChange: (mode) => {
      for (const btn of modeRow.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
        btn.classList.toggle("active", btn.dataset.mode === mode);
      }
      categoryRow.classList.toggle("hidden", mode !== "decorate");
      trayRow.classList.toggle("hidden", mode !== "decorate");
      addItemPanel.classList.toggle("hidden", mode !== "decorate");
      setStatus(mode === "barrier" ? BARRIER_BASE_HINT : DECORATE_BASE_HINT);
    },
  });

  engine.runRenderLoop(() => editor.render());
  window.addEventListener("resize", () => engine.resize());

  window.addEventListener("beforeunload", (e) => {
    if (!hasUnsavedChanges) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // Letter keys always pan the camera. Arrow keys pan too, unless something
  // is selected, in which case they nudge the selected item instead — the
  // two never compete because only one applies at a time.
  const LETTER_PAN_KEYS: Record<string, "up" | "down" | "left" | "right"> = {
    w: "up",
    s: "down",
    a: "left",
    d: "right",
  };
  const ARROW_KEYS: Record<string, "up" | "down" | "left" | "right"> = {
    arrowup: "up",
    arrowdown: "down",
    arrowleft: "left",
    arrowright: "right",
  };

  window.addEventListener("keydown", (e) => {
    if (!editingEnabled) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT") return;

    const modifierHeld = e.ctrlKey || e.metaKey;

    const letterDirection = !modifierHeld ? LETTER_PAN_KEYS[e.key.toLowerCase()] : undefined;
    if (letterDirection) {
      e.preventDefault();
      editor.setPanKeyState(letterDirection, true);
      return;
    }

    const arrowDirection = ARROW_KEYS[e.key.toLowerCase()];
    if (arrowDirection) {
      e.preventDefault();
      if (inspectedItem) {
        editor.nudgeSelected(arrowDirection);
      } else {
        editor.setPanKeyState(arrowDirection, true);
      }
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      editor.deleteInspected();
    } else if (e.key === "Escape") {
      if (!slotModal.classList.contains("hidden")) closeSlotModal();
      else editor.deselect();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && e.shiftKey) {
      editor.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      editor.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      editor.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      editor.duplicateInspected();
    }
  });

  window.addEventListener("keyup", (e) => {
    const direction = LETTER_PAN_KEYS[e.key.toLowerCase()] ?? ARROW_KEYS[e.key.toLowerCase()];
    if (direction) editor.setPanKeyState(direction, false);
  });

  function enterEditMode(): void {
    editingEnabled = true;
    editor.setEditingEnabled(true);
    modeRow.classList.remove("hidden");
    categoryRow.classList.remove("hidden");
    trayRow.classList.remove("hidden");
    addItemPanel.classList.remove("hidden");
    renderModeRow();
    renderTopToolbarEditMode();
    void refreshLibrary();
    setStatus(DECORATE_BASE_HINT);
    window.setInterval(runAutosave, AUTOSAVE_INTERVAL_MS);

    // Showing the mode row/tray/add-item panel shrinks the canvas's CSS
    // size (it shares space with them via flexbox), but that's not a
    // window resize event, so Babylon never resizes its internal render
    // buffer to match — leaving picking math using a stale
    // resolution/aspect ratio while rendering just visually stretches to
    // fit. Force it explicitly.
    engine.resize();
  }

  async function runAutosave(): Promise<void> {
    if (!hasChangesSinceAutosave) return;
    hasChangesSinceAutosave = false;
    try {
      const thumbnail = await editor.captureThumbnail();
      await saveMap(AUTOSAVE_SLOT, editor.exportMap(), thumbnail);
      setStatus(`Autosaved draft (slot "${AUTOSAVE_SLOT}").`);
    } catch {
      // A missed autosave isn't worth interrupting the admin over; the next
      // interval, or an explicit Save, will catch up.
    }
  }

  function renderTopToolbarStart(): void {
    topToolbar.innerHTML = "";
    topToolbar.classList.remove("hidden");
    const openBtn = document.createElement("button");
    openBtn.textContent = "Open Editor";
    openBtn.onclick = enterEditMode;
    topToolbar.append(openBtn);
  }

  function updateSlotLabel(): void {
    const label = document.getElementById("slot-label");
    if (label) label.textContent = `Slot: ${currentSlot}${hasUnsavedChanges ? " *" : ""}`;
  }

  async function saveCurrentSlot(): Promise<void> {
    setStatus("Saving...");
    try {
      const thumbnail = await editor.captureThumbnail();
      await saveMap(currentSlot, editor.exportMap(), thumbnail);
      hasUnsavedChanges = false;
      updateSlotLabel();
      setStatus(`Saved to slot "${currentSlot}".`);
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    }
  }

  function renderTopToolbarEditMode(): void {
    topToolbar.innerHTML = "";

    const slotLabel = document.createElement("span");
    slotLabel.id = "slot-label";
    slotLabel.style.color = "#e6e6e6";
    slotLabel.style.fontSize = "12px";
    slotLabel.style.alignSelf = "center";

    const undoBtn = document.createElement("button");
    undoBtn.id = "undo-btn";
    undoBtn.textContent = "Undo";
    undoBtn.className = "secondary";
    undoBtn.disabled = true;
    undoBtn.onclick = () => editor.undo();

    const redoBtn = document.createElement("button");
    redoBtn.id = "redo-btn";
    redoBtn.textContent = "Redo";
    redoBtn.className = "secondary";
    redoBtn.disabled = true;
    redoBtn.onclick = () => editor.redo();

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.onclick = () => void saveCurrentSlot();

    const saveAsBtn = document.createElement("button");
    saveAsBtn.textContent = "Save As...";
    saveAsBtn.className = "secondary";
    saveAsBtn.onclick = () => {
      const name = window.prompt("Save as slot named:", currentSlot);
      if (!name || !name.trim()) return;
      currentSlot = name.trim();
      updateSlotLabel();
      void saveCurrentSlot();
    };

    const loadBtn = document.createElement("button");
    loadBtn.textContent = "Load...";
    loadBtn.className = "secondary";
    loadBtn.onclick = () => void openSlotModal();

    const logoutBtn = document.createElement("button");
    logoutBtn.textContent = "Log out";
    logoutBtn.className = "secondary";
    logoutBtn.onclick = async () => {
      await logout();
      window.location.reload();
    };

    topToolbar.append(slotLabel, undoBtn, redoBtn, saveBtn, saveAsBtn, loadBtn, logoutBtn);
    updateSlotLabel();
  }

  async function openSlotModal(): Promise<void> {
    slotModal.classList.remove("hidden");
    slotList.innerHTML = "Loading...";
    let slots: MapSlotSummary[] = [];
    try {
      slots = await listMapSlots();
    } catch (err) {
      slotList.textContent = `Could not load save slots: ${(err as Error).message}`;
      return;
    }
    renderSlotList(slots);
  }

  function closeSlotModal(): void {
    slotModal.classList.add("hidden");
  }

  function renderSlotList(slots: MapSlotSummary[]): void {
    slotList.innerHTML = "";

    const newCard = document.createElement("div");
    newCard.className = "slot-card new-slot";
    newCard.textContent = "+ New map";
    newCard.onclick = () => {
      if (hasUnsavedChanges && !window.confirm(`Discard unsaved changes to "${currentSlot}" and start a new map?`)) return;
      editor.loadMap({ decor: [], barriers: [] });
      const name = window.prompt("Name the new map slot:", "");
      currentSlot = name && name.trim() ? name.trim() : `untitled-${Date.now()}`;
      hasUnsavedChanges = true;
      updateSlotLabel();
      closeSlotModal();
      setStatus(`Started a new map. Slot "${currentSlot}" — Save to create it.`);
    };
    slotList.append(newCard);

    for (const slot of slots) {
      const card = document.createElement("div");
      card.className = `slot-card${slot.mapId === currentSlot ? " current" : ""}`;

      const thumb = document.createElement("img");
      thumb.className = "slot-card-thumb";
      thumb.src = slot.thumbnail ?? "";
      thumb.alt = slot.mapId;

      const body = document.createElement("div");
      body.className = "slot-card-body";

      const name = document.createElement("div");
      name.className = "slot-card-name";
      name.textContent = slot.mapId;

      const meta = document.createElement("div");
      meta.className = "slot-card-meta";
      meta.textContent = new Date(slot.updatedAt).toLocaleString();

      const actions = document.createElement("div");
      actions.className = "slot-card-actions";

      const loadBtn = document.createElement("button");
      loadBtn.textContent = "Load";
      loadBtn.onclick = (e) => {
        e.stopPropagation();
        void loadSlot(slot.mapId);
      };

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.className = "danger";
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        void deleteSlot(slot.mapId);
      };

      actions.append(loadBtn, deleteBtn);
      body.append(name, meta, actions);
      card.append(thumb, body);
      card.onclick = () => void loadSlot(slot.mapId);
      slotList.append(card);
    }
  }

  async function loadSlot(mapId: string): Promise<void> {
    if (hasUnsavedChanges && !window.confirm(`Discard unsaved changes to "${currentSlot}" and load "${mapId}"?`)) return;
    try {
      const map = await getMap(mapId);
      editor.loadMap(map);
      currentSlot = mapId;
      hasUnsavedChanges = false;
      updateSlotLabel();
      closeSlotModal();
      setStatus(`Loaded slot "${mapId}": ${map.decor.length} decor, ${map.barriers.length} barriers.`);
    } catch (err) {
      setStatus(`Could not load slot "${mapId}": ${(err as Error).message}`);
    }
  }

  async function deleteSlot(mapId: string): Promise<void> {
    if (!window.confirm(`Permanently delete the "${mapId}" save slot? This can't be undone.`)) return;
    try {
      await deleteMapSlot(mapId);
      await openSlotModal();
    } catch (err) {
      setStatus(`Could not delete slot "${mapId}": ${(err as Error).message}`);
    }
  }

  slotModalClose.onclick = closeSlotModal;
  slotModal.addEventListener("click", (e) => {
    if (e.target === slotModal) closeSlotModal();
  });

  function renderModeRow(): void {
    modeRow.innerHTML = "";
    for (const mode of MODES) {
      const btn = document.createElement("button");
      btn.textContent = mode.label;
      btn.className = "secondary";
      btn.dataset.mode = mode.id;
      btn.classList.toggle("active", mode.id === "decorate");
      btn.onclick = () => editor.setMode(mode.id);
      modeRow.append(btn);
    }
  }

  function row(...children: HTMLElement[]): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "inspect-row";
    el.append(...children);
    return el;
  }

  function iconButton(label: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    btn.className = "secondary";
    btn.onclick = onClick;
    return btn;
  }

  function renderInspectPanel(): void {
    inspectPanel.innerHTML = "";

    if (!inspectedItem || !inspectedKind) {
      inspectPanel.classList.add("hidden");
      return;
    }

    if (inspectedKind === "barrier") {
      const barrier = inspectedItem as Barrier;

      const widthInput = document.createElement("input");
      widthInput.type = "number";
      widthInput.min = "0.2";
      widthInput.step = "0.1";
      widthInput.value = barrier.width.toFixed(1);
      widthInput.onchange = () => {
        const value = Math.max(0.2, Number(widthInput.value) || 0.2);
        editor.updateInspected({ width: value });
        editor.commitHistory();
      };

      const depthInput = document.createElement("input");
      depthInput.type = "number";
      depthInput.min = "0.2";
      depthInput.step = "0.1";
      depthInput.value = barrier.depth.toFixed(1);
      depthInput.onchange = () => {
        const value = Math.max(0.2, Number(depthInput.value) || 0.2);
        editor.updateInspected({ depth: value });
        editor.commitHistory();
      };

      inspectPanel.classList.remove("hidden");
      inspectPanel.append(row(labelSpan("Width:"), widthInput), row(labelSpan("Depth:"), depthInput));
      return;
    }

    const item = inspectedItem as DecorItem;

    const layerSelect = document.createElement("select");
    for (const [value, text] of [
      ["behind", "Behind"],
      ["auto", "Auto"],
      ["front", "Front"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = item.layer === value;
      layerSelect.append(option);
    }
    layerSelect.onchange = () => {
      editor.updateInspected({ layer: layerSelect.value as DecorItem["layer"] });
      editor.commitHistory();
    };

    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.min = "0.2";
    sizeInput.max = "6";
    sizeInput.step = "0.1";
    sizeInput.value = item.scale.toFixed(2);
    sizeInput.onchange = () => {
      const value = Math.min(6, Math.max(0.2, Number(sizeInput.value) || 1));
      editor.updateInspected({ scale: value });
      editor.commitHistory();
    };

    inspectPanel.classList.remove("hidden");
    inspectPanel.append(
      row(labelSpan("Layer:"), layerSelect),
      row(
        iconButton("⟲15°", "Rotate left 15° (Shift-click for 45°)", (e) => editor.rotateSelected(e.shiftKey ? -45 : -15)),
        iconButton("15°⟳", "Rotate right 15° (Shift-click for 45°)", (e) => editor.rotateSelected(e.shiftKey ? 45 : 15)),
        iconButton("⇋", "Flip horizontal", () => editor.flipSelected("horizontal")),
        iconButton("⇵", "Flip vertical", () => editor.flipSelected("vertical"))
      ),
      row(labelSpan("Size:"), sizeInput),
      row(
        iconButton("⤒", "Send to very front", () => editor.adjustSelectedLayer("front")),
        iconButton("↑", "Send forward one", () => editor.adjustSelectedLayer("forward")),
        iconButton("↓", "Send back one", () => editor.adjustSelectedLayer("backward")),
        iconButton("⤓", "Send to very back", () => editor.adjustSelectedLayer("back"))
      )
    );
  }

  function labelSpan(text: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }

  const refreshLibrary = async () => {
    try {
      libraryImages = await listUploads();
    } catch {
      libraryImages = [];
    }
    renderCategoryRow();
    renderCategoryOptions();
    renderTray();
  };

  function categoryOf(image: UploadedImage): string {
    return image.category?.trim() || UNCATEGORIZED;
  }

  function renderCategoryRow(): void {
    const categories = Array.from(new Set(libraryImages.map(categoryOf))).sort();
    const tabs = [ALL_CATEGORY, RECENTLY_USED, ...categories];

    if (!tabs.includes(activeCategory)) activeCategory = ALL_CATEGORY;

    categoryRow.innerHTML = "";
    for (const tab of tabs) {
      const btn = document.createElement("button");
      btn.textContent = tab;
      btn.className = "secondary";
      btn.classList.toggle("active", tab === activeCategory);
      btn.onclick = () => {
        activeCategory = tab;
        renderCategoryRow();
        renderTray();
      };
      categoryRow.append(btn);
    }
  }

  function renderCategoryOptions(): void {
    categoryOptionsList.innerHTML = "";
    const categories = Array.from(new Set(libraryImages.map(categoryOf).filter((c) => c !== UNCATEGORIZED))).sort();
    for (const category of categories) {
      const option = document.createElement("option");
      option.value = category;
      categoryOptionsList.append(option);
    }
  }

  function visibleTrayImages(): UploadedImage[] {
    const query = searchInput.value.trim().toLowerCase();
    if (query) {
      return libraryImages.filter((image) => image.originalName.toLowerCase().includes(query));
    }
    if (activeCategory === RECENTLY_USED) {
      const recent = getRecentlyUsedUrls();
      return recent.map((url) => libraryImages.find((i) => i.url === url)).filter((i): i is UploadedImage => !!i);
    }
    if (activeCategory === ALL_CATEGORY) return libraryImages;
    return libraryImages.filter((image) => categoryOf(image) === activeCategory);
  }

  function renderTray(): void {
    const filtered = visibleTrayImages();

    itemTray.innerHTML = "";

    if (filtered.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent =
        libraryImages.length === 0
          ? "No items yet — add one on the right."
          : activeCategory === RECENTLY_USED
            ? "Nothing placed yet."
            : "No matches.";
      itemTray.append(hint);
      return;
    }

    for (const image of filtered) {
      const thumb = document.createElement("img");
      thumb.src = resolveImageUrl(image.url);
      thumb.title = image.originalName;
      thumb.className = "tray-item";
      thumb.draggable = true;
      thumb.ondragstart = (e) => {
        draggingImageUrl = image.url;
        e.dataTransfer?.setData(TRAY_ITEM_MIME, image.url);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      };
      thumb.ondragend = () => {
        draggingImageUrl = null;
        editor.hidePlacementGhost();
      };
      itemTray.append(thumb);
    }
  }

  function findImage(url: string): UploadedImage | undefined {
    return libraryImages.find((i) => i.url === url);
  }

  setupTrayScrolling();
  setupDropZone();
  setupCanvasDrop();

  searchInput.oninput = () => renderTray();

  addBtn.onclick = () => fileInput.click();

  showBarriersToggle.onchange = () => editor.setShowBarriers(showBarriersToggle.checked);

  function setupTrayScrolling(): void {
    let dragging = false;
    let startX = 0;
    let startScroll = 0;

    itemTray.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).classList.contains("tray-item")) return;
      dragging = true;
      startX = e.pageX;
      startScroll = itemTray.scrollLeft;
      itemTray.classList.add("dragging");
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      itemTray.scrollLeft = startScroll - (e.pageX - startX);
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      itemTray.classList.remove("dragging");
    });
    itemTray.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY !== 0) {
          itemTray.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false }
    );
  }

  function setupCanvasDrop(): void {
    canvas.addEventListener("dragover", (e) => {
      if (!editingEnabled) return;
      e.preventDefault();

      if (draggingImageUrl) {
        const rect = canvas.getBoundingClientRect();
        editor.showPlacementGhost(e.clientX - rect.left, e.clientY - rect.top, draggingImageUrl);
      }
    });

    canvas.addEventListener("dragleave", () => {
      editor.hidePlacementGhost();
    });

    canvas.addEventListener("drop", (e) => {
      if (!editingEnabled) return;
      e.preventDefault();
      editor.hidePlacementGhost();
      draggingImageUrl = null;

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      const trayUrl = e.dataTransfer?.getData(TRAY_ITEM_MIME);
      if (trayUrl) {
        editor.placeDecorAt(screenX, screenY, trayUrl, findImage(trayUrl)?.defaultLayer);
        recordRecentlyUsed(trayUrl);
        return;
      }

      const file = e.dataTransfer?.files?.[0];
      if (!file) return;

      setStatus("Uploading...");
      uploadImage(file)
        .then(({ url }) => {
          editor.placeDecorAt(screenX, screenY, url);
          recordRecentlyUsed(url);
          void refreshLibrary();
        })
        .catch((err: Error) => setStatus(`Upload failed: ${err.message}`));
    });
  }

  function setupDropZone(): void {
    dropZone.addEventListener("dblclick", () => fileInput.click());
    dropZone.addEventListener("click", () => fileInput.click());

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) setPendingFile(file);
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) setPendingFile(file);
    });

    uploadBtn.onclick = async () => {
      if (!pendingFile) {
        uploadStatus.textContent = "Choose or drop an image first.";
        return;
      }
      uploadStatus.textContent = "Uploading...";
      try {
        await uploadImage(pendingFile, {
          name: itemNameInput.value.trim() || undefined,
          category: itemCategoryInput.value.trim() || undefined,
          defaultLayer: itemDefaultLayerSelect.value as DecorLayer,
        });
        uploadStatus.textContent = "Uploaded.";
        pendingFile = null;
        itemNameInput.value = "";
        dropZone.textContent = "Drag image here, or click to upload";
        fileInput.value = "";
        void refreshLibrary();
      } catch (err) {
        uploadStatus.textContent = `Upload failed: ${(err as Error).message}`;
      }
    };
  }

  function setPendingFile(file: File): void {
    pendingFile = file;
    dropZone.innerHTML = "";
    const preview = document.createElement("img");
    preview.src = URL.createObjectURL(file);
    dropZone.append(preview);
    if (!itemNameInput.value) {
      itemNameInput.value = file.name.replace(/\.[^.]+$/, "");
    }
  }

  renderTopToolbarStart();

  getMap(DEFAULT_SLOT)
    .then((map) => {
      editor.loadMap(map);
      hasUnsavedChanges = false;
      setStatus(`Loaded map: ${map.decor.length} decor, ${map.barriers.length} barriers`);
    })
    .catch(() => {
      // No "default" slot saved yet (fresh install) — start with a blank map.
      editor.loadMap({ decor: [], barriers: [] });
      hasUnsavedChanges = false;
      setStatus('Starting a new map (slot "default").');
    });
}

void main();
