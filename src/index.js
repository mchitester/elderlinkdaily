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
  const okRef = /^https:\/\/((www\.)?elderlinkdaily\.com|[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev|[a-z0-9.-]*claudeusercontent\.com|claude\.ai)(\/|$)/.test(ref) || url.searchParams.get('k') === env.WARM_KEY && env.WARM_KEY
    // Some iPads send no Referer at all; accept the app's own same-site requests too.
    || /^same-(origin|site)$/.test(request.headers.get('Sec-Fetch-Site') || '')
    || request.headers.get('X-Eld') === '1';
  if (!okRef) return new Response('forbidden', { status: 403 });
  let text = (url.searchParams.get('t') || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 900) return new Response('bad text', { status: 400 });
  const hhv = (url.searchParams.get('h') || '').replace(/[^a-z0-9]/g, '');
  let voiceId = VOICE_ID;
  if (hhv) { const v = await env.VOICE.get('hhv:' + hhv, 'json'); if (v && v.id) voiceId = v.id; else return new Response('no custom voice', { status: 404 }); }
  const rec = await env.VOICE.getWithMetadata((voiceId === VOICE_ID ? 'rec:' : 'rec:' + hhv + ':') + await sha(norm(text)), 'arrayBuffer');
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

async function recAuth(env, url) {
  const hh = (url.searchParams.get('h') || '').replace(/[^a-z0-9]/g, '');
  const k = url.searchParams.get('k') || '';
  if (hh) return (await env.VOICE.get('hhk:' + hh)) === await sha(k) ? 'rec:' + hh + ':' : null;
  return (await sha(k)) === LAURIE_HASH ? 'rec:' : null;
}

async function recSave(request, env, url) {
  const pre = await recAuth(env, url);
  if (!pre) return new Response('forbidden', { status: 403 });
  const text = url.searchParams.get('t') || '';
  const n = norm(text);
  if (!n) return new Response('bad', { status: 400 });
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 2000 || buf.byteLength > 5e6) return new Response('bad size', { status: 400 });
  const type = request.headers.get('Content-Type') || 'audio/mp4';
  await env.VOICE.put(pre + await sha(n), buf, { metadata: { type, text: text.slice(0, 300), at: Date.now() } });
  return new Response('saved', { headers: { 'Access-Control-Allow-Origin': '*' } });
}

async function recList(env, url) {
  const pre = await recAuth(env, url);
  if (!pre) return new Response('forbidden', { status: 403 });
  let out = [], cursor;
  do { const l = await env.VOICE.list({ prefix: pre, cursor }); out = out.concat(l.keys.filter(k => pre !== 'rec:' || /^rec:[0-9a-f]{64}$/.test(k.name)).map(k => k.metadata && k.metadata.text).filter(Boolean)); cursor = l.list_complete ? null : l.cursor; } while (cursor);
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


const ADMIN_HASH = '5ec62cf28eb5aff85268af7bf69e81b10469cfed46ea34aa02d0c36b698d41de';
const LABELS = { name: 'Name', born: 'Year born', narrator: 'Narrator name', voiceMode: 'Narrator voice (laurie / custom / ipad)', adminPin: 'Helper PIN (blank = no lock)', size: 'Text size (L / XL)',
  breaks: 'Breaks during games', breakMin: 'Minutes between breaks', help: 'Highlight playable cards', speak: 'Narration on', sound: 'Sound effects', autoplay: 'Auto-play games',
  mealsOn: 'Meal reminders', showerOn: 'Shower reminders', water: 'Water reminders', o2On: 'Oxygen checks', o2Min: 'Oxygen low warning %', callsOn: 'Call-family reminders', callsPerDay: 'Calls per day', callers: 'Family to call (comma list)',
  storyOn: 'Stories', mystOn: 'Mysteries', singOn: 'Sing-along', inspOn: 'Inspiration', movieOn: 'Movie night', movieFree: 'Movies free (no ticket)', qotdAuto: 'Auto question of the day',
  lauSpeed: 'Voice speed (1, 1.12, 1.25)', lauPtsMin: 'Points reminder every N min (0 = off)', tapMin: 'Tap-the-picture every N min (0 = off)', others: 'Card opponents (comma list)', reportOn: 'Send activity report' };

async function adminOk(url) { return (await sha(url.searchParams.get('a') || '')) === ADMIN_HASH; }

async function households(env) {
  const out = [];
  const lr = await env.VOICE.list({ prefix: 'rep:2' });
  const lastLegacy = lr.keys.map(k => k.name).filter(n => /^rep:\d{4}-/.test(n)).sort().pop();
  out.push({ h: 'main', label: 'Mama C (original iPad)', rep: lastLegacy ? await env.VOICE.get(lastLegacy, 'json') : null });
  const hk = await env.VOICE.list({ prefix: 'hhk:' });
  for (const k of hk.keys) {
    const h = k.name.slice(4); if (h.startsWith('zztest')) continue;
    const l = await env.VOICE.list({ prefix: 'rep:' + h + ':' });
    const last = l.keys.map(x => x.name).sort().pop();
    out.push({ h, rep: last ? await env.VOICE.get(last, 'json') : null });
  }
  for (const o of out) o.push = await env.VOICE.get('cfg:' + o.h, 'json');
  return out;
}

async function adminPage(env, url) {
  if (!await adminOk(url)) return new Response('Not found', { status: 404 });
  const hs = await households(env);
  const fq = (await env.VOICE.get('facq', 'json')) || [];
  const a = esc(url.searchParams.get('a'));
  const card = o => {
    const r = o.rep || {}, cfg = r.cfg || {};
    const fields = Object.keys(LABELS).filter(k => k in cfg || ['adminPin', 'name', 'born', 'narrator', 'voiceMode'].includes(k)).map(k => {
      const v = cfg[k];
      const val = Array.isArray(v) ? v.filter(Boolean).join(', ') : (v ?? '');
      if (typeof v === 'boolean') return `<label class="f"><span>${LABELS[k]}</span><select name="${k}"><option value="">(no change)</option><option value="true"${v ? ' data-cur' : ''}>On${v ? ' (now)' : ''}</option><option value="false"${!v ? ' data-cur' : ''}>Off${!v ? ' (now)' : ''}</option></select></label>`;
      return `<label class="f"><span>${LABELS[k]}</span><input name="${k}" placeholder="${esc(k === 'adminPin' ? '(hidden)' : val)}" data-type="${Array.isArray(v) ? 'list' : typeof v}"></label>`;
    }).join('');
    return `<section><h2>${esc(o.label || (r.name ? r.name + '’s iPad' : 'Household ' + o.h))}</h2>
      <p class="u">Last seen: ${r.updated ? new Date(r.updated).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'never'} · App ${esc(r.ver || '?')} · Voice ${esc(r.voice || '?')} · ID ${o.h}</p>
      ${o.push ? `<p class="pend">Pending change (sent ${new Date(o.push.v).toLocaleString('en-US', { timeZone: 'America/New_York' })}): ${esc(JSON.stringify(o.push.set))}</p>` : ''}
      <details><summary>Change settings</summary><form data-h="${o.h}">${fields}<button type="submit">Send changes</button><p class="u">Only fields you fill in are changed. They apply the next time the app is open (within 10 minutes).</p></form></details></section>`;
  };
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Elder Link Admin</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f7f2e8;color:#1b2a4a;margin:0 auto;padding:16px;max-width:680px}h1{font-family:Georgia,serif}section{background:#fff;border-radius:16px;padding:14px 16px;margin:14px 0;box-shadow:0 2px 10px rgba(0,0,0,.06)}
h2{margin:0;font-size:1.2rem}.u{color:#888;font-size:.85rem}.pend{background:#fff6dc;padding:8px;border-radius:8px;font-size:.85rem;word-break:break-all}summary{cursor:pointer;font-weight:700;margin:8px 0}
.f{display:block;margin:8px 0}.f span{display:block;font-size:.85rem;font-weight:600;margin-bottom:2px}.f input,.f select{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d8cdb4;border-radius:10px;font-size:1rem}
button{background:#2e6b47;color:#fff;border:0;border-radius:12px;padding:12px 18px;font-size:1rem;font-weight:700;margin-top:8px}</style></head><body>
<h1>🛠️ Elder Link Admin</h1>${(fq.length?`<section><h2>🗓️ Calendars waiting to be typed in</h2>${fq.map(x=>`<p>${esc(x.f)} · ${esc(x.m)} · <a href="/fac-photo?f=${esc(x.f)}&m=${esc(x.m)}" target="_blank">view photo</a></p>`).join('')}<p class="u">Ask Claude to type these in. Until then, users of that community can view the photo in the app.</p></section>`:'')}<p class="u">Every iPad using the app. Changes you send are applied the next time that iPad has the app open.</p>${hs.map(card).join('')}
<script>document.querySelectorAll('form').forEach(f=>f.onsubmit=async e=>{e.preventDefault();const set={};
f.querySelectorAll('input,select').forEach(i=>{const v=i.value.trim();if(i.name==='adminPin'&&v==='-'){set.adminPin='';return}if(v==='')return;const t=i.dataset.type;
 set[i.name]=i.tagName==='SELECT'?v==='true':t==='number'?Number(v):t==='list'?v.split(',').map(x=>x.trim()).filter(Boolean):v});
if(!Object.keys(set).length){alert('Fill in at least one field.');return}
const r=await fetch('/admin-push?a=${a}&h='+f.dataset.h,{method:'POST',body:JSON.stringify(set)});alert(r.ok?'Sent! It applies the next time the app is open.':'Something went wrong.');if(r.ok)location.reload()})</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function adminPush(request, env, url) {
  if (!await adminOk(url)) return new Response('forbidden', { status: 403 });
  const h = (url.searchParams.get('h') || '').replace(/[^a-z0-9]/g, '');
  const set = JSON.parse(await request.text());
  const prev = await env.VOICE.get('cfg:' + h, 'json');
  const merged = Object.assign({}, prev && prev.set, set);
  await env.VOICE.put('cfg:' + h, JSON.stringify({ v: Date.now(), set: merged }), { expirationTtl: 60 * 86400 });
  return new Response('ok');
}

async function cfgGet(env, url) {
  const h = (url.searchParams.get('h') || 'main').replace(/[^a-z0-9]/g, '');
  if (h !== 'main') { const stored = await env.VOICE.get('hhk:' + h); if (!stored || stored !== await sha(url.searchParams.get('k') || '')) return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); }
  const c = await env.VOICE.get('cfg:' + h);
  return new Response(c || '{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
}


/* ---------- communities (facilities) and their activity calendars ---------- */
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
async function facList(env) { return (await env.VOICE.get('fac:list', 'json')) || []; }
async function facRoute(request, env, url) {
  const p = url.pathname, f = slug(url.searchParams.get('f') || ''), m = (url.searchParams.get('m') || '').replace(/[^0-9-]/g, '').slice(0, 7);
  if (p === '/fac-list') return J(await facList(env));
  if (p === '/fac-events') {
    const ev = await env.VOICE.get(`fac:${f}:${m}`, 'json');
    const ph = await env.VOICE.get(`facph:${f}:${m}`, 'json');
    return J({ events: ev ? ev.events : null, photo: !!ph, photoAt: ph && ph.at });
  }
  if (p === '/fac-photo' && request.method === 'GET') {
    const r = await env.VOICE.getWithMetadata(`facimg:${f}:${m}`, 'arrayBuffer');
    if (!r.value) return new Response('none', { status: 404 });
    return new Response(r.value, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' } });
  }
  // household-, upload-link- or admin-authorised writes
  const hh = (url.searchParams.get('h') || '').replace(/[^a-z0-9]/g, '');
  const admin = await adminOk(url);
  if (p === '/fac-ukey' && admin) { await env.VOICE.put('facuk:' + f, await sha(url.searchParams.get('u') || '')); return J({ ok: true }); }
  if (p === '/fac-info') { const uk = await env.VOICE.get('facuk:' + f); if (!uk || uk !== await sha(url.searchParams.get('u') || '')) return J({ ok: false }, 403); const fl = (await facList(env)).find(x => x.id === f); return J({ ok: true, name: fl ? fl.name : f }); }
  const upOk = p === '/fac-photo' && f && (await env.VOICE.get('facuk:' + f)) === await sha(url.searchParams.get('u') || 'x');
  if (!admin && !upOk && !await hhCheck(env, hh, url.searchParams.get('hk') || '')) return J({ ok: false }, 403);
  if (p === '/fac-add' && request.method === 'POST') {
    const name = (url.searchParams.get('name') || '').trim().slice(0, 60), city = (url.searchParams.get('city') || '').trim().slice(0, 40);
    if (name.length < 3) return J({ ok: false }, 400);
    const list = await facList(env); const id = slug(name + (city ? ' ' + city : ''));
    if (!list.some(x => x.id === id)) { list.push({ id, name, city, by: hh || 'admin', at: Date.now() }); await env.VOICE.put('fac:list', JSON.stringify(list)); }
    return J({ ok: true, id });
  }
  if (p === '/fac-photo' && request.method === 'POST') {
    if (!/^\d{4}-\d{2}$/.test(m) || !f) return J({ ok: false }, 400);
    const buf = await request.arrayBuffer(); if (buf.byteLength < 10000 || buf.byteLength > 8e6) return J({ ok: false, why: 'size' }, 400);
    await env.VOICE.put(`facimg:${f}:${m}`, buf);
    await env.VOICE.put(`facph:${f}:${m}`, JSON.stringify({ at: Date.now(), by: hh || (upOk ? 'upload-link' : 'admin') }));
    const q = (await env.VOICE.get('facq', 'json')) || []; if (!q.some(x => x.f === f && x.m === m)) q.push({ f, m, at: Date.now() }); await env.VOICE.put('facq', JSON.stringify(q));
    return J({ ok: true });
  }
  if (p === '/fac-events-set' && request.method === 'POST' && admin) {
    const body = JSON.parse(await request.text()); await env.VOICE.put(`fac:${f}:${m}`, JSON.stringify({ events: body.events, at: Date.now() }));
    const q = ((await env.VOICE.get('facq', 'json')) || []).filter(x => !(x.f === f && x.m === m)); await env.VOICE.put('facq', JSON.stringify(q));
    return J({ ok: true, n: body.events.length });
  }
  return J({ ok: false }, 404);
}


/* ---------- local news & local history by ZIP ---------- */
const BAD = /obituar|funeral|crematory|celebration of life|passed away|dies at|died at|overdose|abuse|rape|sexual|molest|child porn|kidnap|abduct|hostage|captiv|suicide|cough|outbreak|exposed|measles|flu cases|ballot|election|levy|levies|data center|layoff|closing|closes|lawmaker|congress|senator|governor|trump|democrat|republican|campaign|protest|immigra|ice agents|deport|tariff|air quality|aqi|recall/i;
const UA = { 'User-Agent': 'ElderLinkDaily/1.0 (https://elderlinkdaily.com; family app for seniors)' };
async function zipPlace(env, zip) {
  const k = 'zip:' + zip; const c = await env.VOICE.get(k, 'json'); if (c) return c;
  const r = await fetch('https://api.zippopotam.us/us/' + zip); if (!r.ok) return null;
  const d = await r.json(); const p = d.places && d.places[0]; if (!p) return null;
  const o = { zip, city: p['place name'], state: p.state, st: p['state abbreviation'], lat: +p.latitude, lon: +p.longitude };
  await env.VOICE.put(k, JSON.stringify(o)); return o;
}
const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '');
const SPAM = /advisor|homeowners|zip code|real estate|for sale|lawyer|attorney|dentist|plumber|roofing|insurance|mortgage|top \d+|best .* in |near me|jobs? |hiring|apartments|almanac|whooping/i;
async function localNews(env, pl) {
  const k = 'lnews5:' + pl.zip; const c = await env.VOICE.get(k, 'json'); if (c) return c;
  const qs = [`"${pl.city}" ${pl.st}`, `"${pl.city}" holiday OR festival OR parade OR concert`, `"${pl.city}" library OR park OR community OR volunteers OR opens`];
  let items = [];
  for (const q of qs) { try { const r = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=en-us&cc=us`, { headers: UA }); if (!r.ok) continue; const x = await r.text();
    for (const m of x.matchAll(/<item>([\s\S]*?)<\/item>/g)) { const it = m[1], g = re => { const mm = it.match(re); return mm ? unesc(mm[1]).trim() : '' };
      items.push({ t: g(/<title>([\s\S]*?)<\/title>/), b: g(/<description>([\s\S]*?)<\/description>/).slice(0, 400), src: g(/<News:Source>([\s\S]*?)<\/News:Source>/), date: g(/<pubDate>([\s\S]*?)<\/pubDate>/) }); } } catch (e) {} }
  const cut = Date.now() - 45 * 86400000;
  items = items.filter(n => n.t && n.t.length > 30 && /\s/.test(n.t.replace(pl.city, '')) && n.t.toLowerCase() !== `${pl.city}, ${pl.state}`.toLowerCase() && n.t.toLowerCase().includes(pl.city.toLowerCase()) && !BAD.test(n.t + ' ' + n.b.slice(0, 160)) && !SPAM.test(n.t) && (!n.date || new Date(n.date) > cut))
    .map(n => ({ ...n, t: n.t.replace(/\s*\((photos|video|watch)\)/ig, '').replace(/\.?\s*Here'?’?s (why|when|what|how).*$/i, '') }));
  const seen = new Set(), out = [];
  for (const n of items.sort((a, b) => new Date(b.date) - new Date(a.date))) { const key = n.t.toLowerCase().replace(/[^a-z]/g, '').slice(0, 30); if (seen.has(key)) continue; seen.add(key); out.push(n); if (out.length >= 10) break; }
  if (out.length) await env.VOICE.put(k, JSON.stringify(out), { expirationTtl: 3 * 3600 }); return out;
}
function chunks(text, max) { const sents = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)/g) || []; const out = []; let cur = '';
  for (const s of sents) { if ((cur + s).length > max && cur) { out.push(cur.trim()); cur = ''; } cur += s; } if (cur.trim().length > 60) out.push(cur.trim()); return out; }
async function localHistory(env, pl) {
  const k = 'lhist7:' + pl.zip; const c = await env.VOICE.get(k, 'json'); if (c) return c;
  const out = [];
  try {
    const title = `${pl.city}, ${pl.state}`;
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`, { headers: UA });
    const d = await r.json(); const pg = Object.values(d.query.pages)[0]; const ex = pg.extract || '';
    const secs = ex.split(/\n== /); const hist = secs.find(s => /^History/.test(s));
    if (hist) { const body = hist.replace(/^History ==\n?/, '').replace(/\n=== ([^=]+) ===/g, '\n').trim();
      chunks(body, 520).slice(0, 14).forEach((b, i) => out.push({ t: i === 0 ? `How ${pl.city} began` : `${pl.city} long ago, part ${i + 1}`, b, kind: 'history' })); }
  } catch (e) {}
  try {
    const g = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${pl.lat}|${pl.lon}&gsradius=10000&gslimit=50&format=json`, { headers: UA }).then(r => r.json());
    const skip = /kidnap|abduct|hostage|abuse|health system|metrohealth|shopping center|commons$|steelyard|hospital|disaster|wreck|foundation|learning center|mall$|prison|jail|school|church|station|cemetery|township|county|elementary|high school|district|route|interchange|tower|\(Ohio\)$|census|precinct|ward|apartments|plaza$|road$|street$|avenue$/i;
    const titles = g.query.geosearch.map(x => x.title).filter(t => !skip.test(t) && !t.startsWith(pl.city + ',')).slice(0, 14);
    for (const t of titles) {
      try { const s = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_')), { headers: UA }).then(r => r.json());
        if (s.extract && s.extract.length > 120 && !BAD.test(s.title + ' ' + s.extract.slice(0, 300))) out.push({ t: `Did you know? ${s.title}`, b: s.extract.slice(0, 600), kind: 'place' }); } catch (e) {}
      if (out.filter(o => o.kind === 'place').length >= 10) break;
    }
  } catch (e) {}
  try {
    const q = `"${pl.city}" ${pl.state} (murder OR gangster OR mob OR robbery OR heist OR bootlegger OR detective OR "unsolved")`;
    const g = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=20&format=json`, { headers: UA }).then(r => r.json());
    const have = new Set(out.map(o => o.t));
    let n = 0;
    for (const x of g.query.search) { if (n >= 8) break; if (/^List of|season|\(film\)|\(TV|\(album|\(song|\(novel|episode|County|, Ohio$/i.test(x.title) || /kidnap|abduct|abuse|rape|sexual|child/i.test(x.title)) continue;
      try { const s2 = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(x.title.replace(/ /g, '_')), { headers: UA }).then(r => r.json());
        const ex = s2.extract || ''; if (ex.length < 150 || /rape|sexual|molest|abuse|child|kidnap|abduct/i.test(ex) || !ex.includes(pl.city) || !/murder|mob\b|mobster|gang|robber|heist|bootleg|detective|crime|criminal|killed|convicted|stole|theft|prohibition|racketeer|outlaw|bandit|swindl|fraud/i.test(ex) || have.has(s2.title)) continue;
        out.push({ t: `True crime: ${s2.title}`, b: ex.slice(0, 700), kind: 'crime' }); n++; } catch (e) {} }
  } catch (e) {}
  if (out.length) await env.VOICE.put(k, JSON.stringify(out), { expirationTtl: 30 * 86400 });
  return out;
}
async function localRoute(env, url) {
  const zip = (url.searchParams.get('zip') || '').replace(/\D/g, '').slice(0, 5);
  if (zip.length !== 5) return J({ ok: false }, 400);
  const pl = await zipPlace(env, zip); if (!pl) return J({ ok: false, why: 'zip' }, 404);
  const want = url.searchParams.get('w') || 'all';
  const [news, hist] = await Promise.all([want !== 'hist' ? localNews(env, pl) : [], want !== 'news' ? localHistory(env, pl) : []]);
  return J({ ok: true, place: pl, news, history: hist });
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
    if (url.pathname === '/local') return localRoute(env, url);
    if (url.pathname === '/face') {
      const hh = (url.searchParams.get('h') || '').replace(/[^a-z0-9]/g, '');
      if (request.method === 'POST') {
        if (!await hhCheck(env, hh, url.searchParams.get('hk') || '')) return new Response('forbidden', { status: 403 });
        const buf = await request.arrayBuffer(); if (buf.byteLength < 3000 || buf.byteLength > 3e6) return new Response('bad size', { status: 400 });
        await env.VOICE.put('hhface:' + hh, buf); return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }
      const img = await env.VOICE.get('hhface:' + hh, 'arrayBuffer');
      return img ? new Response(img, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } }) : new Response('none', { status: 404 });
    }
    if (url.pathname.startsWith('/fac-')) return facRoute(request, env, url);
    if (url.pathname === '/admin') return adminPage(env, url);
    if (url.pathname === '/admin-push' && request.method === 'POST') return adminPush(request, env, url);
    if (url.pathname === '/cfg') return cfgGet(env, url);
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
