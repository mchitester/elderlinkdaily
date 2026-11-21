// Elder Link Daily worker: static files, Range support for audio, and Laurie's voice (/tts).
const VOICE_ID = 'Rfr8Cn9daYiYJv4iZLHl';
const VER = 'v1';
const DAILY_CHAR_CAP = 4000;

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function tts(request, env, url) {
  const ref = request.headers.get('Referer') || request.headers.get('Origin') || '';
  const okRef = /^https:\/\/(www\.)?elderlinkdaily\.com\//.test(ref) || url.searchParams.get('k') === env.WARM_KEY && env.WARM_KEY;
  if (!okRef) return new Response('forbidden', { status: 403 });
  let text = (url.searchParams.get('t') || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 900) return new Response('bad text', { status: 400 });
  const key = VER + ':' + await sha(text);
  const hit = env.VOICE && await env.VOICE.get(key, 'arrayBuffer');
  const headers = { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Voice': 'cache' };
  if (hit) return new Response(hit, { headers });
  const apiKey = env.ELEVEN_KEY || await env.VOICE.get('cfg:eleven');
  if (!apiKey) return new Response('no key', { status: 503 });
  // daily spending guard
  const day = 'chars:' + new Date().toISOString().slice(0, 10);
  const used = Number(await env.VOICE.get(day) || 0);
  if (used + text.length > DAILY_CHAR_CAP && url.searchParams.get('k') !== env.WARM_KEY) return new Response('daily cap', { status: 429 });
  const model = text.length <= 160 ? 'eleven_multilingual_v2' : 'eleven_flash_v2_5';
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
  });
  if (!r.ok) return new Response('tts error ' + r.status, { status: 502 });
  const buf = await r.arrayBuffer();
  await env.VOICE.put(key, buf);
  await env.VOICE.put(day, String(used + text.length), { expirationTtl: 3 * 86400 });
  headers['X-Voice'] = 'new';
  return new Response(buf, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/tts') {
      try { return await tts(request, env, url); } catch (e) { return new Response('error', { status: 500 }); }
    }
    const res = await env.ASSETS.fetch(request);
    const range = request.headers.get('Range');
    if (!range || res.status !== 200) return res;
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) return res;
    const buf = await res.arrayBuffer();
    const size = buf.byteLength;
    let start, end;
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const h = new Headers(res.headers);
    h.set('Content-Range', `bytes ${start}-${end}/${size}`);
    h.set('Content-Length', String(end - start + 1));
    h.set('Accept-Ranges', 'bytes');
    return new Response(buf.slice(start, end + 1), { status: 206, headers: h });
  }
};
