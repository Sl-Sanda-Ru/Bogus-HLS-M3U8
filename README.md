# HLS Obfuscation + Signed-URL Gate

A small, **runnable** reference implementation of the kind of HLS stream protection
used by live-streaming sites (modeled on the "**Mouflon**" scheme observed on
doppiocdn/stripchat). It takes any clean HLS stream and serves it with two layers:

1. **Obfuscation** — real segment URLs are replaced with a decoy; the real reference is
   hidden in a custom `#EXT-X-GUARD` tag. A normal player/scraper only sees junk.
2. **Access control** — an asset-scoped token gates the playlist, and every segment URL is
   individually signed and short-lived. This is the layer that actually protects content.

> **For protecting your _own_ streams.** This is defensive tooling: it shows how to make a
> stream hard to rip and how to gate access. It is not a tool for bypassing anyone else's
> protection.

---

## Table of contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Serving your own video](#serving-your-own-video)
- [Configuration](#configuration)
- [Access-control model](#access-control-model)
- [Modes: server vs client](#modes-server-vs-client)
- [Live vs VOD (important for `SEG_TTL`)](#live-vs-vod-important-for-seg_ttl)
- [Threat model: what stops which scraper](#threat-model-what-stops-which-scraper)
- [Verifying it works](#verifying-it-works)
- [How it maps to the observed "Mouflon" scheme](#how-it-maps-to-the-observed-mouflon-scheme)
- [Project layout](#project-layout)
- [Production checklist](#production-checklist)
- [Limitations & honest caveats](#limitations--honest-caveats)
- [Roadmap](#roadmap)

---

## How it works

```
                        ┌─────────────────────────────────────────────┐
  Clean HLS (ffmpeg)    │  Node origin (server.js)                     │
  media/stream.m3u8     │                                              │
  media/init.mp4        │  GET /token?asset=ID  → short-lived pkey     │
  media/seg_0000.m4s …  │  GET /hls/ID.m3u8     → OBFUSCATED playlist  │
                        │  GET /seg/NAME?sig=…  → real bytes (gated)   │
                        └───────────────┬──────────────────────────────┘
                                        │
                     obfuscated playlist (decoys + #EXT-X-GUARD tags)
                                        │
                        ┌───────────────▼──────────────────────────────┐
                        │  Browser (public/player.js)                   │
                        │  patched hls.js playlist loader:              │
                        │   • reads #EXT-X-GUARD refs                   │
                        │   • swaps each decoy → real signed /seg/ URL  │
                        │   • strips the tags before hls.js parses      │
                        └───────────────────────────────────────────────┘
```

The playlist delivered to the player looks like this (server mode, authorized):

```m3u8
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-GUARD:URI:init.mp4?a=stream&exp=1792250479&sig=kPHWkG7sYc6…   ← real, signed
#EXT-X-MAP:URI="decoy.mp4"                                           ← decoy a scraper sees
#EXTINF:4.000078,
#EXT-X-GUARD:URI:seg_0000.m4s?a=stream&exp=1792250479&sig=GephBiX…  ← real, signed
decoy.mp4                                                            ← decoy a scraper sees
...
```

A tool that doesn't understand `#EXT-X-GUARD` (yt-dlp, ffmpeg, VLC, browser sniffers)
downloads `decoy.mp4` for every fragment and fails. The patched `player.js` swaps the
decoy for the real, signed URL and plays normally.

---

## Quick start

Requirements: **Node 18+** and **ffmpeg** on `PATH`.

```bash
cd hls-obfuscation-demo
npm install
npm run make-stream      # writes a clean test stream into media/
npm start                # → http://localhost:8080
```

Open **http://localhost:8080**. The video plays through the patched loader. Click
**“Show what a scraper sees”** to fetch the playlist without a token and watch every
segment collapse to `decoy.mp4`.

> **Corporate TLS note:** if `npm install` fails with
> `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, run it as
> `NODE_OPTIONS=--use-system-ca npm install`.

---

## Serving your own video

Point the segmenter at any file. If it's already **H.264/AAC**, use `-c copy` (lossless,
near-instant); otherwise drop `-c copy` to re-encode.

```bash
# from the project root
ffmpeg -y -i "C:\path\to\video.mp4" -c copy \
  -f hls -hls_time 4 -hls_playlist_type vod \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "media/seg_%04d.m4s" "media/stream.m3u8"

npm start
```

Or point the server at an existing HLS folder without copying anything:

```bash
MEDIA_DIR="D:\some\hls\output" npm start
```

The player loads the asset named `stream` (`media/stream.m3u8`). To serve a different
asset id, rename the playlist and update `ASSET`/`SRC` at the top of `public/player.js`.

---

## Configuration

All via environment variables:

| var | default | meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `MEDIA_DIR` | `./media` | folder of CLEAN HLS (any ffmpeg/packager output) |
| `GUARD_MODE` | `server` | `server` (real URL emitted only when authorized) or `client` (real ref always present but AES-encrypted) |
| `GUARD_SECRET` | `dev-secret-change-me` | HMAC/KDF secret — **set a real one in prod** |
| `TOKEN_TTL` | `30` | playlist token (`pkey`) lifetime (seconds) |
| `SEG_TTL` | `7200` | per-segment signed-URL lifetime (s). **Live:** short (~30). **VOD:** must exceed content duration (default 2h) |
| `GUARD_GRACE` | `5` | accept tokens/signatures this many seconds past expiry (prevents mid-playback 403s) |
| `BIND_IP` | unset | `1` binds the token **and** every segment signature to the viewer IP (anti-share) |

Example — client mode with a real secret and IP binding:

```bash
GUARD_MODE=client BIND_IP=1 GUARD_SECRET="$(openssl rand -hex 32)" npm start
```

---

## Access-control model

- **Playlist token (`pkey`)** — short-lived, HMAC-signed, and **scoped to one asset**
  (`/token?asset=<id>`). A token for asset *A* cannot de-obfuscate asset *B*.
  Format: `<expEpoch>~<base64url-hmac>`.

- **Per-segment signed URLs** — the server stamps every real segment URL with its own
  `?a=<asset>&exp=<t>&sig=<hmac>`, bound to **(asset, filename, expiry [, viewer IP])**.
  There is **no shared bearer token on segments**: a leaked segment URL unlocks exactly
  one file, for at most `SEG_TTL` seconds. In `client` mode the signed URL is delivered
  AES-256-GCM encrypted (key = `HKDF(secret, pkey)`), handed only to an authenticated
  session.

- **Grace window** (`GUARD_GRACE`) — an about-to-expire reload still succeeds, so token
  refresh never 403s a segment already in flight.

All signatures are HMAC-SHA-256 over a typed string (`pl.…`, `seg.…`) and compared with a
constant-time check.

---

## Modes: server vs client

| | `server` (default) | `client` |
|---|---|---|
| Playlist without a valid token | decoys only (no real refs at all) | decoys + **encrypted** refs |
| Where de-obfuscation happens | server emits plaintext signed URL in the tag | browser decrypts the tag via WebCrypto |
| Browser needs | the `pkey` only | the `pkey` **and** the per-pkey content key (`/token` returns it) |
| Best when | you want the server to be the gate | you want the manifest to be useless even if the token check is bypassed at the edge |

Both modes end up fetching the same signed `/seg/...` URLs, so the segment gate is identical.

---

## Live vs VOD (important for `SEG_TTL`)

- **Live:** a playlist reloads every couple of seconds, so each reload **re-signs** the
  current segments. Keep `SEG_TTL` short (~30s) — leaked URLs are near-worthless.
- **VOD:** the playlist is loaded **once**, so all segment signatures are minted up front.
  `SEG_TTL` must therefore **exceed the video's duration** (default is 2h). If you want
  short-lived signatures on VOD too, use **signed cookies** (one policy for the whole
  session) or have the player periodically reload the source so signatures re-mint.

---

## Threat model: what stops which scraper

| # | Tool / technique | Obfuscation stops it? | Notes |
|---|---|:--:|---|
| 1 | `yt-dlp` / `youtube-dl` | ✅ | sees `decoy.mp4` for all 344 fragments → 404 (verified) |
| 2 | `ffmpeg -i`, `streamlink`, VLC | ✅ | don't understand `#EXT-X-GUARD` |
| 3 | Browser downloader extensions | ⚠️ | may catch signed segment URLs live, but they expire (`SEG_TTL`) / are IP-bound |
| 4 | `curl`/`requests` + m3u8 parser | ⚠️ | must read your JS to find the real refs; else fails |
| 5 | Headless browser (Playwright/Puppeteer) | ❌ | runs your `player.js`, so de-obfuscation happens for them — only the **gate** (short TTL, IP bind, rate limit) slows them |
| 6 | Screen / HDMI capture (OBS) | ❌ | records decoded pixels; no client scheme stops this — not even Widevine L1 |

**Bottom line:** the obfuscation defeats tiers 1–4 (~95% of real attempts). Tiers 5–6 are
defeated by *nobody's* client-side scheme; against those only the server-side gate matters.
Obfuscation = speed bump; **the token/signature gate is the security.**

---

## Verifying it works

Observed results from this repo (localhost):

**yt-dlp against a valid token:**
```
[hlsnative] Total fragments: 344
[download] Got error: HTTP Error 404: Not Found. Retrying fragment 1 ...
```
It parses the manifest but downloads the decoy for every fragment → 404. Defeated.

**Segment gate:**
```
valid signed ref        -> 200
tampered sig            -> 403
swap asset a=stream->x  -> 403
no signature            -> 403
```

**Asset scoping:** a `pkey` minted for `stream` returns **decoys only** for `other.m3u8`.

**Grace window:** a signature 3s past expiry → `200`; 10s past → `403`.

**Real playback (headless Chrome, earlier run):** `manifest parsed — real URLs recovered`,
init + all segments fetched `200` through signed `/seg/...` URLs, MediaSource engaged.

You can reproduce the gate checks with `curl`:

```bash
B=http://localhost:8080
PK=$(curl -s "$B/token?asset=stream" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).pkey))')
curl -s "$B/hls/stream.m3u8"          | grep -m1 EXT-X-MAP     # no token  → decoy.mp4
curl -s "$B/hls/stream.m3u8?pkey=$PK" | grep -m1 EXT-X-GUARD   # token     → real signed ref
curl -s -o /dev/null -w '%{http_code}\n' "$B/seg/seg_0000.m4s" # 403 (unsigned)
```

---

## How it maps to the observed "Mouflon" scheme

| Observed (doppiocdn / MMP player) | This project |
|---|---|
| `#EXT-X-MOUFLON:URI:` / `:FILE:` hides the real URL | `#EXT-X-GUARD:URI:` |
| standard line points at decoy `b-hls-01/media.mp4` | `decoy.mp4` |
| `?psch=v2&pkey=<16-char>` gates decode | `?pkey=<asset-scoped HMAC>` + per-segment `?a&exp&sig` |
| master lists ~11 rotating `PSCH` keys | rotate `GUARD_SECRET`, short TTLs |
| `#EXT-X-MOUFLON:EXT-REF:<pts>;<b64>` timestamp map | omitted (not needed for correctness) |
| MMP = patched hls.js | `public/player.js` custom `pLoader` |
| player bundle hidden behind string-array/char-math obfuscation | out of scope (minify your bundle in prod) |

---

## Project layout

```
hls-obfuscation-demo/
├── server.js                    # origin + gate: /token, /hls/*.m3u8, /seg/*
├── lib/guard.js                 # tokens, per-segment signatures, playlist obfuscation, AES refs
├── public/
│   ├── index.html               # demo page (hls.js pinned from cdnjs)
│   └── player.js                # patched hls.js playlist loader (the de-obfuscator)
├── scripts/make-test-stream.js  # ffmpeg test-stream generator
├── media/                       # your CLEAN HLS (stream.m3u8 + init + segments)
├── package.json
└── README.md
```

Key functions in `lib/guard.js`:

- `mintPlaylistToken(assetId, ttl, bind)` / `verifyPlaylistToken(tok, assetId, bind)`
- `signSegment(assetId, name, bind)` / `verifySegment(name, query, bind)`
- `obfuscateMediaPlaylist(text, { assetId, authorized, bind, pkey })`
- `encryptRef` / `contentKeyB64` (client mode)

---

## Production checklist

- [ ] Set a strong `GUARD_SECRET` (e.g. `openssl rand -hex 32`); store it in a secrets manager.
- [ ] Serve everything over **HTTPS**.
- [ ] Enable `BIND_IP=1` (or bind tokens to the authenticated user id).
- [ ] Keep `TOKEN_TTL` low; use a short `SEG_TTL` for live.
- [ ] Terminate the token/signature check at the **edge** (nginx `secure_link`,
      Cloudflare Worker, or CloudFront signed URLs) and keep the Node origin private —
      don't stream every byte through Node.
- [ ] Add **rate limiting** per token/IP on `/seg` to blunt headless-browser drainers.
- [ ] Set tight CORS; keep playlists `Cache-Control: no-store`, let signed segments be
      cacheable for their signature lifetime.
- [ ] Minify/obfuscate your player bundle (defense-in-depth only; it is reversible).
- [ ] For paid/premium content, use real **DRM** (Widevine / FairPlay / PlayReady).
      Obfuscation is **not** DRM.

---

## Limitations & honest caveats

- The `#EXT-X-GUARD` trick is **reversible** by anyone who reads `player.js`. Its value is
  stopping automated tools, not determined humans.
- A **headless browser** running your player de-obfuscates for free; only the gate slows it.
- **Screen capture** defeats every client-side scheme, including real DRM at lower security
  levels. Plan for it with watermarking + legal deterrence, not code.
- This repo streams bytes through Node for demo clarity. That is **not** a scalable origin.
- `GUARD_MODE=client` hands the content key to the browser, so it only raises the bar; the
  real guarantee is still the server-side signature on `/seg`.

---

## Roadmap

Optional extensions (not yet implemented):

- **Edge config** — nginx `secure_link` / Cloudflare Worker doing the same signature check.
- **Rate limiting** — token-bucket per token/IP on the segment endpoint.
- **True live LL-HLS** — `#EXT-X-PART` + blocking reload (`_HLS_msn`/`_HLS_part`), plus a
  fragment loader as well as the playlist loader.
- **Stronger obfuscation parity** — per-segment encrypted refs with a timestamp map and a
  rotating key set, as in the original scheme.
- **Signed cookies** — session-scoped access for VOD without long per-segment TTLs.

---

*Educational / defensive reference. Use it to protect content you have the right to serve.*
