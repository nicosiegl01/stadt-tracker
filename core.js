/* Stadt Tracker – Kernlogik (ohne DOM): Straßennetz-Index, GPS-Abgleich, Statistik, Gamification, GPX. */
(function (root) {
  'use strict';

  const W = 268435456; // Web-Mercator-Weltbreite in "Kartenpunkten"

  /* Für eine andere Stadt: city und ggf. die Admin-Level ändern, dann in der App "Straßendaten neu laden". */
  const CFG = {
    city: 'Wien',
    cityLevels: '4|6|8',   // OSM admin_level der Stadtgrenze (Wien = 4)
    districtLevel: '9',    // OSM admin_level der Bezirke (Wien = 9)
    highways: 'residential|living_street|pedestrian|unclassified|tertiary|secondary|primary',
    done: 0.9,             // ab diesem Anteil gilt eine Straße / ein Bezirk als fertig
    maxSeg: 40,            // Straßen werden in Stücke bis zu dieser Länge (m) zerlegt
    radius: 20,            // ein Stück gilt als besucht, wenn man so nah (m) an seiner Mitte war
    streakMin: 50          // Mindestmeter neue Straße, damit ein Tag für die Serie zählt
  };

  const projX = (lon) => (lon + 180) / 360 * W;
  const projY = (lat) => {
    const s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W;
  };
  const unprojLon = (x) => x / W * 360 - 180;
  const unprojLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / W))) * 180 / Math.PI;

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function districtLabel(d) {
    const n = parseInt(d.ref, 10);
    return Number.isFinite(n) ? n + '. ' + d.name : d.name;
  }

  /* data: [{district:{id,name,ref}, ways:[{id,name,c:[lat,lon,lat,lon,…]}]}] */
  function buildIndex(data) {
    const ax = [], ay = [], bx = [], by = [], street = [], district = [], len = [];
    const names = [], nameIndex = new Map(), streetLength = [], streetDistrict = [];
    const districtLength = new Array(data.length).fill(0);
    const seen = new Set();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    data.forEach((dd, di) => {
      for (const way of dd.ways) {
        const c = way.c;
        if (!c || c.length < 4 || seen.has(way.id)) continue;
        seen.add(way.id);
        let si = nameIndex.get(way.name);
        if (si === undefined) {
          si = names.length;
          nameIndex.set(way.name, si);
          names.push(way.name);
          streetLength.push(0);
          streetDistrict.push(di);
        }
        let pLat = c[0], pLon = c[1], px = projX(pLon), py = projY(pLat);
        for (let k = 2; k + 1 < c.length; k += 2) {
          const lat = c[k], lon = c[k + 1];
          const m = haversine(pLat, pLon, lat, lon);
          if (m < 0.5) continue;
          const cx = projX(lon), cy = projY(lat);
          const n = Math.max(1, Math.ceil(m / CFG.maxSeg));
          for (let j = 0; j < n; j++) {
            const f0 = j / n, f1 = (j + 1) / n;
            const x0 = px + (cx - px) * f0, y0 = py + (cy - py) * f0;
            const x1 = px + (cx - px) * f1, y1 = py + (cy - py) * f1;
            ax.push(x0); ay.push(y0); bx.push(x1); by.push(y1);
            street.push(si); district.push(di); len.push(m / n);
            if (x0 < minX) minX = x0; if (x1 < minX) minX = x1;
            if (x0 > maxX) maxX = x0; if (x1 > maxX) maxX = x1;
            if (y0 < minY) minY = y0; if (y1 < minY) minY = y1;
            if (y0 > maxY) maxY = y0; if (y1 > maxY) maxY = y1;
          }
          streetLength[si] += m;
          districtLength[di] += m;
          pLat = lat; pLon = lon; px = cx; py = cy;
        }
      }
    });

    const count = ax.length;
    if (!count) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    const centerLat = unprojLat((minY + maxY) / 2);
    const ppm = W / (40075016.686 * Math.cos(centerLat * Math.PI / 180));
    const cell = 60 * ppm;
    const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
    const rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1);

    const idx = {
      count,
      ax: Float64Array.from(ax), ay: Float64Array.from(ay),
      bx: Float64Array.from(bx), by: Float64Array.from(by),
      street: Int32Array.from(street), district: Int32Array.from(district), len: Float32Array.from(len),
      districts: data.map((d) => d.district),
      streetNames: names, streetLength, streetDistrict, districtLength,
      totalLength: districtLength.reduce((a, b) => a + b, 0),
      minX, minY, maxX, maxY, ppm, cell, cols, rows
    };

    const cellOf = (i) => {
      const cc = Math.min(cols - 1, Math.max(0, Math.floor(((idx.ax[i] + idx.bx[i]) / 2 - minX) / cell)));
      const rr = Math.min(rows - 1, Math.max(0, Math.floor(((idx.ay[i] + idx.by[i]) / 2 - minY) / cell)));
      return rr * cols + cc;
    };
    const start = new Int32Array(cols * rows + 1);
    for (let i = 0; i < count; i++) start[cellOf(i) + 1]++;
    for (let i = 1; i < start.length; i++) start[i] += start[i - 1];
    const fill = start.slice();
    const items = new Int32Array(count);
    for (let i = 0; i < count; i++) items[fill[cellOf(i)]++] = i;
    idx.cellStart = start;
    idx.cellItems = items;

    /* Ruft fn(i) für alle Stücke auf, deren Mittelpunkt in einer vom Rechteck berührten Rasterzelle liegt. */
    idx.forEach = (x0, y0, x1, y1, fn) => {
      const c0 = Math.max(0, Math.floor((x0 - minX) / cell)), c1 = Math.min(cols - 1, Math.floor((x1 - minX) / cell));
      const r0 = Math.max(0, Math.floor((y0 - minY) / cell)), r1 = Math.min(rows - 1, Math.floor((y1 - minY) / cell));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const ci = r * cols + c;
          for (let k = start[ci], e = start[ci + 1]; k < e; k++) fn(items[k]);
        }
      }
    };
    return idx;
  }

  function dayKeyOf(date) {
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  }

  function newResult() {
    return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, newMeters: 0, streets: [], districts: [] };
  }

  /* Fortschritt über dem Straßennetz. */
  class Coverage {
    constructor(index) {
      this.index = index;
      this.visited = new Uint8Array(Math.max(index.count, 1));
      this.streetVisited = new Float64Array(index.streetNames.length);
      this.streetDone = new Uint8Array(index.streetNames.length);
      this.districtVisited = new Float64Array(index.districts.length);
      this.districtDone = new Uint8Array(index.districts.length);
      this.visitedLength = 0;
      this.streetsDone = 0;
      this.streetsStarted = 0;
      this.dayNew = new Map();
      this._has = false; this._t = 0; this._x = 0; this._y = 0;
      this._dayStart = 0; this._dayEnd = 0; this._dayKey = 0;
      this._r = CFG.radius * index.ppm;
    }

    /* t in Sekunden (Unix). Lücken zum vorherigen Punkt werden interpoliert, solange sie plausibel sind. */
    add(t, lat, lon, res) {
      const x = projX(lon), y = projY(lat);
      if (t < this._dayStart || t >= this._dayEnd) {
        const d = new Date(t * 1000);
        const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        this._dayStart = s.getTime() / 1000; this._dayEnd = e.getTime() / 1000; this._dayKey = dayKeyOf(d);
      }
      if (this._has) {
        const dt = t - this._t, dx = x - this._x, dy = y - this._y;
        const m = Math.sqrt(dx * dx + dy * dy) / this.index.ppm;
        if (dt >= 0 && dt <= 20 && m > 8 && m <= 300) {
          const n = Math.ceil(m / 8);
          for (let j = 1; j < n; j++) this._mark(this._x + dx * j / n, this._y + dy * j / n, res);
        }
      }
      this._mark(x, y, res);
      this._has = true; this._t = t; this._x = x; this._y = y;
    }

    _mark(x, y, res) {
      const idx = this.index, r = this._r, r2 = r * r, vis = this.visited;
      idx.forEach(x - r, y - r, x + r, y + r, (i) => {
        if (vis[i]) return;
        const dx = (idx.ax[i] + idx.bx[i]) / 2 - x, dy = (idx.ay[i] + idx.by[i]) / 2 - y;
        if (dx * dx + dy * dy > r2) return;
        vis[i] = 1;
        const len = idx.len[i], si = idx.street[i], di = idx.district[i];
        this.visitedLength += len;
        res.newMeters += len;
        this.dayNew.set(this._dayKey, (this.dayNew.get(this._dayKey) || 0) + len);
        if (this.streetVisited[si] === 0) this.streetsStarted++;
        this.streetVisited[si] += len;
        if (!this.streetDone[si] && this.streetVisited[si] >= CFG.done * idx.streetLength[si]) {
          this.streetDone[si] = 1; this.streetsDone++; res.streets.push(si);
        }
        this.districtVisited[di] += len;
        if (!this.districtDone[di] && this.districtVisited[di] >= CFG.done * idx.districtLength[di]) {
          this.districtDone[di] = 1; res.districts.push(di);
        }
        res.minX = Math.min(res.minX, idx.ax[i], idx.bx[i]); res.maxX = Math.max(res.maxX, idx.ax[i], idx.bx[i]);
        res.minY = Math.min(res.minY, idx.ay[i], idx.by[i]); res.maxY = Math.max(res.maxY, idx.ay[i], idx.by[i]);
      });
    }

    /* Nächstes noch nicht besuchtes Straßenstück (ringförmige Suche im Raster). */
    nearestUnvisited(x, y) {
      const idx = this.index;
      if (!idx.count) return -1;
      const c0 = Math.min(Math.max(Math.floor((x - idx.minX) / idx.cell), 0), idx.cols - 1);
      const r0 = Math.min(Math.max(Math.floor((y - idx.minY) / idx.cell), 0), idx.rows - 1);
      let best = -1, bestSq = Infinity;
      const maxRing = Math.max(idx.cols, idx.rows);
      for (let ring = 0; ring <= maxRing; ring++) {
        if (best >= 0 && (ring - 1) * idx.cell > Math.sqrt(bestSq)) break;
        const rLo = r0 - ring, rHi = r0 + ring, cLo = c0 - ring, cHi = c0 + ring;
        for (let r = rLo; r <= rHi; r++) {
          if (r < 0 || r >= idx.rows) continue;
          const step = (r === rLo || r === rHi) ? 1 : Math.max(1, cHi - cLo);
          for (let c = cLo; c <= cHi; c += step) {
            if (c < 0 || c >= idx.cols) continue;
            const ci = r * idx.cols + c;
            for (let k = idx.cellStart[ci], e = idx.cellStart[ci + 1]; k < e; k++) {
              const i = idx.cellItems[k];
              if (this.visited[i]) continue;
              const dx = (idx.ax[i] + idx.bx[i]) / 2 - x, dy = (idx.ay[i] + idx.by[i]) / 2 - y;
              const d = dx * dx + dy * dy;
              if (d < bestSq) { bestSq = d; best = i; }
            }
          }
        }
      }
      return best;
    }

    streetRect(si) {
      const idx = this.index;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < idx.count; i++) {
        if (idx.street[i] !== si) continue;
        minX = Math.min(minX, idx.ax[i], idx.bx[i]); maxX = Math.max(maxX, idx.ax[i], idx.bx[i]);
        minY = Math.min(minY, idx.ay[i], idx.by[i]); maxY = Math.max(maxY, idx.ay[i], idx.by[i]);
      }
      return minX === Infinity ? null : { minX, minY, maxX, maxY };
    }
  }

  // ---------- Gamification ----------

  /* 1 XP pro 10 m neuer Straße, 50 XP pro fertiger Straße, 2000 XP pro erobertem Bezirk. */
  const xpOf = (visitedM, streetsDone, districtsDone) => Math.floor(visitedM / 10) + streetsDone * 50 + districtsDone * 2000;
  const levelOf = (xp) => Math.floor(Math.sqrt(Math.max(xp, 0) / 50)) + 1;
  const xpForLevel = (level) => 50 * (level - 1) * (level - 1);
  function levelTitle(level) {
    if (level < 3) return 'Tourist';
    if (level < 6) return 'Spaziergänger';
    if (level < 10) return 'Grätzl-Kenner';
    if (level < 16) return 'Bezirks-Bummler';
    if (level < 25) return 'Stadtwanderer';
    if (level < 40) return 'Flaneur';
    if (level < 60) return 'Straßenjäger';
    if (level < 85) return 'Stadtkenner';
    return 'Stadtlegende';
  }

  function computeStats(cov, now) {
    const idx = cov.index;
    const s = {
      totalM: idx.totalLength, visitedM: cov.visitedLength,
      streetsTotal: idx.streetNames.length, streetsDone: cov.streetsDone, streetsStarted: cov.streetsStarted
    };
    s.fraction = s.totalM > 0 ? Math.min(s.visitedM / s.totalM, 1) : 0;
    s.districts = idx.districts.map((d, i) => {
      const total = idx.districtLength[i], visited = cov.districtVisited[i];
      const fraction = total > 0 ? Math.min(visited / total, 1) : 0;
      return { id: d.id, name: districtLabel(d), totalM: total, visitedM: visited, fraction, done: fraction >= CFG.done };
    });
    s.districtsDone = s.districts.filter((d) => d.done).length;
    s.districtsTouched = s.districts.filter((d) => d.visitedM > 0).length;

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayAt = (offset) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const meters = (date) => cov.dayNew.get(dayKeyOf(date)) || 0;
    s.todayM = meters(today);
    s.bestDayM = 0; s.activeDays = 0;
    for (const v of cov.dayNew.values()) { if (v > s.bestDayM) s.bestDayM = v; if (v >= CFG.streakMin) s.activeDays++; }
    let off = meters(today) >= CFG.streakMin ? 0 : 1, streak = 0;
    while (meters(dayAt(off)) >= CFG.streakMin) { streak++; off++; }
    s.streak = streak;
    s.week = [];
    for (let o = 6; o >= 0; o--) {
      const d = dayAt(o);
      s.week.push({ label: d.toLocaleDateString('de-AT', { weekday: 'short' }), meters: meters(d) });
    }
    s.xp = xpOf(s.visitedM, s.streetsDone, s.districtsDone);
    s.level = levelOf(s.xp);
    const lo = xpForLevel(s.level), hi = xpForLevel(s.level + 1);
    s.levelFraction = (s.xp - lo) / (hi - lo);
    s.xpToNext = hi - s.xp;
    s.levelTitle = levelTitle(s.level);
    return s;
  }

  function achievements(s) {
    const list = [];
    const add = (id, icon, title, detail, current, target) =>
      list.push({ id, icon, title, detail, current, target, unlocked: current >= target, fraction: Math.max(0, Math.min(current / target, 1)) });
    const km = s.visitedM / 1000, pct = s.fraction * 100, nd = Math.max(s.districts.length, 1);

    add('first_steps', '🚶', 'Erste Schritte', '100 m neue Straße erkunden', s.visitedM, 100);
    [[1, 'Erste Straße'], [10, 'Zehnerpack'], [50, 'Straßensammler'], [100, 'Hunderter-Klub'], [250, 'Viertelmeister'],
      [500, 'Straßenprofi'], [1000, 'Tausendsassa'], [2500, 'Unaufhaltsam']].forEach(([n, t]) =>
      add('streets_' + n, '🪧', t, n === 1 ? 'Eine Straße komplett abgehen' : n + ' Straßen komplett abgehen', s.streetsDone, n));
    [[10, 'Aufgewärmt'], [50, 'Halbmarathon plus'], [100, 'Hundert Kilometer'], [500, 'Fernwanderer'], [1000, 'Tausend Kilometer']]
      .forEach(([n, t]) => add('km_' + n, '🛣️', t, n + ' km neue Straßen erkunden', km, n));
    [[1, 'Ein Prozent'], [5, 'Fünf Prozent'], [10, 'Ein Zehntel'], [25, 'Ein Viertel'], [50, 'Halbzeit'], [75, 'Dreiviertel']]
      .forEach(([n, t]) => add('city_' + n, '🏙️', t, n + ' % von ' + CFG.city + ' erkunden', pct, n));
    add('city_done', '👑', CFG.city + ' komplett', '90 % aller Straßenmeter – die Stadt gilt als abgeklappert', pct, CFG.done * 100);
    if (s.districts.length > 1) {
      add('districts_touched', '📍', 'Überall gewesen', 'In jedem Bezirk mindestens eine Straße betreten', s.districtsTouched, nd);
      add('district_first', '🏁', 'Bezirkskaiser', 'Einen Bezirk erobern (90 %)', s.districtsDone, 1);
      add('district_5', '🏁', 'Fünf Bezirke', 'Fünf Bezirke erobern', s.districtsDone, Math.min(5, nd));
      add('district_all', '🏆', 'Alle Bezirke', 'Jeden Bezirk erobern', s.districtsDone, nd);
    }
    [[3, 'Dranbleiber'], [7, 'Wochenserie'], [14, 'Zwei Wochen am Stück'], [30, 'Monatsserie'], [100, 'Hundert Tage']]
      .forEach(([n, t]) => add('streak_' + n, '🔥', t, n + ' Tage in Folge neue Straßen', s.streak, n));
    [[5, 'Großer Tag'], [10, 'Zehner-Tag'], [20, 'Marathon-Tag']]
      .forEach(([n, t]) => add('day_' + n, '⚡', t, n + ' km neue Straßen an einem Tag', s.bestDayM / 1000, n));
    return list;
  }

  // ---------- GPX ----------

  /* Liefert [t, lat, lon, t, lat, lon, …]. Punkte ohne Zeitstempel bekommen fortlaufende Zeiten ab fallbackT. */
  function parseGPX(text, fallbackT) {
    const out = [];
    const re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
    let m, synth = fallbackT;
    while ((m = re.exec(text))) {
      const lat = /\blat\s*=\s*["']([^"']+)["']/.exec(m[1]);
      const lon = /\blon\s*=\s*["']([^"']+)["']/.exec(m[1]);
      if (!lat || !lon) continue;
      const la = parseFloat(lat[1]), lo = parseFloat(lon[1]);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 85 || Math.abs(lo) > 180) continue;
      let t = NaN;
      const tm = m[2] && /<time>\s*([^<]+?)\s*<\/time>/.exec(m[2]);
      if (tm) t = Date.parse(tm[1]) / 1000;
      if (!Number.isFinite(t)) { t = synth; synth += 5; }
      out.push(t, la, lo);
    }
    return out;
  }

  function toGPX(points) {
    const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Stadt Tracker" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>Stadt Tracker</name>\n<trkseg>\n'];
    let lastT = null;
    for (let i = 0; i + 2 < points.length; i += 3) {
      const t = points[i];
      if (lastT !== null && (t - lastT > 20 || t < lastT)) parts.push('</trkseg>\n<trkseg>\n');
      parts.push('<trkpt lat="' + points[i + 1].toFixed(6) + '" lon="' + points[i + 2].toFixed(6) + '"><time>' +
        new Date(t * 1000).toISOString() + '</time></trkpt>\n');
      lastT = t;
    }
    parts.push('</trkseg>\n</trk>\n</gpx>\n');
    return parts.join('');
  }

  /* Sortiert Tripel [t, lat, lon, …] nach Zeit. */
  function sortPoints(points) {
    const n = Math.floor(points.length / 3);
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => points[a * 3] - points[b * 3]);
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = order[i] * 3;
      out[i * 3] = points[o]; out[i * 3 + 1] = points[o + 1]; out[i * 3 + 2] = points[o + 2];
    }
    return out;
  }

  root.ST = {
    W, CFG, projX, projY, unprojLon, unprojLat, haversine, districtLabel, buildIndex, newResult, Coverage,
    computeStats, achievements, levelTitle, parseGPX, toGPX, sortPoints
  };
})(typeof window !== 'undefined' ? window : globalThis);
