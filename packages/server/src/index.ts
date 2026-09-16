import "dotenv/config";
import express from "express";
import { connectToDatabase, isDatabaseConnected } from "./db.js";

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3001;

connectToDatabase(process.env.MONGODB_URI);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    database: isDatabaseConnected() ? "connected" : "disconnected",
  });
});

app.listen(port, () => {
  console.log(`[server] Listening on http://localhost:${port}`);
});
