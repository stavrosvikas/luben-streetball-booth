// Booth on the totem: live camera -> ΤΡΑΒΑ -> 5..1 -> record ~3 seconds -> QR at once, and the finished clip
// takes over the screen as soon as the server has it. The next player only after ΕΠΟΜΕΝΟΣ (no timer by default),
// so people have time to get their phones out.
// The raw clip goes to the server, which renders the branded clip (booth.js on the server).
// Clips wait in IndexedDB until they are uploaded, so a dropped connection loses nothing:
// the QR is made on the totem from an id chosen here, and the page behind it waits for the clip.

const Q = new URLSearchParams(location.search);
const OPT = {
  rot: [0, 90, 180, 270].includes(+Q.get('rot')) ? +Q.get('rot') : 0,
  sec: Math.min(10, Math.max(1, +Q.get('sec') || 3)), // 3 s: the effect lands mid-clip, the render cuts the rest anyway
  count: Math.min(9, Math.max(1, +Q.get('count') || 5)), // countdown seconds
  fps: +Q.get('fps') || 30, // camera frame rate asked for; 60 only if the totem keeps up
  codec: (Q.get('codec') || '').toLowerCase(), // force a recorder type, e.g. vp8 / h264
  mirror: Q.get('mirror') !== '0',
  cam: (Q.get('cam') || '').toLowerCase(),
  back: +Q.get('back') ? Math.max(10, +Q.get('back')) : 0, // seconds on the QR screen before it goes back by itself; 0 = only ΕΠΟΜΕΝΟΣ
  debug: Q.get('debug') === '1',
  look: Q.get('look') === 'boom' ? 'boom' : 'replay',
  zoom: Q.get('zoom') || '', // replay freeze zoom 'x,y,factor' (e.g. 0.5,0.4,1.5); empty = server default
  tag: Q.get('tag') || '',
  share: Q.get('share') || '', // base of the QR link when the booth runs on localhost (e.g. http://192.168.1.186:3711/)
  qr: Q.get('qr') !== '0', // default: QR for the phone · ?qr=0: no QR, the totem plays the finished clip itself
};
// effects on offer; the server must know the key too (EFFECTS in booth.js)
// Stavros's six filters run on the server (booth-fx); fire / none are ours (replay look)
const FX = { ghost: 'GHOST<br>ECHO', quake: 'EARTHQUAKE<br>ECHO', rgb: 'RGB<br>GHOST', sticker: 'JITTERY<br>STICKER',
  flame: 'FLAME<br>OUTLINE', card: 'PLAYER<br>CARD', onfire: 'ON<br>FIRE', reaction: 'ON FIRE<br>REACTION', fire: 'ΦΩΤΙΑ', none: 'ΚΛΑΣΙΚΟ' };
// onfire = Stavros's flame + the Vangelis Ioannou reaction (server)
OPT.fx = (Q.get('fx') || 'ghost,quake,rgb,sticker,onfire,card').split(',').filter(k => FX[k]);
let fx = OPT.fx[0] || 'none';
const EXTRA = 0.6; // seconds recorded beyond `sec`: the server skips the first, still-exposing frames

const $ = id => document.getElementById(id);
const body = document.body;
const cam = $('cam'), replay = $('replay');
let stream = null, busy = false, backTimer = null, pollTimer = null, replayUrl = null, lastClip = '';

body.classList.toggle('mirror', OPT.mirror);
if (OPT.rot) body.classList.add('rot' + OPT.rot);
if (OPT.tag) $('gift').textContent = `STORY ΜΕ TAG ${OPT.tag} ΚΑΙ ΔΩΡΟ ΣΤΟ BOOTH`;
const step = s => { body.dataset.step = s; };
body.classList.toggle('noqr', !OPT.qr);
if (OPT.fx.length > 1) {
  $('fx').innerHTML = OPT.fx.map(k => `<button data-fx="${k}"><i class="ic ic-${k}"></i><b>${FX[k]}</b></button>`).join('');
  const mark = () => $('fx').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.fx === fx));
  $('fx').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { fx = b.dataset.fx; mark(); } });
  mark();
}

// ---------------------------------------------------------------- camera

async function openCamera() {
  step('boot'); $('retry').hidden = true;
  $('bootMsg').textContent = 'ΑΝΟΙΓΕΙ Η ΚΑΜΕΡΑ';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no-api'), { name: 'NoApi' });
    const want = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: OPT.fps } };
    stream = await navigator.mediaDevices.getUserMedia({ video: { ...want, facingMode: 'user' }, audio: false });
    if (OPT.cam) { // pick a named camera (e.g. ?cam=facecam) once labels are visible
      const dev = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'videoinput' && d.label.toLowerCase().includes(OPT.cam));
      if (dev && stream.getVideoTracks()[0].getSettings().deviceId !== dev.deviceId) {
        stream.getTracks().forEach(t => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({ video: { ...want, deviceId: { exact: dev.deviceId } }, audio: false });
      }
    }
    cam.srcObject = stream;
    await cam.play().catch(() => {});
    stream.getVideoTracks()[0].addEventListener('ended', () => { stream = null; cameraLost(); });
    step('idle');
    debugInfo();
  } catch (e) {
    const why = {
      NotAllowedError: 'Ο browser δεν έδωσε άδεια για την κάμερα',
      NotFoundError: 'Δεν βρέθηκε κάμερα',
      NotReadableError: 'Η κάμερα χρησιμοποιείται από άλλη εφαρμογή',
      NoApi: 'Η σελίδα θέλει https (ή localhost) για την κάμερα',
    }[e.name] || e.message;
    $('bootMsg').innerHTML = `ΠΡΟΒΛΗΜΑ ΜΕ ΤΗΝ ΚΑΜΕΡΑ<small>${why}</small>`;
    $('retry').hidden = false;
  }
}

function cameraLost() {
  step('boot');
  $('bootMsg').innerHTML = 'Η ΚΑΜΕΡΑ ΑΠΟΣΥΝΔΕΘΗΚΕ<small>Έλεγχος καλωδίου USB, μετά ΞΑΝΑ</small>';
  $('retry').hidden = false;
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (!stream && body.dataset.step === 'boot') openCamera(); });

// ---------------------------------------------------------------- record

// H.264 first: Android totems encode it in hardware. VP9 runs in software and chokes a 2GB box
// (first totem test 6/11: 3 frames in 3.6 seconds).
function pickType() {
  const all = { h264: ['video/mp4;codecs=avc1', 'video/webm;codecs=h264', 'video/mp4'], vp8: ['video/webm;codecs=vp8'], vp9: ['video/webm;codecs=vp9'] };
  const types = OPT.codec && all[OPT.codec] ? all[OPT.codec] : [...all.h264, ...all.vp8, 'video/webm', ...all.vp9];
  return types.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function countdown() {
  step('count');
  const el = $('count');
  for (let n = OPT.count; n >= 1; n--) {
    el.textContent = n; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    await sleep(800);
  }
}

function record() {
  return new Promise((ok, fail) => {
    const type = pickType();
    const rec = new MediaRecorder(stream, { ...(type && { mimeType: type }), videoBitsPerSecond: 8e6 });
    const parts = [];
    rec.ondataavailable = e => e.data.size && parts.push(e.data);
    rec.onstop = () => ok(new Blob(parts, { type: rec.mimeType || type || 'video/webm' }));
    rec.onerror = e => fail(e.error || new Error('recorder'));
    const ms = (OPT.sec + EXTRA) * 1000;
    step('rec');
    rec.start(500);
    // progress bar as one CSS transition and a single timer: nothing per frame while the encoder works
    const bar = $('recBar');
    bar.style.transition = 'none'; bar.style.width = '0%'; void bar.offsetWidth;
    bar.style.transition = `width ${ms}ms linear`; bar.style.width = '100%';
    setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, ms);
  });
}

async function go() {
  if (busy || !stream) return;
  busy = true;
  try {
    enterFullscreen();
    await countdown();
    const blob = await record();
    const id = newId();
    await Pending.add({ id, blob, rot: OPT.rot, look: OPT.look, zoom: OPT.zoom, fx, at: Date.now() });
    showDone(id, blob);
    Pending.flush();
  } catch (e) {
    console.error(e);
    step('idle');
  } finally { busy = false; }
}

function newId() {
  const a = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(a, b => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
}

// ---------------------------------------------------------------- QR screen

// The raw clip plays at once (behind the QR); the finished clip takes over as soon as the server has it.
// Without QR (?qr=0, tests) it is the same screen without the QR.
function showDone(id, blob) {
  if (OPT.qr) {
    const url = new URL('v/' + id, OPT.share || document.baseURI).href;
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
    lastClip = `
clip ${(blob.size / 1e6).toFixed(1)} MB ${blob.type}
${url}`;
  } else lastClip = `
clip ${(blob.size / 1e6).toFixed(1)} MB ${blob.type}
fx ${fx} id ${id}`;
  body.classList.remove('ready');
  if (replayUrl) URL.revokeObjectURL(replayUrl);
  replayUrl = URL.createObjectURL(blob);
  replay.src = replayUrl; replay.classList.add('on', 'raw'); // raw = turned and mirrored like the live camera (css)
  replay.play().catch(() => {});
  step('done');
  $('back').textContent = '';
  clearInterval(backTimer); clearTimeout(pollTimer);
  if (OPT.back) {
    let left = OPT.back;
    const tick = () => { $('back').textContent = `ΝΕΑ ΛΗΨΗ ΣΕ ${left}″`; if (left-- <= 0) toIdle(); };
    tick(); backTimer = setInterval(tick, 1000);
  }
  const t0 = Date.now();
  const poll = async () => {
    let s = {};
    try { s = await (await fetch(`v/${id}.json`, { cache: 'no-store' })).json(); } catch { /* offline: keep trying */ }
    if (s.status === 'ready') {
      replay.src = `v/${id}.mp4`; replay.classList.remove('raw'); replay.play().catch(() => {}); // finished clip: already upright
      body.classList.add('ready');
      return;
    }
    if (s.status === 'failed' || Date.now() - t0 > 180000) { $('wait').lastChild.textContent = 'ΚΑΤΙ ΠΗΓΕ ΣΤΡΑΒΑ'; return; }
    pollTimer = setTimeout(poll, 1500);
  };
  pollTimer = setTimeout(poll, 2000);
}

function toIdle() {
  clearInterval(backTimer); clearTimeout(pollTimer);
  body.classList.remove('ready');
  $('wait').lastChild.textContent = $('wait').dataset.text || 'ΤΟ VIDEO ΕΤΟΙΜΑΖΕΤΑΙ';
  replay.pause(); replay.removeAttribute('src'); replay.classList.remove('on', 'raw');
  step(stream ? 'idle' : 'boot');
}

// ---------------------------------------------------------------- upload queue (IndexedDB)

const Pending = {
  db: null,
  open() {
    return this.db ||= new Promise((ok, fail) => {
      const r = indexedDB.open('booth', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('clips', { keyPath: 'id' });
      r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((ok, fail) => {
      const t = db.transaction('clips', mode), s = t.objectStore('clips');
      const r = fn(s); t.oncomplete = () => ok(r?.result); t.onerror = () => fail(t.error);
    });
  },
  add(c) { return this.tx('readwrite', s => s.put(c)).catch(() => { this.mem.set(c.id, c); }); },
  remove(id) { this.mem.delete(id); return this.tx('readwrite', s => s.delete(id)).catch(() => {}); },
  async all() { const db = await this.tx('readonly', s => s.getAll()).catch(() => []); return [...(db || []), ...this.mem.values()]; },
  mem: new Map(), // fallback if IndexedDB is unavailable (private mode)
  running: false, wait: 3000,

  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      for (const c of (await this.all()).sort((a, b) => a.at - b.at)) {
        const r = await fetch(`api/booth/upload?id=${c.id}&rot=${c.rot}&look=${c.look || 'replay'}&fx=${c.fx || 'ghost'}${c.zoom ? '&zoom=' + c.zoom : ''}`, { method: 'POST', headers: { 'Content-Type': c.blob.type || 'video/webm' }, body: c.blob });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
        await this.remove(c.id);
      }
      this.wait = 3000; online(true);
    } catch (e) {
      online(false);
      this.wait = Math.min(30000, this.wait * 1.6);
    } finally {
      this.running = false;
      const n = (await this.all()).length;
      $('pending').hidden = !n; $('pending').textContent = `ΣΤΗΝ ΟΥΡΑ: ${n}`;
      if (n) setTimeout(() => this.flush(), this.wait);
    }
  },
};

function online(ok) { body.classList.toggle('offline', !ok); $('liveTxt').textContent = ok ? 'LIVE' : 'OFFLINE'; }
addEventListener('online', () => Pending.flush());

// ---------------------------------------------------------------- kiosk bits

let wake = null;
async function enterFullscreen() {
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* fine */ }
  try { wake ||= await navigator.wakeLock?.request('screen'); wake?.addEventListener('release', () => { wake = null; }); } catch { /* fine */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !wake) navigator.wakeLock?.request('screen').then(w => { wake = w; }).catch(() => {}); });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('pointerdown', enterFullscreen); // first touch anywhere = full screen (needs a gesture)
addEventListener('gesturestart', e => e.preventDefault());

$('start').addEventListener('click', go);
$('next').addEventListener('click', toIdle);
$('retry').addEventListener('click', openCamera);
addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && body.dataset.step === 'idle') go(); }); // USB button = a key

// ---------------------------------------------------------------- debug (?debug=1): what the camera really gives

function debugInfo() {
  if (!OPT.debug) return;
  const box = $('debug'); box.hidden = false;
  const tr = stream.getVideoTracks()[0], s = tr.getSettings();
  let frames = 0, t0 = performance.now(), fps = 0;
  const count = () => { frames++; cam.requestVideoFrameCallback(count); };
  if (cam.requestVideoFrameCallback) cam.requestVideoFrameCallback(count);
  setInterval(() => {
    const now = performance.now(); fps = frames * 1000 / (now - t0); frames = 0; t0 = now;
    box.textContent = `${tr.label || 'camera'}\n${s.width}x${s.height} @ ${s.frameRate?.toFixed?.(0) ?? '?'} fps (settings)`
      + `\nμετρημένα: ${fps.toFixed(1)} fps\nrecorder: ${pickType() || 'default'}\nrot ${OPT.rot} mirror ${OPT.mirror ? 1 : 0}${lastClip}`;
  }, 1000);
}

openCamera();
Pending.flush();
