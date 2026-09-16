export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3001,
  mongodbUri: process.env.MONGODB_URI,
  clientUrl: process.env.CLIENT_URL ?? "http://localhost:5173",
  sessionSecret: process.env.SESSION_SECRET ?? "change-me",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleCallbackUrl:
    process.env.GOOGLE_CALLBACK_URL ?? "http://localhost:3001/auth/google/callback",
  adminEmails: (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
};

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}
