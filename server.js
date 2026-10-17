'use strict';
/*
 * server.js — origin + edge gate.
 *
 *   GET /token?asset=<id>       -> { pkey, asset, ttl, mode, contentKey? }   (asset-scoped)
 *   GET /hls/:name(.m3u8)?pkey=  -> obfuscated playlist (token scoped to this asset)
 *   GET /seg/:name?a=&exp=&sig=  -> real segment bytes; each URL individually signed
 *   GET /                        -> demo player
 *
 * Point MEDIA_DIR at any CLEAN HLS output (e.g. from `npm run make-stream`).
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const guard = require('./lib/guard');

const PORT = Number(process.env.PORT || 8080);
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(__dirname, 'media'));
const TOKEN_TTL = Number(process.env.TOKEN_TTL || 30); // playlist-token lifetime (s)

const app = express();
app.set('trust proxy', true); // so req.ip reflects X-Forwarded-For behind a proxy

// Bind tokens/signatures to the viewer when BIND_IP=1 (anti-share).
const bindFor = (req) => (process.env.BIND_IP === '1' ? req.ip : '');

// ---- mint an asset-scoped playlist token -----------------------------------
app.get('/token', (req, res) => {
  const asset = guard.assetIdOf(path.basename(String(req.query.asset || 'stream')));
  const bind = bindFor(req);
  const pkey = guard.mintPlaylistToken(asset, TOKEN_TTL, bind);
  const body = { pkey, asset, ttl: TOKEN_TTL, mode: guard.MODE };
  if (guard.MODE === 'client') body.contentKey = guard.contentKeyB64(pkey);
  res.set('cache-control', 'no-store').json(body);
});

// ---- playlists --------------------------------------------------------------
app.get(/^\/hls\/(.+\.m3u8)$/, (req, res) => {
  const name = path.basename(req.params[0]); // no traversal
  const file = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).send('no such playlist');

  const assetId = guard.assetIdOf(name);
  const bind = bindFor(req);
  const authorized = guard.verifyPlaylistToken(req.query.pkey, assetId, bind); // (1) asset-scoped

  const text = fs.readFileSync(file, 'utf8');
  const isMaster = /#EXT-X-STREAM-INF/.test(text);

  res.set('content-type', 'application/vnd.apple.mpegurl').set('cache-control', 'no-store');

  if (isMaster) return res.send(guard.rewriteMasterPlaylist(text, req.query.pkey || ''));
  return res.send(
    guard.obfuscateMediaPlaylist(text, { assetId, authorized, bind, pkey: req.query.pkey || '' }),
  );
});

// ---- segment origin: verify the PER-SEGMENT signature, not a shared token ----
app.get(/^\/seg\/(.+)$/, (req, res) => {
  const name = path.basename(req.params[0]);
  const bind = bindFor(req);
  if (!guard.verifySegment(name, req.query, bind)) { // (2) + (4) grace inside
    return res.status(403).send('forbidden: bad/expired segment signature');
  }
  const file = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).send('no such segment');

  // VOD segments are immutable: the signed `exp` already bounds access, so they may be
  // cached by the browser/CDN for the signature's lifetime.
  res.set('content-type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
  res.set('accept-ranges', 'bytes');
  res.set('cache-control', `private, max-age=${guard.SEG_TTL}`);
  fs.createReadStream(file).pipe(res);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  HLS obfuscation demo`);
  console.log(`  mode      : ${guard.MODE}`);
  console.log(`  media dir : ${MEDIA_DIR}`);
  console.log(`  token ttl : ${TOKEN_TTL}s   seg sig ttl: ${guard.SEG_TTL}s   grace: ${guard.GRACE}s`);
  console.log(`  open      : http://localhost:${PORT}\n`);
  if (!fs.existsSync(MEDIA_DIR) || fs.readdirSync(MEDIA_DIR).length === 0) {
    console.log('  (!) media/ is empty — run:  npm run make-stream\n');
  }
});
