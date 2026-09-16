export interface Vector2 {
  x: number;
  y: number;
}

export interface WorldPosition extends Vector2 {
  rotation: number;
}

export type DecorLayer = "behind" | "auto" | "front";

export interface DecorItem {
  id: string;
  imageUrl: string;
  x: number;
  z: number;
  rotation: number;
  scale: number;
  layer: DecorLayer;
}

export interface Barrier {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  rotation: number;
}

export interface WorldMapData {
  decor: DecorItem[];
  barriers: Barrier[];
}

export interface AdminUser {
  email: string;
  name: string;
}
