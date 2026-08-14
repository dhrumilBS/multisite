// Persistent player profile (display name + photo), keyed by the same
// client-generated `playerId` the wallet uses - shared across both games,
// unlike the wallet which is Teen Patti-only. Mirrors game/wallet.js's
// single-file, atomic-write, load-once-into-memory pattern exactly.
"use strict";

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./common/atomicWrite");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES_PATH = path.join(DATA_DIR, "profiles.json");

const MAX_NAME = 16;
const MAX_PHOTO_CHARS = 200000; // ~150KB - generous ceiling for a 128x128 JPEG data URI

// Anchored end-to-end (not just a prefix check) - this string later lands in
// an <img src="..."> template on OTHER players' screens, so anything beyond
// the exact data-URI charset (no quotes, angle brackets, etc.) is rejected
// before it's ever stored.
const PHOTO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

let profiles = null;

function init() {
  if (profiles) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  } catch (e) {
    profiles = {};
  }
}

function persist() {
  try {
    writeJsonAtomic(PROFILES_PATH, profiles);
  } catch (e) {
    console.error("Profile save failed:", e.message);
  }
}

function getProfile(playerId) {
  init();
  const p = playerId && profiles[playerId];
  return { name: (p && p.name) || null, photo: (p && p.photo) || null };
}

function getPhoto(playerId) {
  if (!playerId) return null;
  return getProfile(playerId).photo;
}

// name/photo are both optional - a name-only update keeps the existing
// photo, and vice versa. Returns {error} on any invalid input; never throws.
function setProfile(playerId, { name, photo } = {}) {
  init();
  if (!playerId || typeof playerId !== "string") return { error: "No player id." };
  if (photo != null) {
    if (typeof photo !== "string" || photo.length > MAX_PHOTO_CHARS) return { error: "Photo is too large." };
    if (!PHOTO_RE.test(photo)) return { error: "Invalid photo format." };
  }
  const existing = profiles[playerId] || {};
  const cleanName = name != null ? String(name).trim().slice(0, MAX_NAME) || null : existing.name || null;
  const cleanPhoto = photo != null ? photo : existing.photo || null;
  profiles[playerId] = { name: cleanName, photo: cleanPhoto, updatedAt: Date.now() };
  persist();
  return { ok: true, name: cleanName, photo: cleanPhoto };
}

module.exports = { init, getProfile, getPhoto, setProfile, MAX_NAME, MAX_PHOTO_CHARS };
