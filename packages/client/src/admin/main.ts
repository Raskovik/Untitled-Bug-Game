import { Engine } from "@babylonjs/core";
import type { Barrier, DecorItem } from "@bug-game/shared";
import { getCurrentUser, getMap, googleLoginUrl, logout, saveMap, uploadImage } from "./api";
import { WorldEditor } from "./editor";

const loginGate = document.getElementById("login-gate") as HTMLDivElement;
const sidebar = document.getElementById("sidebar") as HTMLDivElement;
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

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
  });

  engine.runRenderLoop(() => editor.render());
  window.addEventListener("resize", () => engine.resize());

  const handleSave = async () => {
    setStatus("Saving...");
    try {
      await saveMap(editor.exportMap());
      setStatus("Saved.");
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    }
  };

  buildSidebar(email, editor, setStatus, handleSave);

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
      panel.textContent = "Nothing selected.";
      return;
    }

    if (selectedKind === "decor") {
      const item = selectedItem as DecorItem;

      panel.append(
        field(
          "Rotation",
          rangeInput(0, 360, radToDeg(item.rotation), (deg) => {
            editor.updateSelected({ rotation: degToRad(deg) });
          })
        ),
        field(
          "Scale",
          rangeInput(
            0.2,
            5,
            item.scale,
            (value) => editor.updateSelected({ scale: value }),
            0.1
          )
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
            (value) => editor.updateSelected({ layer: value as DecorItem["layer"] })
          )
        )
      );
    } else {
      const barrier = selectedItem as Barrier;
      panel.append(
        field(
          "Rotation",
          rangeInput(0, 360, radToDeg(barrier.rotation), (deg) => {
            editor.updateSelected({ rotation: degToRad(deg) });
          })
        )
      );
    }

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.className = "danger";
    deleteButton.style.marginTop = "8px";
    deleteButton.onclick = () => editor.deleteSelected();
    panel.append(deleteButton);
  }
}

function buildSidebar(
  email: string,
  editor: WorldEditor,
  setStatus: (message: string) => void,
  handleSave: () => void
): void {
  sidebar.innerHTML = "";

  const heading = document.createElement("h1");
  heading.textContent = "World Editor";

  const userLine = document.createElement("div");
  userLine.style.fontSize = "12px";
  userLine.style.color = "#9aa0a6";
  userLine.textContent = email;

  const logoutButton = document.createElement("button");
  logoutButton.textContent = "Log out";
  logoutButton.className = "secondary";
  logoutButton.style.marginTop = "8px";
  logoutButton.onclick = async () => {
    await logout();
    window.location.reload();
  };

  sidebar.append(heading, userLine, logoutButton);

  const toolsHeading = document.createElement("h2");
  toolsHeading.textContent = "Tool";
  sidebar.append(toolsHeading);

  sidebar.append(
    toolButton("Select / Edit", () => editor.setTool("select")),
    toolButton("Draw Barrier", () => editor.setTool("barrier"))
  );

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
      setStatus("Choose an image file first.");
      return;
    }
    setStatus("Uploading...");
    try {
      const { url } = await uploadImage(file);
      editor.setTool("place", url);
      setStatus("Click the ground to place it. Switch tool to stop placing.");
    } catch (err) {
      setStatus(`Upload failed: ${(err as Error).message}`);
    }
  };

  sidebar.append(fileInput, uploadBtn);

  const selectionHeading = document.createElement("h2");
  selectionHeading.textContent = "Selected";
  const selectionPanel = document.createElement("div");
  selectionPanel.id = "selection-panel";
  selectionPanel.textContent = "Nothing selected.";
  sidebar.append(selectionHeading, selectionPanel);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save Map";
  saveBtn.style.marginTop = "20px";
  saveBtn.onclick = handleSave;
  sidebar.append(saveBtn);

  const status = document.createElement("div");
  status.id = "status";
  sidebar.append(status);
}

function toolButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.className = "secondary";
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

function rangeInput(
  min: number,
  max: number,
  value: number,
  onChange: (value: number) => void,
  step = 1
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.oninput = () => onChange(Number(input.value));
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
