import passport from "passport";
import { Strategy as GoogleStrategy, type Profile } from "passport-google-oauth20";
import type { AdminUser } from "@bug-game/shared";
import { config, isGoogleOAuthConfigured } from "../config.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface User extends AdminUser {}
  }
}

export function configurePassport(): void {
  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((user: AdminUser, done) => {
    done(null, user);
  });

  if (!isGoogleOAuthConfigured()) {
    console.warn(
      "[auth] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set — admin login is disabled until configured."
    );
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.googleClientId,
        clientSecret: config.googleClientSecret,
        callbackURL: config.googleCallbackUrl,
      },
      (_accessToken: string, _refreshToken: string, profile: Profile, done) => {
        const email = profile.emails?.[0]?.value?.toLowerCase();

        if (!email || !config.adminEmails.includes(email)) {
          done(null, false);
          return;
        }

        const user: AdminUser = { email, name: profile.displayName };
        done(null, user);
      }
    )
  );
}
