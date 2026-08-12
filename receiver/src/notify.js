import fetch from "node-fetch";

const WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL;

/**
 * Fire a Slack-compatible (Slack, Discord w/ Slack shim, Mattermost, etc.)
 * incoming-webhook notification whenever a new report lands.
 * Silently no-ops if NOTIFY_WEBHOOK_URL isn't configured, so this never
 * blocks a report from being saved.
 */
export async function notifyNewReport(report) {
  if (!WEBHOOK_URL) return;

  const kind = report.source === "auto-error" ? "Auto-captured error" : "Staff report";
  const lines = [
    `*${kind}* from *${report.appName}*`,
    report.reporterEmail ? `Reported by: ${report.reporterEmail}` : null,
    report.url ? `Page: ${report.url}` : null,
    report.note ? `Note: ${report.note}` : null,
    report.glitchtipEventId ? `Linked GlitchTip event: ${report.glitchtipEventId}` : null,
    `Bundle ID: ${report.id}`,
  ].filter(Boolean);

  const body = { text: lines.join("\n") };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`notify webhook returned ${res.status}`);
    }
  } catch (err) {
    console.error("notify webhook failed:", err.message);
  }
}
