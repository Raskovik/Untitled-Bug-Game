import { Router } from "express";
import passport from "passport";
import { config, isGoogleOAuthConfigured } from "../config.js";

export const authRouter = Router();

authRouter.get("/google", (req, res, next) => {
  if (!isGoogleOAuthConfigured()) {
    res.status(503).json({
      error: "Google OAuth is not configured on this server yet (missing GOOGLE_CLIENT_ID/SECRET).",
    });
    return;
  }

  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

authRouter.get(
  "/google/callback",
  (req, res, next) => {
    if (!isGoogleOAuthConfigured()) {
      res.redirect(`${config.clientUrl}/admin.html?error=oauth_not_configured`);
      return;
    }
    next();
  },
  passport.authenticate("google", {
    failureRedirect: `${config.clientUrl}/admin.html?error=unauthorized`,
  }),
  (_req, res) => {
    res.redirect(`${config.clientUrl}/admin.html`);
  }
);

authRouter.post("/logout", (req, res) => {
  req.logout((err) => {
    if (err) {
      res.status(500).json({ error: "Failed to log out" });
      return;
    }
    res.json({ ok: true });
  });
});

authRouter.get("/me", (req, res) => {
  res.json({ user: req.user ?? null });
});
