import { Schema, model } from "mongoose";

interface UploadedImageDocument {
  id: string;
  url: string;
  originalName: string;
  uploadedAt: Date;
}

const uploadedImageSchema = new Schema<UploadedImageDocument>({
  id: { type: String, required: true, unique: true },
  url: { type: String, required: true },
  originalName: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
});

export const UploadedImage = model<UploadedImageDocument>("UploadedImage", uploadedImageSchema);
