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
const sidebar = document.getElementById("sidebar") as HTMLDivElement;
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

const TOOL_HINTS: Record<string, string> = {
  select: "Click an item to select it. Drag to move it.",
  place: "Click the ground to place the image. Switch tools when done.",
  barrier: "Click and drag on the ground to draw a collision rectangle.",
};

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("error");

  const { user } = await getCurrentUser();

  if (!user) {
    renderLoginGate(authError);
    return;
  }

  loginGate.classList.add("hidden");
  sidebar.classList.remove("hidden");
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

  const setStatus = (message: string) => {
    const el = document.getElementById("status");
    if (el) el.textContent = message;
  };

  const editor = new WorldEditor(engine, canvas, {
    onSelectionChange: (item, kind) => {
      selectedItem = item;
      selectedKind = kind;
      renderSelectionPanel();
    },
    onStatusChange: setStatus,
    onHistoryChange: (canUndo, canRedo) => {
      const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement | null;
      const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement | null;
      if (undoBtn) undoBtn.disabled = !canUndo;
      if (redoBtn) redoBtn.disabled = !canRedo;
    },
  });

  engine.runRenderLoop(() => editor.render());
  window.addEventListener("resize", () => engine.resize());

  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT") return;

    if (e.key === "Delete" || e.key === "Backspace") {
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

  const handleSave = async () => {
    setStatus("Saving...");
    try {
      await saveMap(editor.exportMap());
      setStatus("Saved.");
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    }
  };

  function setTool(tool: "select" | "place" | "barrier", imageUrl?: string): void {
    editor.setTool(tool, imageUrl);
    const hint = document.getElementById("tool-hint");
    if (hint) hint.textContent = TOOL_HINTS[tool] ?? "";
    for (const btn of sidebar.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      btn.classList.toggle("active", btn.dataset.tool === tool);
    }
  }

  const refreshLibrary = async () => {
    const library = document.getElementById("image-library") as HTMLDivElement | null;
    if (!library) return;
    try {
      const images = await listUploads();
      renderImageLibrary(library, images, (url) => {
        setTool("place", url);
        setStatus("Click the ground to place it.");
      });
    } catch {
      // Image library is a convenience feature; silently skip if it can't load.
    }
  };

  buildSidebar(email, editor, setStatus, handleSave, setTool);
  void refreshLibrary();

  getMap()
    .then((map) => {
      editor.loadMap(map);
      setStatus(`Loaded map: ${map.decor.length} decor, ${map.barriers.length} barriers`);
    })
    .catch((err: Error) => setStatus(`Could not load map: ${err.message}`));

  function renderSelectionPanel(): void {
    const panel = document.getElementById("selection-panel") as HTMLDivElement;
    panel.innerHTML = "";

    if (!selectedItem || !selectedKind) {
      panel.textContent = "Nothing selected. Click an item on the map to edit it.";
      return;
    }

    const commit = () => editor.commitHistory();

    if (selectedKind === "decor") {
      const item = selectedItem as DecorItem;

      panel.append(
        positionFields(item.x, item.z, (x, z) => editor.updateSelected({ x, z }), commit),
        field(
          "Rotation",
          rangeInput(
            0,
            360,
            radToDeg(item.rotation),
            (deg) => editor.updateSelected({ rotation: degToRad(deg) }),
            1,
            commit
          )
        ),
        field(
          "Scale",
          rangeInput(0.2, 5, item.scale, (value) => editor.updateSelected({ scale: value }), 0.1, commit)
        ),
        field(
          "Layer",
          selectInput(
            [
              ["behind", "Behind"],
              ["auto", "Auto (Y-sort)"],
              ["front", "Front"],
            ],
            item.layer,
            (value) => {
              editor.updateSelected({ layer: value as DecorItem["layer"] });
              commit();
            }
          )
        )
      );
    } else {
      const barrier = selectedItem as Barrier;
      panel.append(
        positionFields(barrier.x, barrier.z, (x, z) => editor.updateSelected({ x, z }), commit),
        field(
          "Width",
          numberInput(barrier.width, (value) => editor.updateSelected({ width: value }), commit, 0.1)
        ),
        field(
          "Depth",
          numberInput(barrier.depth, (value) => editor.updateSelected({ depth: value }), commit, 0.1)
        ),
        field(
          "Rotation",
          rangeInput(
            0,
            360,
            radToDeg(barrier.rotation),
            (deg) => editor.updateSelected({ rotation: degToRad(deg) }),
            1,
            commit
          )
        )
      );
    }

    const actions = document.createElement("div");
    actions.className = "action-row";

    const duplicateButton = document.createElement("button");
    duplicateButton.textContent = "Duplicate";
    duplicateButton.className = "secondary";
    duplicateButton.onclick = () => editor.duplicateSelected();

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.className = "danger";
    deleteButton.onclick = () => editor.deleteSelected();

    actions.append(duplicateButton, deleteButton);
    panel.append(actions);
  }

  function buildSidebar(
    userEmail: string,
    worldEditor: WorldEditor,
    status: (message: string) => void,
    onSave: () => void,
    onSetTool: (tool: "select" | "place" | "barrier", imageUrl?: string) => void
  ): void {
    sidebar.innerHTML = "";

    const heading = document.createElement("h1");
    heading.textContent = "World Editor";

    const userLine = document.createElement("div");
    userLine.style.fontSize = "12px";
    userLine.style.color = "#9aa0a6";
    userLine.textContent = userEmail;

    const logoutButton = document.createElement("button");
    logoutButton.textContent = "Log out";
    logoutButton.className = "secondary";
    logoutButton.style.marginTop = "8px";
    logoutButton.onclick = async () => {
      await logout();
      window.location.reload();
    };

    sidebar.append(heading, userLine, logoutButton);

    const historyRow = document.createElement("div");
    historyRow.className = "action-row";
    historyRow.style.marginTop = "16px";

    const undoBtn = document.createElement("button");
    undoBtn.id = "undo-btn";
    undoBtn.textContent = "Undo";
    undoBtn.className = "secondary";
    undoBtn.disabled = true;
    undoBtn.onclick = () => worldEditor.undo();

    const redoBtn = document.createElement("button");
    redoBtn.id = "redo-btn";
    redoBtn.textContent = "Redo";
    redoBtn.className = "secondary";
    redoBtn.disabled = true;
    redoBtn.onclick = () => worldEditor.redo();

    historyRow.append(undoBtn, redoBtn);
    sidebar.append(historyRow);

    const toolsHeading = document.createElement("h2");
    toolsHeading.textContent = "Tool";
    sidebar.append(toolsHeading);

    const selectBtn = toolButton("Select / Move", "select", () => onSetTool("select"));
    const barrierBtn = toolButton("Draw Barrier", "barrier", () => onSetTool("barrier"));
    selectBtn.classList.add("active");
    sidebar.append(selectBtn, barrierBtn);

    const hint = document.createElement("div");
    hint.id = "tool-hint";
    hint.textContent = TOOL_HINTS.select;
    sidebar.append(hint);

    const uploadHeading = document.createElement("h2");
    uploadHeading.textContent = "Add Decor";
    sidebar.append(uploadHeading);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.marginBottom = "8px";
    fileInput.style.width = "100%";

    const uploadBtn = document.createElement("button");
    uploadBtn.textContent = "Upload & Place";
    uploadBtn.onclick = async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        status("Choose an image file first.");
        return;
      }
      status("Uploading...");
      try {
        const { url } = await uploadImage(file);
        onSetTool("place", url);
        status("Click the ground to place it.");
        fileInput.value = "";
        void refreshLibrary();
      } catch (err) {
        status(`Upload failed: ${(err as Error).message}`);
      }
    };

    sidebar.append(fileInput, uploadBtn);

    const libraryHeading = document.createElement("h2");
    libraryHeading.textContent = "Your Images";
    const library = document.createElement("div");
    library.id = "image-library";
    library.className = "thumb-grid";
    library.textContent = "No images uploaded yet.";
    sidebar.append(libraryHeading, library);

    const selectionHeading = document.createElement("h2");
    selectionHeading.textContent = "Selected";
    const selectionPanel = document.createElement("div");
    selectionPanel.id = "selection-panel";
    selectionPanel.textContent = "Nothing selected. Click an item on the map to edit it.";
    sidebar.append(selectionHeading, selectionPanel);

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save Map";
    saveBtn.style.marginTop = "20px";
    saveBtn.onclick = onSave;
    sidebar.append(saveBtn);

    const statusEl = document.createElement("div");
    statusEl.id = "status";
    sidebar.append(statusEl);
  }
}

function renderImageLibrary(
  container: HTMLDivElement,
  images: UploadedImage[],
  onPick: (url: string) => void
): void {
  container.innerHTML = "";

  if (images.length === 0) {
    container.textContent = "No images uploaded yet.";
    return;
  }

  for (const image of images) {
    const thumb = document.createElement("img");
    thumb.src = resolveImageUrl(image.url);
    thumb.title = image.originalName;
    thumb.className = "thumb";
    thumb.onclick = () => onPick(image.url);
    container.append(thumb);
  }
}

function toolButton(label: string, tool: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.className = "secondary";
  button.dataset.tool = tool;
  button.style.marginBottom = "8px";
  button.onclick = onClick;
  return button;
}

function field(labelText: string, input: HTMLElement): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  wrapper.append(label, input);
  return wrapper;
}

function positionFields(
  x: number,
  z: number,
  onChange: (x: number, z: number) => void,
  onCommit: () => void
): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const label = document.createElement("label");
  label.textContent = "Position (X, Z)";

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "6px";

  const xInput = document.createElement("input");
  xInput.type = "number";
  xInput.step = "0.1";
  xInput.value = x.toFixed(1);

  const zInput = document.createElement("input");
  zInput.type = "number";
  zInput.step = "0.1";
  zInput.value = z.toFixed(1);

  const handleInput = () => onChange(Number(xInput.value), Number(zInput.value));
  xInput.oninput = handleInput;
  zInput.oninput = handleInput;
  xInput.onchange = onCommit;
  zInput.onchange = onCommit;

  row.append(xInput, zInput);
  wrapper.append(label, row);
  return wrapper;
}

function rangeInput(
  min: number,
  max: number,
  value: number,
  onChange: (value: number) => void,
  step: number,
  onCommit: () => void
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.oninput = () => onChange(Number(input.value));
  input.onchange = onCommit;
  return input;
}

function numberInput(
  value: number,
  onChange: (value: number) => void,
  onCommit: () => void,
  step = 1
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = String(step);
  input.value = String(value);
  input.oninput = () => onChange(Number(input.value));
  input.onchange = onCommit;
  return input;
}

function selectInput(
  options: [string, string][],
  value: string,
  onChange: (value: string) => void
): HTMLSelectElement {
  const select = document.createElement("select");
  for (const [optValue, label] of options) {
    const option = document.createElement("option");
    option.value = optValue;
    option.textContent = label;
    option.selected = optValue === value;
    select.append(option);
  }
  select.onchange = () => onChange(select.value);
  return select;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

void main();
