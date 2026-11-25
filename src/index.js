// Elder Link Daily worker: static files, Range support for audio, and Laurie's voice (/tts).
const VOICE_ID = 'Rfr8Cn9daYiYJv4iZLHl';
const VER = 'v3';
const DAILY_CHAR_CAP = 8000;

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function tts(request, env, url) {
  const ref = request.headers.get('Referer') || request.headers.get('Origin') || '';
  const okRef = /^https:\/\/((www\.)?elderlinkdaily\.com|[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev|[a-z0-9.-]*claudeusercontent\.com|claude\.ai)(\/|$)/.test(ref) || url.searchParams.get('k') === env.WARM_KEY && env.WARM_KEY;
  if (!okRef) return new Response('forbidden', { status: 403 });
  let text = (url.searchParams.get('t') || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 900) return new Response('bad text', { status: 400 });
  const hhv = (url.searchParams.get('h') || '').replace(/[^a-z0-9]/g, '');
  let voiceId = VOICE_ID;
  if (hhv) { const v = await env.VOICE.get('hhv:' + hhv, 'json'); if (v && v.id) voiceId = v.id; else return new Response('no custom voice', { status: 404 }); }
  const rec = voiceId === VOICE_ID ? await env.VOICE.getWithMetadata('rec:' + await sha(norm(text)), 'arrayBuffer') : { value: null };
  if (rec.value) return new Response(rec.value, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': (rec.metadata && rec.metadata.type) || 'audio/mp4', 'Cache-Control': 'no-cache', 'X-Voice': 'rec', 'Access-Control-Expose-Headers': 'X-Voice' } });
  const key = VER + ':' + (voiceId === VOICE_ID ? '' : voiceId + ':') + await sha(text);
  const hit = env.VOICE && await env.VOICE.get(key, 'arrayBuffer');
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Voice', 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache', 'X-Voice': 'cache' };
  if (hit) return new Response(hit, { headers });
  const apiKey = env.ELEVEN_KEY || await env.VOICE.get('cfg:eleven');
  if (!apiKey) return new Response('no key', { status: 503 });
  // daily spending guard
  const day = 'chars:' + new Date().toISOString().slice(0, 10);
  const used = Number(await env.VOICE.get(day) || 0);
  if (used + text.length > DAILY_CHAR_CAP && url.searchParams.get('k') !== env.WARM_KEY) return new Response('daily cap', { status: 429 });
  const model = 'eleven_multilingual_v2';
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.4, similarity_boost: 1.0, style: 0.3, use_speaker_boost: true } })
  });
  if (!r.ok) return new Response('tts error ' + r.status, { status: 502 });
  const buf = await r.arrayBuffer();
  await env.VOICE.put(key, buf);
  await env.VOICE.put(day, String(used + text.length), { expirationTtl: 3 * 86400 });
  headers['X-Voice'] = 'new';
  return new Response(buf, { headers });
}

const LAURIE_HASH = '3389ffb066991f7714f4676370e5615caab1e0a9a5499647f96b507e049adbd0';
const norm = t => String(t).toLowerCase().replace(/[\u2018\u2019\u201c\u201d'"]/g,'').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();

async function recSave(request, env, url) {
  if (await sha(url.searchParams.get('k') || '') !== LAURIE_HASH) return new Response('forbidden', { status: 403 });
  const text = url.searchParams.get('t') || '';
  const n = norm(text);
  if (!n) return new Response('bad', { status: 400 });
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 2000 || buf.byteLength > 5e6) return new Response('bad size', { status: 400 });
  const type = request.headers.get('Content-Type') || 'audio/mp4';
  await env.VOICE.put('rec:' + await sha(n), buf, { metadata: { type, text: text.slice(0, 300), at: Date.now() } });
  return new Response('saved', { headers: { 'Access-Control-Allow-Origin': '*' } });
}

async function recList(env, url) {
  if (await sha(url.searchParams.get('k') || '') !== LAURIE_HASH) return new Response('forbidden', { status: 403 });
  let out = [], cursor;
  do { const l = await env.VOICE.list({ prefix: 'rec:', cursor }); out = out.concat(l.keys.map(k => k.metadata && k.metadata.text).filter(Boolean)); cursor = l.list_complete ? null : l.cursor; } while (cursor);
  return new Response(JSON.stringify(out.map(norm)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function recGet(env, url) {
  const t = url.searchParams.get('t') || '';
  const r = await env.VOICE.getWithMetadata('rec:' + await sha(norm(t)), 'arrayBuffer');
  if (!r.value) return new Response('none', { status: 404 });
  return new Response(r.value, { headers: { 'Content-Type': (r.metadata && r.metadata.type) || 'audio/mp4', 'Cache-Control': 'no-store' } });
}


async function hhCheck(env, hh, hk) {
  if (!hh || hk.length < 8) return false;
  const stored = await env.VOICE.get('hhk:' + hh); const h2 = await sha(hk);
  if (!stored) { await env.VOICE.put('hhk:' + hh, h2); return true; }
  return stored === h2;
}

async function voiceNew(request, env, url) {
  const hh = (url.searchParams.get('h') || '').replace(/[^a-z0-9]/g, '');
  if (!await hhCheck(env, hh, url.searchParams.get('hk') || '')) return new Response('forbidden', { status: 403 });
  const name = (url.searchParams.get('name') || 'Narrator').slice(0, 40);
  const apiKey = env.ELEVEN_KEY || await env.VOICE.get('cfg:eleven');
  const audio = await request.arrayBuffer();
  if (audio.byteLength < 50000 || audio.byteLength > 20e6) return new Response('Recording too short. Please read for at least a minute.', { status: 400 });
  const type = request.headers.get('Content-Type') || 'audio/mp4';
  const fd = new FormData();
  fd.append('name', `Elder Link – ${name} (${hh})`);
  fd.append('description', 'Narrator voice for an Elder Link Daily household');
  fd.append('remove_background_noise', 'true');
  fd.append('files', new Blob([audio], { type }), type.includes('webm') ? 'sample.webm' : 'sample.m4a');
  const r = await fetch('https://api.elevenlabs.io/v1/voices/add', { method: 'POST', headers: { 'xi-api-key': apiKey }, body: fd });
  const txt = await r.text();
  if (!r.ok) {
    const why = /permission|missing_permissions|unauthor/i.test(txt) ? 'needs-permission' : /voice_limit|limit/i.test(txt) ? 'no-slots' : 'error';
    return new Response(JSON.stringify({ ok: false, why, status: r.status, detail: txt.slice(0, 300) }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
  const id = JSON.parse(txt).voice_id;
  const old = await env.VOICE.get('hhv:' + hh, 'json');
  await env.VOICE.put('hhv:' + hh, JSON.stringify({ id, name, at: Date.now() }));
  if (old && old.id && old.id !== id) { try { await fetch('https://api.elevenlabs.io/v1/voices/' + old.id, { method: 'DELETE', headers: { 'xi-api-key': apiKey } }); } catch (e) {} }
  return new Response(JSON.stringify({ ok: true, name }), { headers: { 'Content-Type': 'application/json' } });
}

const FAMILY_HASH = 'a0fd6079e0d6ff651d9b86ba60fe7988f5b4842d9b302f10913a15903b567c5d';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function saveReport(request, env) {
  const ref = request.headers.get('Referer') || request.headers.get('Origin') || '';
  if (!/^https:\/\/(www\.)?elderlinkdaily\.com/.test(ref)) return new Response('forbidden', { status: 403 });
  const txt = await request.text();
  if (txt.length > 20000) return new Response('too big', { status: 413 });
  let d; try { d = JSON.parse(txt) } catch (e) { return new Response('bad', { status: 400 }) }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day || '')) return new Response('bad day', { status: 400 });
  const hh = String(d.hh || '').replace(/[^a-z0-9]/g, '').slice(0, 16), hk = String(d.hk || '');
  delete d.hk;
  if (hh) {
    const stored = await env.VOICE.get('hhk:' + hh);
    const hk2 = await sha(hk);
    if (!stored) { if (hk.length < 8) return new Response('bad key', { status: 400 }); await env.VOICE.put('hhk:' + hh, hk2); }
    else if (stored !== hk2) return new Response('forbidden', { status: 403 });
    await env.VOICE.put('rep:' + hh + ':' + d.day, JSON.stringify(d), { expirationTtl: 180 * 86400 });
    return new Response('ok');
  }
  await env.VOICE.put('rep:' + d.day, JSON.stringify(d), { expirationTtl: 180 * 86400 });
  return new Response('ok');
}

async function familyPage(env, url) {
  const hh = (url.searchParams.get('h') || '').replace(/[^a-z0-9]/g, '');
  const k = url.searchParams.get('k') || '';
  let prefix = 'rep:';
  if (hh) { const stored = await env.VOICE.get('hhk:' + hh); if (!stored || stored !== await sha(k)) return new Response('Not found', { status: 404 }); prefix = 'rep:' + hh + ':'; }
  else if (await sha(k) !== FAMILY_HASH) return new Response('Not found', { status: 404 });
  const list = await env.VOICE.list({ prefix });
  const days = list.keys.map(k => k.name).filter(n => hh || /^rep:\d{4}-/.test(n)).sort().reverse().slice(0, 30);
  const rows = (await Promise.all(days.map(k => env.VOICE.get(k, 'json')))).filter(Boolean);
  const n = v => v || 0;
  const card = r => {
    const d = new Date(r.day + 'T12:00:00');
    const items = [
      ['🎮 Minutes in the app', Math.round(n(r.play) / 60)], ['🃏 Games played', n(r.games)], ['🏆 Games won', n(r.wins)],
      ['❓ Questions right', `${n(r.qr)} of ${n(r.qa)}`], ['💬 Question of the day', n(r.qotd)], ['📰 News questions right', n(r.newsq)],
      ['🧠 Memory minute', n(r.memory)], ['🦃 Tap the picture', n(r.tapit)], ['🎶 Songs sung', n(r.songs)], ['📖 Stories', n(r.stories)],
      ['🕵️ Mysteries', n(r.myst)], ['📺 Shows / movies', n(r.shows)], ['🤸 Stretches', n(r.stretch)], ['💧 Water sips', n(r.water)],
      ['🚿 Showered', r.shower ? 'Yes ✔' : '—'], ['📞 Called', (r.calls || []).join(', ') || '—'],
      ['🫁 Oxygen', (r.o2 || []).map(o => `${o.v}% at ${o.t}`).join(', ') || '—'], ['⭐ Points now', r.pts ?? '—'], ['🎟️ Tickets', r.tickets ?? '—'], ['🔊 Voice used last', r.voice || '—'], ['📱 App version', r.ver || '—']];
    return `<section><h2>${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
      <p class="u">Last update ${r.updated ? new Date(r.updated).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : ''}</p>
      <table>${items.map(([a, b]) => `<tr><td>${a}</td><td>${esc(b)}</td></tr>`).join('')}</table></section>`;
  };
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Mama C's Activity</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#f7f2e8;color:#1b2a4a;margin:0;padding:18px;max-width:640px;margin:auto}
h1{font-family:Georgia,serif;font-size:1.7rem;margin:8px 0}section{background:#fff;border-radius:16px;padding:14px 16px;margin:14px 0;box-shadow:0 2px 10px rgba(0,0,0,.06)}
h2{font-size:1.15rem;margin:0}.u{color:#888;font-size:.85rem;margin:2px 0 8px}table{width:100%;border-collapse:collapse}td{padding:6px 2px;border-top:1px solid #eee;font-size:1rem}td:last-child{text-align:right;font-weight:600}</style></head>
<body><h1>📊 ${esc(rows[0] && rows[0].name || 'Mama C')}'s activity</h1><p class="u">From her iPad on elderlinkdaily.com. Updates every couple of minutes while she's using it.</p>
${rows.length ? rows.map(card).join('') : '<section>Nothing yet. On her iPad, open ⚙︎ Settings → Activity report and tap “Yes, this is hers.”</section>'}</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/voice-new' && request.method === 'POST') return voiceNew(request, env, url);
    if (url.pathname === '/rec' && request.method === 'POST') return recSave(request, env, url);
    if (url.pathname === '/rec-list') return recList(env, url);
    if (url.pathname === '/rec-get') { if (await sha(url.searchParams.get('k') || '') !== LAURIE_HASH) return new Response('forbidden', { status: 403 }); return recGet(env, url); }
    if (url.pathname === '/report' && request.method === 'POST') return saveReport(request, env);
    if (url.pathname === '/family') return familyPage(env, url);
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
