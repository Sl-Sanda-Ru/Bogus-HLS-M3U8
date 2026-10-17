'use strict';
/*
 * guard.js — obfuscation + access control.
 *
 * Layers:
 *   1. Obfuscation: real segment/part/init URLs are replaced with a DECOY and the
 *      real reference is carried in `#EXT-X-GUARD:URI:` (plaintext when authorized,
 *      or AES-GCM encrypted in client mode). Cosmetic — raises the bar for scrapers.
 *   2. Access control (what matters):
 *        a) Playlist token (`pkey`) — short-lived, HMAC-signed, **scoped to one asset**.
 *        b) Per-segment SIGNED URLs — every segment URL carries its own `exp`+`sig`,
 *           bound to (asset, filename, expiry [, viewer]). No shared bearer token on
 *           segments; a leaked URL only unlocks one file for a few seconds.
 *      A GRACE window keeps near-expiry reloads from 403-ing mid-playback.
 */

const crypto = require('crypto');

const SECRET = process.env.GUARD_SECRET || 'dev-secret-change-me';
const MODE = process.env.GUARD_MODE === 'client' ? 'client' : 'server';
// Per-segment signature lifetime (s). Live: keep SHORT (every ~2s playlist reload
// re-signs). VOD: the playlist is loaded once, so this must EXCEED the content
// duration (default 2h) or late segments 403 mid-playback — see README.
const SEG_TTL = Number(process.env.SEG_TTL || 7200);
const GRACE = Number(process.env.GUARD_GRACE || 5); // accept this many seconds past exp
const TAG = '#EXT-X-GUARD';
const DECOY = 'decoy.mp4';

const now = () => Math.floor(Date.now() / 1000);
const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
const eq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// assetId for a playlist file, e.g. "stream.m3u8" -> "stream"
function assetIdOf(playlistName) {
  return String(playlistName).replace(/\.m3u8$/i, '');
}

// ---------------------------------------------------------------------------
// (1) Playlist token (pkey) — asset-scoped.  format: <exp>~<sig>
// ---------------------------------------------------------------------------
function mintPlaylistToken(assetId, ttlSec, bind = '') {
  const exp = now() + Number(ttlSec);
  return `${exp}~${sign(`pl.${assetId}.${exp}.${bind}`)}`;
}
function verifyPlaylistToken(tok, assetId, bind = '') {
  if (!tok || typeof tok !== 'string') return false;
  const [exp, sig] = tok.split('~');
  if (!/^\d+$/.test(exp) || Number(exp) < now() - GRACE) return false; // (4) grace
  return eq(sig, sign(`pl.${assetId}.${exp}.${bind}`));
}

// ---------------------------------------------------------------------------
// (2) Per-segment signed URL.  "<name>?a=<asset>&exp=<t>&sig=<s>"
// ---------------------------------------------------------------------------
function signSegment(assetId, name, bind = '') {
  const exp = now() + SEG_TTL;
  const sig = sign(`seg.${assetId}.${name}.${exp}.${bind}`);
  return `${name}?a=${encodeURIComponent(assetId)}&exp=${exp}&sig=${sig}`;
}
function verifySegment(name, query, bind = '') {
  const { a, exp, sig } = query || {};
  if (!a || !exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < now() - GRACE) return false; // (4) grace
  return eq(sig, sign(`seg.${a}.${name}.${exp}.${bind}`));
}

// ---------------------------------------------------------------------------
// Client-mode confidentiality of the GUARD ref: AES-256-GCM, key = HKDF(secret,pkey)
// ---------------------------------------------------------------------------
function contentKey(pkey) {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(SECRET), Buffer.from(String(pkey)), Buffer.from('guard-content'), 32),
  );
}
function contentKeyB64(pkey) {
  return contentKey(pkey).toString('base64');
}
function encryptRef(plain, pkey) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', contentKey(pkey), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url'); // iv|tag|ct
}

// ---------------------------------------------------------------------------
// Turn a CLEAN media playlist into decoys + GUARD tags carrying SIGNED refs.
// ---------------------------------------------------------------------------
function obfuscateMediaPlaylist(text, { assetId, authorized, bind = '', pkey = '' }) {
  // Build the GUARD payload for one real filename: a signed URL, then (per mode) hide it.
  const payloadFor = (name) => {
    const signed = signSegment(assetId, name, bind); // (2) per-segment signature
    return MODE === 'client' ? encryptRef(signed, pkey) : signed;
  };
  // Only emit the real ref when we're allowed to (server mode gate; client mode always,
  // because it's encrypted).
  const emit = MODE === 'client' || authorized;
  const out = [];

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m;

    if ((m = line.match(/^#EXT-X-MAP:(.*)URI="([^"]+)"(.*)$/))) {
      if (emit) out.push(`${TAG}:URI:${payloadFor(m[2])}`);
      out.push(`#EXT-X-MAP:${m[1]}URI="${DECOY}"${m[3]}`);
    } else if ((m = line.match(/^#EXT-X-PART:(.*)URI="([^"]+)"(.*)$/))) {
      if (emit) out.push(`${TAG}:URI:${payloadFor(m[2])}`);
      out.push(`#EXT-X-PART:${m[1]}URI="${DECOY}"${m[3]}`);
    } else if ((m = line.match(/^#EXT-X-PRELOAD-HINT:(.*)URI="([^"]+)"(.*)$/))) {
      if (emit) out.push(`${TAG}:URI:${payloadFor(m[2])}`);
      out.push(`#EXT-X-PRELOAD-HINT:${m[1]}URI="${DECOY}"${m[3]}`);
    } else if (line && !line.startsWith('#')) {
      if (emit) out.push(`${TAG}:URI:${payloadFor(line.trim())}`);
      out.push(DECOY);
    } else {
      out.push(line); // passthrough
    }
  }
  return out.join('\n');
}

function rewriteMasterPlaylist(text, pkey) {
  return text
    .split('\n')
    .map((raw) => {
      const line = raw.replace(/\r$/, '');
      if (line && !line.startsWith('#')) {
        const sep = line.includes('?') ? '&' : '?';
        return `/hls/${line.trim()}${sep}pkey=${encodeURIComponent(pkey)}`;
      }
      return line;
    })
    .join('\n');
}

module.exports = {
  TAG, DECOY, MODE, SEG_TTL, GRACE,
  assetIdOf,
  mintPlaylistToken, verifyPlaylistToken,
  verifySegment,
  obfuscateMediaPlaylist, rewriteMasterPlaylist,
  contentKeyB64,
};
