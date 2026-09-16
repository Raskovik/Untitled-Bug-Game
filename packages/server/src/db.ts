import mongoose from "mongoose";

let connectAttempted = false;

export function connectToDatabase(uri: string | undefined): void {
  if (connectAttempted) return;
  connectAttempted = true;

  if (!uri) {
    console.warn("[db] MONGODB_URI not set — skipping database connection.");
    return;
  }

  mongoose.connect(uri).catch((error: unknown) => {
    console.error("[db] Failed to connect to MongoDB:", error);
  });

  mongoose.connection.on("connected", () => {
    console.log("[db] Connected to MongoDB.");
  });

  mongoose.connection.on("error", (error) => {
    console.error("[db] MongoDB connection error:", error);
  });
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
