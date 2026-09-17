import { Engine } from "@babylonjs/core";
import type { Barrier, DecorItem, UploadedImage } from "@bug-game/shared";
import {
  getCurrentUser,
  getMap,
  googleLoginUrl,
  listUploads,
  logout,
  resolveImageUrl,
  saveMap,
  uploadImage,
} from "./api";
import { WorldEditor } from "./editor";

const loginGate = document.getElementById("login-gate") as HTMLDivElement;
const topToolbar = document.getElementById("top-toolbar") as HTMLDivElement;
const selectionToolbar = document.getElementById("selection-toolbar") as HTMLDivElement;
const statusLine = document.getElementById("status-line") as HTMLDivElement;
const trayRow = document.getElementById("tray-row") as HTMLDivElement;
const addItemPanel = document.getElementById("add-item-panel") as HTMLDivElement;
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const itemTray = document.getElementById("item-tray") as HTMLDivElement;
const searchInput = document.getElementById("search-items") as HTMLInputElement;
const addBtn = document.getElementById("add-btn") as HTMLButtonElement;
const dropZone = document.getElementById("drop-zone") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const itemNameInput = document.getElementById("item-name") as HTMLInputElement;
const uploadBtn = document.getElementById("upload-btn") as HTMLButtonElement;
const uploadStatus = document.getElementById("upload-status") as HTMLDivElement;

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("error");

  const { user } = await getCurrentUser();

  if (!user) {
    renderLoginGate(authError);
    return;
  }

  loginGate.classList.add("hidden");
  startEditor(user.email);
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

function startEditor(email: string): void {
  const engine = new Engine(canvas, true);

  let selectedItem: DecorItem | Barrier | null = null;
  let selectedKind: "decor" | "barrier" | null = null;
  let editingEnabled = false;
  let armedImageUrl: string | null = null;
  let libraryImages: UploadedImage[] = [];
  let pendingFile: File | null = null;

  const setStatus = (message: string) => {
    statusLine.textContent = message;
    statusLine.classList.remove("hidden");
  };

  const editor = new WorldEditor(engine, canvas, {
    onSelectionChange: (item, kind) => {
      selectedItem = item;
      selectedKind = kind;
      renderSelectionToolbar();
    },
    onStatusChange: setStatus,
    onHistoryChange: (canUndo, canRedo) => {
      const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement | null;
      const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement | null;
      if (undoBtn) undoBtn.disabled = !canUndo;
      if (redoBtn) redoBtn.disabled = !canRedo;
    },
  });

  engine.runRenderLoop(() => {
    editor.render();
    updateSelectionToolbarPosition();
  });
  window.addEventListener("resize", () => engine.resize());

  window.addEventListener("keydown", (e) => {
    if (!editingEnabled) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT") return;

    if (e.shiftKey && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const direction = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const;
      editor.panView(direction[e.key as keyof typeof direction]);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      editor.deleteSelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && e.shiftKey) {
      editor.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      editor.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      editor.redo();
    } else if (e.key === "Escape") {
      setTool("select");
    }
  });

  function setTool(tool: "select" | "place" | "barrier", imageUrl?: string): void {
    editor.setTool(tool, imageUrl);
    armedImageUrl = tool === "place" ? (imageUrl ?? null) : null;
    const barrierBtn = document.getElementById("barrier-tool-btn") as HTMLButtonElement | null;
    if (barrierBtn) barrierBtn.classList.toggle("active", tool === "barrier");
    renderTray();
  }

  function enterEditMode(): void {
    editingEnabled = true;
    editor.setEditingEnabled(true);
    trayRow.classList.remove("hidden");
    addItemPanel.classList.remove("hidden");
    renderTopToolbarEditMode();
    void refreshLibrary();
  }

  function renderTopToolbarStart(): void {
    topToolbar.innerHTML = "";
    topToolbar.classList.remove("hidden");
    const openBtn = document.createElement("button");
    openBtn.textContent = "Open Editor";
    openBtn.onclick = enterEditMode;
    topToolbar.append(openBtn);
  }

  function renderTopToolbarEditMode(): void {
    topToolbar.innerHTML = "";

    const barrierBtn = document.createElement("button");
    barrierBtn.id = "barrier-tool-btn";
    barrierBtn.textContent = "Draw Barrier";
    barrierBtn.className = "secondary";
    barrierBtn.onclick = () => {
      const isActive = barrierBtn.classList.contains("active");
      setTool(isActive ? "select" : "barrier");
    };

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
    saveBtn.textContent = "Save Edit";
    saveBtn.onclick = async () => {
      setStatus("Saving...");
      try {
        await saveMap(editor.exportMap());
        setStatus("Saved.");
      } catch (err) {
        setStatus(`Save failed: ${(err as Error).message}`);
      }
    };

    const logoutBtn = document.createElement("button");
    logoutBtn.textContent = "Log out";
    logoutBtn.className = "secondary";
    logoutBtn.onclick = async () => {
      await logout();
      window.location.reload();
    };

    topToolbar.append(barrierBtn, undoBtn, redoBtn, saveBtn, logoutBtn);
  }

  function renderSelectionToolbar(): void {
    selectionToolbar.innerHTML = "";

    if (!selectedItem || !selectedKind) {
      selectionToolbar.classList.add("hidden");
      return;
    }

    const rotateBtn = document.createElement("button");
    rotateBtn.textContent = "Rotate";
    rotateBtn.className = "secondary";
    rotateBtn.onclick = () => editor.beginRotate();

    const resizeBtn = document.createElement("button");
    resizeBtn.textContent = "Resize";
    resizeBtn.className = "secondary";
    resizeBtn.onclick = () => editor.beginResize();

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "danger";
    deleteBtn.onclick = () => editor.deleteSelected();

    selectionToolbar.append(rotateBtn, resizeBtn);

    if (selectedKind === "decor") {
      const item = selectedItem as DecorItem;
      const layerSelect = document.createElement("select");
      for (const [value, label] of [
        ["behind", "Behind"],
        ["auto", "Auto"],
        ["front", "Front"],
      ] as const) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = item.layer === value;
        layerSelect.append(option);
      }
      layerSelect.onchange = () => {
        editor.updateSelected({ layer: layerSelect.value as DecorItem["layer"] });
        editor.commitHistory();
      };
      selectionToolbar.append(layerSelect);
    }

    selectionToolbar.append(deleteBtn);
  }

  function updateSelectionToolbarPosition(): void {
    if (!editingEnabled) {
      selectionToolbar.classList.add("hidden");
      return;
    }
    const pos = editor.getSelectedScreenPosition();
    if (!pos) {
      selectionToolbar.classList.add("hidden");
      return;
    }
    selectionToolbar.classList.remove("hidden");
    selectionToolbar.style.left = `${pos.x}px`;
    selectionToolbar.style.top = `${pos.y}px`;
  }

  const refreshLibrary = async () => {
    try {
      libraryImages = await listUploads();
    } catch {
      libraryImages = [];
    }
    renderTray();
  };

  function renderTray(): void {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = query
      ? libraryImages.filter((image) => image.originalName.toLowerCase().includes(query))
      : libraryImages;

    itemTray.innerHTML = "";

    if (filtered.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = libraryImages.length === 0 ? "No items yet — add one on the right." : "No matches.";
      itemTray.append(hint);
      return;
    }

    for (const image of filtered) {
      const thumb = document.createElement("img");
      thumb.src = resolveImageUrl(image.url);
      thumb.title = image.originalName;
      thumb.className = "tray-item";
      thumb.classList.toggle("selected", image.url === armedImageUrl);
      thumb.onclick = () => {
        setTool("place", image.url);
        setStatus(`Placing "${image.originalName}" — click the map to place it.`);
      };
      itemTray.append(thumb);
    }
  }

  setupTrayScrolling();
  setupDropZone();

  searchInput.oninput = () => renderTray();

  addBtn.onclick = () => fileInput.click();

  function setupTrayScrolling(): void {
    let dragging = false;
    let didDrag = false;
    let startX = 0;
    let startScroll = 0;

    itemTray.addEventListener("mousedown", (e) => {
      dragging = true;
      didDrag = false;
      startX = e.pageX;
      startScroll = itemTray.scrollLeft;
      itemTray.classList.add("dragging");
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.pageX - startX;
      if (Math.abs(dx) > 5) didDrag = true;
      itemTray.scrollLeft = startScroll - dx;
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      itemTray.classList.remove("dragging");
    });
    itemTray.addEventListener(
      "click",
      (e) => {
        if (didDrag) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
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
        await uploadImage(pendingFile, itemNameInput.value.trim() || undefined);
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

  getMap()
    .then((map) => {
      editor.loadMap(map);
      setStatus(`Loaded map: ${map.decor.length} decor, ${map.barriers.length} barriers`);
    })
    .catch((err: Error) => setStatus(`Could not load map: ${err.message}`));
}

void main();
