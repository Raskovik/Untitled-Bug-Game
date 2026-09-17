import { Schema, model } from "mongoose";
import type { Barrier, DecorItem, DecorLayer } from "@bug-game/shared";

const decorItemSchema = new Schema<DecorItem>(
  {
    id: { type: String, required: true },
    imageUrl: { type: String, required: true },
    x: { type: Number, required: true },
    z: { type: Number, required: true },
    rotation: { type: Number, required: true, default: 0 },
    scale: { type: Number, required: true, default: 1 },
    layer: { type: String, enum: ["behind", "auto", "front"] as DecorLayer[], default: "auto" },
    flipX: { type: Boolean, default: false },
    flipY: { type: Boolean, default: false },
  },
  { _id: false }
);

const barrierSchema = new Schema<Barrier>(
  {
    id: { type: String, required: true },
    x: { type: Number, required: true },
    z: { type: Number, required: true },
    width: { type: Number, required: true },
    depth: { type: Number, required: true },
    rotation: { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

/** `mapId` doubles as the save slot's name (mirrors Pony Town's `/savemap <slot>`). */
interface WorldMapDocument {
  mapId: string;
  decor: DecorItem[];
  barriers: Barrier[];
  thumbnail?: string;
  updatedAt: Date;
}

const worldMapSchema = new Schema<WorldMapDocument>(
  {
    mapId: { type: String, required: true, unique: true },
    decor: { type: [decorItemSchema], default: [] },
    barriers: { type: [barrierSchema], default: [] },
    thumbnail: { type: String },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const WorldMap = model<WorldMapDocument>("WorldMap", worldMapSchema);
