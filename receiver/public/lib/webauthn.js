/**
 * Talking to a security key or a passkey.
 *
 * The awkwardness here is entirely about encoding. WebAuthn deals in
 * ArrayBuffers — a challenge, credential ids, signatures — and JSON does not,
 * so allauth sends them base64url and expects them back the same way. Getting
 * one of those conversions wrong produces a browser prompt that appears
 * normally and then fails with nothing useful to say, which is why the
 * conversion lives in one place rather than inline at both call sites.
 *
 * Written against the long-standing API rather than the newer
 * PublicKeyCredential.parseRequestOptionsFromJSON()/toJSON() pair: those are
 * pleasanter and not yet everywhere, and a sign-in screen is the last place
 * to discover a browser is too old.
 */

/** Whether this browser can do any of this at all. */
export function supported() {
  return typeof window !== "undefined" && Boolean(window.PublicKeyCredential);
}

function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** allauth's JSON shape, turned into what navigator.credentials.get wants. */
function decodeRequestOptions(options) {
  const publicKey = { ...options };
  publicKey.challenge = fromBase64Url(options.challenge);
  if (Array.isArray(options.allowCredentials)) {
    publicKey.allowCredentials = options.allowCredentials.map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    }));
  }
  return publicKey;
}

/** And the credential the browser produced, turned back into JSON. */
function encodeCredential(credential) {
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    // Present when the key was used to sign in rather than to register.
    authenticatorAttachment: credential.authenticatorAttachment || null,
    response: {
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      authenticatorData: toBase64Url(credential.response.authenticatorData),
      signature: toBase64Url(credential.response.signature),
      userHandle: credential.response.userHandle
        ? toBase64Url(credential.response.userHandle)
        : null,
    },
  };
}

/**
 * Ask for a signature, and hand back what allauth expects to receive.
 *
 * @param {object} requestOptions - allauth's `request_options`, verbatim.
 * @param {AbortSignal} [signal] - so navigating away closes the browser's
 *   own prompt rather than leaving it over the next screen.
 */
export async function sign(requestOptions, signal) {
  const publicKey = decodeRequestOptions(requestOptions.publicKey || requestOptions);
  const credential = await navigator.credentials.get({ publicKey, signal });
  if (!credential) throw new Error("No credential was returned.");
  return encodeCredential(credential);
}
