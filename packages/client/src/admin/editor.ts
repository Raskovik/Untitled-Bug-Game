import {
  Color3,
  Engine,
  HighlightLayer,
  Matrix,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
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
const HOVER_GLOW_COLOR = new Color3(1, 0.9, 0.3);
const MIN_SCALE = 0.2;
const MAX_SCALE = 6;
const KEY_PAN_STEP = 3;

type Tool = "select" | "barrier";
type SelectionKind = "decor" | "barrier" | null;
type DragMode = "move" | "rotate" | "resize";
type PanDirection = "up" | "down" | "left" | "right";

export interface EditorCallbacks {
  onSelectionChange: (item: DecorItem | Barrier | null, kind: SelectionKind) => void;
  onStatusChange: (message: string) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
}

interface ResizeStart {
  distance: number;
  decorScale?: number;
  barrierWidth?: number;
  barrierDepth?: number;
}

export class WorldEditor {
  private gameScene: GameScene;
  private decorMeshes = new Map<string, Mesh>();
  private barrierMeshes = new Map<string, Mesh>();
  private decorItems: DecorItem[] = [];
  private barriers: Barrier[] = [];
  private tool: Tool = "select";
  private selectedId: string | null = null;
  private selectedKind: SelectionKind = null;
  private drawStart: { x: number; z: number } | null = null;
  private drawPreview: Mesh | null = null;
  private draggingId: string | null = null;
  private draggedDuringGesture = false;
  private dragMode: DragMode = "move";
  private pendingInteraction: "rotate" | "resize" | null = null;
  private resizeStart: ResizeStart | null = null;
  private history: WorldMapData[] = [];
  private historyIndex = -1;
  private editingEnabled = false;
  private highlightLayer: HighlightLayer;
  private hoveredId: string | null = null;
  private panLastScreen: { x: number; y: number } | null = null;

  constructor(
    private engine: Engine,
    canvas: HTMLCanvasElement,
    private callbacks: EditorCallbacks
  ) {
    this.gameScene = createScene(engine, canvas);
    this.highlightLayer = new HighlightLayer("hoverHighlight", this.gameScene.scene);
    this.setupPointerHandling();
  }

  get scene() {
    return this.gameScene.scene;
  }

  render(): void {
    this.gameScene.scene.render();
  }

  setEditingEnabled(enabled: boolean): void {
    this.editingEnabled = enabled;
    if (!enabled) {
      this.clearSelection();
      this.clearHover();
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

  setTool(tool: Tool): void {
    this.tool = tool;
    this.clearSelection();
  }

  /**
   * Places a decor item at the world position under the given canvas-relative
   * screen coordinates (used by drag-and-drop from the tray or the OS), and
   * selects it so the floating toolbar appears immediately.
   */
  placeDecor(screenX: number, screenY: number, imageUrl: string): void {
    const point = this.pickGroundPointAt(screenX, screenY);
    if (!point) return;

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
    this.tool = "select";
    this.selectedId = item.id;
    this.selectedKind = "decor";
    this.callbacks.onSelectionChange(item, "decor");
    this.callbacks.onStatusChange(`Placed decor at (${point.x.toFixed(1)}, ${point.z.toFixed(1)})`);
    this.pushHistory();
  }

  /** Arms a one-shot rotate gesture: the next canvas drag rotates the selected item. */
  beginRotate(): void {
    if (!this.selectedId) return;
    this.pendingInteraction = "rotate";
  }

  /** Arms a one-shot resize gesture: the next canvas drag resizes the selected item. */
  beginResize(): void {
    if (!this.selectedId) return;
    this.pendingInteraction = "resize";
  }

  /** Screen-space position (px) of the current selection, for positioning a floating toolbar. Null if nothing selected. */
  getSelectedScreenPosition(): { x: number; y: number } | null {
    if (!this.selectedId) return null;
    const mesh = this.decorMeshes.get(this.selectedId) ?? this.barrierMeshes.get(this.selectedId);
    if (!mesh) return null;

    const { scene, camera } = this.gameScene;
    const viewport = camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    const projected = Vector3.Project(
      mesh.getAbsolutePosition(),
      Matrix.Identity(),
      scene.getTransformMatrix(),
      viewport
    );
    return { x: projected.x, y: projected.y };
  }

  /** Pans the camera one fixed step in the given screen-relative direction (for keyboard shortcuts). */
  panView(direction: PanDirection): void {
    const { right, forward } = this.groundPanAxes();
    const stepVector: Record<PanDirection, Vector3> = {
      up: forward.scale(KEY_PAN_STEP),
      down: forward.scale(-KEY_PAN_STEP),
      left: right.scale(-KEY_PAN_STEP),
      right: right.scale(KEY_PAN_STEP),
    };
    this.gameScene.camera.target.addInPlace(stepVector[direction]);
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

  updateSelected(patch: Partial<DecorItem> | Partial<Barrier>): void {
    if (!this.selectedId) return;

    if (this.selectedKind === "decor") {
      const item = this.decorItems.find((d) => d.id === this.selectedId);
      if (!item) return;
      Object.assign(item, patch);
      this.refreshDecorMesh(item);
    } else if (this.selectedKind === "barrier") {
      const barrier = this.barriers.find((b) => b.id === this.selectedId);
      if (!barrier) return;
      Object.assign(barrier, patch);
      this.refreshBarrierMesh(barrier);
    }
  }

  /** Call after a batch of updateSelected() calls (e.g. a slider drag ends) to make it undoable. */
  commitHistory(): void {
    this.pushHistory();
  }

  duplicateSelected(): void {
    if (!this.selectedId) return;

    if (this.selectedKind === "decor") {
      const source = this.decorItems.find((d) => d.id === this.selectedId);
      if (!source) return;
      const clone: DecorItem = {
        ...source,
        id: crypto.randomUUID(),
        x: source.x + DUPLICATE_OFFSET,
        z: source.z + DUPLICATE_OFFSET,
      };
      this.decorItems.push(clone);
      this.addDecorMesh(clone);
      this.selectedId = clone.id;
      this.callbacks.onSelectionChange(clone, "decor");
      this.pushHistory();
      this.callbacks.onStatusChange("Duplicated");
    } else if (this.selectedKind === "barrier") {
      const source = this.barriers.find((b) => b.id === this.selectedId);
      if (!source) return;
      const clone: Barrier = {
        ...source,
        id: crypto.randomUUID(),
        x: source.x + DUPLICATE_OFFSET,
        z: source.z + DUPLICATE_OFFSET,
      };
      this.barriers.push(clone);
      this.addBarrierMesh(clone);
      this.selectedId = clone.id;
      this.callbacks.onSelectionChange(clone, "barrier");
      this.pushHistory();
      this.callbacks.onStatusChange("Duplicated");
    }
  }

  deleteSelected(): void {
    if (!this.selectedId) return;

    if (this.hoveredId === this.selectedId) this.clearHover();

    if (this.selectedKind === "decor") {
      this.decorMeshes.get(this.selectedId)?.dispose();
      this.decorMeshes.delete(this.selectedId);
      this.decorItems = this.decorItems.filter((d) => d.id !== this.selectedId);
    } else if (this.selectedKind === "barrier") {
      this.barrierMeshes.get(this.selectedId)?.dispose();
      this.barrierMeshes.delete(this.selectedId);
      this.barriers = this.barriers.filter((b) => b.id !== this.selectedId);
    }

    this.clearSelection();
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

  private snapshot(): WorldMapData {
    return {
      decor: this.decorItems.map((item) => ({ ...item })),
      barriers: this.barriers.map((barrier) => ({ ...barrier })),
    };
  }

  private pushHistory(): void {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this.snapshot());
    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
    }
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

    this.clearSelection();
  }

  private clearSelection(): void {
    this.selectedId = null;
    this.selectedKind = null;
    this.pendingInteraction = null;
    this.callbacks.onSelectionChange(null, null);
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

      if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
        this.handlePointerDown(Boolean(pointerInfo.event.shiftKey));
      } else if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
        this.handlePointerMove();
      } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
        this.handlePointerUp();
      }
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
    const pick = this.gameScene.scene.pick(
      this.gameScene.scene.pointerX,
      this.gameScene.scene.pointerY
    );
    if (!pick?.hit || !pick.pickedMesh) return null;
    return pick.pickedMesh as Mesh;
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

  private handlePointerDown(shiftKey: boolean): void {
    if (shiftKey) {
      this.panLastScreen = { x: this.gameScene.scene.pointerX, y: this.gameScene.scene.pointerY };
      return;
    }

    if (this.pendingInteraction && this.selectedId) {
      const center = this.itemCenter(this.selectedId, this.selectedKind);
      const point = this.pickGroundPoint();
      if (!center || !point) return;

      this.draggingId = this.selectedId;
      this.draggedDuringGesture = false;
      this.dragMode = this.pendingInteraction;

      if (this.pendingInteraction === "resize") {
        const distance = Math.hypot(point.x - center.x, point.z - center.z) || 0.01;
        if (this.selectedKind === "decor") {
          const item = this.decorItems.find((d) => d.id === this.selectedId);
          this.resizeStart = { distance, decorScale: item?.scale ?? 1 };
        } else {
          const barrier = this.barriers.find((b) => b.id === this.selectedId);
          this.resizeStart = { distance, barrierWidth: barrier?.width ?? 1, barrierDepth: barrier?.depth ?? 1 };
        }
      }

      this.pendingInteraction = null;
      return;
    }

    if (this.tool === "barrier") {
      const point = this.pickGroundPoint();
      if (!point) return;
      this.drawStart = point;
      return;
    }

    // select tool
    const mesh = this.pickAnyMesh();
    if (!mesh) {
      this.clearSelection();
      return;
    }

    const decorId = mesh.metadata?.decorId as string | undefined;
    const barrierId = mesh.metadata?.barrierId as string | undefined;

    if (decorId) {
      this.selectedId = decorId;
      this.selectedKind = "decor";
      this.draggingId = decorId;
      this.draggedDuringGesture = false;
      this.dragMode = "move";
      const item = this.decorItems.find((d) => d.id === decorId) ?? null;
      this.callbacks.onSelectionChange(item, "decor");
    } else if (barrierId) {
      this.selectedId = barrierId;
      this.selectedKind = "barrier";
      this.draggingId = barrierId;
      this.draggedDuringGesture = false;
      this.dragMode = "move";
      const barrier = this.barriers.find((b) => b.id === barrierId) ?? null;
      this.callbacks.onSelectionChange(barrier, "barrier");
    } else {
      this.clearSelection();
    }
  }

  private handlePointerMove(): void {
    if (this.panLastScreen) {
      const { scene } = this.gameScene;
      const dxScreen = scene.pointerX - this.panLastScreen.x;
      const dyScreen = scene.pointerY - this.panLastScreen.y;
      this.applyScreenPan(dxScreen, dyScreen);
      this.panLastScreen = { x: scene.pointerX, y: scene.pointerY };
      return;
    }

    if (this.tool === "select" && this.draggingId) {
      const point = this.pickGroundPoint();
      if (!point) return;

      if (this.dragMode === "move") {
        this.updateSelected({ x: point.x, z: point.z });
      } else if (this.dragMode === "rotate") {
        const center = this.itemCenter(this.draggingId, this.selectedKind);
        if (center) {
          const angle = Math.atan2(point.x - center.x, point.z - center.z);
          this.updateSelected({ rotation: angle });
        }
      } else if (this.dragMode === "resize" && this.resizeStart) {
        const center = this.itemCenter(this.draggingId, this.selectedKind);
        if (center) {
          const distance = Math.hypot(point.x - center.x, point.z - center.z);
          const factor = distance / this.resizeStart.distance;
          if (this.selectedKind === "decor" && this.resizeStart.decorScale !== undefined) {
            const scale = clamp(this.resizeStart.decorScale * factor, MIN_SCALE, MAX_SCALE);
            this.updateSelected({ scale });
          } else if (
            this.selectedKind === "barrier" &&
            this.resizeStart.barrierWidth !== undefined &&
            this.resizeStart.barrierDepth !== undefined
          ) {
            this.updateSelected({
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
        {
          width: Math.max(0.1, Math.abs(point.x - this.drawStart.x)),
          height: Math.max(0.1, Math.abs(point.z - this.drawStart.z)),
        },
        this.gameScene.scene
      );
      this.drawPreview.position.set(
        (this.drawStart.x + point.x) / 2,
        BARRIER_HEIGHT,
        (this.drawStart.z + point.z) / 2
      );
      const material = new StandardMaterial("barrier-preview-mat", this.gameScene.scene);
      material.diffuseColor = new Color3(0.85, 0.2, 0.2);
      material.alpha = 0.4;
      this.drawPreview.material = material;
      return;
    }

    if (this.tool === "select" && !this.draggingId) {
      this.updateHover();
    }
  }

  private handlePointerUp(): void {
    if (this.panLastScreen) {
      this.panLastScreen = null;
      return;
    }

    if (this.tool === "select" && this.draggingId) {
      if (this.draggedDuringGesture) {
        this.pushHistory();
        // Refresh the selection panel/toolbar so displayed values reflect the change.
        if (this.selectedKind === "decor") {
          const item = this.decorItems.find((d) => d.id === this.selectedId) ?? null;
          this.callbacks.onSelectionChange(item, "decor");
        } else if (this.selectedKind === "barrier") {
          const barrier = this.barriers.find((b) => b.id === this.selectedId) ?? null;
          this.callbacks.onSelectionChange(barrier, "barrier");
        }
      }
      this.draggingId = null;
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

  private applyScreenPan(dxScreen: number, dyScreen: number): void {
    const { camera } = this.gameScene;
    const unitsPerPixelX = ((camera.orthoRight ?? 1) - (camera.orthoLeft ?? -1)) / this.engine.getRenderWidth();
    const unitsPerPixelY = ((camera.orthoTop ?? 1) - (camera.orthoBottom ?? -1)) / this.engine.getRenderHeight();
    const { right, forward } = this.groundPanAxes();
    const worldDelta = right
      .scale(-dxScreen * unitsPerPixelX)
      .add(forward.scale(-dyScreen * unitsPerPixelY));
    camera.target.addInPlace(worldDelta);
  }

  private addDecorMesh(item: DecorItem): void {
    const mesh = MeshBuilder.CreatePlane(`decor-${item.id}`, { size: DECOR_SIZE }, this.gameScene.scene);
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.metadata = { decorId: item.id };

    const material = new StandardMaterial(`decor-mat-${item.id}`, this.gameScene.scene);
    const texture = new Texture(resolveImageUrl(item.imageUrl), this.gameScene.scene);
    texture.hasAlpha = true;
    material.diffuseTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
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
    mesh.rotation.y = item.rotation;
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
