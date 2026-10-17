/* player.js — patched hls.js loader that reverses the Guard obfuscation.
 *
 * The media playlist hls.js receives contains only DECOY urls; the real refs
 * live in `#EXT-X-GUARD:URI:` tags. We intercept the playlist loader, swap the
 * decoys back to real `/seg/..?pkey=..` urls, and strip the Guard tags before
 * hls.js ever parses the manifest. This is the browser twin of the server's
 * `obfuscateMediaPlaylist()`.
 */
(() => {
  const SRC = 'stream.m3u8';
  const ASSET = 'stream';
  const GUARD = '#EXT-X-GUARD:URI:';

  let PKEY = '';
  let MODE = 'server';
  let cryptoKey = null; // AES-GCM CryptoKey, client mode only

  const log = (...a) => {
    const el = document.getElementById('log');
    el.textContent += a.join(' ') + '\n';
    el.scrollTop = el.scrollHeight;
    console.log('[guard]', ...a);
  };

  async function refreshToken() {
    const j = await (await fetch(`/token?asset=${encodeURIComponent(ASSET)}`, { cache: 'no-store' })).json();
    PKEY = j.pkey;
    MODE = j.mode;
    if (MODE === 'client' && j.contentKey) {
      const raw = Uint8Array.from(atob(j.contentKey), (c) => c.charCodeAt(0));
      cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    }
    return j;
  }

  // `ref` is the server-signed segment reference ("name?a=..&exp=..&sig=.."),
  // already carrying its own per-segment signature — no shared pkey is appended.
  function segUrl(ref) {
    return `/seg/${ref}`;
  }

  async function decryptRef(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const iv = bin.slice(0, 12);
    const tag = bin.slice(12, 28);
    const ct = bin.slice(28);
    const data = new Uint8Array(ct.length + tag.length); // WebCrypto wants ct||tag
    data.set(ct, 0);
    data.set(tag, ct.length);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
    return new TextDecoder().decode(pt);
  }

  async function deobfuscate(text) {
    const out = [];
    let pending = null;
    for (const line of text.split('\n')) {
      if (line.startsWith(GUARD)) {
        const ref = line.slice(GUARD.length).trim();
        pending = MODE === 'client' ? await decryptRef(ref) : ref;
        continue; // drop the Guard tag — hls.js shouldn't see it
      }
      if (/^#EXT-X-(MAP|PART|PRELOAD-HINT):/.test(line) && pending) {
        out.push(line.replace(/URI="[^"]*"/, `URI="${segUrl(pending)}"`));
        pending = null;
        continue;
      }
      if (line && !line.startsWith('#') && pending) {
        out.push(segUrl(pending));
        pending = null;
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  function GuardLoader(Base) {
    return class extends Base {
      load(context, config, callbacks) {
        // keep the current pkey on every playlist reload (handles token refresh)
        if (/\/hls\//.test(context.url) && !/[?&]pkey=/.test(context.url)) {
          context.url += (context.url.includes('?') ? '&' : '?') + 'pkey=' + encodeURIComponent(PKEY);
        }
        const orig = callbacks.onSuccess;
        callbacks.onSuccess = (response, stats, ctx, net) => {
          const data = response.data;
          if (typeof data === 'string' && data.includes('#EXT-X-GUARD')) {
            deobfuscate(data).then((fixed) => {
              response.data = fixed;
              orig(response, stats, ctx, net);
            }).catch((e) => {
              log('deobfuscate error:', e.message);
              orig(response, stats, ctx, net);
            });
          } else {
            orig(response, stats, ctx, net);
          }
        };
        super.load(context, config, callbacks);
      }
    };
  }

  async function main() {
    const video = document.getElementById('video');
    await refreshToken();
    log('mode =', MODE, '| pkey =', PKEY.slice(0, 14) + '…');

    // refresh the short-lived pkey before it expires
    setInterval(() => refreshToken().then(() => log('pkey refreshed')), 20000);

    if (!window.Hls || !Hls.isSupported()) {
      log('hls.js not supported; trying native HLS (Safari).');
      video.src = `/hls/${SRC}?pkey=${encodeURIComponent(PKEY)}`;
      return;
    }

    const hls = new Hls({
      lowLatencyMode: true,
      pLoader: GuardLoader(Hls.DefaultConfig.loader),
    });
    hls.on(Hls.Events.ERROR, (_e, d) => log('hls error:', d.type, d.details, d.fatal ? '(fatal)' : ''));
    hls.on(Hls.Events.MANIFEST_PARSED, () => log('manifest parsed — real URLs recovered, playing'));
    hls.loadSource(`/hls/${SRC}?pkey=${encodeURIComponent(PKEY)}`);
    hls.attachMedia(video);
  }

  // Demo helper: show what a NAIVE player/scraper sees (decoys only).
  window.showRaw = async () => {
    const t = await (await fetch(`/hls/${SRC}`, { cache: 'no-store' })).text(); // no pkey
    document.getElementById('raw').textContent = t;
    log('fetched raw playlist WITHOUT pkey — note every segment is "decoy.mp4"');
  };

  document.addEventListener('DOMContentLoaded', main);
})();
