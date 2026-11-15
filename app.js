/* Stadt Tracker – Oberfläche: Karte, GPS, Speicher, Download der Straßendaten. */
(function () {
  'use strict';
  const { CFG, W } = ST;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (v, d) => v.toLocaleString('de-AT', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtDist = (m) => (m < 1000 ? Math.round(m) + ' m' : nf(m / 1000, 1) + ' km');
  const fmtPct = (f, d) => nf(f * 100, d === undefined ? 1 : d) + ' %';

  const prefs = {
    get(k, def) { try { const v = localStorage.getItem('st_' + k); return v === null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem('st_' + k, JSON.stringify(v)); } catch (e) { /* ohne Speicher weiterarbeiten */ } }
  };

  // ---------- IndexedDB ----------
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open('stadttracker', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('track', { autoIncrement: true }); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbPromise;
  }
  function tx(store, mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = t.onabort = () => reject(t.error);
    }));
  }
  const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
  const kvSet = (k, v) => tx('kv', 'readwrite', (s) => { s.put(v, k); });
  const kvClear = () => tx('kv', 'readwrite', (s) => { s.clear(); });

  /* Alle GPS-Punkte als Tripel [t, lat, lon]. Aus ihnen wird der Fortschritt bei jedem Start neu berechnet. */
  async function trackLoad() {
    const chunks = (await tx('track', 'readonly', (s) => s.getAll())) || [];
    let n = 0;
    for (const c of chunks) n += c.length;
    const all = new Float64Array(n);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    const sorted = ST.sortPoints(all);
    if (chunks.length > 200) await tx('track', 'readwrite', (s) => { s.clear(); s.add(sorted); });
    return sorted;
  }
  const trackAppend = (arr) => tx('track', 'readwrite', (s) => { s.add(arr); });

  // ---------- Zustand ----------
  let cov = null, stats = null;
  let buf = [], flushTimer = null;
  let tracking = false, watchId = null, wakeLock = null;
  let lastFix = null, lastLogged = null, follow = true;
  let showOpen = prefs.get('showOpen', true);
  let others = null; // Straßenstücke anderer Personen (Uint8Array), gesetzt von cloud.js
  let activeTab = 'map';
  let streetFilter = 'started', streetLimit = 150;

  function flush() {
    clearTimeout(flushTimer); flushTimer = null;
    if (!buf.length) return Promise.resolve();
    const arr = Float64Array.from(buf);
    buf = [];
    return trackAppend(arr).catch(() => { /* Speicher voll oder gesperrt: Punkte gehen verloren, App läuft weiter */ });
  }

  // ---------- Setup-Bildschirm ----------
  function setup(mode, text, fraction) {
    const el = $('setup');
    el.style.display = mode === 'hide' ? 'none' : 'flex';
    $('setup-btn').style.display = (mode === 'need' || mode === 'error') ? '' : 'none';
    $('setup-btn').textContent = mode === 'error' ? 'Erneut versuchen' : 'Straßendaten laden';
    $('setup-hint').style.display = mode === 'need' ? '' : 'none';
    $('setup-error').style.display = mode === 'error' ? '' : 'none';
    $('setup-bar').style.display = mode === 'progress' ? '' : 'none';
    if (mode === 'error') { $('setup-error').textContent = text; $('setup-text').textContent = 'Der öffentliche Kartenserver ist oft ausgelastet. Meist klappt es beim zweiten Versuch.'; }
    else if (mode === 'need') $('setup-text').textContent = 'Geh, lauf oder radle jede Straße in ' + CFG.city + ' ab. Die App merkt sich, wo du schon warst.';
    else if (text) $('setup-text').textContent = text;
    if (mode === 'progress') $('setup-bar').firstElementChild.style.width = Math.round((fraction || 0) * 100) + '%';
  }

  // ---------- Overpass ----------
  const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const cityArea = () => 'area["name"="' + CFG.city + '"]["boundary"="administrative"]["admin_level"~"^(' + CFG.cityLevels + ')$"]->.c;';

  async function overpass(query) {
    let lastError = new Error('Keine Antwort vom Kartenserver.');
    for (let attempt = 0; attempt < 6; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 330000);
      try {
        const r = await fetch(ENDPOINTS[attempt % ENDPOINTS.length], {
          method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
        });
        if (r.ok) {
          const json = await r.json();
          if (json.remark && /error/i.test(json.remark)) lastError = new Error('Der Kartenserver meldet: ' + json.remark);
          else return json;
        } else if (r.status === 406) lastError = new Error('Der Kartenserver lehnt die Anfrage ab (406). Die App muss über einen Webserver laufen (http:// oder https://), nicht als lokale Datei.');
        else lastError = new Error('Der Kartenserver ist gerade überlastet (Fehler ' + r.status + '). Bitte in einer Minute noch einmal versuchen.');
      } catch (e) {
        lastError = new Error('Der Kartenserver ist nicht erreichbar. Prüfe deine Internetverbindung.');
      } finally { clearTimeout(timer); }
      await new Promise((res) => setTimeout(res, (3 + attempt * 3) * 1000));
    }
    throw lastError;
  }

  const WAY_FILTER = '["highway"~"^(' + CFG.highways + ')$"]["name"]["access"!~"^(private|no)$"]["area"!="yes"]';

  /* Eine einzige Abfrage: pro Bezirk die IDs seiner Straßen, danach alle Straßen der Stadt mit Geometrie. */
  async function fetchCity() {
    const json = await overpass('[out:json][timeout:300];' + cityArea() +
      'relation(area.c)["boundary"="administrative"]["admin_level"="' + CFG.districtLevel + '"];' +
      'foreach->.d(.d out tags;.d map_to_area->.a;way(area.a)(area.c)' + WAY_FILTER + ';out ids;);' +
      'way(area.c)' + WAY_FILTER + ';out tags geom;');
    const districts = [], districtOf = new Map(), raw = [];
    let current = -1;
    for (const e of json.elements) {
      if (e.type === 'relation') {
        if (e.tags && e.tags.name) { current = districts.length; districts.push({ id: e.id, name: e.tags.name, ref: e.tags.ref || null }); }
        else current = -1;
      } else if (e.type === 'way') {
        if (e.geometry) raw.push(e);
        else if (current >= 0 && !districtOf.has(e.id)) districtOf.set(e.id, current);
      }
    }
    // Bezirke nach Nummer sortieren
    const num = (d) => { const n = parseInt(d.ref, 10); return Number.isFinite(n) ? n : 1e9; };
    const order = districts.map((d, i) => i).sort((x, y) => num(districts[x]) - num(districts[y]) || districts[x].name.localeCompare(districts[y].name, 'de'));
    const rank = new Array(districts.length);
    order.forEach((oldIndex, newIndex) => { rank[oldIndex] = newIndex; });
    const sorted = order.map((i) => districts[i]);
    const ways = [], loose = [];
    for (const e of raw) {
      if (!e.tags || !e.tags.name || e.geometry.length < 2) continue;
      const c = new Float64Array(e.geometry.length * 2);
      let ok = true;
      e.geometry.forEach((p, i) => { if (!p) { ok = false; return; } c[i * 2] = p.lat; c[i * 2 + 1] = p.lon; });
      if (!ok) continue;
      const way = { id: e.id, name: e.tags.name, c, d: districtOf.has(e.id) ? rank[districtOf.get(e.id)] : -1 };
      (way.d < 0 ? loose : ways).push(way);
    }
    if (!sorted.length) {
      // Stadt ohne Bezirke: alles in einen Sammelbezirk
      sorted.push({ id: 0, name: CFG.city, ref: null });
      loose.forEach((w) => { w.d = 0; ways.push(w); });
    } else {
      // Straßen, die keinem Bezirk zugeordnet wurden, bekommen den Bezirk der nächstgelegenen Straße
      for (const w of loose) {
        let best = 0, bestSq = Infinity;
        for (const o of ways) {
          const dy = o.c[0] - w.c[0], dx = (o.c[1] - w.c[1]) * 0.67, sq = dx * dx + dy * dy;
          if (sq < bestSq) { bestSq = sq; best = o.d; }
        }
        w.d = best;
      }
      loose.forEach((w) => ways.push(w));
    }
    return { districts: sorted, ways };
  }

  let downloadTimer = null;
  async function downloadCity() {
    const t0 = Date.now();
    clearInterval(downloadTimer);
    const tick = () => setup('progress', 'Lade Straßen von ' + CFG.city + ' … (' + Math.round((Date.now() - t0) / 1000) + ' s)', Math.min((Date.now() - t0) / 100000, 0.95));
    tick();
    downloadTimer = setInterval(tick, 1000);
    try {
      const city = await fetchCity();
      clearInterval(downloadTimer);
      if (!city.ways.length) return setup('error', 'Für „' + CFG.city + '“ wurden keine Straßen gefunden.');
      setup('loading', 'Speichere Straßendaten …');
      await kvSet('city', city);
      await loadAll();
    } catch (e) {
      clearInterval(downloadTimer);
      setup('error', e && e.message ? e.message : 'Download fehlgeschlagen.');
    }
  }

  // ---------- Laden ----------
  async function loadAll() {
    setup('loading', 'Straßennetz wird geladen …');
    let city;
    try { city = await kvGet('city'); } catch (e) { return setup('error', 'Dieser Browser erlaubt keinen lokalen Speicher (z. B. privater Modus).'); }
    if (!city || !city.ways || !city.ways.length) return setup('need');
    const data = city.districts.map((d) => ({ district: d, ways: [] }));
    for (const w of city.ways) data[w.d].ways.push(w);
    const index = ST.buildIndex(data);
    if (!index.count) {
      await kvClear();
      return setup('error', 'Für „' + CFG.city + '“ wurden keine Straßen gefunden.');
    }
    await flush();
    const c = new ST.Coverage(index);
    const pts = await trackLoad();
    const res = ST.newResult();
    for (let i = 0; i + 2 < pts.length; i += 3) c.add(pts[i], pts[i + 1], pts[i + 2], res);
    cov = c;
    refresh();
    syncUnlocked();
    setup('hide');
    layer.redraw();
    if (!lastFix) map.fitBounds(rectToBounds(index), { padding: [20, 20], animate: false });
    if (window.STCloud) window.STCloud.onCoverageReady();
  }

  // ---------- Karte ----------
  const map = L.map('map', { zoomControl: false }).setView([48.2082, 16.3738], 12);
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
  }).addTo(map);

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const GREEN = 'rgba(31,157,85,.92)', RED = 'rgba(229,72,77,.38)', VIOLET = 'rgba(124,77,255,.6)';

  function drawTile(canvas, coords) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, 256, 256);
    if (!cov) return;
    const idx = cov.index, vis = cov.visited;
    const s = 256 * Math.pow(2, coords.z) / W, ox = coords.x * 256, oy = coords.y * 256;
    const drawOpen = showOpen && coords.z >= 13;
    const pv = new Path2D(), po = new Path2D(), px = new Path2D();
    const oth = others && others.length === vis.length ? others : null;
    const pad = idx.cell;
    idx.forEach(ox / s - pad, oy / s - pad, (ox + 256) / s + pad, (oy + 256) / s + pad, (i) => {
      const v = vis[i], o = oth ? oth[i] : 0;
      if (!v && !o && !drawOpen) return;
      const x0 = idx.ax[i] * s - ox, y0 = idx.ay[i] * s - oy, x1 = idx.bx[i] * s - ox, y1 = idx.by[i] * s - oy;
      if (o) { px.moveTo(x0, y0); px.lineTo(x1, y1); }
      if (v) { pv.moveTo(x0, y0); pv.lineTo(x1, y1); }
      else if (!o) { po.moveTo(x0, y0); po.lineTo(x1, y1); }
    });
    const w = coords.z >= 16 ? 5 : (coords.z >= 14 ? 3.5 : 2.5);
    ctx.lineCap = 'round';
    if (drawOpen) { ctx.strokeStyle = RED; ctx.lineWidth = w - 1; ctx.stroke(po); }
    if (oth) { ctx.strokeStyle = VIOLET; ctx.lineWidth = w + 3; ctx.stroke(px); }
    ctx.strokeStyle = GREEN; ctx.lineWidth = w; ctx.stroke(pv);
  }

  const CoverageLayer = L.GridLayer.extend({
    createTile(coords) {
      const canvas = document.createElement('canvas');
      canvas.width = 256 * DPR; canvas.height = 256 * DPR;
      drawTile(canvas, coords);
      return canvas;
    }
  });
  const layer = new CoverageLayer({ tileSize: 256, maxZoom: 19, zIndex: 5, updateWhenZooming: false, keepBuffer: 1 });
  layer.addTo(map);

  /* Zeichnet nur die Kacheln neu, die vom geänderten Bereich berührt werden. */
  function redrawDirty(res) {
    const pad = cov.index.cell;
    for (const key in layer._tiles) {
      const t = layer._tiles[key];
      const s = 256 * Math.pow(2, t.coords.z) / W;
      const x0 = t.coords.x * 256 / s, y0 = t.coords.y * 256 / s, size = 256 / s;
      if (res.maxX + pad < x0 || res.minX - pad > x0 + size || res.maxY + pad < y0 || res.minY - pad > y0 + size) continue;
      drawTile(t.el, t.coords);
    }
  }

  const toLatLng = (x, y) => L.latLng(ST.unprojLat(y), ST.unprojLon(x));
  const rectToBounds = (r) => L.latLngBounds(toLatLng(r.minX, r.maxY), toLatLng(r.maxX, r.minY));

  let meMarker = null, meCircle = null, pin = null;
  function showMe() {
    if (!lastFix) return;
    const ll = [lastFix.lat, lastFix.lon];
    if (!meMarker) {
      meCircle = L.circle(ll, { radius: lastFix.acc, stroke: false, fillColor: '#2f7de1', fillOpacity: 0.14, interactive: false }).addTo(map);
      meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
    } else {
      meMarker.setLatLng(ll); meCircle.setLatLng(ll); meCircle.setRadius(lastFix.acc);
    }
    if (follow) map.setView(ll, Math.max(map.getZoom(), 16), { animate: true });
  }
  function setFollow(on) {
    follow = on;
    $('btn-follow').className = 'round ' + (on ? 'on' : '');
  }
  map.on('dragstart', () => setFollow(false));

  function setPin(latlng, title) {
    if (pin) pin.remove();
    pin = L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#e5484d', fillOpacity: 1 }).addTo(map);
    pin.bindTooltip(esc(title), { permanent: true, direction: 'top', offset: [0, -8], className: 'pin-label' }).openTooltip();
  }

  // ---------- GPS ----------
  function note(text) {
    const el = $('gps-note');
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
  }

  function onPosition(p) {
    const c = p.coords;
    lastFix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 0 };
    note('');
    showMe();
    if (!tracking) return;
    if (!(c.accuracy > 0 && c.accuracy <= 35)) return;
    let t = p.timestamp / 1000;
    if (!Number.isFinite(t) || Math.abs(t - Date.now() / 1000) > 86400) t = Date.now() / 1000;
    if (lastLogged && ST.haversine(lastLogged.lat, lastLogged.lon, c.latitude, c.longitude) < 4) return;
    lastLogged = { lat: c.latitude, lon: c.longitude };
    buf.push(t, c.latitude, c.longitude);
    if (!flushTimer) flushTimer = setTimeout(flush, 3000);
    if (!cov) return;
    const res = ST.newResult();
    cov.add(t, c.latitude, c.longitude, res);
    if (res.newMeters > 0) {
      refresh();
      redrawDirty(res);
      announce(res);
      if (window.STCloud) window.STCloud.onProgress();
    }
  }

  function onPositionError(e) {
    if (e.code === 1) {
      note('Standortzugriff ist nicht erlaubt. Erlaube ihn in den Browser-Einstellungen für diese Seite.');
      stopTracking();
    } else note('Kein GPS-Signal. Geh ins Freie und warte kurz.');
  }

  async function acquireWake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* nicht unterstützt oder abgelehnt */ }
  }

  function startTracking() {
    if (!('geolocation' in navigator)) return note('Dieser Browser unterstützt keine Standortabfrage.');
    if (!window.isSecureContext) return note('Standort funktioniert nur über HTTPS (oder localhost).');
    tracking = true;
    prefs.set('tracking', true);
    setFollow(true);
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    acquireWake();
    updateTrackButton();
  }

  function stopTracking() {
    tracking = false;
    prefs.set('tracking', false);
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    flush();
    updateTrackButton();
  }

  function updateTrackButton() {
    const b = $('btn-track');
    b.textContent = tracking ? 'Stopp' : 'Start';
    b.className = tracking ? 'on' : '';
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (tracking) acquireWake();
      if (cov) refresh();
    } else flush();
  });
  window.addEventListener('pagehide', flush);

  // ---------- Toasts & Erfolge ----------
  const toastQueue = [];
  let toastBusy = false;
  function toast(ico, title, sub) {
    toastQueue.push({ ico, title, sub });
    if (toastQueue.length > 6) toastQueue.shift();
    if (!toastBusy) nextToast();
  }
  function nextToast() {
    const t = toastQueue.shift();
    if (!t) { toastBusy = false; return; }
    toastBusy = true;
    $('toast-ico').textContent = t.ico; $('toast-title').textContent = t.title; $('toast-sub').textContent = t.sub || '';
    $('toast').classList.add('show');
    setTimeout(() => { $('toast').classList.remove('show'); setTimeout(nextToast, 400); }, 3200);
  }

  function announce(res) {
    res.streets.slice(0, 3).forEach((si) => toast('✅', 'Straße komplett!', cov.index.streetNames[si] + ' · +50 XP'));
    res.districts.forEach((di) => toast('🏁', 'Bezirk erobert!', ST.districtLabel(cov.index.districts[di]) + ' · +2000 XP'));
    const unlocked = new Set(prefs.get('unlocked', []));
    for (const a of ST.achievements(stats)) {
      if (a.unlocked && !unlocked.has(a.id)) { unlocked.add(a.id); toast('🏆', 'Erfolg freigeschaltet', a.title); }
    }
    prefs.set('unlocked', Array.from(unlocked));
    const last = prefs.get('level', 0);
    if (stats.level > last) {
      if (last > 0) toast('⭐', 'Level ' + stats.level + ' erreicht!', stats.levelTitle);
      prefs.set('level', stats.level);
    }
  }
  function syncUnlocked() {
    prefs.set('unlocked', ST.achievements(stats).filter((a) => a.unlocked).map((a) => a.id));
    prefs.set('level', stats.level);
  }

  // ---------- Anzeige ----------
  const ringSvg = (r, fraction) => {
    const c = 2 * Math.PI * r, size = (r + 5) * 2, m = r + 5;
    return '<svg viewBox="0 0 ' + size + ' ' + size + '"><circle class="bg" cx="' + m + '" cy="' + m + '" r="' + r + '"/><circle class="fg" cx="' + m + '" cy="' + m + '" r="' + r +
      '" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + (c * (1 - Math.max(0, Math.min(fraction, 1)))).toFixed(2) + '"/></svg>';
  };
  const bar = (fraction, cls) => '<div class="bar ' + (cls || '') + '"><i style="width:' + (Math.max(0, Math.min(fraction, 1)) * 100).toFixed(1) + '%"></i></div>';

  function refresh() {
    if (!cov) return;
    stats = ST.computeStats(cov, new Date());
    const goal = prefs.get('goal', 1000);
    $('hud-pct').textContent = fmtPct(stats.fraction, 2);
    $('hud-city').textContent = 'von ' + CFG.city;
    $('hud-level').textContent = 'Level ' + stats.level;
    $('hud-streets').textContent = stats.streetsDone + (stats.streetsDone === 1 ? ' Straße fertig' : ' Straßen fertig');
    $('hud-ring').setAttribute('stroke-dashoffset', (94.25 * (1 - Math.min(stats.todayM / goal, 1))).toFixed(2));
    $('hud-flame').textContent = stats.streak > 0 ? '🔥' : '🚶';
    if (activeTab === 'progress') renderProgress();
    else if (activeTab === 'streets') renderStreets();
    else if (activeTab === 'awards') renderAwards();
  }

  function renderProgress() {
    if (!stats) return;
    const s = stats, goal = prefs.get('goal', 1000);
    const maxDay = Math.max(1, ...s.week.map((d) => d.meters));
    $('progress-body').innerHTML =
      '<div class="card"><div class="row between"><div><b style="font-size:24px">Level ' + s.level + '</b> <span class="muted">' + esc(s.levelTitle) + '</span></div><span class="muted num small">' +
        s.xp.toLocaleString('de-AT') + ' XP</span></div><div style="margin:10px 0 6px">' + bar(s.levelFraction, 'gold') + '</div><div class="small muted">Noch ' +
        s.xpToNext.toLocaleString('de-AT') + ' XP bis Level ' + (s.level + 1) + '</div></div>' +
      '<div class="card row" style="gap:20px"><div class="bigring">' + ringSvg(47, s.fraction) + '<span class="num">' + fmtPct(s.fraction, 1) + '</span></div><div><b style="font-size:20px">' +
        esc(CFG.city) + '</b><div class="small">' + fmtDist(s.visitedM) + ' von ' + fmtDist(s.totalM) + '</div><div class="small muted">' + s.streetsStarted +
        ' Straßen betreten</div><div class="small muted">Noch ' + fmtDist(Math.max(s.totalM - s.visitedM, 0)) + '</div></div></div>' +
      '<div class="grid2">' +
        '<div class="tile">🛣️<div class="v num">' + fmtDist(s.visitedM) + '</div><div class="small muted">Erkundet</div></div>' +
        '<div class="tile">🪧<div class="v num">' + s.streetsDone + ' / ' + s.streetsTotal + '</div><div class="small muted">Straßen fertig</div></div>' +
        '<div class="tile">🔥<div class="v num">' + s.streak + (s.streak === 1 ? ' Tag' : ' Tage') + '</div><div class="small muted">Serie</div></div>' +
        '<div class="tile">🏁<div class="v num">' + s.districtsDone + ' / ' + s.districts.length + '</div><div class="small muted">Bezirke erobert</div></div>' +
      '</div>' +
      '<div class="card"><div class="row between"><h2>Tagesziel</h2>' + (s.todayM >= goal ? '<span class="small" style="color:var(--green)">✓ Geschafft</span>' : '') + '</div>' +
        bar(s.todayM / goal) + '<div class="small muted" style="margin-top:6px">' + fmtDist(s.todayM) + ' von ' + fmtDist(goal) + ' neue Straße heute</div></div>' +
      '<div class="card"><h2>Letzte 7 Tage</h2><div class="week">' +
        s.week.map((d) => '<div><i style="height:' + (d.meters / maxDay * 100).toFixed(1) + '%"></i>' + esc(d.label) + '</div>').join('') +
        '</div><div class="small muted" style="margin-top:8px">Neue Straßen pro Tag · Bester Tag: ' + fmtDist(s.bestDayM) + '</div></div>' +
      '<div class="card"><h2>Bezirke</h2>' +
        s.districts.map((d) => '<div class="district"><div class="row between"><span>' + esc(d.name) + (d.done ? ' ✅' : '') + '</span><span class="muted num">' +
          fmtPct(d.fraction, 1) + '</span></div>' + bar(d.fraction, d.done ? '' : 'blue') + '</div>').join('') + '</div>';
  }

  function renderStreets() {
    if (!cov) return;
    const idx = cov.index, q = $('street-search').value.trim().toLowerCase();
    const rows = [];
    for (let i = 0; i < idx.streetNames.length; i++) {
      const total = idx.streetLength[i], visited = cov.streetVisited[i];
      const fraction = total > 0 ? Math.min(visited / total, 1) : 0, done = fraction >= CFG.done;
      if (streetFilter === 'open' && visited > 0) continue;
      if (streetFilter === 'started' && (visited === 0 || done)) continue;
      if (streetFilter === 'done' && !done) continue;
      if (q && !idx.streetNames[i].toLowerCase().includes(q)) continue;
      rows.push({ i, name: idx.streetNames[i], total, fraction, done });
    }
    if (streetFilter === 'started') rows.sort((a, b) => b.fraction - a.fraction);
    else rows.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    $('street-count').textContent = rows.length ? (rows.length === 1 ? '1 Straße' : rows.length.toLocaleString('de-AT') + ' Straßen') : (
      streetFilter === 'started' ? 'Noch keine angefangene Straße. Starte die Aufzeichnung auf der Karte.' :
      streetFilter === 'done' ? 'Noch keine Straße komplett. Eine Straße gilt ab 90 % als fertig.' : 'Keine Treffer.');
    let html = rows.slice(0, streetLimit).map((r) =>
      '<button class="street' + (r.done ? ' done' : '') + '" data-si="' + r.i + '"><span class="dot">' + ringSvg(11, r.fraction) + '</span><span class="name"><b>' +
      esc(r.name) + '</b><span class="small muted">' + esc(ST.districtLabel(idx.districts[idx.streetDistrict[r.i]])) + ' · ' + fmtDist(r.total) +
      '</span></span><span class="muted num small">' + fmtPct(r.fraction, 0) + '</span></button>').join('');
    if (rows.length > streetLimit) html += '<button class="more" id="street-more">Mehr anzeigen</button>';
    $('street-list').innerHTML = html;
  }

  function renderAwards() {
    if (!stats) return;
    const all = ST.achievements(stats);
    $('awards-body').innerHTML = '<p class="muted small" style="margin:0 2px 12px">' + all.filter((a) => a.unlocked).length + ' von ' + all.length +
      ' freigeschaltet</p><div class="awards">' + all.map((a) => '<div class="award' + (a.unlocked ? ' on' : '') + '"><div class="ico">' + (a.unlocked ? a.icon : '🔒') +
      '</div><b>' + esc(a.title) + '</b><span class="small muted">' + esc(a.detail) + '</span>' + (a.unlocked ? '' : bar(a.fraction, 'orange')) + '</div>').join('') + '</div>';
  }

  function showTab(name) {
    activeTab = name;
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + name));
    document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'map') map.invalidateSize();
    else if (name === 'progress') renderProgress();
    else if (name === 'streets') { streetLimit = 150; renderStreets(); }
    else if (name === 'awards') renderAwards();
    else if (name === 'friends' && window.STCloud) window.STCloud.render();
  }

  // ---------- Bedienung ----------
  document.querySelector('nav.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) showTab(b.dataset.tab);
  });
  $('setup-btn').addEventListener('click', downloadCity);
  $('btn-track').addEventListener('click', () => (tracking ? stopTracking() : startTracking()));

  function updateEye() { $('btn-eye').className = 'round ' + (showOpen ? '' : 'off'); $('set-open').checked = showOpen; }
  function setShowOpen(on) { showOpen = on; prefs.set('showOpen', on); updateEye(); layer.redraw(); }
  $('btn-eye').addEventListener('click', () => setShowOpen(!showOpen));

  $('btn-follow').addEventListener('click', () => {
    setFollow(true);
    if (lastFix) showMe();
    if (!tracking && 'geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(onPosition, onPositionError, { enableHighAccuracy: true, timeout: 20000 });
    }
  });

  $('btn-next').addEventListener('click', () => {
    if (!cov) return;
    const idx = cov.index;
    const x = lastFix ? ST.projX(lastFix.lon) : (idx.minX + idx.maxX) / 2;
    const y = lastFix ? ST.projY(lastFix.lat) : (idx.minY + idx.maxY) / 2;
    const i = cov.nearestUnvisited(x, y);
    if (i < 0) return toast('👑', 'Alles erledigt!', 'Es gibt keine offene Straße mehr.');
    const target = toLatLng((idx.ax[i] + idx.bx[i]) / 2, (idx.ay[i] + idx.by[i]) / 2);
    setFollow(false);
    setPin(target, idx.streetNames[idx.street[i]]);
    if (lastFix) map.fitBounds(L.latLngBounds([target, [lastFix.lat, lastFix.lon]]), { padding: [70, 70], maxZoom: 18 });
    else map.setView(target, 17);
  });

  $('street-search').addEventListener('input', () => { streetLimit = 150; renderStreets(); });
  $('street-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    streetFilter = b.dataset.f; streetLimit = 150;
    document.querySelectorAll('#street-filter button').forEach((x) => x.classList.toggle('active', x === b));
    renderStreets();
  });
  $('street-list').addEventListener('click', (e) => {
    if (e.target.closest('#street-more')) { streetLimit += 300; return renderStreets(); }
    const b = e.target.closest('.street');
    if (!b || !cov) return;
    const si = +b.dataset.si, rect = cov.streetRect(si);
    if (!rect) return;
    showTab('map');
    setFollow(false);
    setPin(toLatLng((rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2), cov.index.streetNames[si]);
    map.fitBounds(rectToBounds(rect), { padding: [60, 60], maxZoom: 18 });
  });

  // Einstellungen
  $('btn-settings').addEventListener('click', () => { $('set-goal').value = String(prefs.get('goal', 1000)); updateEye(); $('sheet').classList.add('show'); });
  $('sheet-close').addEventListener('click', () => $('sheet').classList.remove('show'));
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').classList.remove('show'); });
  $('set-goal').addEventListener('change', (e) => { prefs.set('goal', +e.target.value); refresh(); });
  $('set-open').addEventListener('change', (e) => setShowOpen(e.target.checked));

  $('set-import').addEventListener('click', () => $('file-gpx').click());
  $('file-gpx').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    let count = 0;
    const before = cov ? cov.visitedLength : 0;
    for (const f of files) {
      const pts = ST.parseGPX(await f.text(), Date.now() / 1000);
      if (pts.length) { await trackAppend(Float64Array.from(pts)); count += pts.length / 3; }
    }
    $('sheet').classList.remove('show');
    if (!count) return toast('⚠️', 'Keine Punkte gefunden', 'Die Datei enthält keine GPX-Trackpunkte.');
    await loadAll();
    toast('📥', count.toLocaleString('de-AT') + ' Punkte importiert', cov ? '+' + fmtDist(cov.visitedLength - before) + ' neue Straße' : '');
  });

  $('set-export').addEventListener('click', async () => {
    await flush();
    const pts = await trackLoad();
    if (!pts.length) return toast('ℹ️', 'Noch nichts aufgezeichnet', '');
    const url = URL.createObjectURL(new Blob([ST.toGPX(pts)], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'stadt-tracker-' + new Date().toISOString().slice(0, 10) + '.gpx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  $('set-reload').addEventListener('click', async () => {
    if (!confirm('Straßendaten neu aus OpenStreetMap laden? Dein Fortschritt bleibt erhalten.')) return;
    $('sheet').classList.remove('show');
    cov = null;
    await kvClear();
    downloadCity();
  });

  $('set-reset').addEventListener('click', async () => {
    if (!confirm('Wirklich den gesamten Fortschritt löschen? Das lässt sich nicht rückgängig machen.')) return;
    $('sheet').classList.remove('show');
    buf = []; lastLogged = null;
    await tx('track', 'readwrite', (s) => { s.clear(); });
    prefs.set('unlocked', []); prefs.set('level', 0);
    await loadAll();
  });

  // ---------- Schnittstelle für cloud.js ----------
  window.STApp = {
    esc, fmtDist, fmtPct, toast, showTab,
    getCov: () => cov,
    setOthers(arr, label) {
      others = arr;
      const chip = $('view-chip');
      chip.style.display = arr ? 'block' : 'none';
      chip.textContent = arr ? 'Ansicht: ' + label + '  ✕' : '';
      layer.redraw();
    }
  };

  // ---------- Start ----------
  updateEye();
  setFollow(true);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (location.protocol === 'file:') {
    setup('error', 'Die App wurde als lokale Datei geöffnet. So gibt der Browser weder Standort noch Kartendaten frei. Öffne sie über einen Webserver (siehe README.md).');
    $('setup-btn').style.display = 'none';
    $('setup-text').textContent = '';
    return;
  }
  loadAll().then(() => { if (prefs.get('tracking', false)) startTracking(); })
    .catch((e) => setup('error', 'Die App konnte nicht starten: ' + (e && e.message ? e.message : e)));
})();
