import {
  Color3,
  Engine,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import type { Barrier, DecorItem, DecorLayer, WorldMapData } from "@bug-game/shared";
import { createScene, type GameScene } from "../scene";
import { resolveImageUrl } from "./api";

const DECOR_SIZE = 3;
const LAYER_RENDER_GROUP: Record<DecorLayer, number> = { behind: 0, auto: 1, front: 2 };
const BARRIER_HEIGHT = 0.05;
const DUPLICATE_OFFSET = 1.5;
const HISTORY_LIMIT = 100;

type Tool = "select" | "place" | "barrier";
type SelectionKind = "decor" | "barrier" | null;

export interface EditorCallbacks {
  onSelectionChange: (item: DecorItem | Barrier | null, kind: SelectionKind) => void;
  onStatusChange: (message: string) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
}

export class WorldEditor {
  private gameScene: GameScene;
  private decorMeshes = new Map<string, Mesh>();
  private barrierMeshes = new Map<string, Mesh>();
  private decorItems: DecorItem[] = [];
  private barriers: Barrier[] = [];
  private tool: Tool = "select";
  private pendingImageUrl: string | null = null;
  private selectedId: string | null = null;
  private selectedKind: SelectionKind = null;
  private drawStart: { x: number; z: number } | null = null;
  private drawPreview: Mesh | null = null;
  private draggingId: string | null = null;
  private draggedDuringGesture = false;
  private history: WorldMapData[] = [];
  private historyIndex = -1;

  constructor(
    engine: Engine,
    canvas: HTMLCanvasElement,
    private callbacks: EditorCallbacks
  ) {
    this.gameScene = createScene(engine, canvas);
    this.setupPointerHandling();
  }

  get scene() {
    return this.gameScene.scene;
  }

  render(): void {
    this.gameScene.scene.render();
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

  setTool(tool: Tool, imageUrl?: string): void {
    this.tool = tool;
    this.pendingImageUrl = tool === "place" ? (imageUrl ?? null) : null;
    this.clearSelection();
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
    this.callbacks.onSelectionChange(null, null);
  }

  private setupPointerHandling(): void {
    const { scene, ground } = this.gameScene;

    scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
        this.handlePointerDown();
      } else if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
        this.handlePointerMove();
      } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
        this.handlePointerUp();
      }
    });

    void ground;
  }

  private pickGroundPoint(): { x: number; z: number } | null {
    const pick = this.gameScene.scene.pick(
      this.gameScene.scene.pointerX,
      this.gameScene.scene.pointerY,
      (mesh) => mesh === this.gameScene.ground
    );
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

  private handlePointerDown(): void {
    if (this.tool === "place" && this.pendingImageUrl) {
      const point = this.pickGroundPoint();
      if (!point) return;
      const item: DecorItem = {
        id: crypto.randomUUID(),
        imageUrl: this.pendingImageUrl,
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
      const item = this.decorItems.find((d) => d.id === decorId) ?? null;
      this.callbacks.onSelectionChange(item, "decor");
    } else if (barrierId) {
      this.selectedId = barrierId;
      this.selectedKind = "barrier";
      this.draggingId = barrierId;
      this.draggedDuringGesture = false;
      const barrier = this.barriers.find((b) => b.id === barrierId) ?? null;
      this.callbacks.onSelectionChange(barrier, "barrier");
    } else {
      this.clearSelection();
    }
  }

  private handlePointerMove(): void {
    if (this.tool === "select" && this.draggingId) {
      const point = this.pickGroundPoint();
      if (!point) return;
      this.updateSelected({ x: point.x, z: point.z });
      this.draggedDuringGesture = true;
      return;
    }

    if (this.tool !== "barrier" || !this.drawStart) return;

    const point = this.pickGroundPoint();
    if (!point) return;

    this.drawPreview?.dispose();
    this.drawPreview = this.createBarrierMesh({
      id: "__preview__",
      x: (this.drawStart.x + point.x) / 2,
      z: (this.drawStart.z + point.z) / 2,
      width: Math.max(0.1, Math.abs(point.x - this.drawStart.x)),
      depth: Math.max(0.1, Math.abs(point.z - this.drawStart.z)),
      rotation: 0,
    });
  }

  private handlePointerUp(): void {
    if (this.tool === "select" && this.draggingId) {
      if (this.draggedDuringGesture) {
        this.pushHistory();
        // Refresh the selection panel so numeric X/Z fields reflect the new position.
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

  private createBarrierMesh(barrier: Barrier): Mesh {
    const mesh = MeshBuilder.CreateGround(
      `barrier-${barrier.id}`,
      { width: barrier.width, height: barrier.depth },
      this.gameScene.scene
    );
    mesh.position.set(barrier.x, BARRIER_HEIGHT, barrier.z);
    mesh.rotation.y = barrier.rotation;
    mesh.metadata = { barrierId: barrier.id };

    const material = new StandardMaterial(`barrier-mat-${barrier.id}`, this.gameScene.scene);
    material.diffuseColor = new Color3(0.85, 0.2, 0.2);
    material.alpha = 0.4;
    mesh.material = material;

    return mesh;
  }

  private addBarrierMesh(barrier: Barrier): void {
    const mesh = this.createBarrierMesh(barrier);
    this.barrierMeshes.set(barrier.id, mesh);
  }

  private refreshBarrierMesh(barrier: Barrier): void {
    const mesh = this.barrierMeshes.get(barrier.id);
    if (!mesh) return;
    mesh.dispose();
    this.barrierMeshes.set(barrier.id, this.createBarrierMesh(barrier));
  }
}
