import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import { readFileSync } from "node:fs";
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

/**
 * The shell, with its <base> and its mount meta tag filled in for whichever
 * root actually matched — "/sentinel" behind the shared origin, "" at the
 * bare standalone root, in router.js's own vocabulary (no trailing slash).
 *
 * Every asset reference in index.html is relative, so the browser needs to
 * be told which of the two roots it's resolving against — and once routes
 * could nest (settings/apps/:app, two segments deep), only telling it via
 * <base> at all was enough; the naive fix, a plain relative href, silently
 * broke past one segment. The meta tag is the same fact, for app.js: it
 * used to work this out itself from location.pathname, a second copy of
 * this same rule that could drift from this one. Now there's one rule, here,
 * and app.js just reads what it decided. Read once at boot: this file only
 * changes on a rebuild, which restarts the process anyway.
 */
const BASE_PLACEHOLDER = "__SENTINEL_BASE__";
const MOUNT_PLACEHOLDER = "__SENTINEL_MOUNT__";
const INDEX_TEMPLATE = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");

// Checked once, at boot, rather than trusted: a second mention anywhere in
// the file — a comment referring to it by name, a copy-pasted tag — makes
// String.replace() patch the FIRST occurrence and leave the real one
// untouched, with no error, just a page that's wrong every time it's
// served. It happened once already, to BASE_PLACEHOLDER, in this file's own
// comment, while writing this. Failing to boot is loud; a wrong <base> or
// mount in production is not.
for (const placeholder of [BASE_PLACEHOLDER, MOUNT_PLACEHOLDER]) {
  const count = INDEX_TEMPLATE.split(placeholder).length - 1;
  if (count !== 1) {
    throw new Error(
      `index.html must contain exactly one ${placeholder} — found ${count}. ` +
        "Check for a stray mention in a comment, or a duplicated tag."
    );
  }
}

function renderShell(mount) {
  return INDEX_TEMPLATE.replace(BASE_PLACEHOLDER, mount ? `${mount}/` : "/").replace(
    MOUNT_PLACEHOLDER,
    mount
  );
}
function sendShell(mount) {
  return (_req, res) => res.type("html").send(renderShell(mount));
}

// The trailing slash isn't cosmetic: asset paths are relative, so at
// /sentinel they'd resolve against the root and land on GlitchTip. Express
// treats /sentinel and /sentinel/ as one route, so the check is on the URL
// as it actually arrived — otherwise this redirects to itself.
app.get("/sentinel", (req, res, next) => {
  if (req.originalUrl.split("?")[0].endsWith("/sentinel")) return res.redirect("/sentinel/");
  return next();
});
// Ahead of the static middleware below, so its own auto-index behaviour
// never gets a chance to serve index.html untemplated for these two exact
// paths. Every other file under /sentinel — styles.css, app.js, lib/*,
// views/* — still falls through to static exactly as before.
app.get("/sentinel/", sendShell("/sentinel"));
app.use("/sentinel", express.static(PUBLIC_DIR, staticOptions));

/**
 * Anything else under /sentinel is a client-side route — /sentinel/issues,
 * /sentinel/settings/apps/:app — so it has to serve the shell rather than
 * 404. Without this, a bookmark or a reload anywhere but the root is a dead
 * end, which is the whole reason the viewer had no routing before.
 *
 * Only for navigations: a missing asset should still 404 rather than
 * silently returning HTML, which is a confusing failure to debug.
 */
app.get("/sentinel/*", (req, res, next) => {
  if (req.method !== "GET") return next();
  if (!String(req.headers.accept || "").includes("text/html")) return next();
  if (path.extname(req.path)) return next();
  return sendShell("/sentinel")(req, res);
});
// Standalone: the same shell, at the root this port serves it from.
app.get("/", sendShell(""));
app.use(express.static(PUBLIC_DIR, staticOptions));

/**
 * Standalone's version of the fallback above. The router starts the same
 * way regardless of which root served it (app.js, gated only on `embedded`,
 * not on which port it's running behind) — so a bookmark or reload of
 * :4000/settings/apps/foo needs the same answer :8000/sentinel/settings/apps/foo
 * already gets. Same guards, same reasoning, one root lower.
 */
app.get("/*", (req, res, next) => {
  if (req.method !== "GET") return next();
  if (!String(req.headers.accept || "").includes("text/html")) return next();
  if (path.extname(req.path)) return next();
  return sendShell("")(req, res);
});

/**
 * The viewer's own API lives under /sentinel/api, out of GlitchTip's way.
 *
 * Sharing an origin means sharing a URL space, and /api/settings/ is
 * GlitchTip's too — the first call its frontend makes. Anything only this
 * viewer calls therefore moved; /api/reports stayed, because every app's SDK
 * is already configured to post there and that contract isn't ours to break.
 */
const VIEWER_API = "/sentinel/api";

// Sign-in lives outside the guard — it's how you get past it.
app.use(VIEWER_API, authRouter);
app.use("/api", authRouter);

// Asking for access is the one thing someone not yet let in may do, so it
// sits behind a weaker guard than everything else — and on its own prefix,
// because a guard mounted at /api runs for every /api request, refusing the
// bearer-token calls that post reports.
app.use(`${VIEWER_API}/access`, requireSignedIn, accessRouter);
app.use("/api/access", requireSignedIn, accessRouter);

app.use(VIEWER_API, requireStaffToken, settingsRouter);
app.use(VIEWER_API, requireStaffToken, reportRouter);

// The path apps' SDKs post to, and the embedded viewer reads from.
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
