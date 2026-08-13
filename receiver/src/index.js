import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reportRouter } from "./routes/report.js";
import { authRouter } from "./routes/auth.js";
import { requireStaffToken, requireSignedIn } from "./middleware/auth.js";
import { glitchtipConfigured, glitchtipInfo } from "./glitchtip.js";
import { startRetentionSweeps } from "./retention.js";
import { initSettings, allowedOrigins } from "./settings.js";
import { settingsRouter } from "./routes/settings.js";
import { accessRouter } from "./routes/access.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // The viewer fetches screenshots with an auth header and renders
        // them from object URLs, so blob: has to be allowed.
        "img-src": ["'self'", "data:", "blob:"],
        // Each app embeds the viewer in its own admin area, so the apps
        // we already trust as API origins may also frame it. Anything
        // else still can't (clickjacking).
        // Evaluated per response, not at boot: origins can be added from the
        // viewer, and a browser that has to be told to trust an app is no
        // use if the answer is a restart old.
        "frame-ancestors": ["'self'", () => allowedOrigins().join(" ")],
        /**
         * Only claim this when TLS is actually in front.
         *
         * helmet sets it by default, and it tells the browser to rewrite
         * every http:// subresource to https://. On a plain-HTTP
         * deployment that points the stylesheet and the script at a port
         * with no TLS listener: the page itself loads, because a
         * top-level navigation isn't upgraded, and then nothing else
         * does. Browsers exempt localhost from the rule, so it looks
         * perfect in development and breaks on the first real host.
         */
        "upgrade-insecure-requests": process.env.SECURE_COOKIES === "true" ? [] : null,
      },
    },
  })
);
app.use(
  cors({
    // Same reason as frame-ancestors above: consulted on each request,
    // including the preflight that decides whether an app may report.
    origin(origin, callback) {
      const allowed = allowedOrigins();
      callback(null, allowed.length ? allowed : false);
    },
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Viewer UI. Static assets only — every byte of report data still comes
// from the token-gated /api routes below.
/**
 * Served at two paths on purpose. Behind the shared origin the viewer lives
 * under /sentinel, alongside GlitchTip; on its own port it's still at the
 * root. Asset references are relative so the same files work from either.
 */
const staticOptions = {
    setHeaders(res, filePath) {
      // The viewer is a handful of small files that change when the
      // pipeline is upgraded. Without this, browsers serve a stale copy
      // after a rebuild and staff see an old UI against new data.
      // "no-cache" still allows 304s — it just forces revalidation.
    res.setHeader(
      "Cache-Control",
      filePath.includes(`${path.sep}vendor${path.sep}`)
        ? "public, max-age=604800, immutable" // bundled player, changes with the image
        : "no-cache"
    );
  },
};

// The trailing slash isn't cosmetic: asset paths are relative, so at
// /sentinel they'd resolve against the root and land on GlitchTip. Express
// treats /sentinel and /sentinel/ as one route, so the check is on the URL
// as it actually arrived — otherwise this redirects to itself.
app.get("/sentinel", (req, res, next) => {
  if (req.originalUrl.split("?")[0].endsWith("/sentinel")) return res.redirect("/sentinel/");
  return next();
});
app.use("/sentinel", express.static(PUBLIC_DIR, staticOptions));
app.use(express.static(PUBLIC_DIR, staticOptions));

// Sign-in lives outside the guard — it's how you get past it.
app.use("/api", authRouter);

// Asking for access is the one thing someone not yet let in may do, so it
// sits behind a weaker guard than everything else — and on its own prefix,
// because a guard mounted at /api runs for every /api request, refusing the
// bearer-token calls that post reports.
app.use("/api/access", requireSignedIn, accessRouter);

app.use("/api", requireStaffToken, settingsRouter);
app.use("/api", requireStaffToken, reportRouter);

await initSettings();

app.listen(PORT, () => {
  console.log(`Sentinel receiver listening on :${PORT}`);
  if (glitchtipConfigured && glitchtipInfo().org) {
    console.log(`sign-in: GlitchTip accounts in the "${glitchtipInfo().org}" organisation`);
  } else if (glitchtipConfigured) {
    console.log(
      "sign-in: any GlitchTip account — each person sees the apps whose projects they can see"
    );
  } else {
    console.warn(
      "GLITCHTIP_URL is unset — sign-in falls back to the shared staff token only."
    );
  }
  startRetentionSweeps();
  if (!allowedOrigins().length) {
    console.warn(
      "No allowed origins — no browser can post reports yet. Add them in the viewer under Settings."
    );
  }
});
