import express from "express";
import cors from "cors";
import helmet from "helmet";
import { reportRouter } from "./routes/report.js";
import { requireStaffToken } from "./middleware/auth.js";

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.use(helmet());
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api", requireStaffToken, reportRouter);

app.listen(PORT, () => {
  console.log(`feedback-incident-receiver listening on :${PORT}`);
  if (!ALLOWED_ORIGINS.length) {
    console.warn("ALLOWED_ORIGINS is empty — no browser origin will be able to call this API.");
  }
});
