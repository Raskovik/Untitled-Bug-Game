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
  /** Mirrors the sprite along its own local axis; undefined is equivalent to false. */
  flipX?: boolean;
  flipY?: boolean;
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

/** A named save slot's map data plus a thumbnail preview (mirrors Pony Town's `/savemap <slot>`). */
export interface MapSlotSummary {
  mapId: string;
  updatedAt: string;
  thumbnail: string | null;
}

export const UNCATEGORIZED = "Uncategorized";

export interface UploadedImage {
  id: string;
  url: string;
  originalName: string;
  /** Palette tab this item is filed under; falls back to UNCATEGORIZED when absent. */
  category?: string;
  /** Layer newly-placed instances of this item start on; falls back to "auto" when absent. */
  defaultLayer?: DecorLayer;
}

export interface AdminUser {
  email: string;
  name: string;
}
