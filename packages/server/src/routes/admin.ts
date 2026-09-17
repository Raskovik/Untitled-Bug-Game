import { randomUUID } from "node:crypto";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import type { DecorLayer, MapSlotSummary, UploadedImage as UploadedImageType, WorldMapData } from "@bug-game/shared";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { WorldMap } from "../models/WorldMap.js";
import { UploadedImage } from "../models/UploadedImage.js";
import { isDatabaseConnected } from "../db.js";

export const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
export const DEFAULT_MAP_ID = "default";
const VALID_LAYERS: DecorLayer[] = ["behind", "auto", "front"];

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image uploads are allowed"));
      return;
    }
    cb(null, true);
  },
});

export const adminRouter = Router();

adminRouter.use(requireAdmin);

adminRouter.post("/upload", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No image uploaded" });
    return;
  }

  const url = `/uploads/${req.file.filename}`;
  const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : req.file.originalname;
  const category = typeof req.body?.category === "string" && req.body.category.trim() ? req.body.category.trim() : undefined;
  const defaultLayer =
    typeof req.body?.defaultLayer === "string" && VALID_LAYERS.includes(req.body.defaultLayer as DecorLayer)
      ? (req.body.defaultLayer as DecorLayer)
      : undefined;

  if (isDatabaseConnected()) {
    await UploadedImage.create({
      id: randomUUID(),
      url,
      originalName: name,
      category,
      defaultLayer,
    });
  }

  res.json({ url });
});

adminRouter.get("/uploads", async (_req, res) => {
  if (!isDatabaseConnected()) {
    res.json([]);
    return;
  }

  const images = await UploadedImage.find().sort({ uploadedAt: -1 }).limit(100).lean();
  const result: UploadedImageType[] = images.map((image) => ({
    id: image.id,
    url: image.url,
    originalName: image.originalName,
    category: image.category,
    defaultLayer: image.defaultLayer,
  }));
  res.json(result);
});

adminRouter.get("/maps", async (_req, res) => {
  if (!isDatabaseConnected()) {
    res.json([]);
    return;
  }

  const maps = await WorldMap.find().sort({ updatedAt: -1 }).select("mapId updatedAt thumbnail").lean();
  const result: MapSlotSummary[] = maps.map((map) => ({
    mapId: map.mapId,
    updatedAt: map.updatedAt.toISOString(),
    thumbnail: map.thumbnail ?? null,
  }));
  res.json(result);
});

adminRouter.get("/map/:mapId", async (req, res) => {
  if (!isDatabaseConnected()) {
    res.status(503).json({ error: "Database not connected" });
    return;
  }

  const map = await WorldMap.findOne({ mapId: req.params.mapId }).lean();
  if (!map) {
    res.status(404).json({ error: "No map saved under that slot yet" });
    return;
  }

  const data: WorldMapData = { decor: map.decor, barriers: map.barriers };
  res.json(data);
});

adminRouter.put("/map/:mapId", async (req, res) => {
  if (!isDatabaseConnected()) {
    res.status(503).json({ error: "Database not connected" });
    return;
  }

  const { decor, barriers, thumbnail } = req.body as Partial<WorldMapData> & { thumbnail?: string };

  if (!Array.isArray(decor) || !Array.isArray(barriers)) {
    res.status(400).json({ error: "Request body must include decor[] and barriers[]" });
    return;
  }

  await WorldMap.findOneAndUpdate(
    { mapId: req.params.mapId },
    { mapId: req.params.mapId, decor, barriers, ...(thumbnail ? { thumbnail } : {}) },
    { upsert: true }
  );

  res.json({ ok: true });
});

adminRouter.delete("/map/:mapId", async (req, res) => {
  if (!isDatabaseConnected()) {
    res.status(503).json({ error: "Database not connected" });
    return;
  }

  await WorldMap.deleteOne({ mapId: req.params.mapId });
  res.json({ ok: true });
});
