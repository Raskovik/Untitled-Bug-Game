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
const MIN_ORTHO_SIZE = 4;
const MAX_ORTHO_SIZE = 40;
const INITIAL_ORTHO_SIZE = 12;

/**
 * A Pony Town-style toolbox: each tool does exactly one job, chosen
 * explicitly before acting on the map (hammer=place, crowbar=move,
 * wand=duplicate, broom=delete) rather than a generic "select" tool with
 * contextual buttons.
 */
export type Tool = "hammer" | "crowbar" | "rotate" | "resize" | "wand" | "broom" | "barrier" | "inspect";
type SelectionKind = "decor" | "barrier" | null;
type DragMode = "move" | "rotate" | "resize";
export type PanDirection = "up" | "down" | "left" | "right";

export interface EditorCallbacks {
  onInspect: (item: DecorItem | Barrier | null, kind: SelectionKind) => void;
  onStatusChange: (message: string) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  onToolChange: (tool: Tool, armedImageUrl: string | null) => void;
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
  private tool: Tool = "crowbar";
  private armedImageUrl: string | null = null;
  private inspectedId: string | null = null;
  private inspectedKind: SelectionKind = null;
  private drawStart: { x: number; z: number } | null = null;
  private drawPreview: Mesh | null = null;
  private draggingId: string | null = null;
  private draggingKind: SelectionKind = null;
  private draggedDuringGesture = false;
  private dragMode: DragMode = "move";
  private resizeStart: ResizeStart | null = null;
  private history: WorldMapData[] = [];
  private historyIndex = -1;
  private editingEnabled = false;
  private highlightLayer: HighlightLayer;
  private hoveredId: string | null = null;
  private heldPanDirections = new Set<PanDirection>();
  private orthoSize = INITIAL_ORTHO_SIZE;
  private decorRotation: Quaternion;

  constructor(
    private engine: Engine,
    canvas: HTMLCanvasElement,
    private callbacks: EditorCallbacks
  ) {
    this.gameScene = createScene(engine, canvas);
    this.decorRotation = computeFixedFacingRotation(this.gameScene);
    this.highlightLayer = new HighlightLayer("hoverHighlight", this.gameScene.scene);
    this.setupPointerHandling();

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

  render(): void {
    this.applyContinuousPan();
    this.gameScene.scene.render();
  }

  setEditingEnabled(enabled: boolean): void {
    this.editingEnabled = enabled;
    if (!enabled) {
      this.clearInspection();
      this.clearHover();
      this.heldPanDirections.clear();
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

  get activeTool(): Tool {
    return this.tool;
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    if (tool !== "hammer") this.armedImageUrl = null;
    this.clearInspection();
    this.callbacks.onToolChange(this.tool, this.armedImageUrl);
  }

  /** Selects an image to place and switches to the hammer tool (repeatable placement, like Pony Town). */
  armHammer(imageUrl: string): void {
    this.tool = "hammer";
    this.armedImageUrl = imageUrl;
    this.clearInspection();
    this.callbacks.onToolChange(this.tool, this.armedImageUrl);
  }

  /** Places a decor item at the world position under canvas-relative screen coordinates (drag-and-drop from tray/OS). */
  placeDecorAt(screenX: number, screenY: number, imageUrl: string): void {
    const point = this.pickGroundPointAt(screenX, screenY);
    if (!point) return;
    this.placeDecor(point, imageUrl);
  }

  /** Deletes whatever is currently inspected, if anything (keyboard-shortcut convenience for the inspect tool). */
  deleteInspected(): void {
    if (!this.inspectedId) return;
    this.deleteItem(this.inspectedId, this.inspectedKind);
  }

  /** Pan the camera continuously while a direction key is held (WASD/arrows), like Pony Town's movement keys. */
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
      this.callbacks.onStatusChange("Duplicated");
      this.pushHistory();
    } else if (kind === "barrier") {
      const source = this.barriers.find((b) => b.id === id);
      if (!source) return;
      const clone: Barrier = { ...source, id: crypto.randomUUID(), x: source.x + DUPLICATE_OFFSET, z: source.z + DUPLICATE_OFFSET };
      this.barriers.push(clone);
      this.addBarrierMesh(clone);
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

  private clearInspection(): void {
    this.inspectedId = null;
    this.inspectedKind = null;
    this.callbacks.onInspect(null, null);
  }

  private clearHover(): void {
    if (!this.hoveredId) return;
    const mesh = this.decorMeshes.get(this.hoveredId) ?? this.barrierMeshes.get(this.hoveredId);
    if (mesh) this.highlightLayer.removeMesh(mesh);
    this.hoveredId = null;
  }

  private updateHover(): void {
    const mesh = this.pickAnyMesh();
    const id = (mesh?.metadata?.decorId as string | undefined) ?? (mesh?.metadata?.barrierId as string | undefined) ?? null;
    if (id === this.hoveredId) return;
    this.clearHover();
    if (id) {
      const newMesh = this.decorMeshes.get(id) ?? this.barrierMeshes.get(id);
      if (newMesh) {
        this.highlightLayer.addMesh(newMesh, HOVER_GLOW_COLOR);
        this.hoveredId = id;
      }
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

  private pickItem(): { id: string; kind: SelectionKind } | null {
    const mesh = this.pickAnyMesh();
    const decorId = mesh?.metadata?.decorId as string | undefined;
    const barrierId = mesh?.metadata?.barrierId as string | undefined;
    if (decorId) return { id: decorId, kind: "decor" };
    if (barrierId) return { id: barrierId, kind: "barrier" };
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
    if (this.tool === "hammer") {
      if (!this.armedImageUrl) return;
      const point = this.pickGroundPoint();
      if (!point) return;
      this.placeDecor(point, this.armedImageUrl);
      return;
    }

    if (this.tool === "barrier") {
      const point = this.pickGroundPoint();
      if (!point) return;
      this.drawStart = point;
      return;
    }

    const picked = this.pickItem();

    if (this.tool === "wand") {
      if (picked) this.duplicate(picked.id, picked.kind);
      return;
    }

    if (this.tool === "broom") {
      if (picked) this.deleteItem(picked.id, picked.kind);
      return;
    }

    if (this.tool === "inspect") {
      if (picked) {
        this.inspectedId = picked.id;
        this.inspectedKind = picked.kind;
        const item =
          picked.kind === "decor"
            ? (this.decorItems.find((d) => d.id === picked.id) ?? null)
            : (this.barriers.find((b) => b.id === picked.id) ?? null);
        this.callbacks.onInspect(item, picked.kind);
      } else {
        this.clearInspection();
      }
      return;
    }

    // crowbar / rotate / resize all start a drag on whatever was clicked.
    if (!picked) return;

    this.draggingId = picked.id;
    this.draggingKind = picked.kind;
    this.draggedDuringGesture = false;
    this.dragMode = this.tool === "rotate" ? "rotate" : this.tool === "resize" ? "resize" : "move";

    if (this.dragMode === "resize") {
      const center = this.itemCenter(picked.id, picked.kind);
      const point = this.pickGroundPoint();
      if (center && point) {
        const distance = Math.hypot(point.x - center.x, point.z - center.z) || 0.01;
        if (picked.kind === "decor") {
          const item = this.decorItems.find((d) => d.id === picked.id);
          this.resizeStart = { distance, decorScale: item?.scale ?? 1 };
        } else {
          const barrier = this.barriers.find((b) => b.id === picked.id);
          this.resizeStart = { distance, barrierWidth: barrier?.width ?? 1, barrierDepth: barrier?.depth ?? 1 };
        }
      }
    }
  }

  private handlePointerMove(): void {
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

    if (this.tool === "barrier" && this.drawStart) {
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

    if (this.tool !== "barrier" || !this.drawStart) return;

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
    // Rotate tool), then apply the fixed camera-facing rotation on top —
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
