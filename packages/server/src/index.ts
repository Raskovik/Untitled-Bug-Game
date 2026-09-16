import "dotenv/config";
import fs from "node:fs";
import cors from "cors";
import express from "express";
import session from "express-session";
import passport from "passport";
import { configurePassport } from "./auth/passport.js";
import { config } from "./config.js";
import { connectToDatabase, isDatabaseConnected } from "./db.js";
import { adminRouter, UPLOADS_DIR } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

connectToDatabase(config.mongodbUri);
configurePassport();

const app = express();

app.use(cors({ origin: config.clientUrl, credentials: true }));
app.use(express.json());
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
  })
);
app.use(passport.initialize());
app.use(passport.session());
app.use("/uploads", express.static(UPLOADS_DIR));

app.use("/auth", authRouter);
app.use("/admin", adminRouter);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    database: isDatabaseConnected() ? "connected" : "disconnected",
  });
});

app.listen(config.port, () => {
  console.log(`[server] Listening on http://localhost:${config.port}`);
});
