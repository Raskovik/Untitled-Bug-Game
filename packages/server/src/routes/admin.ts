import { randomUUID } from "node:crypto";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import type { WorldMapData } from "@bug-game/shared";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { WorldMap } from "../models/WorldMap.js";
import { isDatabaseConnected } from "../db.js";

export const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
const DEFAULT_MAP_ID = "default";

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

adminRouter.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No image uploaded" });
    return;
  }
  res.json({ url: `/uploads/${req.file.filename}` });
});

adminRouter.get("/map", async (_req, res) => {
  if (!isDatabaseConnected()) {
    res.status(503).json({ error: "Database not connected" });
    return;
  }

  const map = await WorldMap.findOne({ mapId: DEFAULT_MAP_ID }).lean();
  const data: WorldMapData = {
    decor: map?.decor ?? [],
    barriers: map?.barriers ?? [],
  };
  res.json(data);
});

adminRouter.put("/map", async (req, res) => {
  if (!isDatabaseConnected()) {
    res.status(503).json({ error: "Database not connected" });
    return;
  }

  const { decor, barriers } = req.body as Partial<WorldMapData>;

  if (!Array.isArray(decor) || !Array.isArray(barriers)) {
    res.status(400).json({ error: "Request body must include decor[] and barriers[]" });
    return;
  }

  await WorldMap.findOneAndUpdate(
    { mapId: DEFAULT_MAP_ID },
    { mapId: DEFAULT_MAP_ID, decor, barriers },
    { upsert: true }
  );

  res.json({ ok: true });
});
