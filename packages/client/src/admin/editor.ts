import {
  Color3,
  Engine,
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

type Tool = "select" | "place" | "barrier";

export interface EditorCallbacks {
  onSelectionChange: (item: DecorItem | Barrier | null, kind: "decor" | "barrier" | null) => void;
  onStatusChange: (message: string) => void;
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
  private selectedKind: "decor" | "barrier" | null = null;
  private drawStart: { x: number; z: number } | null = null;
  private drawPreview: Mesh | null = null;

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
    this.clearAll();
    for (const item of data.decor) this.addDecorMesh(item);
    for (const barrier of data.barriers) this.addBarrierMesh(barrier);
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
  }

  private clearAll(): void {
    for (const mesh of this.decorMeshes.values()) mesh.dispose();
    for (const mesh of this.barrierMeshes.values()) mesh.dispose();
    this.decorMeshes.clear();
    this.barrierMeshes.clear();
    this.decorItems = [];
    this.barriers = [];
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

  private pickAnyMesh(): { mesh: Mesh; point: { x: number; z: number } } | null {
    const pick = this.gameScene.scene.pick(
      this.gameScene.scene.pointerX,
      this.gameScene.scene.pointerY
    );
    if (!pick?.hit || !pick.pickedMesh || !pick.pickedPoint) return null;
    return {
      mesh: pick.pickedMesh as Mesh,
      point: { x: pick.pickedPoint.x, z: pick.pickedPoint.z },
    };
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
      return;
    }

    if (this.tool === "barrier") {
      const point = this.pickGroundPoint();
      if (!point) return;
      this.drawStart = point;
      return;
    }

    // select tool
    const picked = this.pickAnyMesh();
    if (!picked) {
      this.clearSelection();
      return;
    }

    const decorId = picked.mesh.metadata?.decorId as string | undefined;
    const barrierId = picked.mesh.metadata?.barrierId as string | undefined;

    if (decorId) {
      this.selectedId = decorId;
      this.selectedKind = "decor";
      const item = this.decorItems.find((d) => d.id === decorId) ?? null;
      this.callbacks.onSelectionChange(item, "decor");
    } else if (barrierId) {
      this.selectedId = barrierId;
      this.selectedKind = "barrier";
      const barrier = this.barriers.find((b) => b.id === barrierId) ?? null;
      this.callbacks.onSelectionChange(barrier, "barrier");
    } else {
      this.clearSelection();
    }
  }

  private handlePointerMove(): void {
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
