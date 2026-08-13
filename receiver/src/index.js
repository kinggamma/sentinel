import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reportRouter } from "./routes/report.js";
import { authRouter } from "./routes/auth.js";
import { requireStaffToken } from "./middleware/auth.js";
import { glitchtipConfigured, glitchtipInfo } from "./glitchtip.js";
import { startRetentionSweeps } from "./retention.js";

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
        "frame-ancestors": ["'self'", ...ALLOWED_ORIGINS],
      },
    },
  })
);
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Viewer UI. Static assets only — every byte of report data still comes
// from the token-gated /api routes below.
app.use(
  express.static(PUBLIC_DIR, {
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
  })
);

// Sign-in lives outside the guard — it's how you get past it.
app.use("/api", authRouter);

app.use("/api", requireStaffToken, reportRouter);

app.listen(PORT, () => {
  console.log(`Sentinel receiver listening on :${PORT}`);
  if (glitchtipConfigured && glitchtipInfo().org) {
    console.log(`sign-in: GlitchTip accounts in the "${glitchtipInfo().org}" organisation`);
  } else if (glitchtipConfigured) {
    console.log(
      "sign-in: GlitchTip accounts — the organisation will be taken from the first person to sign in"
    );
  } else {
    console.warn(
      "GLITCHTIP_URL is unset — sign-in falls back to the shared staff token only."
    );
  }
  startRetentionSweeps();
  if (!ALLOWED_ORIGINS.length) {
    console.warn("ALLOWED_ORIGINS is empty — no browser origin will be able to call this API.");
  }
});
