import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reportRouter } from "./routes/report.js";
import { requireStaffToken } from "./middleware/auth.js";
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
app.use(express.static(PUBLIC_DIR));

app.use("/api", requireStaffToken, reportRouter);

app.listen(PORT, () => {
  console.log(`feedback-incident-receiver listening on :${PORT}`);
  startRetentionSweeps();
  if (!ALLOWED_ORIGINS.length) {
    console.warn("ALLOWED_ORIGINS is empty — no browser origin will be able to call this API.");
  }
});
