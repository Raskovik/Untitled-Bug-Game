import {
  Color3,
  Engine,
  HighlightLayer,
  Material,
  Matrix,
  Mesh,
  MeshBuilder,
  type PickingInfo,
  PointerEventTypes,
  Quaternion,
  StandardMaterial,
  type SubMesh,
  Texture,
  Vector3,
} from "@babylonjs/core";
import type { Barrier, DecorItem, DecorLayer, WorldMapData } from "@bug-game/shared";
import { createScene, type GameScene } from "../scene";
import { resolveImageUrl } from "./api";

const DECOR_SIZE = 3;
const LAYER_RENDER_GROUP: Record<DecorLayer, number> = { behind: 0, auto: 1, front: 2 };
const BARRIER_HEIGHT = 0.05;
const DUPLICATE_OFFSET = 1.5;
const HISTORY_LIMIT = 100;
const HOVER_GLOW_COLOR = new Color3(1, 1, 1);
const ALPHA_HIT_THRESHOLD = 32; // 0-255; pixels less opaque than this don't register hover/click
const MIN_SCALE = 0.2;
const MAX_SCALE = 6;
const PAN_SPEED = 12; // world units per second
const NUDGE_STEP = 0.1; // world units per arrow-key press
const MIN_ORTHO_SIZE = 4;
const MAX_ORTHO_SIZE = 40;
const INITIAL_ORTHO_SIZE = 12;
const HANDLE_SIZE = 0.5;
const HANDLE_HEIGHT = 1.2;
const HANDLE_MARGIN = 0.8;
const ROTATE_HANDLE_COLOR = new Color3(0.3, 0.9, 1);
const RESIZE_HANDLE_COLOR = new Color3(1, 0.55, 0.15);
const DELETE_HANDLE_COLOR = new Color3(0.9, 0.2, 0.2);
const GHOST_ALPHA = 0.55;

export const DECORATE_BASE_HINT =
  "Drag an item from the tray onto the map to place it. Click an item to select it, or drag on empty ground to pan.";
export const BARRIER_BASE_HINT = "Click and drag on empty ground to draw a barrier. Click an existing barrier to select it.";

const HANDLE_HINTS: Record<HandleType, string> = {
  rotate: "Drag to rotate.",
  resize: "Drag to resize.",
  delete: "Click to delete.",
};

/**
 * Two clear modes rather than a toolbox of one-off tools: Decorate mode is
 * always "select" behavior (hover/click/drag an item, or drag from the
 * palette to place one), and Barrier mode is the same select/drag behavior
 * scoped to barriers, plus drawing a new one on empty ground.
 */
export type EditorMode = "decorate" | "barrier";
type ItemKind = "decor" | "barrier";
type SelectionKind = ItemKind | null;
type DragMode = "move" | "rotate" | "resize";
type HandleType = "rotate" | "resize" | "delete";
export type PanDirection = "up" | "down" | "left" | "right";

export interface EditorCallbacks {
  onInspect: (item: DecorItem | Barrier | null, kind: SelectionKind) => void;
  onStatusChange: (message: string) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  onModeChange: (mode: EditorMode) => void;
}

interface ResizeStart {
  distance: number;
  decorScale?: number;
  barrierWidth?: number;
  barrierDepth?: number;
}

interface AlphaMask {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Per-URL cache of each decor image's alpha channel, read once via an
 * offscreen canvas (not GPU texture readback, which is async/slow). Used so
 * hover/click only register on visibly opaque pixels, not the sprite
 * plane's full transparent bounding square.
 */
const alphaMaskCache = new Map<string, AlphaMask | null>();
const alphaMaskLoading = new Set<string>();

function ensureAlphaMask(url: string): void {
  if (alphaMaskCache.has(url) || alphaMaskLoading.has(url)) return;
  alphaMaskLoading.add(url);

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      alphaMaskCache.set(url, { width: canvas.width, height: canvas.height, data: imageData.data });
    } catch {
      alphaMaskCache.set(url, null);
    } finally {
      alphaMaskLoading.delete(url);
    }
  };
  img.onerror = () => {
    alphaMaskCache.set(url, null);
    alphaMaskLoading.delete(url);
  };
  img.src = url;
}

/** True unless the mask says this exact pixel is (close to) fully transparent. Fails open while loading. */
function isOpaqueAt(url: string, u: number, v: number): boolean {
  const mask = alphaMaskCache.get(url);
  if (mask === undefined || mask === null) return true;
  const x = clamp(Math.floor(u * mask.width), 0, mask.width - 1);
  const y = clamp(Math.floor((1 - v) * mask.height), 0, mask.height - 1);
  const alpha = mask.data[(y * mask.width + x) * 4 + 3];
  return alpha >= ALPHA_HIT_THRESHOLD;
}

/**
 * Babylon's dynamic `billboardMode` injects rotation directly into each
 * frame's render-time world matrix without ever writing it back to
 * `mesh.rotationQuaternion`. Rendering looks correct, but picking's
 * bounding/intersection math reads `rotationQuaternion` and sees identity —
 * so a billboarded decor sprite renders in the right place but is
 * unpickable. Since this camera's angle never changes, the "face the
 * camera" rotation is a constant: compute it once via a throwaway
 * billboarded probe and apply it to every decor mesh as a real static
 * rotation instead, which both renders and picks correctly.
 */
function computeFixedFacingRotation(gameScene: GameScene): Quaternion {
  const probe = MeshBuilder.CreatePlane("__billboard_probe", { size: 1 }, gameScene.scene);
  probe.billboardMode = Mesh.BILLBOARDMODE_ALL;
  probe.computeWorldMatrix(true);
  const scale = new Vector3();
  const rotation = new Quaternion();
  const translation = new Vector3();
  probe.getWorldMatrix().decompose(scale, rotation, translation);
  probe.dispose();
  return rotation;
}

export class WorldEditor {
  private gameScene: GameScene;
  private decorMeshes = new Map<string, Mesh>();
  private barrierMeshes = new Map<string, Mesh>();
  private decorItems: DecorItem[] = [];
  private barriers: Barrier[] = [];
  private mode: EditorMode = "decorate";
  private showBarriersInDecorate = false;
  private inspectedId: string | null = null;
  private inspectedKind: SelectionKind = null;
  private rotateHandle: Mesh | null = null;
  private resizeHandle: Mesh | null = null;
  private deleteHandle: Mesh | null = null;
  private drawStart: { x: number; z: number } | null = null;
  private drawPreview: Mesh | null = null;
  private draggingId: string | null = null;
  private draggingKind: SelectionKind = null;
  private draggedDuringGesture = false;
  private dragMode: DragMode = "move";
  private resizeStart: ResizeStart | null = null;
  private isPanningCamera = false;
  private panAnchorWorld: { x: number; z: number } | null = null;
  private ghostMesh: Mesh | null = null;
  private ghostImageUrl: string | null = null;
  private history: WorldMapData[] = [];
  private historyIndex = -1;
  private editingEnabled = false;
  private highlightLayer: HighlightLayer;
  private hoveredId: string | null = null;
  private lastHint: string | null = null;
  private lastCursor: string | null = null;
  private heldPanDirections = new Set<PanDirection>();
  private orthoSize = INITIAL_ORTHO_SIZE;
  private decorRotation: Quaternion;
  private viewDirection: Vector3;

  constructor(
    private engine: Engine,
    private canvas: HTMLCanvasElement,
    private callbacks: EditorCallbacks
  ) {
    this.gameScene = createScene(engine, canvas);
    this.decorRotation = computeFixedFacingRotation(this.gameScene);
    this.viewDirection = this.gameScene.camera.getDirection(Vector3.Forward());
    this.highlightLayer = new HighlightLayer("hoverHighlight", this.gameScene.scene);
    this.setupPointerHandling();

    // Painter's-algorithm depth sort (farthest first) for every decor
    // rendering group, rather than the raw GPU depth test: a billboarded
    // sprite's tall quad can extend closer to the camera than a shorter
    // sprite anchored slightly further back, which the depth buffer alone
    // would render in the wrong stacking order. Sorting by each sprite's
    // actual position (not per-pixel depth) keeps "further back = drawn
    // behind" consistent no matter how tall/short two overlapping sprites
    // are.
    for (const groupId of Object.values(LAYER_RENDER_GROUP)) {
      this.gameScene.scene.setRenderingOrder(groupId, this.depthSortCompare, this.depthSortCompare, this.depthSortCompare);
    }

    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.editingEnabled) return;
        e.preventDefault();
        this.zoomBy(e.deltaY);
      },
      { passive: false }
    );
  }

  get scene() {
    return this.gameScene.scene;
  }

  get activeMode(): EditorMode {
    return this.mode;
  }

  render(): void {
    this.applyContinuousPan();
    this.updateHandlePositions();
    this.gameScene.scene.render();
  }

  setEditingEnabled(enabled: boolean): void {
    this.editingEnabled = enabled;
    if (!enabled) {
      this.clearInspection();
      this.clearHover();
      this.heldPanDirections.clear();
      this.isPanningCamera = false;
      this.panAnchorWorld = null;
      this.drawStart = null;
      this.drawPreview?.dispose();
      this.drawPreview = null;
      this.hidePlacementGhost();
    }
  }

  loadMap(data: WorldMapData): void {
    this.applyMapData(data);
    this.history = [this.snapshot()];
    this.historyIndex = 0;
    this.notifyHistoryChange();
  }

  exportMap(): WorldMapData {
    return { decor: this.decorItems, barriers: this.barriers };
  }

  setMode(mode: EditorMode): void {
    this.mode = mode;
    this.clearInspection();
    this.drawStart = null;
    this.drawPreview?.dispose();
    this.drawPreview = null;
    this.updateBarrierVisibility();
    this.lastHint = null;
    this.callbacks.onModeChange(mode);
  }

  setShowBarriers(show: boolean): void {
    this.showBarriersInDecorate = show;
    this.updateBarrierVisibility();
  }

  /** Places a decor item at the world position under canvas-relative screen coordinates (drag-and-drop from the palette). */
  placeDecorAt(screenX: number, screenY: number, imageUrl: string): void {
    const point = this.pickGroundPointAt(screenX, screenY);
    if (!point) return;
    this.placeDecor(point, imageUrl);
  }

  /** Shows/updates a semi-transparent preview of the dragged palette item at the given canvas-relative screen position. */
  showPlacementGhost(screenX: number, screenY: number, imageUrl: string): void {
    const point = this.pickGroundPointAt(screenX, screenY);
    if (!point) {
      this.hidePlacementGhost();
      return;
    }
    const resolvedUrl = resolveImageUrl(imageUrl);
    if (!this.ghostMesh || this.ghostImageUrl !== resolvedUrl) {
      this.hidePlacementGhost();
      this.ghostMesh = this.createGhostMesh(resolvedUrl);
      this.ghostImageUrl = resolvedUrl;
    }
    this.ghostMesh.position.set(point.x, DECOR_SIZE / 2, point.z);
  }

  hidePlacementGhost(): void {
    this.ghostMesh?.dispose();
    this.ghostMesh = null;
    this.ghostImageUrl = null;
  }

  /** Deselects whatever's currently inspected, if anything. */
  deselect(): void {
    this.clearInspection();
  }

  /** Deletes whatever is currently inspected, if anything (keyboard-shortcut convenience). */
  deleteInspected(): void {
    if (!this.inspectedId) return;
    this.deleteItem(this.inspectedId, this.inspectedKind);
  }

  /** Duplicates whatever is currently inspected, if anything (Ctrl+D convenience), and selects the new copy. */
  duplicateInspected(): void {
    if (!this.inspectedId) return;
    this.duplicate(this.inspectedId, this.inspectedKind);
  }

  /** Nudges the currently-selected item by one small step in a screen-relative direction (arrow-key convenience). */
  nudgeSelected(direction: PanDirection): void {
    if (!this.inspectedId) return;
    const center = this.itemCenter(this.inspectedId, this.inspectedKind);
    if (!center) return;
    const { right, forward } = this.groundPanAxes();
    const axis = direction === "up" || direction === "down" ? forward : right;
    const sign = direction === "up" || direction === "right" ? 1 : -1;
    this.setItemPatch(this.inspectedId, this.inspectedKind, {
      x: center.x + axis.x * sign * NUDGE_STEP,
      z: center.z + axis.z * sign * NUDGE_STEP,
    });
    this.pushHistory();
  }

  /** Pan the camera continuously while a direction key is held (WASD), like Pony Town's movement keys. */
  setPanKeyState(direction: PanDirection, pressed: boolean): void {
    if (pressed) this.heldPanDirections.add(direction);
    else this.heldPanDirections.delete(direction);
  }

  zoomBy(wheelDeltaY: number): void {
    const factor = Math.exp(wheelDeltaY * 0.001);
    this.orthoSize = clamp(this.orthoSize * factor, MIN_ORTHO_SIZE, MAX_ORTHO_SIZE);
    this.gameScene.setOrthoSize(this.orthoSize);
  }

  updateInspected(patch: Partial<DecorItem> | Partial<Barrier>): void {
    if (!this.inspectedId) return;

    if (this.inspectedKind === "decor") {
      const item = this.decorItems.find((d) => d.id === this.inspectedId);
      if (!item) return;
      Object.assign(item, patch);
      this.refreshDecorMesh(item);
    } else if (this.inspectedKind === "barrier") {
      const barrier = this.barriers.find((b) => b.id === this.inspectedId);
      if (!barrier) return;
      Object.assign(barrier, patch);
      this.refreshBarrierMesh(barrier);
    }
  }

  commitHistory(): void {
    this.pushHistory();
  }

  undo(): void {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this.applyMapData(this.history[this.historyIndex]);
    this.notifyHistoryChange();
  }

  redo(): void {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this.applyMapData(this.history[this.historyIndex]);
    this.notifyHistoryChange();
  }

  private depthSortCompare = (a: SubMesh, b: SubMesh): number => {
    const distA = Vector3.Dot(
      a.getBoundingInfo().boundingSphere.centerWorld.subtract(this.gameScene.camera.position),
      this.viewDirection
    );
    const distB = Vector3.Dot(
      b.getBoundingInfo().boundingSphere.centerWorld.subtract(this.gameScene.camera.position),
      this.viewDirection
    );
    return distB - distA;
  };

  private createGhostMesh(resolvedUrl: string): Mesh {
    const mesh = MeshBuilder.CreatePlane("placement-ghost", { size: DECOR_SIZE }, this.gameScene.scene);
    mesh.isPickable = false;
    mesh.renderingGroupId = 3;
    mesh.rotationQuaternion = this.decorRotation;

    const material = new StandardMaterial("placement-ghost-mat", this.gameScene.scene);
    const texture = new Texture(resolvedUrl, this.gameScene.scene);
    texture.hasAlpha = true;
    material.diffuseTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    material.alpha = GHOST_ALPHA;
    material.backFaceCulling = false;
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    material.emissiveColor = Color3.White();
    mesh.material = material;

    return mesh;
  }

  private placeDecor(point: { x: number; z: number }, imageUrl: string): void {
    const item: DecorItem = {
      id: crypto.randomUUID(),
      imageUrl,
      x: point.x,
      z: point.z,
      rotation: 0,
      scale: 1,
      layer: "auto",
    };
    this.decorItems.push(item);
    this.addDecorMesh(item);
    this.selectItem(item.id, "decor");
    this.callbacks.onStatusChange(`Placed decor at (${point.x.toFixed(1)}, ${point.z.toFixed(1)})`);
    this.pushHistory();
  }

  private duplicate(id: string, kind: SelectionKind): void {
    if (kind === "decor") {
      const source = this.decorItems.find((d) => d.id === id);
      if (!source) return;
      const clone: DecorItem = { ...source, id: crypto.randomUUID(), x: source.x + DUPLICATE_OFFSET, z: source.z + DUPLICATE_OFFSET };
      this.decorItems.push(clone);
      this.addDecorMesh(clone);
      this.selectItem(clone.id, "decor");
      this.callbacks.onStatusChange("Duplicated");
      this.pushHistory();
    } else if (kind === "barrier") {
      const source = this.barriers.find((b) => b.id === id);
      if (!source) return;
      const clone: Barrier = { ...source, id: crypto.randomUUID(), x: source.x + DUPLICATE_OFFSET, z: source.z + DUPLICATE_OFFSET };
      this.barriers.push(clone);
      this.addBarrierMesh(clone);
      this.selectItem(clone.id, "barrier");
      this.callbacks.onStatusChange("Duplicated");
      this.pushHistory();
    }
  }

  private deleteItem(id: string, kind: SelectionKind): void {
    if (this.hoveredId === id) this.clearHover();
    if (this.inspectedId === id) this.clearInspection();

    if (kind === "decor") {
      this.decorMeshes.get(id)?.dispose();
      this.decorMeshes.delete(id);
      this.decorItems = this.decorItems.filter((d) => d.id !== id);
    } else if (kind === "barrier") {
      this.barrierMeshes.get(id)?.dispose();
      this.barrierMeshes.delete(id);
      this.barriers = this.barriers.filter((b) => b.id !== id);
    }
    this.callbacks.onStatusChange("Deleted");
    this.pushHistory();
  }

  private snapshot(): WorldMapData {
    return {
      decor: this.decorItems.map((item) => ({ ...item })),
      barriers: this.barriers.map((barrier) => ({ ...barrier })),
    };
  }

  private pushHistory(): void {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this.snapshot());
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this.notifyHistoryChange();
  }

  private notifyHistoryChange(): void {
    this.callbacks.onHistoryChange(this.historyIndex > 0, this.historyIndex < this.history.length - 1);
  }

  private applyMapData(data: WorldMapData): void {
    this.clearHover();
    for (const mesh of this.decorMeshes.values()) mesh.dispose();
    for (const mesh of this.barrierMeshes.values()) mesh.dispose();
    this.decorMeshes.clear();
    this.barrierMeshes.clear();

    this.decorItems = data.decor.map((item) => ({ ...item }));
    this.barriers = data.barriers.map((barrier) => ({ ...barrier }));

    for (const item of this.decorItems) this.addDecorMesh(item);
    for (const barrier of this.barriers) this.addBarrierMesh(barrier);

    this.clearInspection();
  }

  private selectItem(id: string, kind: ItemKind): void {
    this.inspectedId = id;
    this.inspectedKind = kind;
    const item =
      kind === "decor"
        ? (this.decorItems.find((d) => d.id === id) ?? null)
        : (this.barriers.find((b) => b.id === id) ?? null);
    this.callbacks.onInspect(item, kind);
    this.showHandles();
  }

  private clearInspection(): void {
    this.inspectedId = null;
    this.inspectedKind = null;
    this.hideHandles();
    this.callbacks.onInspect(null, null);
  }

  private showHandles(): void {
    this.hideHandles();
    // Barriers rotate around their own axis less usefully than decor
    // sprites do (they're axis-aligned collision rectangles), so only decor
    // gets a rotate handle — matches the spec's barrier control set
    // (move/resize/delete only).
    if (this.inspectedKind === "decor") {
      this.rotateHandle = this.createHandleMesh("rotate", ROTATE_HANDLE_COLOR);
    }
    this.resizeHandle = this.createHandleMesh("resize", RESIZE_HANDLE_COLOR);
    this.deleteHandle = this.createHandleMesh("delete", DELETE_HANDLE_COLOR);
    this.updateHandlePositions();
  }

  private hideHandles(): void {
    this.rotateHandle?.dispose();
    this.resizeHandle?.dispose();
    this.deleteHandle?.dispose();
    this.rotateHandle = null;
    this.resizeHandle = null;
    this.deleteHandle = null;
  }

  private createHandleMesh(type: HandleType, color: Color3): Mesh {
    const mesh = MeshBuilder.CreateSphere(`handle-${type}`, { diameter: HANDLE_SIZE }, this.gameScene.scene);
    mesh.metadata = { handleType: type };
    mesh.renderingGroupId = 3;
    const material = new StandardMaterial(`handle-mat-${type}`, this.gameScene.scene);
    material.disableLighting = true;
    material.emissiveColor = color;
    mesh.material = material;
    return mesh;
  }

  /** Keeps the rotate/resize/delete handles glued to the selected item every frame, including mid-drag. */
  private updateHandlePositions(): void {
    if (!this.inspectedId) return;
    const center = this.itemCenter(this.inspectedId, this.inspectedKind);
    if (!center) return;

    const radius = this.itemRadius(this.inspectedId, this.inspectedKind);
    const { right, forward } = this.groundPanAxes();
    if (this.rotateHandle) {
      this.rotateHandle.position.set(center.x + forward.x * radius, HANDLE_HEIGHT, center.z + forward.z * radius);
    }
    if (this.resizeHandle) {
      this.resizeHandle.position.set(center.x + right.x * radius, HANDLE_HEIGHT, center.z + right.z * radius);
    }
    if (this.deleteHandle) {
      this.deleteHandle.position.set(center.x - right.x * radius, HANDLE_HEIGHT, center.z - right.z * radius);
    }
  }

  private itemRadius(id: string, kind: SelectionKind): number {
    if (kind === "decor") {
      const item = this.decorItems.find((d) => d.id === id);
      return item ? (DECOR_SIZE / 2) * item.scale + HANDLE_MARGIN : 2;
    }
    if (kind === "barrier") {
      const barrier = this.barriers.find((b) => b.id === id);
      return barrier ? Math.max(barrier.width, barrier.depth) / 2 + HANDLE_MARGIN : 2;
    }
    return 2;
  }

  /**
   * Picks only the rotate/resize/delete handle meshes, ignoring everything
   * else in the scene. A generic nearest-hit pick would often lose to the
   * selected item's own (larger, camera-facing) sprite, which can visually
   * occlude a handle sitting right next to it — handles are UI controls and
   * should always win regardless of depth.
   */
  private pickHandleType(): HandleType | null {
    const { scene } = this.gameScene;
    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (mesh) => mesh === this.rotateHandle || mesh === this.resizeHandle || mesh === this.deleteHandle
    );
    if (!pick?.hit || !pick.pickedMesh) return null;
    return (pick.pickedMesh.metadata?.handleType as HandleType | undefined) ?? null;
  }

  private beginResizeGesture(id: string, kind: SelectionKind): void {
    const center = this.itemCenter(id, kind);
    const point = this.pickGroundPoint();
    if (!center || !point) return;
    const distance = Math.hypot(point.x - center.x, point.z - center.z) || 0.01;
    if (kind === "decor") {
      const item = this.decorItems.find((d) => d.id === id);
      this.resizeStart = { distance, decorScale: item?.scale ?? 1 };
    } else if (kind === "barrier") {
      const barrier = this.barriers.find((b) => b.id === id);
      this.resizeStart = { distance, barrierWidth: barrier?.width ?? 1, barrierDepth: barrier?.depth ?? 1 };
    }
  }

  private clearHover(): void {
    if (!this.hoveredId) return;
    const mesh = this.decorMeshes.get(this.hoveredId) ?? this.barrierMeshes.get(this.hoveredId);
    if (mesh) this.highlightLayer.removeMesh(mesh);
    this.hoveredId = null;
  }

  private setHint(text: string): void {
    if (text === this.lastHint) return;
    this.lastHint = text;
    this.callbacks.onStatusChange(text);
  }

  private setCursor(cursor: string): void {
    if (cursor === this.lastCursor) return;
    this.lastCursor = cursor;
    this.canvas.style.cursor = cursor;
  }

  private baseModeHint(): string {
    return this.mode === "barrier" ? BARRIER_BASE_HINT : DECORATE_BASE_HINT;
  }

  private updateHover(): void {
    const allowedKind: ItemKind = this.mode === "barrier" ? "barrier" : "decor";

    if (this.inspectedId) {
      const handleType = this.pickHandleType();
      if (handleType) {
        this.clearHover();
        this.setCursor("pointer");
        this.setHint(HANDLE_HINTS[handleType]);
        return;
      }
    }

    const mesh = this.pickAnyMesh();
    const decorId = mesh?.metadata?.decorId as string | undefined;
    const barrierId = mesh?.metadata?.barrierId as string | undefined;
    const id = (allowedKind === "decor" ? decorId : barrierId) ?? null;

    if (id !== this.hoveredId) {
      this.clearHover();
      if (id) {
        const newMesh = allowedKind === "decor" ? this.decorMeshes.get(id) : this.barrierMeshes.get(id);
        if (newMesh) {
          this.highlightLayer.addMesh(newMesh, HOVER_GLOW_COLOR);
          this.hoveredId = id;
        }
      }
    }

    if (id) {
      this.setCursor("pointer");
      this.setHint(id === this.inspectedId ? "Drag to move." : "Click to select — drag to move.");
    } else {
      this.setCursor(this.mode === "barrier" ? "crosshair" : "grab");
      this.setHint(this.baseModeHint());
    }
  }

  private setupPointerHandling(): void {
    const { scene } = this.gameScene;
    scene.onPointerObservable.add((pointerInfo) => {
      if (!this.editingEnabled) return;
      if (pointerInfo.type === PointerEventTypes.POINTERDOWN) this.handlePointerDown();
      else if (pointerInfo.type === PointerEventTypes.POINTERMOVE) this.handlePointerMove();
      else if (pointerInfo.type === PointerEventTypes.POINTERUP) this.handlePointerUp();
    });
  }

  private pickGroundPoint(): { x: number; z: number } | null {
    return this.pickGroundPointAt(this.gameScene.scene.pointerX, this.gameScene.scene.pointerY);
  }

  private pickGroundPointAt(screenX: number, screenY: number): { x: number; z: number } | null {
    const pick = this.gameScene.scene.pick(screenX, screenY, (mesh) => mesh === this.gameScene.ground);
    if (!pick?.hit || !pick.pickedPoint) return null;
    return { x: pick.pickedPoint.x, z: pick.pickedPoint.z };
  }

  private pickAnyMesh(): Mesh | null {
    const pick = this.gameScene.scene.pick(this.gameScene.scene.pointerX, this.gameScene.scene.pointerY);
    return this.resolveOpaquePick(pick);
  }

  /** Rejects a hit on a decor sprite's transparent padding, treating it as a miss. */
  private resolveOpaquePick(pick: PickingInfo | null): Mesh | null {
    if (!pick?.hit || !pick.pickedMesh) return null;
    const mesh = pick.pickedMesh as Mesh;

    const imageUrl = mesh.metadata?.imageUrl as string | undefined;
    if (!imageUrl) return mesh;

    const uv = pick.getTextureCoordinates();
    if (!uv) return mesh;

    return isOpaqueAt(imageUrl, uv.x, uv.y) ? mesh : null;
  }

  /** Picks only meshes of the given kind (decor items are ignored in barrier mode and vice versa). */
  private pickItem(allowed: ItemKind): { id: string; kind: ItemKind } | null {
    const mesh = this.pickAnyMesh();
    const decorId = mesh?.metadata?.decorId as string | undefined;
    const barrierId = mesh?.metadata?.barrierId as string | undefined;
    if (allowed === "decor" && decorId) return { id: decorId, kind: "decor" };
    if (allowed === "barrier" && barrierId) return { id: barrierId, kind: "barrier" };
    return null;
  }

  private itemCenter(id: string, kind: SelectionKind): { x: number; z: number } | null {
    if (kind === "decor") {
      const item = this.decorItems.find((d) => d.id === id);
      return item ? { x: item.x, z: item.z } : null;
    }
    if (kind === "barrier") {
      const barrier = this.barriers.find((b) => b.id === id);
      return barrier ? { x: barrier.x, z: barrier.z } : null;
    }
    return null;
  }

  private handlePointerDown(): void {
    if (this.mode === "barrier") {
      this.handleBarrierPointerDown();
    } else {
      this.handleDecoratePointerDown();
    }
  }

  private beginHandleDrag(handleType: HandleType): void {
    if (!this.inspectedId) return;
    if (handleType === "delete") {
      this.deleteItem(this.inspectedId, this.inspectedKind);
      return;
    }
    this.draggingId = this.inspectedId;
    this.draggingKind = this.inspectedKind;
    this.draggedDuringGesture = false;
    this.dragMode = handleType;
    if (handleType === "resize") this.beginResizeGesture(this.inspectedId, this.inspectedKind);
  }

  private handleDecoratePointerDown(): void {
    if (this.inspectedId && this.inspectedKind === "decor") {
      const handleType = this.pickHandleType();
      if (handleType) {
        this.beginHandleDrag(handleType);
        return;
      }
    }

    const picked = this.pickItem("decor");
    if (picked) {
      this.selectItem(picked.id, "decor");
      this.draggingId = picked.id;
      this.draggingKind = "decor";
      this.draggedDuringGesture = false;
      this.dragMode = "move";
      return;
    }

    this.clearInspection();
    const point = this.pickGroundPoint();
    if (point) {
      this.isPanningCamera = true;
      this.panAnchorWorld = point;
      this.setCursor("grabbing");
    }
  }

  private handleBarrierPointerDown(): void {
    if (this.inspectedId && this.inspectedKind === "barrier") {
      const handleType = this.pickHandleType();
      if (handleType) {
        this.beginHandleDrag(handleType);
        return;
      }
    }

    const picked = this.pickItem("barrier");
    if (picked) {
      this.selectItem(picked.id, "barrier");
      this.draggingId = picked.id;
      this.draggingKind = "barrier";
      this.draggedDuringGesture = false;
      this.dragMode = "move";
      return;
    }

    this.clearInspection();
    const point = this.pickGroundPoint();
    if (point) this.drawStart = point;
  }

  private handlePointerMove(): void {
    if (this.isPanningCamera) {
      if (!this.panAnchorWorld) return;
      const current = this.pickGroundPoint();
      if (!current) return;
      this.gameScene.camera.target.x += this.panAnchorWorld.x - current.x;
      this.gameScene.camera.target.z += this.panAnchorWorld.z - current.z;
      return;
    }

    if (this.draggingId) {
      const point = this.pickGroundPoint();
      if (!point) return;
      const kind = this.draggingKind;
      const id = this.draggingId;

      if (this.dragMode === "move") {
        this.moveItem(id, kind, point);
      } else if (this.dragMode === "rotate") {
        const center = this.itemCenter(id, kind);
        if (center) {
          const angle = Math.atan2(point.x - center.x, point.z - center.z);
          this.setItemPatch(id, kind, { rotation: angle });
        }
      } else if (this.dragMode === "resize" && this.resizeStart) {
        const center = this.itemCenter(id, kind);
        if (center) {
          const distance = Math.hypot(point.x - center.x, point.z - center.z);
          const factor = distance / this.resizeStart.distance;
          if (kind === "decor" && this.resizeStart.decorScale !== undefined) {
            this.setItemPatch(id, kind, { scale: clamp(this.resizeStart.decorScale * factor, MIN_SCALE, MAX_SCALE) });
          } else if (kind === "barrier" && this.resizeStart.barrierWidth !== undefined && this.resizeStart.barrierDepth !== undefined) {
            this.setItemPatch(id, kind, {
              width: Math.max(0.2, this.resizeStart.barrierWidth * factor),
              depth: Math.max(0.2, this.resizeStart.barrierDepth * factor),
            });
          }
        }
      }

      this.draggedDuringGesture = true;
      return;
    }

    if (this.mode === "barrier" && this.drawStart) {
      const point = this.pickGroundPoint();
      if (!point) return;

      this.drawPreview?.dispose();
      this.drawPreview = MeshBuilder.CreateGround(
        "barrier-preview",
        { width: Math.max(0.1, Math.abs(point.x - this.drawStart.x)), height: Math.max(0.1, Math.abs(point.z - this.drawStart.z)) },
        this.gameScene.scene
      );
      this.drawPreview.position.set((this.drawStart.x + point.x) / 2, BARRIER_HEIGHT, (this.drawStart.z + point.z) / 2);
      const material = new StandardMaterial("barrier-preview-mat", this.gameScene.scene);
      material.diffuseColor = new Color3(0.85, 0.2, 0.2);
      material.alpha = 0.4;
      this.drawPreview.material = material;
      return;
    }

    this.updateHover();
  }

  private handlePointerUp(): void {
    if (this.isPanningCamera) {
      this.isPanningCamera = false;
      this.panAnchorWorld = null;
      return;
    }

    if (this.draggingId) {
      if (this.draggedDuringGesture) {
        this.pushHistory();
        if (this.inspectedId === this.draggingId) {
          const item =
            this.inspectedKind === "decor"
              ? (this.decorItems.find((d) => d.id === this.inspectedId) ?? null)
              : (this.barriers.find((b) => b.id === this.inspectedId) ?? null);
          this.callbacks.onInspect(item, this.inspectedKind);
        }
      }
      this.draggingId = null;
      this.draggingKind = null;
      this.draggedDuringGesture = false;
      this.dragMode = "move";
      this.resizeStart = null;
      return;
    }

    if (this.mode !== "barrier" || !this.drawStart) return;

    const point = this.pickGroundPoint();
    this.drawPreview?.dispose();
    this.drawPreview = null;

    if (point) {
      const width = Math.abs(point.x - this.drawStart.x);
      const depth = Math.abs(point.z - this.drawStart.z);
      if (width > 0.3 && depth > 0.3) {
        const barrier: Barrier = {
          id: crypto.randomUUID(),
          x: (this.drawStart.x + point.x) / 2,
          z: (this.drawStart.z + point.z) / 2,
          width,
          depth,
          rotation: 0,
        };
        this.barriers.push(barrier);
        this.addBarrierMesh(barrier);
        this.selectItem(barrier.id, "barrier");
        this.callbacks.onStatusChange("Barrier added");
        this.pushHistory();
      }
    }

    this.drawStart = null;
  }

  private moveItem(id: string, kind: SelectionKind, point: { x: number; z: number }): void {
    this.setItemPatch(id, kind, { x: point.x, z: point.z });
  }

  private setItemPatch(id: string, kind: SelectionKind, patch: Partial<DecorItem> | Partial<Barrier>): void {
    if (kind === "decor") {
      const item = this.decorItems.find((d) => d.id === id);
      if (!item) return;
      Object.assign(item, patch);
      this.refreshDecorMesh(item);
    } else if (kind === "barrier") {
      const barrier = this.barriers.find((b) => b.id === id);
      if (!barrier) return;
      Object.assign(barrier, patch);
      this.refreshBarrierMesh(barrier);
    }
  }

  private applyContinuousPan(): void {
    if (this.heldPanDirections.size === 0) return;
    const dt = this.engine.getDeltaTime() / 1000;
    const step = PAN_SPEED * dt;
    const { right, forward } = this.groundPanAxes();
    let delta = Vector3.Zero();
    if (this.heldPanDirections.has("up")) delta = delta.add(forward.scale(step));
    if (this.heldPanDirections.has("down")) delta = delta.add(forward.scale(-step));
    if (this.heldPanDirections.has("left")) delta = delta.add(right.scale(-step));
    if (this.heldPanDirections.has("right")) delta = delta.add(right.scale(step));
    this.gameScene.camera.target.addInPlace(delta);
  }

  /**
   * The camera's right/"up on screen" directions, flattened onto the ground
   * plane (Y zeroed out) so panning always slides across the flat map —
   * like sliding a sheet of paper — instead of drifting off the fixed
   * viewing angle the way the raw camera-space vectors would.
   */
  private groundPanAxes(): { right: Vector3; forward: Vector3 } {
    const { camera } = this.gameScene;
    const rawRight = camera.getDirection(Vector3.Right());
    const rawUp = camera.getDirection(Vector3.Up());
    const right = new Vector3(rawRight.x, 0, rawRight.z).normalize();
    const forward = new Vector3(rawUp.x, 0, rawUp.z).normalize();
    return { right, forward };
  }

  private updateBarrierVisibility(): void {
    const visible = this.mode === "barrier" || this.showBarriersInDecorate;
    for (const mesh of this.barrierMeshes.values()) mesh.isVisible = visible;
  }

  private addDecorMesh(item: DecorItem): void {
    const resolvedUrl = resolveImageUrl(item.imageUrl);
    ensureAlphaMask(resolvedUrl);

    const mesh = MeshBuilder.CreatePlane(`decor-${item.id}`, { size: DECOR_SIZE }, this.gameScene.scene);
    mesh.metadata = { decorId: item.id, imageUrl: resolvedUrl };

    const material = new StandardMaterial(`decor-mat-${item.id}`, this.gameScene.scene);
    const texture = new Texture(resolvedUrl, this.gameScene.scene);
    texture.hasAlpha = true;
    material.diffuseTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
    // Alpha-TEST (cutout) rather than alpha-blend: fully transparent pixels
    // are discarded outright, so the hover glow's silhouette hugs the
    // sprite's actual opaque shape instead of the whole rectangular plane.
    material.transparencyMode = Material.MATERIAL_ALPHATEST;
    material.alphaCutOff = ALPHA_HIT_THRESHOLD / 255;
    material.backFaceCulling = false;
    material.specularColor = Color3.Black();
    // Depth WRITE off (depth test stays on) so the custom painter's-algorithm
    // sort above — not raw per-pixel GPU depth — decides stacking order
    // between overlapping sprites.
    material.disableDepthWrite = true;
    mesh.material = material;

    this.decorMeshes.set(item.id, mesh);
    this.refreshDecorMesh(item);
  }

  private refreshDecorMesh(item: DecorItem): void {
    const mesh = this.decorMeshes.get(item.id);
    if (!mesh) return;
    mesh.position.set(item.x, DECOR_SIZE / 2, item.z);
    mesh.scaling.setAll(item.scale);
    // Roll around the plane's own normal first (its in-place spin from the
    // rotate handle), then apply the fixed camera-facing rotation on top —
    // this keeps it always facing the camera while still visibly rotating.
    const roll = Quaternion.RotationAxis(Vector3.Forward(), item.rotation);
    mesh.rotationQuaternion = this.decorRotation.multiply(roll);
    mesh.renderingGroupId = LAYER_RENDER_GROUP[item.layer];
  }

  private addBarrierMesh(barrier: Barrier): void {
    const mesh = MeshBuilder.CreateGround(`barrier-${barrier.id}`, { width: 1, height: 1 }, this.gameScene.scene);
    mesh.metadata = { barrierId: barrier.id };

    const material = new StandardMaterial(`barrier-mat-${barrier.id}`, this.gameScene.scene);
    material.diffuseColor = new Color3(0.85, 0.2, 0.2);
    material.alpha = 0.4;
    mesh.material = material;

    this.barrierMeshes.set(barrier.id, mesh);
    this.refreshBarrierMesh(barrier);
    this.updateBarrierVisibility();
  }

  private refreshBarrierMesh(barrier: Barrier): void {
    const mesh = this.barrierMeshes.get(barrier.id);
    if (!mesh) return;
    mesh.position.set(barrier.x, BARRIER_HEIGHT, barrier.z);
    mesh.rotation.y = barrier.rotation;
    mesh.scaling.set(Math.max(0.01, barrier.width), 1, Math.max(0.01, barrier.depth));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
