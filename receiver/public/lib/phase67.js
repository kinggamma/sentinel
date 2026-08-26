/** Small, testable contracts shared by the organisation and profile forms. */

export function environmentRows(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const key = row?.id ?? row?.name;
      if (key === undefined || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}

export function socialAppPayload(values, { editing = false } = {}) {
  const payload = {
    name: String(values.name || "").trim(),
    ...(editing ? {} : { provider: values.provider || "openid_connect" }),
    clientID: String(values.clientId || "").trim(),
    ...(!editing || values.clientSecret ? { clientSecret: String(values.clientSecret || "").trim() } : {}),
  };
  const serverUrl = String(values.serverUrl || "").trim().replace(/\/+$/, "");
  if (serverUrl) payload.serverUrl = serverUrl;
  return payload;
}

export const tokenCreatedAt = (token) => token?.created || token?.dateCreated || "";

/** GlitchTip generates these from lower-case ASCII letters and digits. */
export const validWizardHash = (value) => /^[a-z0-9]{64}$/.test(String(value || ""));
