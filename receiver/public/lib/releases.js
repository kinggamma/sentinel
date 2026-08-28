/**
 * The contracts behind the releases screen, kept out of it so they can be
 * tested without a browser.
 *
 * One of them is not a formatting convenience but a trap. GlitchTip's release
 * update schema gives `dateReleased` a default of *now*, and its handler
 * writes back every field the payload produced — so a PUT that omits the date
 * does not leave it alone, it stamps the release as released this second, and
 * a PUT that omits `ref` clears it. There is no partial update of a release.
 * `releaseUpdate` therefore always sends both, which is why the form is
 * prefilled from the release rather than left blank.
 */

/** Both fields, always, because omitting either one rewrites it. */
export function releaseUpdate({ ref = "", dateReleased = "" } = {}) {
  return {
    ref: String(ref || "").trim() || null,
    // Null is the one way to say "not released", since an absent key means now.
    dateReleased: String(dateReleased || "").trim() || null,
  };
}

/**
 * A datetime-local input wants "YYYY-MM-DDTHH:mm" in local time, and gives
 * one back. GlitchTip speaks ISO 8601 in UTC. Round-tripping through the
 * browser's own parser keeps the conversion in one place; anything
 * unparseable comes back empty rather than as "Invalid Date".
 */
export function toLocalInput(iso) {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function fromLocalInput(value) {
  if (!value) return "";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "" : at.toISOString();
}

/** Sizes as a person reads them. Bytes below a kilobyte stay bytes. */
export function fileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The first line of a commit message, which is the only part a table row has
 * room for. A message that is all body and no subject still gets something.
 */
export function commitSubject(message) {
  const first = String(message || "").split("\n").find((line) => line.trim());
  return first ? first.trim() : "(no message)";
}

/**
 * A version as a person typed it into their build, shortened only where it is
 * obviously a commit SHA. Truncating anything else hides which release this
 * is, which is the one thing the column exists to say.
 */
export function shortVersion(version) {
  const value = String(version || "");
  return /^[0-9a-f]{40}$/i.test(value) ? value.slice(0, 12) : value;
}
