/* Stadt Tracker – Konto, Freunde und geteilte Karten (Supabase).
   Ohne Eintrag in config.js bleibt die App rein lokal. Zugriffsregeln erzwingt die Datenbank (supabase.sql). */
(function () {
  'use strict';
  const A = window.STApp, ST = window.ST, CFG = ST.CFG;
  const conf = window.ST_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const esc = A.esc;
  const enabled = !!(conf.supabaseUrl && conf.supabaseKey && window.supabase && window.supabase.createClient);

  let sb = null, session = null, profile = null;
  let needMfa = false, step = 'email', pendingEmail = '', busy = false, message = '';
  let people = [], invites = [], enroll = null, hasTotp = false;
  let view = 'me';
  let dirty = false, syncTimer = null, lastUpload = '';
  const pointsCache = new Map(); // user_id -> { updated_at, pts: Int32Array }

  const ERRORS = {
    not_authenticated: 'Bitte melde dich neu an.', mfa_required: 'Bitte bestätige zuerst den zweiten Faktor.',
    invalid_username: 'Der Nutzername braucht 3–20 Zeichen: Kleinbuchstaben, Ziffern oder _.',
    already_registered: 'Für dieses Konto gibt es schon ein Profil.', username_taken: 'Dieser Nutzername ist vergeben.',
    invalid_invite: 'Der Einladungscode ist ungültig oder schon benutzt.', not_registered: 'Lege zuerst dein Profil an.',
    too_many_invites: 'Du hast schon 5 offene Einladungen.', user_not_found: 'Diesen Nutzernamen gibt es nicht.',
    cannot_add_self: 'Das bist du selbst.', invalid_email: 'Bitte gib eine gültige E-Mail-Adresse ein.', too_many_requests: 'Du hast zu viele offene Anfragen.', request_not_found: 'Die Anfrage gibt es nicht mehr.'
  };
  function errText(e) {
    const m = (e && e.message) || String(e || '');
    for (const k in ERRORS) if (m.includes(k)) return ERRORS[k];
    if (/rate limit|too many/i.test(m)) return 'Zu viele Versuche. Bitte warte ein paar Minuten.';
    if (/expired|invalid/i.test(m) && /token|otp|code/i.test(m)) return 'Der Code ist falsch oder abgelaufen.';
    if (/fetch|network/i.test(m)) return 'Keine Verbindung zum Server.';
    return 'Das hat nicht geklappt. Bitte versuche es noch einmal.';
  }
  /* Führt eine Server-Aktion aus, zeigt Fehler an und zeichnet danach neu. */
  async function act(fn) {
    if (busy) return;
    busy = true; message = '';
    try { await fn(); } catch (e) { message = errText(e); }
    busy = false;
    render();
  }
  const ok = (res) => { if (res.error) throw res.error; return res.data; };

  // ---------- Kodierung der eigenen Karte ----------
  /* Geteilt werden nur die Mittelpunkte besuchter Straßenstücke (auf ca. 1 m gerundet) – keine GPS-Spur, keine Zeiten. */
  function encodeCoverage(cov) {
    const idx = cov.index, vis = cov.visited;
    let n = 0;
    for (let i = 0; i < idx.count; i++) if (vis[i]) n++;
    const out = new Int32Array(n * 2);
    let k = 0;
    for (let i = 0; i < idx.count; i++) {
      if (!vis[i]) continue;
      out[k++] = Math.round(ST.unprojLat((idx.ay[i] + idx.by[i]) / 2) * 1e5);
      out[k++] = Math.round(ST.unprojLon((idx.ax[i] + idx.bx[i]) / 2) * 1e5);
    }
    const bytes = new Uint8Array(out.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(s);
  }
  function decodePoints(b64) {
    try {
      const s = atob(b64 || '');
      const n = s.length - (s.length % 8);
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = s.charCodeAt(i);
      return new Int32Array(bytes.buffer);
    } catch (e) { return new Int32Array(0); }
  }
  function markPoints(cov, pts, out) {
    const idx = cov.index, r = 6 * idx.ppm, r2 = r * r;
    for (let k = 0; k + 1 < pts.length; k += 2) {
      const lat = pts[k] / 1e5, lon = pts[k + 1] / 1e5;
      if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180)) continue;
      const x = ST.projX(lon), y = ST.projY(lat);
      idx.forEach(x - r, y - r, x + r, y + r, (i) => {
        if (out[i]) return;
        const dx = (idx.ax[i] + idx.bx[i]) / 2 - x, dy = (idx.ay[i] + idx.by[i]) / 2 - y;
        if (dx * dx + dy * dy <= r2) out[i] = 1;
      });
    }
  }

  // ---------- Server ----------
  async function afterLogin() {
    profile = null; people = []; invites = []; needMfa = false;
    if (!session) return;
    const aal = ok(await sb.auth.mfa.getAuthenticatorAssuranceLevel());
    needMfa = aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2';
    hasTotp = aal.nextLevel === 'aal2';
    if (needMfa) return;
    profile = ok(await sb.from('profiles').select('id,username,visibility').eq('id', session.user.id).maybeSingle());
    if (!profile) return;
    await refreshPeople();
    if (profile.visibility === 'private') await sb.from('coverage').delete().eq('user_id', profile.id);
    else { dirty = true; syncUp(); }
  }

  async function refreshPeople() {
    const uid = profile.id;
    const [fr, pr, cv, inv] = await Promise.all([
      sb.from('friendships').select('requester,addressee,status'),
      sb.from('profiles').select('id,username,visibility').limit(500),
      sb.from('coverage').select('user_id,visited_m,total_m,streets_done,updated_at').eq('city', CFG.city).limit(500),
      sb.from('invites').select('code,used_at').is('used_at', null)
    ]);
    const rel = new Map();
    for (const f of ok(fr)) {
      const other = f.requester === uid ? f.addressee : f.requester;
      rel.set(other, f.status === 'accepted' ? 'friend' : (f.requester === uid ? 'outgoing' : 'incoming'));
    }
    const covs = new Map(ok(cv).map((c) => [c.user_id, c]));
    people = ok(pr).map((p) => ({
      id: p.id, username: p.username, visibility: p.visibility,
      relation: p.id === uid ? 'me' : (rel.get(p.id) || 'public'), cov: covs.get(p.id) || null
    }));
    invites = ok(inv).map((i) => i.code);
    if (view.startsWith('u:') && !people.some((p) => 'u:' + p.id === view && p.cov)) view = 'me';
  }

  /* Lädt die eigene Karte hoch – nur wenn die Sichtbarkeit nicht "privat" ist. */
  async function syncUp() {
    clearTimeout(syncTimer); syncTimer = null;
    const cov = A.getCov();
    if (!dirty || !profile || !cov || profile.visibility === 'private') return;
    dirty = false;
    const points = encodeCoverage(cov);
    const key = points.length + ':' + Math.round(cov.visitedLength);
    if (key === lastUpload) return;
    const res = await sb.from('coverage').upsert({
      user_id: profile.id, city: CFG.city, points,
      visited_m: Math.round(cov.visitedLength), total_m: Math.round(cov.index.totalLength), streets_done: cov.streetsDone
    });
    if (res.error) dirty = true; else lastUpload = key;
  }

  async function setVisibility(v) {
    ok(await sb.from('profiles').update({ visibility: v }).eq('id', profile.id));
    profile.visibility = v;
    if (v === 'private') { ok(await sb.from('coverage').delete().eq('user_id', profile.id)); lastUpload = ''; }
    else { dirty = true; lastUpload = ''; await syncUp(); }
    await refreshPeople();
  }

  // ---------- Kartenansicht ----------
  const viewLabel = () => {
    if (view === 'friends') return 'Freunde';
    if (view === 'all') return 'Alle sichtbaren';
    const p = people.find((x) => 'u:' + x.id === view);
    return p ? '@' + p.username : '';
  };
  function viewTargets() {
    if (view === 'friends') return people.filter((p) => p.relation === 'friend' && p.cov);
    if (view === 'all') return people.filter((p) => p.relation !== 'me' && p.cov);
    return people.filter((p) => 'u:' + p.id === view && p.cov);
  }
  async function applyView() {
    const cov = A.getCov();
    if (!cov || !profile || view === 'me') { A.setOthers(null, ''); return; }
    const targets = viewTargets();
    const missing = targets.filter((p) => { const c = pointsCache.get(p.id); return !c || c.updated_at !== p.cov.updated_at; }).map((p) => p.id);
    if (missing.length) {
      const res = await sb.from('coverage').select('user_id,points,updated_at').in('user_id', missing);
      if (!res.error) for (const row of res.data) pointsCache.set(row.user_id, { updated_at: row.updated_at, pts: decodePoints(row.points) });
    }
    const out = new Uint8Array(Math.max(cov.index.count, 1));
    for (const p of targets) { const c = pointsCache.get(p.id); if (c) markPoints(cov, c.pts, out); }
    A.setOthers(out, viewLabel());
  }
  function setView(v) {
    view = v;
    applyView().catch(() => A.setOthers(null, ''));
  }

  function openViewSheet() {
    if (!enabled || !profile) { A.showTab('friends'); return; }
    const opt = (v, label, sub) => '<button class="linkbtn viewopt' + (view === v ? ' sel' : '') + '" data-view="' + esc(v) + '">' + esc(label) +
      (sub ? '<span class="small muted"> · ' + esc(sub) + '</span>' : '') + '</button>';
    const friends = people.filter((p) => p.relation === 'friend' && p.cov);
    const others = people.filter((p) => p.relation === 'public' && p.cov);
    let html = '<h1>Kartenansicht <button id="views-close" class="textbtn">Fertig</button></h1><div class="card">' + opt('me', 'Nur ich') +
      opt('friends', 'Meine Freunde', friends.length + (friends.length === 1 ? ' Karte' : ' Karten')) +
      opt('all', 'Alle, die ich sehen darf', (friends.length + others.length) + ' Karten') + '</div>';
    if (friends.length) html += '<div class="card"><h2>Freunde</h2>' + friends.map((p) => opt('u:' + p.id, '@' + p.username, A.fmtDist(p.cov.visited_m))).join('') + '</div>';
    if (others.length) html += '<div class="card"><h2>Öffentlich</h2>' + others.map((p) => opt('u:' + p.id, '@' + p.username, A.fmtDist(p.cov.visited_m))).join('') + '</div>';
    html += '<p class="small muted" style="padding:0 6px">Grün sind deine Straßen, violett die der gewählten Personen. Du siehst nur Karten, deren Besitzer das erlaubt haben.</p>';
    $('views-panel').innerHTML = html;
    $('views').classList.add('show');
  }

  // ---------- Oberfläche ----------
  const VIS = { private: ['Privat', 'Niemand sieht deine Karte. Sie wird nicht hochgeladen.'],
    friends: ['Freunde', 'Nur bestätigte Freunde sehen deine Karte.'],
    public: ['Alle', 'Jeder angemeldete Nutzer sieht deine Karte und deinen Nutzernamen.'] };

  /* Zeichnet den Freunde-Tab neu und behält dabei bereits getippte Eingaben. */
  function render() {
    const el = $('friends-body');
    if (!el) return;
    const typed = {};
    el.querySelectorAll('input[id]').forEach((i) => { typed[i.id] = i.value; });
    renderInto(el);
    el.querySelectorAll('input[id]').forEach((i) => { if (typed[i.id] && !i.value) i.value = typed[i.id]; });
  }

  function renderInto(el) {
    const msg = message ? '<p class="err small">' + esc(message) + '</p>' : '';
    const dis = busy ? ' disabled' : '';
    if (!enabled) {
      el.innerHTML = '<div class="card"><h2>Online-Funktionen sind nicht eingerichtet</h2><p class="small muted">Konto, Freunde und geteilte Karten brauchen einen Server. ' +
        'Die Einrichtung steht in SETUP.md. Bis dahin läuft die App rein lokal auf diesem Gerät.</p></div>';
      return;
    }
    if (!session) {
      el.innerHTML = step === 'email'
        ? '<div class="card"><h2>Anmelden</h2><p class="small muted">Du bekommst einen einmaligen Anmeldelink per E-Mail. Ein Passwort gibt es nicht.</p>' +
          '<input class="field" id="in-email" type="email" inputmode="email" autocomplete="email" placeholder="E-Mail-Adresse">' + msg +
          '<button class="primary wide" data-act="send"' + dis + '>Anmeldelink senden</button></div>'
        : '<div class="card"><h2>E-Mail prüfen</h2><p class="small muted">Wir haben eine E-Mail an ' + esc(pendingEmail) + ' geschickt. Tippe auf den Link darin – du bist dann in diesem Browser angemeldet.</p>' +
          '<p class="small muted">Nutzt du die App vom Home-Bildschirm? Dann halte den Link in der E-Mail gedrückt, wähle „Link kopieren“ und füge ihn hier ein:</p>' +
          '<input class="field" id="in-code" type="text" autocapitalize="none" autocomplete="off" placeholder="Link (oder Code) aus der E-Mail">' + msg +
          '<button class="primary wide" data-act="verify"' + dis + '>Anmelden</button><button class="linkbtn" data-act="back">Andere E-Mail-Adresse</button></div>';
      return;
    }
    if (needMfa) {
      el.innerHTML = '<div class="card"><h2>Zweiter Faktor</h2><p class="small muted">Gib den 6-stelligen Code aus deiner Authenticator-App ein.</p>' +
        '<input class="field" id="in-totp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">' + msg +
        '<button class="primary wide" data-act="mfa"' + dis + '>Bestätigen</button><button class="linkbtn" data-act="logout">Abmelden</button></div>';
      return;
    }
    if (!profile) {
      el.innerHTML = '<div class="card"><h2>Profil anlegen</h2><p class="small muted">Andere sehen nur diesen Nutzernamen, nie deine E-Mail-Adresse.</p>' +
        '<input class="field" id="in-username" type="text" autocapitalize="none" autocomplete="off" maxlength="20" placeholder="Nutzername (a–z, 0–9, _)">' +
        '<input class="field" id="in-invite" type="text" autocapitalize="characters" autocomplete="off" maxlength="12" placeholder="Einladungscode">' +
        '<p class="small muted">Der erste Nutzer dieser Installation braucht keinen Code.</p>' + msg +
        '<button class="primary wide" data-act="register"' + dis + '>Profil anlegen</button><button class="linkbtn" data-act="logout">Abmelden</button></div>';
      return;
    }

    const me = people.find((p) => p.relation === 'me');
    const ranked = people.filter((p) => p.cov && (p.relation === 'friend' || p.relation === 'public')).sort((a, b) => b.cov.visited_m - a.cov.visited_m);
    const friendsNoMap = people.filter((p) => p.relation === 'friend' && !p.cov);
    const incoming = people.filter((p) => p.relation === 'incoming'), outgoing = people.filter((p) => p.relation === 'outgoing');
    const cov = A.getCov();
    const myM = cov ? cov.visitedLength : (me && me.cov ? me.cov.visited_m : 0);
    const pct = (c) => (c.total_m > 0 ? A.fmtPct(Math.min(c.visited_m / c.total_m, 1), 1) : '');

    let html = '<div class="card"><div class="row between"><div><b style="font-size:20px">@' + esc(profile.username) + '</b><div class="small muted">' +
      esc(session.user.email || '') + '</div></div><span class="num">' + A.fmtDist(myM) + '</span></div>' +
      '<h2 style="margin-top:14px">Wer darf meine Karte sehen?</h2><div class="seg">' +
      Object.keys(VIS).map((k) => '<button data-act="vis" data-v="' + k + '" class="' + (profile.visibility === k ? 'active' : '') + '"' + dis + '>' + VIS[k][0] + '</button>').join('') +
      '</div><p class="small muted" style="margin:0">' + VIS[profile.visibility][1] + '</p>' + msg + '</div>';

    if (incoming.length) {
      html += '<div class="card"><h2>Anfragen an dich</h2>' + incoming.map((p) => '<div class="setting"><span>@' + esc(p.username) + '</span><span>' +
        '<button class="pill ok" data-act="accept" data-id="' + esc(p.id) + '"' + dis + '>Annehmen</button> ' +
        '<button class="pill" data-act="unfriend" data-id="' + esc(p.id) + '"' + dis + '>Ablehnen</button></span></div>').join('') + '</div>';
    }

    html += '<div class="card"><h2>Rangliste</h2>';
    if (!ranked.length) html += '<p class="small muted" style="margin:0">Noch keine Karten von anderen. Füge Freunde hinzu – sie müssen ihre Karte für Freunde oder alle freigeben.</p>';
    else html += ranked.map((p, i) => '<button class="street" data-act="show" data-id="' + esc(p.id) + '"><span class="rank">' + (i + 1) + '</span><span class="name"><b>@' + esc(p.username) +
      '</b><span class="small muted">' + (p.relation === 'friend' ? 'Freund' : 'Öffentlich') + ' · ' + p.cov.streets_done + ' Straßen fertig</span></span><span class="num small" style="text-align:right">' +
      A.fmtDist(p.cov.visited_m) + '<br><span class="muted">' + pct(p.cov) + '</span></span></button>').join('') +
      '<p class="small muted" style="margin:10px 0 0">Tippe auf eine Person, um ihre Karte zu sehen.</p>';
    html += '</div>';

    html += '<div class="card"><h2>Freunde</h2>';
    const friends = people.filter((p) => p.relation === 'friend');
    if (!friends.length && !outgoing.length) html += '<p class="small muted" style="margin:0 0 8px">Du hast noch keine Freunde hinzugefügt.</p>';
    html += friends.map((p) => '<div class="setting"><span>@' + esc(p.username) + (p.cov ? '' : ' <span class="small muted">· teilt keine Karte</span>') +
      '</span><button class="pill" data-act="unfriend" data-id="' + esc(p.id) + '"' + dis + '>Entfernen</button></div>').join('');
    html += outgoing.map((p) => '<div class="setting"><span>@' + esc(p.username) + ' <span class="small muted">· wartet auf Bestätigung</span></span>' +
      '<button class="pill" data-act="unfriend" data-id="' + esc(p.id) + '"' + dis + '>Zurückziehen</button></div>').join('');
    html += '<div class="row" style="margin-top:10px"><input class="field" id="in-friend" type="text" autocapitalize="none" autocomplete="off" maxlength="20" placeholder="Nutzername" style="margin:0">' +
      '<button class="pill ok" data-act="add"' + dis + '>Hinzufügen</button></div></div>';
    void friendsNoMap;

    html += '<div class="card"><h2>Einladungen</h2><p class="small muted" style="margin-top:0">Neue Nutzer brauchen einen Code. Jeder Code gilt einmal.</p>' +
      invites.map((c) => '<div class="setting"><code class="code">' + esc(c) + '</code><button class="pill" data-act="copy" data-code="' + esc(c) + '">Kopieren</button></div>').join('') +
      '<button class="linkbtn" data-act="invite" style="border:0"' + dis + '>Neuen Einladungscode erstellen</button></div>';

    html += '<div class="card"><h2>Sicherheit</h2>';
    if (enroll) {
      html += '<p class="small muted" style="margin-top:0">Scanne den QR-Code mit einer Authenticator-App und gib dann den 6-stelligen Code ein.</p>' +
        '<img class="qr" alt="QR-Code" src="' + esc(enroll.qr) + '"><p class="small muted">Oder Schlüssel eintippen: <code class="code">' + esc(enroll.secret) + '</code></p>' +
        '<input class="field" id="in-enroll" type="text" inputmode="numeric" maxlength="6" placeholder="123456">' +
        '<button class="primary wide" data-act="enroll-verify"' + dis + '>Aktivieren</button><button class="linkbtn" data-act="enroll-cancel">Abbrechen</button>';
    } else if (hasTotp) {
      html += '<div class="setting"><span>Zweiter Faktor <span class="small" style="color:var(--green)">· aktiv</span></span><button class="pill" data-act="mfa-off"' + dis + '>Entfernen</button></div>';
    } else {
      html += '<p class="small muted" style="margin-top:0">Mit einer Authenticator-App reicht der Zugriff auf dein E-Mail-Postfach allein nicht mehr zum Anmelden.</p>' +
        '<button class="linkbtn" data-act="enroll"' + dis + '>Zweiten Faktor einrichten</button>';
    }
    html += '<button class="linkbtn" data-act="logout">Abmelden</button><button class="linkbtn danger" data-act="delete"' + dis + '>Konto und alle Server-Daten löschen</button></div>' +
      '<p class="small muted" style="padding:0 6px">Auf dem Server liegen nur dein Nutzername, deine E-Mail-Adresse, deine Freundesliste und – außer bei „Privat“ – die besuchten Straßenstücke. ' +
      'Deine GPS-Aufzeichnung mit Zeiten bleibt immer auf diesem Gerät.</p>';
    el.innerHTML = html;
  }

  const val = (id) => ($(id) ? $(id).value.trim() : '');
  const ACTIONS = {
    send: () => act(async () => {
      const email = val('in-email').toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('invalid_email');
      const redirect = location.origin + location.pathname.replace(/index\.html$/, '');
      ok(await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirect } }));
      pendingEmail = email; step = 'code';
    }),
    back: () => { step = 'email'; message = ''; render(); },
    verify: () => act(async () => {
      const input = val('in-code').replace(/\s/g, '');
      let data;
      if (/^\d{6,10}$/.test(input)) {
        data = ok(await sb.auth.verifyOtp({ email: pendingEmail, token: input, type: 'email' }));
      } else {
        // Eingefügter Link aus der E-Mail: enthält ein einmaliges Token und dessen Art
        let url;
        try { url = new URL(input); } catch (e) { throw new Error('invalid otp code'); }
        const hash = url.searchParams.get('token_hash') || url.searchParams.get('token');
        const kind = url.searchParams.get('type');
        if (!hash || !/^https:$/.test(url.protocol)) throw new Error('invalid otp code');
        const types = ['signup', 'magiclink', 'email', 'invite', 'recovery'];
        data = ok(await sb.auth.verifyOtp({ token_hash: hash, type: types.includes(kind) ? kind : 'email' }));
      }
      session = data.session; step = 'email';
      await afterLogin();
    }),
    mfa: () => act(async () => {
      const factors = ok(await sb.auth.mfa.listFactors());
      const totp = (factors.totp || [])[0];
      if (!totp) throw new Error('mfa');
      ok(await sb.auth.mfa.challengeAndVerify({ factorId: totp.id, code: val('in-totp') }));
      session = ok(await sb.auth.getSession()).session;
      await afterLogin();
    }),
    register: () => act(async () => {
      ok(await sb.rpc('register', { p_username: val('in-username').toLowerCase(), p_invite: val('in-invite').toUpperCase() || null }));
      await afterLogin();
    }),
    vis: (b) => act(() => setVisibility(b.dataset.v)),
    add: () => act(async () => {
      const name = val('in-friend').replace(/^@/, '').toLowerCase();
      if (!name) return;
      const status = ok(await sb.rpc('request_friend', { p_username: name }));
      await refreshPeople();
      A.toast('👋', status === 'accepted' ? 'Ihr seid jetzt befreundet' : 'Anfrage gesendet', '@' + name);
    }),
    accept: (b) => act(async () => { ok(await sb.rpc('accept_friend', { p_requester: b.dataset.id })); await refreshPeople(); }),
    unfriend: (b) => act(async () => {
      const id = b.dataset.id;
      ok(await sb.from('friendships').delete().or('and(requester.eq.' + profile.id + ',addressee.eq.' + id + '),and(requester.eq.' + id + ',addressee.eq.' + profile.id + ')'));
      pointsCache.delete(id);
      await refreshPeople();
      await applyView();
    }),
    show: (b) => { setView('u:' + b.dataset.id); A.showTab('map'); },
    invite: () => act(async () => { ok(await sb.rpc('create_invite')); await refreshPeople(); }),
    copy: (b) => { if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.code).then(() => A.toast('📋', 'Code kopiert', b.dataset.code)).catch(() => {}); },
    enroll: () => act(async () => {
      const existing = ok(await sb.auth.mfa.listFactors());
      for (const f of (existing.all || [])) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id });
      const d = ok(await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Stadt Tracker ' + Date.now() }));
      enroll = { id: d.id, qr: d.totp.qr_code, secret: d.totp.secret };
    }),
    'enroll-verify': () => act(async () => {
      ok(await sb.auth.mfa.challengeAndVerify({ factorId: enroll.id, code: val('in-enroll') }));
      enroll = null; hasTotp = true;
      A.toast('🔐', 'Zweiter Faktor aktiv', 'Ab jetzt wird er bei jeder Anmeldung abgefragt.');
    }),
    'enroll-cancel': () => act(async () => { if (enroll) await sb.auth.mfa.unenroll({ factorId: enroll.id }); enroll = null; }),
    'mfa-off': () => {
      if (!confirm('Zweiten Faktor wirklich entfernen? Dein Konto ist dann nur noch durch den E-Mail-Code geschützt.')) return;
      act(async () => {
        const factors = ok(await sb.auth.mfa.listFactors());
        for (const f of (factors.totp || [])) ok(await sb.auth.mfa.unenroll({ factorId: f.id }));
        await sb.auth.refreshSession();
        hasTotp = false;
      });
    },
    logout: () => act(async () => { await sb.auth.signOut(); signedOut(); }),
    delete: () => {
      if (!confirm('Konto wirklich löschen? Profil, Freundschaften und deine geteilte Karte werden unwiderruflich vom Server entfernt. Dein Fortschritt auf diesem Gerät bleibt.')) return;
      act(async () => { ok(await sb.rpc('delete_account')); await sb.auth.signOut().catch(() => {}); signedOut(); });
    }
  };

  function signedOut() {
    session = null; profile = null; people = []; invites = []; enroll = null; needMfa = false; hasTotp = false;
    view = 'me'; lastUpload = ''; pointsCache.clear(); step = 'email';
    A.setOthers(null, '');
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && $('friends-body').contains(b) && ACTIONS[b.dataset.act]) return ACTIONS[b.dataset.act](b);
    const v = e.target.closest('[data-view]');
    if (v) { $('views').classList.remove('show'); return setView(v.dataset.view); }
    if (e.target.id === 'views-close' || e.target.id === 'views') $('views').classList.remove('show');
    if (e.target.closest('#btn-people')) openViewSheet();
    if (e.target.closest('#view-chip')) setView('me');
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) syncUp(); });

  window.STCloud = {
    render,
    /* Wird von der App nach jedem neuen Straßenstück und nach dem Laden aufgerufen. */
    onProgress() {
      dirty = true;
      if (!syncTimer) syncTimer = setTimeout(syncUp, 45000);
    },
    onCoverageReady() { dirty = true; syncUp(); applyView().catch(() => {}); }
  };

  if (!enabled) { render(); return; }
  sb = window.supabase.createClient(conf.supabaseUrl, conf.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
  });
  sb.auth.onAuthStateChange((event, s) => {
    if (event === 'SIGNED_OUT') { signedOut(); render(); }
    else if (event === 'SIGNED_IN' && s && !session) {
      // Anmeldung über den Link aus der E-Mail (z. B. in einem anderen Tab)
      session = s;
      setTimeout(() => { afterLogin().catch((e) => { message = errText(e); }).then(() => { render(); applyView().catch(() => {}); }); }, 0);
    }
    else if (event === 'TOKEN_REFRESHED' && s) session = s;
  });
  sb.auth.getSession().then(async (res) => {
    session = res.data ? res.data.session : null;
    try { await afterLogin(); } catch (e) { message = errText(e); }
    render();
    applyView().catch(() => {});
  });
})();
