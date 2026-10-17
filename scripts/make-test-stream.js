'use strict';
/* Generates a CLEAN fMP4 HLS VOD stream (test pattern + tone) into media/.
 * The server then obfuscates it on the fly. Requires ffmpeg on PATH. */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const mediaDir = path.resolve(process.env.MEDIA_DIR || path.join(__dirname, '..', 'media'));
fs.mkdirSync(mediaDir, { recursive: true });

const args = [
  '-hide_banner', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000',
  '-t', '20',
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k',
  '-f', 'hls',
  '-hls_time', '2',
  '-hls_playlist_type', 'vod',
  '-hls_segment_type', 'fmp4',
  '-hls_fmp4_init_filename', 'init.mp4',
  '-hls_segment_filename', 'seg_%03d.m4s',
  'stream.m3u8',
];

console.log('Running ffmpeg in', mediaDir);
const r = spawnSync('ffmpeg', args, { cwd: mediaDir, stdio: 'inherit' });
if (r.error) {
  console.error('\nffmpeg not found on PATH. Install it, or point MEDIA_DIR at an existing HLS folder.');
  process.exit(1);
}
process.exit(r.status || 0);
