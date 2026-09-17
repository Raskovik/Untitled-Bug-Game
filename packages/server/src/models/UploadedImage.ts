import { Schema, model } from "mongoose";
import type { DecorLayer } from "@bug-game/shared";

interface UploadedImageDocument {
  id: string;
  url: string;
  originalName: string;
  uploadedAt: Date;
  category?: string;
  defaultLayer?: DecorLayer;
}

const uploadedImageSchema = new Schema<UploadedImageDocument>({
  id: { type: String, required: true, unique: true },
  url: { type: String, required: true },
  originalName: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  category: { type: String },
  defaultLayer: { type: String, enum: ["behind", "auto", "front"] as DecorLayer[] },
});

export const UploadedImage = model<UploadedImageDocument>("UploadedImage", uploadedImageSchema);
