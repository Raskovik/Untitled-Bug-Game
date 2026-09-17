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
import { WorldEditor, type Tool } from "./editor";

const TRAY_ITEM_MIME = "application/x-item-url";

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  {
    id: "select",
    label: "Select",
    hint: "Click an item to select it and drag to move — use the handles that appear to rotate or resize it.",
  },
  { id: "hammer", label: "Hammer", hint: "Pick an item below, then click the map to place it (repeatable)." },
  { id: "wand", label: "Clone", hint: "Click an item to duplicate it." },
  { id: "broom", label: "Delete", hint: "Click an item to remove it." },
  { id: "barrier", label: "Barrier", hint: "Click and drag on the ground to draw a collision rectangle." },
];

const loginGate = document.getElementById("login-gate") as HTMLDivElement;
const topToolbar = document.getElementById("top-toolbar") as HTMLDivElement;
const toolboxRow = document.getElementById("toolbox-row") as HTMLDivElement;
const inspectPanel = document.getElementById("inspect-panel") as HTMLDivElement;
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
  let armedImageUrl: string | null = null;

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
    },
    onToolChange: (tool, nextArmedImageUrl) => {
      armedImageUrl = nextArmedImageUrl;
      for (const btn of toolboxRow.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
        btn.classList.toggle("active", btn.dataset.tool === tool);
      }
      const hint = TOOLS.find((t) => t.id === tool)?.hint ?? "";
      setStatus(hint);
      renderTray(armedImageUrl);
    },
  });

  engine.runRenderLoop(() => editor.render());
  window.addEventListener("resize", () => engine.resize());

  const PAN_KEYS: Record<string, "up" | "down" | "left" | "right"> = {
    w: "up",
    arrowup: "up",
    s: "down",
    arrowdown: "down",
    a: "left",
    arrowleft: "left",
    d: "right",
    arrowright: "right",
  };

  window.addEventListener("keydown", (e) => {
    if (!editingEnabled) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT") return;

    const direction = PAN_KEYS[e.key.toLowerCase()];
    if (direction) {
      e.preventDefault();
      editor.setPanKeyState(direction, true);
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      editor.deleteInspected();
    } else if (e.key === "Escape") {
      editor.setTool("select");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && e.shiftKey) {
      editor.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      editor.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      editor.redo();
    }
  });

  window.addEventListener("keyup", (e) => {
    const direction = PAN_KEYS[e.key.toLowerCase()];
    if (direction) editor.setPanKeyState(direction, false);
  });

  function enterEditMode(): void {
    editingEnabled = true;
    editor.setEditingEnabled(true);
    toolboxRow.classList.remove("hidden");
    trayRow.classList.remove("hidden");
    addItemPanel.classList.remove("hidden");
    renderToolboxRow();
    renderTopToolbarEditMode();
    void refreshLibrary();

    // Showing the toolbox/tray/add-item panel shrinks the canvas's CSS size
    // (it shares space with them via flexbox), but that's not a window
    // resize event, so Babylon never resizes its internal render buffer to
    // match — leaving picking math using a stale resolution/aspect ratio
    // while rendering just visually stretches to fit. Force it explicitly.
    engine.resize();
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

    topToolbar.append(undoBtn, redoBtn, saveBtn, logoutBtn);
  }

  function renderToolboxRow(): void {
    toolboxRow.innerHTML = "";
    for (const tool of TOOLS) {
      const btn = document.createElement("button");
      btn.textContent = tool.label;
      btn.className = "secondary";
      btn.dataset.tool = tool.id;
      btn.classList.toggle("active", tool.id === "select");
      btn.onclick = () => editor.setTool(tool.id);
      toolboxRow.append(btn);
    }
  }

  function renderInspectPanel(): void {
    inspectPanel.innerHTML = "";

    if (!inspectedItem || inspectedKind !== "decor") {
      inspectPanel.classList.add("hidden");
      return;
    }

    const item = inspectedItem as DecorItem;
    const label = document.createElement("span");
    label.textContent = "Layer:";

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

    inspectPanel.classList.remove("hidden");
    inspectPanel.append(label, layerSelect);
  }

  const refreshLibrary = async () => {
    try {
      libraryImages = await listUploads();
    } catch {
      libraryImages = [];
    }
    renderTray(armedImageUrl);
  };

  function renderTray(armedImageUrl: string | null): void {
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
      thumb.classList.toggle("armed", image.url === armedImageUrl);
      thumb.draggable = true;
      thumb.ondragstart = (e) => {
        e.dataTransfer?.setData(TRAY_ITEM_MIME, image.url);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      };
      thumb.onclick = () => {
        editor.armHammer(image.url);
        setStatus(`Hammer holding "${image.originalName}" — click the map to place it.`);
      };
      itemTray.append(thumb);
    }
  }

  setupTrayScrolling();
  setupDropZone();
  setupCanvasDrop();

  searchInput.oninput = () => renderTray(armedImageUrl);

  addBtn.onclick = () => fileInput.click();

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
    });

    canvas.addEventListener("drop", (e) => {
      if (!editingEnabled) return;
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      const trayUrl = e.dataTransfer?.getData(TRAY_ITEM_MIME);
      if (trayUrl) {
        editor.placeDecorAt(screenX, screenY, trayUrl);
        return;
      }

      const file = e.dataTransfer?.files?.[0];
      if (!file) return;

      setStatus("Uploading...");
      uploadImage(file)
        .then(({ url }) => {
          editor.placeDecorAt(screenX, screenY, url);
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
