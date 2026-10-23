// Per-deck public-view passwords.
//
// A deck may carry its own view password for public view-only hosts, set by
// its owner through the editor (stored as a salted verifier — never plain-
// text — under .history/view.json, gitignored and bucket-private like
// access.json). Decks without one fall back to the host-wide
// DECKS_VIEW_PASSWORD exactly as before; an explicit per-deck setting
// overrides only that deck.
//
// Unlock cookies are bound to the document: the cookie value is
// HMAC(key = password secret material, message = documentId), so a cookie
// earned on one deck never unlocks another, and changing a deck's password
// invalidates its prior unlock state (the old hash no longer derives the
// cookie) without touching other decks.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const VERIFIER_FILE = path.join(".history", "view.json");
const KEY_LENGTH = 32;

// Document-bound cookie token from the deck's secret material.
export const cookieValue = (secret, documentId) =>
  createHmac("sha256", secret).update(documentId).digest("hex");

export const cookieName = (documentId) => `decks_view_${documentId}`;

// Parse and validate a stored verifier; anything malformed counts as absent.
const parseVerifier = (json, documentId) => {
  try {
    const data = JSON.parse(json);
    if (data.documentId !== documentId) return null;
    const salt = Buffer.from(data.salt, "hex"), hash = Buffer.from(data.hash, "hex");
    if (salt.length < 16 || hash.length !== KEY_LENGTH) return null;
    return { salt, hash, updatedAt: String(data.updatedAt || "") };
  } catch { return null; }
};

// Read the deck's verifier, cached by file mtime so runtime password changes
// (made through the private host's read-write mount) are picked up on the
// next request without rescrypt work on every asset fetch.
export const createVerifierStore = (deckDir, documentId) => {
  const file = path.join(deckDir, VERIFIER_FILE);
  let cached = null, cachedMtime = -1;
  return {
    load() {
      let mtime = -1;
      try { mtime = statSync(file).mtimeMs; } catch { cached = null; cachedMtime = -1; return null; }
      if (mtime === cachedMtime && cached) return cached;
      try { cached = parseVerifier(readFileSync(file, "utf8"), documentId); }
      catch { cached = null; }
      cachedMtime = mtime;
      return cached;
    },
    // Returns { updatedAt }; the plaintext exists only for this call.
    set(password) {
      const salt = randomBytes(16);
      const hash = scryptSync(String(password), salt, KEY_LENGTH);
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp-${process.pid}`;
      writeFileSync(temporary, JSON.stringify({
        documentId, salt: salt.toString("hex"), hash: hash.toString("hex"),
        updatedAt: new Date().toISOString(),
      }, null, 2) + "\n");
      renameSync(temporary, file);
      cached = parseVerifier(readFileSync(file, "utf8"), documentId);
      cachedMtime = statSync(file).mtimeMs;
      return { updatedAt: cached.updatedAt };
    },
    remove() {
      try { unlinkSync(file); } catch {}
      cached = null; cachedMtime = -1;
    },
  };
};

// Salted, timing-safe check of a posted password against the verifier.
export const verifyAgainstVerifier = (password, verifier) => {
  try {
    const candidate = scryptSync(String(password || ""), verifier.salt, KEY_LENGTH);
    return timingSafeEqual(candidate, verifier.hash);
  } catch { return false; }
};
