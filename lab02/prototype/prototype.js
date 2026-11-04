/*
  Lab 2 prototype: "Add a stop", redesigned.
  Runs on the Google Maps JavaScript API when lab2/config.js has a key
  (Maps JS + Places API (New) + Routes API), and on a schematic demo map
  with sample places when it does not. Same UI and logic in both modes.

  URL options (used by the report to render static mockups):
    ?embed           fill the frame, no device chrome
    ?static          freeze timers, fixed clock, no auto-hide
    ?demo            force the demo map
    ?state=route|add|added|nav   initial state
    ?cat=coffee|gas|food|pharmacy|atm|store
*/
(() => {
  'use strict';

  const cfg = window.MAPS_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const EMBED = params.has('embed');
  const STATIC = params.has('static');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const D = REDUCED || STATIC ? 0 : 1; // GSAP duration multiplier
  if (EMBED) document.body.classList.add('embed');
  if (STATIC) document.body.classList.add('static');

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const sheet = $('sheet');
  const stopsEl = $('stops');
  const resultsEl = $('results');
  const ICON = (n) => `<svg class="i" aria-hidden="true"><use href="assets/icons.svg#i-${n}"/></svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const lang = cfg.language || 'en';
  const fmtKm = new Intl.NumberFormat(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const fmtTime = new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' });

  const CATS = [
    { id: 'gas', label: 'Gas', icon: 'local_gas_station', query: 'gas station' },
    { id: 'coffee', label: 'Coffee', icon: 'local_cafe', query: 'coffee shop' },
    { id: 'food', label: 'Food', icon: 'restaurant', query: 'restaurant' },
    { id: 'pharmacy', label: 'Pharmacy', icon: 'local_pharmacy', query: 'pharmacy' },
    { id: 'atm', label: 'ATM', icon: 'local_atm', query: 'ATM' },
    { id: 'store', label: 'Store', icon: 'local_convenience_store', query: 'convenience store' },
  ];
  const catById = Object.fromEntries(CATS.map((c) => [c.id, c]));

  // Sample places for demo mode only (fictional businesses).
  const DEMO_PLACES = [
    ['coffee', 'Molino Café', 'Col. Nápoles', 19.3912, -99.1712],
    ['coffee', 'Taza Lenta', 'Col. Roma Sur', 19.4105, -99.1648],
    ['coffee', 'Tueste Sur', 'Col. Del Valle Sur', 19.3688, -99.1745],
    ['coffee', 'Café Pausa', 'Col. Santa Catarina', 19.3575, -99.1598],
    ['gas', 'Estación Norte', 'Col. Roma Sur', 19.4160, -99.1702],
    ['gas', 'Gas 24 Sur', 'Col. Narvarte', 19.3790, -99.1658],
    ['gas', 'Estación Río', 'Col. Florida', 19.3538, -99.1730],
    ['food', 'Fonda Marina', 'Col. Del Valle', 19.4030, -99.1690],
    ['food', 'Tacos del Puente', 'Col. Insurgentes Mixcoac', 19.3850, -99.1760],
    ['food', 'Cocina Siete', 'Col. Del Carmen', 19.3625, -99.1650],
    ['pharmacy', 'Farmacia Central', 'Col. Narvarte', 19.4075, -99.1650],
    ['pharmacy', 'Botica 12', 'Col. Del Valle Sur', 19.3720, -99.1702],
    ['atm', 'Cajero Banco Uno', 'Col. Nápoles', 19.3955, -99.1720],
    ['atm', 'Cajero Plaza Sur', 'Col. Chimalistac', 19.3605, -99.1690],
    ['store', 'Mini Súper Luna', 'Col. Narvarte', 19.3870, -99.1650],
    ['store', 'Tienda 8', 'Col. Roma Sur', 19.4125, -99.1730],
  ].map(([cat, name, address, lat, lng], i) => ({ id: 'demo-' + i, cat, name, address, pos: { lat, lng } }));

  const MAX_STOPS = 9;
  const DEMO_STOP_MIN = 1; // demo model: pulling over adds about a minute per stop
  const SPEED = 400; // meters per minute, about 24 km/h in city traffic
  const ROAD_FACTOR = 1.3;

  const state = {
    live: false,
    origin: { id: 'origin', name: cfg.origin?.name || 'Start', address: cfg.origin?.address || '', pos: { lat: cfg.origin?.lat ?? 19.42696, lng: cfg.origin?.lng ?? -99.16771 } },
    dest: { id: 'dest', name: cfg.destination?.name || 'Destination', address: cfg.destination?.address || '', pos: { lat: cfg.destination?.lat ?? 19.35003, lng: cfg.destination?.lng ?? -99.16239 } },
    stops: [],
    view: 'route',
    navigating: false,
    cat: params.get('cat') && catById[params.get('cat')] ? params.get('cat') : 'coffee',
    query: '',
    results: [],
    activeId: null,
    route: null,
    newId: null,
    undo: null,
    seq: 0,
  };

  const now = () => {
    if (!STATIC) return new Date();
    const d = new Date();
    d.setHours(15, 10, 0, 0);
    return d;
  };

  /* ---------------- geometry ---------------- */
  const toR = Math.PI / 180;
  function hav(a, b) {
    const dLat = (b.lat - a.lat) * toR;
    const dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(s));
  }
  const corner = (a, b) => ({ lat: b.lat, lng: a.lng });
  // Leg cost in minutes. Demo mode follows its own L-shaped street model so
  // the predicted detour equals what the route then reports.
  function legMin(a, b) {
    if (state.live) return (hav(a, b) * ROAD_FACTOR) / SPEED;
    const c = corner(a, b);
    return ((hav(a, c) + hav(c, b)) * 1.05) / SPEED;
  }
  const waypoints = () => [state.origin, ...state.stops, state.dest];
  function bestInsert(pos, list = waypoints()) {
    let best = { extra: Infinity, index: 0 };
    for (let i = 0; i < list.length - 1; i++) {
      const extra = legMin(list[i].pos, pos) + legMin(pos, list[i + 1].pos) - legMin(list[i].pos, list[i + 1].pos);
      if (extra < best.extra) best = { extra, index: i };
    }
    if (!state.live) best.extra += DEMO_STOP_MIN;
    return best;
  }
  function distToPath(p, path) {
    const k = Math.cos(p.lat * toR) * 111320;
    const xy = (q) => [q.lng * k, q.lat * 110540];
    const [px, py] = xy(p);
    let min = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, ay] = xy(path[i]);
      const [bx, by] = xy(path[i + 1]);
      const dx = bx - ax, dy = by - ay;
      const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
      min = Math.min(min, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
    }
    return min;
  }
  function boundsOf(points, padM = 0) {
    let n = -90, s = 90, e = -180, w = 180;
    points.forEach((p) => { n = Math.max(n, p.lat); s = Math.min(s, p.lat); e = Math.max(e, p.lng); w = Math.min(w, p.lng); });
    const dLat = padM / 110540;
    const dLng = padM / (111320 * Math.cos(((n + s) / 2) * toR));
    return { north: n + dLat, south: s - dLat, east: e + dLng, west: w - dLng };
  }

  /* ---------------- routing ---------------- */
  function demoRoute(list) {
    const path = [];
    const legs = [];
    let dist = 0;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i].pos, b = list[i + 1].pos, c = corner(a, b);
      if (i === 0) path.push(a);
      path.push(c, b);
      dist += (hav(a, c) + hav(c, b)) * 1.05;
      legs.push(legMin(a, b) + (i < list.length - 2 ? DEMO_STOP_MIN : 0));
    }
    return { path, distance: dist, legs, duration: legs.reduce((x, y) => x + y, 0), approx: !state.live };
  }

  async function liveRoute(list) {
    const lib = await google.maps.importLibrary('routes');
    const mids = list.slice(1, -1);
    if (lib.Route) {
      try {
        const { routes } = await lib.Route.computeRoutes({
          origin: list[0].pos,
          destination: list[list.length - 1].pos,
          intermediates: mids.map((w) => ({ location: w.pos })),
          travelMode: 'DRIVING',
          fields: ['durationMillis', 'distanceMeters', 'path', 'legs'],
        });
        const r = routes && routes[0];
        if (r && r.path) {
          const legs = (r.legs || []).map((l) => (l.durationMillis || 0) / 60000);
          return {
            path: r.path.map((p) => ({ lat: p.lat, lng: p.lng })),
            distance: r.distanceMeters,
            legs,
            duration: (r.durationMillis || 0) / 60000 || legs.reduce((x, y) => x + y, 0),
          };
        }
      } catch (err) {
        console.warn('Routes API (Route.computeRoutes) failed, trying DirectionsService.', err);
      }
    }
    try {
      const ds = new lib.DirectionsService();
      const res = await ds.route({
        origin: list[0].pos,
        destination: list[list.length - 1].pos,
        waypoints: mids.map((w) => ({ location: w.pos, stopover: true })),
        travelMode: 'DRIVING',
      });
      const r = res.routes[0];
      return {
        path: r.overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() })),
        distance: r.legs.reduce((x, l) => x + l.distance.value, 0),
        legs: r.legs.map((l) => l.duration.value / 60),
        duration: r.legs.reduce((x, l) => x + l.duration.value / 60, 0),
      };
    } catch (err) {
      console.warn('DirectionsService failed, using an estimated route.', err);
      return { ...demoRoute(list), approx: true };
    }
  }

  let routeToken = 0;
  async function recompute() {
    const token = ++routeToken;
    app.classList.add('is-updating');
    const r = state.live ? await liveRoute(waypoints()) : demoRoute(waypoints());
    if (token !== routeToken) return false;
    state.route = r;
    app.classList.remove('is-updating');
    return true;
  }

  /* ---------------- places ---------------- */
  const catCache = new Map();
  function scorePlaces(list) {
    const path = state.route ? state.route.path : waypoints().map((w) => w.pos);
    return list
      .map((p) => ({ ...p, off: distToPath(p.pos, path), cost: Math.max(1, Math.round(bestInsert(p.pos).extra)) }))
      .filter((p) => p.off < 1600)
      .sort((a, b) => a.cost - b.cost || a.off - b.off)
      .slice(0, 6);
  }

  async function searchCategory(catId) {
    const cat = catById[catId];
    if (!state.live) return scorePlaces(DEMO_PLACES.filter((p) => p.cat === catId));
    const key = catId + '|' + waypoints().map((w) => w.id).join(',');
    if (catCache.has(key)) return catCache.get(key);
    const { Place } = await google.maps.importLibrary('places');
    const b = boundsOf(state.route ? state.route.path : waypoints().map((w) => w.pos), 900);
    const { places } = await Place.searchByText({
      textQuery: cat.query,
      fields: ['id', 'displayName', 'formattedAddress', 'location'],
      locationRestriction: b,
      maxResultCount: 15,
      language: lang,
      region: cfg.region,
    });
    const out = scorePlaces(
      (places || []).filter((p) => p.location).map((p) => ({
        id: p.id, cat: catId, name: p.displayName, address: shortAddr(p.formattedAddress),
        pos: { lat: p.location.lat(), lng: p.location.lng() },
      })),
    );
    catCache.set(key, out);
    return out;
  }

  let sessionToken = null;
  async function searchText(q) {
    if (!state.live) {
      const nq = norm(q);
      return scorePlaces(DEMO_PLACES.filter((p) => norm(p.name + ' ' + p.address + ' ' + catById[p.cat].label + ' ' + catById[p.cat].query).includes(nq)));
    }
    const { AutocompleteSuggestion, AutocompleteSessionToken } = await google.maps.importLibrary('places');
    sessionToken = sessionToken || new AutocompleteSessionToken();
    const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: q,
      sessionToken,
      locationBias: boundsOf(state.route ? state.route.path : waypoints().map((w) => w.pos), 1500),
      language: lang,
      region: cfg.region,
    });
    return (suggestions || [])
      .filter((s) => s.placePrediction)
      .slice(0, 6)
      .map((s) => {
        const pp = s.placePrediction;
        return { id: pp.placeId, cat: null, name: pp.mainText?.text || pp.text?.text, address: pp.secondaryText?.text || '', prediction: pp, cost: null };
      });
  }
  const shortAddr = (a) => (a || '').split(',').slice(0, 2).join(',').trim();

  /* ---------------- pins (shared markup) ---------------- */
  function pinEl(p) {
    const el = document.createElement('div');
    if (p.type === 'origin') el.className = 'pin-origin';
    else if (p.type === 'dest') { el.className = 'pin-dest'; el.innerHTML = `<svg aria-hidden="true"><use href="assets/icons.svg#i-location_on-f"/></svg>`; }
    else if (p.type === 'stop') { el.className = 'pin-stop'; el.textContent = p.label; }
    else {
      el.className = 'pin-cand' + (p.active ? ' is-active' : '');
      el.innerHTML = `${ICON(catById[p.cat]?.icon || 'location_on')}<span class="pin-cost">+${p.cost}</span>`;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `Add ${p.name}, ${p.cost} more minutes`);
    }
    return el;
  }

  /* ---------------- demo map ---------------- */
  function createDemoMap(host) {
    const B = { n: 19.47, s: 19.27, w: -99.24, e: -99.09 };
    const k = Math.cos(((B.n + B.s) / 2) * toR);
    const W = 1000;
    const H = Math.round((W * (B.n - B.s)) / ((B.e - B.w) * k));
    const px = (p) => ({ x: ((p.lng - B.w) / (B.e - B.w)) * W, y: ((B.n - p.lat) / (B.n - B.s)) * H });
    const latY = (lat) => ((B.n - lat) / (B.n - B.s)) * H;
    const lngX = (lng) => ((lng - B.w) / (B.e - B.w)) * W;

    let minor = '', major = '';
    for (let lat = 19.27; lat <= 19.47; lat += 0.004) {
      const y = latY(lat).toFixed(1);
      (Math.round((lat - 19.27) / 0.004) % 3 === 0 ? (major += `M0 ${y}H${W}`) : (minor += `M0 ${y}H${W}`));
    }
    for (let lng = -99.24; lng <= -99.09; lng += 0.004) {
      const x = lngX(lng).toFixed(1);
      (Math.round((lng + 99.24) / 0.004) % 3 === 0 ? (major += `M${x} 0V${H}`) : (minor += `M${x} 0V${H}`));
    }
    const avenue = `M${lngX(state.origin.pos.lng).toFixed(1)} 0V${H}M0 ${latY(state.dest.pos.lat).toFixed(1)}H${W}`;
    const parks = [
      [19.4300, 19.4180, -99.2050, -99.1830], [19.4180, 19.4120, -99.1790, -99.1735],
      [19.3880, 19.3820, -99.1600, -99.1530], [19.3730, 19.3640, -99.1880, -99.1790],
      [19.3470, 19.3390, -99.1700, -99.1590], [19.4010, 19.3960, -99.1560, -99.1500],
      [19.3330, 19.3180, -99.2000, -99.1700],
    ].map(([n, s, w, e]) => `<rect x="${lngX(w).toFixed(1)}" y="${latY(n).toFixed(1)}" width="${(lngX(e) - lngX(w)).toFixed(1)}" height="${(latY(s) - latY(n)).toFixed(1)}" rx="6"/>`).join('');

    host.innerHTML = `
      <div class="demo">
        <div class="world" style="width:${W}px;height:${H}px">
          <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
            <rect width="${W}" height="${H}" fill="#ECEEE8"/>
            <g fill="#D7E7CF">${parks}</g>
            <path d="${minor}" stroke="#F6F7F3" stroke-width="1.2" vector-effect="non-scaling-stroke" fill="none"/>
            <path d="${major}" stroke="#FFFFFF" stroke-width="3.2" vector-effect="non-scaling-stroke" fill="none"/>
            <path d="${avenue}" stroke="#FFFFFF" stroke-width="6" vector-effect="non-scaling-stroke" fill="none"/>
            <polyline class="route-casing" points=""/>
            <polyline class="route-main" points=""/>
          </svg>
          <div class="pinlayer"></div>
        </div>
      </div>`;
    const world = host.querySelector('.world');
    const layer = host.querySelector('.pinlayer');
    const casing = host.querySelector('.route-casing');
    const main = host.querySelector('.route-main');
    const anchors = new Map();
    let first = true;
    let onCand = () => {};

    return {
      setRoute(path) {
        const pts = path.map((p) => { const q = px(p); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(' ');
        casing.setAttribute('points', pts);
        main.setAttribute('points', pts);
        if (D && !first) gsap.fromTo([casing, main], { opacity: 0.35 }, { opacity: 1, duration: 0.3 * D, ease: 'power2.out' });
      },
      setPins(list) {
        const keep = new Set(list.map((p) => p.key));
        anchors.forEach((a, key) => {
          if (keep.has(key)) return;
          anchors.delete(key);
          if (D) gsap.to(a.firstChild, { opacity: 0, duration: 0.16, onComplete: () => a.remove() });
          else a.remove();
        });
        list.forEach((p) => {
          let a = anchors.get(p.key);
          const sig = JSON.stringify([p.type, p.label, p.active, p.cost]);
          if (!a) {
            a = document.createElement('div');
            a.className = 'pin-anchor' + (p.type === 'dest' ? ' is-tip' : '');
            anchors.set(p.key, a);
            layer.appendChild(a);
            a.appendChild(pinEl(p));
            if (D && !first) gsap.from(a.firstChild, { opacity: 0, duration: 0.24, ease: 'power2.out' });
          } else if (a.dataset.sig !== sig) {
            const fresh = pinEl(p);
            a.replaceChildren(fresh);
          }
          a.dataset.sig = sig;
          a.style.zIndex = p.type === 'cand' ? (p.active ? 6 : 3) : p.type === 'stop' ? 5 : 4;
          const q = px(p.pos);
          a.style.left = q.x + 'px';
          a.style.top = q.y + 'px';
          if (p.type === 'cand') a.firstChild.onclick = () => onCand(p.id);
        });
      },
      fit(points, pad) {
        const vw = host.clientWidth, vh = host.clientHeight;
        const ps = points.map(px);
        const minX = Math.min(...ps.map((p) => p.x)), maxX = Math.max(...ps.map((p) => p.x));
        const minY = Math.min(...ps.map((p) => p.y)), maxY = Math.max(...ps.map((p) => p.y));
        const aw = Math.max(40, vw - pad.left - pad.right), ah = Math.max(40, vh - pad.top - pad.bottom);
        const s = Math.max(0.25, Math.min(3, Math.min(aw / Math.max(1, maxX - minX), ah / Math.max(1, maxY - minY))));
        const tx = pad.left + (aw - (maxX - minX) * s) / 2 - minX * s;
        const ty = pad.top + (ah - (maxY - minY) * s) / 2 - minY * s;
        if (first || !D) world.style.transition = 'none';
        world.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`;
        world.style.setProperty('--inv', (1 / s).toFixed(4));
        if (first || !D) { world.getBoundingClientRect(); world.style.transition = ''; }
        first = false;
      },
      setActive(id) {
        layer.querySelectorAll('.pin-cand').forEach((el) => el.classList.remove('is-active'));
        const a = anchors.get('c:' + id);
        if (a) { a.firstChild.classList.add('is-active'); a.style.zIndex = 6; }
      },
      onCandidate(fn) { onCand = fn; },
    };
  }

  /* ---------------- Google map ---------------- */
  function loadGoogle() {
    return new Promise((resolve, reject) => {
      if (window.google?.maps?.importLibrary) return resolve();
      const timer = setTimeout(() => reject(new Error('Google Maps took too long to load')), 15000);
      window.__lab2MapsReady = () => { clearTimeout(timer); resolve(); };
      const q = new URLSearchParams({ key: cfg.apiKey, v: 'weekly', loading: 'async', callback: '__lab2MapsReady', language: lang, region: cfg.region || 'MX' });
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?' + q.toString();
      s.async = true;
      s.onerror = () => { clearTimeout(timer); reject(new Error('Google Maps script failed to load')); };
      document.head.appendChild(s);
    });
  }

  async function createGoogleMap(host) {
    await loadGoogle();
    const { Map: GMap, Polyline } = await google.maps.importLibrary('maps');
    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
    const map = new GMap(host, {
      center: state.origin.pos,
      zoom: 13,
      mapId: cfg.mapId || 'DEMO_MAP_ID',
      disableDefaultUI: true,
      clickableIcons: false,
      gestureHandling: 'greedy',
    });
    const casing = new Polyline({ map, strokeColor: '#1546A8', strokeWeight: 8, strokeOpacity: 1, zIndex: 1, clickable: false });
    const main = new Polyline({ map, strokeColor: '#1D5BD8', strokeWeight: 5, strokeOpacity: 1, zIndex: 2, clickable: false });
    const markers = new Map();
    let onCand = () => {};
    return {
      setRoute(path) { casing.setPath(path); main.setPath(path); },
      setPins(list) {
        const keep = new Set(list.map((p) => p.key));
        markers.forEach((m, key) => { if (!keep.has(key)) { m.marker.map = null; markers.delete(key); } });
        list.forEach((p) => {
          const sig = JSON.stringify([p.type, p.label, p.active, p.cost, p.pos]);
          const have = markers.get(p.key);
          if (have && have.sig === sig) return;
          if (have) have.marker.map = null;
          const marker = new AdvancedMarkerElement({
            map, position: p.pos, content: pinEl(p),
            zIndex: p.type === 'cand' ? (p.active ? 60 : 30) : p.type === 'stop' ? 50 : 40,
            gmpClickable: p.type === 'cand',
            title: p.name || '',
          });
          if (p.type === 'cand') marker.addEventListener('gmp-click', () => onCand(p.id));
          markers.set(p.key, { marker, sig });
        });
      },
      fit(points, pad) {
        if (!points.length) return;
        const b = boundsOf(points);
        map.fitBounds(b, { top: pad.top, bottom: pad.bottom, left: pad.left, right: pad.right });
      },
      setActive(id) {
        markers.forEach((m, key) => {
          if (!key.startsWith('c:')) return;
          m.marker.content.classList.toggle('is-active', key === 'c:' + id);
          m.marker.zIndex = key === 'c:' + id ? 60 : 30;
        });
      },
      onCandidate(fn) { onCand = fn; },
    };
  }

  /* ---------------- rendering ---------------- */
  let mapApi = null;
  const badge = $('badge');
  function setBadge(text, live) {
    $('badgeText').textContent = text;
    badge.classList.toggle('is-live', !!live);
  }

  function renderSummary(delta) {
    const r = state.route;
    if (!r) return;
    const mins = Math.max(1, Math.round(r.duration));
    $('etaMin').textContent = mins;
    $('dist').textContent = fmtKm.format(r.distance / 1000) + ' km';
    $('arrive').textContent = fmtTime.format(new Date(now().getTime() + r.duration * 60000));
    $('navEta').textContent = `${mins} min`;
    const n = state.stops.length;
    $('navMeta').textContent = `${fmtKm.format(r.distance / 1000)} km · arrive ${fmtTime.format(new Date(now().getTime() + r.duration * 60000))} · ${n} ${n === 1 ? 'stop' : 'stops'}`;
    const next = state.stops[0] || state.dest;
    $('navTitle').textContent = `Toward ${next.name}`;
    $('navSub').textContent = `${state.stops.length ? 'Stop 1' : 'Destination'} · ${Math.max(1, Math.round(r.legs[0] || r.duration))} min`;
    if (delta !== undefined) showDelta(delta);
  }

  let deltaTimer = 0;
  function showDelta(delta) {
    const el = $('delta');
    clearTimeout(deltaTimer);
    if (!delta) { el.classList.remove('is-on'); return; }
    el.textContent = (delta > 0 ? '+' : '−') + Math.abs(delta) + ' min';
    el.classList.add('is-on');
    if (!STATIC) deltaTimer = setTimeout(() => el.classList.remove('is-on'), 6000);
  }

  // Arrival label per waypoint after the origin. Shows "Updating" while the
  // route still describes the previous list of stops.
  function arrivals() {
    const r = state.route;
    const fresh = r && r.legs.length === state.stops.length + 1;
    const t0 = now().getTime();
    let acc = 0;
    return (i) => {
      if (!fresh) return 'Updating';
      acc += r.legs[i] || 0;
      return 'Arrive ' + fmtTime.format(new Date(t0 + acc * 60000));
    };
  }
  function updateArrivals() {
    const at = arrivals();
    const rows = [...stopsEl.querySelectorAll('.row.is-stop')];
    const dest = stopsEl.querySelector('[data-flip-id="dest"] small');
    rows.forEach((row, i) => {
      const s = state.stops[i];
      const small = row.querySelector('.txt small');
      if (small && s) small.textContent = at(i) + (s.address ? ' · ' + s.address : '');
    });
    if (dest) dest.textContent = at(state.stops.length) + (state.dest.address ? ' · ' + state.dest.address : '');
  }

  function renderStops(animate = true) {
    const arriveAt = arrivals();
    const full = state.stops.length >= MAX_STOPS;
    let html = `<li class="row" data-flip-id="origin"><span class="node o" aria-hidden="true"></span><div class="txt"><b>${esc(state.origin.name)}</b><small>Your start</small></div></li>`;
    state.stops.forEach((s, i) => {
      html += `<li class="row is-stop${s.id === state.newId ? ' is-new' : ''}" data-flip-id="${s.id}" data-id="${s.id}">
        <span class="node n" aria-hidden="true">${i + 1}</span>
        <div class="txt"><b>${esc(s.name)}</b><small>${arriveAt(i)}${s.address ? ' · ' + esc(s.address) : ''}</small></div>
        <button class="row-btn" type="button" data-remove="${s.id}" aria-label="Remove ${esc(s.name)}">${ICON('close')}</button>
        <button class="row-btn handle" type="button" data-handle="${s.id}" aria-label="Reorder ${esc(s.name)}. Drag, or use the arrow keys.">${ICON('drag_indicator')}</button>
      </li>`;
    });
    html += `<li class="add-row" data-flip-id="add"><button class="add-btn" type="button" id="addBtn"${full ? ' disabled' : ''}>
        <span class="node plus" aria-hidden="true">${ICON('add')}</span>
        <span><b>Add stop</b><small>${full ? 'Up to 9 stops per route' : 'Gas, coffee, food on the way'}</small></span>
      </button></li>`;
    html += `<li class="row" data-flip-id="dest"><span class="node d" aria-hidden="true"><svg><use href="assets/icons.svg#i-location_on-f"/></svg></span><div class="txt"><b>${esc(state.dest.name)}</b><small>${arriveAt(state.stops.length)}${state.dest.address ? ' · ' + esc(state.dest.address) : ''}</small></div></li>`;

    const flipState = animate && D ? Flip.getState(stopsEl.querySelectorAll('[data-flip-id]')) : null;
    stopsEl.innerHTML = html;
    if (flipState) {
      Flip.from(flipState, {
        targets: stopsEl.querySelectorAll('[data-flip-id]'),
        duration: 0.32 * D,
        ease: 'power3.out',
        onEnter: (els) => gsap.fromTo(els, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.28 * D, ease: 'power3.out' }),
      });
    }
    if (state.newId) {
      const id = state.newId;
      state.newId = null;
      if (!STATIC) setTimeout(() => stopsEl.querySelector(`[data-id="${id}"]`)?.classList.remove('is-new'), 1400);
    }
  }

  function renderChips() {
    $('chips').innerHTML = CATS.map((c) => `<button class="chip" type="button" role="radio" aria-checked="${!state.query && c.id === state.cat}" data-cat="${c.id}">${ICON(c.icon)}${c.label}</button>`).join('');
  }

  function renderResults(kind) {
    const label = $('listLabel');
    if (kind === 'loading') {
      resultsEl.setAttribute('aria-busy', 'true');
      resultsEl.innerHTML = '<li class="skel"><i></i><span><i></i><i></i></span></li>'.repeat(3);
      return;
    }
    resultsEl.removeAttribute('aria-busy');
    label.textContent = state.query ? `Results for “${state.query}”` : `${catById[state.cat].label} along your route · least added time first`;
    if (kind === 'error') {
      resultsEl.innerHTML = `<li class="state-msg"><b>Places search is not available.</b>Check that Places API (New) is enabled for this key, or try again.</li>`;
      return;
    }
    if (!state.results.length) {
      resultsEl.innerHTML = `<li class="state-msg"><b>Nothing on the way${state.query ? ' for “' + esc(state.query) + '”' : ''}.</b>Try another word or pick a category.</li>`;
      return;
    }
    resultsEl.innerHTML = state.results.map((p) => {
      const cat = catById[p.cat];
      const off = p.off !== undefined ? ` · ${p.off < 100 ? 'on route' : fmtKm.format(p.off / 1000) + ' km off'}` : '';
      const cost = p.cost != null
        ? `<span class="r-cost"><b>+${p.cost}</b><small>min</small></span>`
        : `<span class="r-cost">${ICON('add_circle')}</span>`;
      return `<li><button class="result${p.id === state.activeId ? ' is-active' : ''}" type="button" data-pid="${esc(p.id)}" aria-label="Add ${esc(p.name)}${p.cost != null ? ', ' + p.cost + ' more minutes' : ''}">
        <span class="r-ico">${ICON(cat ? cat.icon : 'location_on')}</span>
        <span class="txt"><b>${esc(p.name)}</b><small>${esc(p.address)}${off}</small></span>
        ${cost}
      </button></li>`;
    }).join('');
  }

  function pinsFor() {
    const pins = [{ key: 'o', type: 'origin', pos: state.origin.pos }];
    state.stops.forEach((s, i) => pins.push({ key: 's:' + s.id, type: 'stop', label: String(i + 1), pos: s.pos }));
    pins.push({ key: 'd', type: 'dest', pos: state.dest.pos });
    if (state.view === 'add') {
      state.results.filter((p) => p.pos && p.cost != null).forEach((p) => pins.push({ key: 'c:' + p.id, id: p.id, type: 'cand', cat: p.cat, cost: p.cost, name: p.name, pos: p.pos, active: p.id === state.activeId }));
    }
    return pins;
  }

  function syncMap() {
    if (!mapApi) return;
    if (state.route) mapApi.setRoute(state.route.path);
    mapApi.setPins(pinsFor());
  }

  /* ---------------- layout ---------------- */
  const views = { route: $('viewRoute'), add: $('viewAdd'), nav: $('viewNav') };
  let lastVisible = 0;
  let fitTimer = 0;
  function layout() {
    const appH = app.clientHeight;
    const sheetH = sheet.offsetHeight;
    if (state.view === 'add') {
      const fixed = views.add.offsetHeight - resultsEl.offsetHeight;
      resultsEl.style.setProperty('--results-max', Math.max(150, Math.round(appH * 0.62 - fixed)) + 'px');
    }
    const visible = Math.min(sheetH, 12 + views[state.view].offsetHeight);
    sheet.style.setProperty('--y', Math.max(0, sheetH - visible) + 'px');
    app.style.setProperty('--snack-b', visible + 'px');
    if (Math.abs(visible - lastVisible) > 2) {
      lastVisible = visible;
      clearTimeout(fitTimer);
      fitTimer = setTimeout(fitMap, STATIC ? 0 : 40);
    }
  }
  function fitMap() {
    if (!mapApi) return;
    const pts = (state.route ? state.route.path : waypoints().map((w) => w.pos)).slice();
    waypoints().forEach((w) => pts.push(w.pos));
    if (state.view === 'add') state.results.forEach((p) => p.pos && pts.push(p.pos));
    const top = state.navigating ? 120 : 76;
    mapApi.fit(pts, { top, bottom: lastVisible + 18, left: 36, right: 36 });
  }
  const ro = new ResizeObserver(() => layout());
  Object.values(views).forEach((v) => ro.observe(v));
  ro.observe(app);

  function setView(v) {
    state.view = v;
    app.dataset.view = v;
    app.dataset.nav = state.navigating ? '1' : '0';
    Object.entries(views).forEach(([k, el]) => {
      el.setAttribute('aria-hidden', k === v ? 'false' : 'true');
      el.inert = k !== v;
    });
    syncMap();
    layout();
    fitMap();
  }

  /* ---------------- snackbar + announcements ---------------- */
  let snackTimer = 0;
  let undoFn = null;
  function snack(text, onUndo) {
    $('snackText').textContent = text;
    undoFn = onUndo || null;
    $('undoBtn').hidden = !onUndo;
    $('snack').classList.add('is-on');
    clearTimeout(snackTimer);
    if (!STATIC) snackTimer = setTimeout(() => $('snack').classList.remove('is-on'), 5000);
    announce(text);
  }
  function hideSnack() { $('snack').classList.remove('is-on'); clearTimeout(snackTimer); }
  function announce(t) { $('live').textContent = ''; requestAnimationFrame(() => { $('live').textContent = t; }); }

  /* ---------------- actions ---------------- */
  const snapshot = () => ({ stops: state.stops.slice(), route: state.route });
  function restore(snap, message) {
    const before = state.route?.duration || 0;
    state.stops = snap.stops.slice();
    state.route = snap.route;
    renderStops();
    renderSummary(Math.round(state.route.duration - before));
    syncMap();
    hideSnack();
    announce(message);
  }

  async function openAdd() {
    if (state.stops.length >= MAX_STOPS) return;
    hideSnack();
    state.query = '';
    $('q').value = '';
    renderChips();
    state.results = [];
    setView('add');
    await loadCategory(state.cat);
  }
  function closeAdd() {
    state.activeId = null;
    state.results = [];
    setView(state.navigating ? 'nav' : 'route');
  }

  let searchToken = 0;
  async function loadCategory(catId) {
    state.cat = catId;
    state.query = '';
    renderChips();
    const token = ++searchToken;
    renderResults('loading');
    try {
      const list = await searchCategory(catId);
      if (token !== searchToken) return;
      state.results = list;
      state.activeId = null;
      renderResults();
    } catch (err) {
      console.warn(err);
      if (token !== searchToken) return;
      state.results = [];
      renderResults('error');
    }
    syncMap();
    layout();
    fitMap();
  }

  let typeTimer = 0;
  function onType(q) {
    clearTimeout(typeTimer);
    state.query = q.trim();
    if (!state.query) { loadCategory(state.cat); return; }
    renderChips();
    typeTimer = setTimeout(async () => {
      const token = ++searchToken;
      renderResults('loading');
      try {
        const list = await searchText(state.query);
        if (token !== searchToken) return;
        state.results = list;
        renderResults();
      } catch (err) {
        console.warn(err);
        if (token !== searchToken) return;
        state.results = [];
        renderResults('error');
      }
      syncMap();
      layout();
      fitMap();
    }, state.live ? 260 : 120);
  }

  async function addPlace(p) {
    if (state.stops.length >= MAX_STOPS) return;
    let pos = p.pos, name = p.name, address = p.address;
    if (!pos && p.prediction) {
      try {
        const place = p.prediction.toPlace();
        await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
        sessionToken = null;
        pos = { lat: place.location.lat(), lng: place.location.lng() };
        name = place.displayName || name;
        address = shortAddr(place.formattedAddress) || address;
      } catch (err) {
        console.warn(err);
        snack('That place could not be loaded. Try another one.');
        return;
      }
    }
    const before = snapshot();
    const ins = bestInsert(pos);
    const stop = { id: 's' + ++state.seq, name, address, pos, cat: p.cat };
    state.stops.splice(ins.index, 0, stop);
    state.newId = stop.id;
    state.activeId = null;
    state.results = [];
    const prev = state.route ? state.route.duration : 0;
    setView(state.navigating ? 'nav' : 'route');
    renderStops();
    if (!(await recompute())) return;
    updateArrivals();
    const delta = Math.round(state.route.duration - prev);
    renderSummary(delta);
    syncMap();
    layout();
    fitMap();
    const order = state.stops.indexOf(stop) + 1;
    snack(`${name} added as stop ${order}${delta > 0 ? ` · +${delta} min` : ''}`, () => restore(before, `${name} removed`));
  }

  async function removeStop(id) {
    const s = state.stops.find((x) => x.id === id);
    if (!s) return;
    const before = snapshot();
    const prev = state.route.duration;
    const row = stopsEl.querySelector(`[data-id="${id}"]`);
    if (row && D) await gsap.to(row, { opacity: 0, duration: 0.16, ease: 'power2.out' });
    state.stops = state.stops.filter((x) => x.id !== id);
    renderStops();
    if (!(await recompute())) return;
    updateArrivals();
    const delta = Math.round(state.route.duration - prev);
    renderSummary(delta);
    syncMap();
    fitMap();
    snack(`${s.name} removed${delta < 0 ? ` · ${'−'}${Math.abs(delta)} min` : ''}`, () => restore(before, `${s.name} restored`));
  }

  async function moveStop(from, to) {
    if (from === to || to < 0 || to >= state.stops.length) return false;
    const before = snapshot();
    const prev = state.route.duration;
    const [s] = state.stops.splice(from, 1);
    state.stops.splice(to, 0, s);
    renderStops();
    if (!(await recompute())) return true;
    updateArrivals();
    const delta = Math.round(state.route.duration - prev);
    renderSummary(delta);
    syncMap();
    snack(`${s.name} is now stop ${to + 1}${delta ? ` · ${delta > 0 ? '+' : '−'}${Math.abs(delta)} min` : ''}`, () => restore(before, 'Order restored'));
    return true;
  }

  /* drag to reorder (pointer), arrow keys as the keyboard path */
  function startDrag(e, handle) {
    const li = handle.closest('.row');
    const rows = [...stopsEl.querySelectorAll('.row.is-stop')];
    const idx = rows.indexOf(li);
    if (idx < 0 || rows.length < 2) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const rects = rows.map((r) => r.getBoundingClientRect());
    const h = rects[idx].height;
    const startY = e.clientY;
    let ni = idx;
    li.classList.add('is-dragging');
    rows.forEach((r) => r !== li && r.classList.add('shifting'));
    // A little slack past the first and last slot so the end positions are reachable.
    const minDy = rects[0].top - rects[idx].top - h * 0.4;
    const maxDy = rects[rects.length - 1].top - rects[idx].top + h * 0.4;
    const move = (ev) => {
      const dy = Math.max(minDy, Math.min(maxDy, ev.clientY - startY));
      li.style.transform = `translateY(${dy}px)`;
      const center = rects[idx].top + h / 2 + dy;
      ni = idx;
      rects.forEach((rc, j) => {
        const mid = rc.top + rc.height / 2;
        if (j < idx && center < mid) ni = Math.min(ni, j);
        if (j > idx && center > mid) ni = Math.max(ni, j);
      });
      rows.forEach((r, j) => {
        if (r === li) return;
        let shift = 0;
        if (idx < ni && j > idx && j <= ni) shift = -h;
        if (ni < idx && j >= ni && j < idx) shift = h;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      li.classList.remove('is-dragging');
      if (ni !== idx) {
        moveStop(idx, ni);
      } else {
        rows.forEach((r) => r.classList.remove('shifting'));
        gsap.to(li, { y: 0, duration: 0.2 * D, ease: 'power3.out', clearProps: 'transform' });
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  /* ---------------- events ---------------- */
  stopsEl.addEventListener('click', (e) => {
    const add = e.target.closest('#addBtn');
    if (add) return openAdd();
    const rm = e.target.closest('[data-remove]');
    if (rm) return removeStop(rm.dataset.remove);
  });
  stopsEl.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-handle]');
    if (h && e.button === 0) startDrag(e, h);
  });
  stopsEl.addEventListener('keydown', async (e) => {
    const h = e.target.closest('[data-handle]');
    if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const i = state.stops.findIndex((s) => s.id === h.dataset.handle);
    if (await moveStop(i, i + (e.key === 'ArrowUp' ? -1 : 1))) stopsEl.querySelector(`[data-handle="${h.dataset.handle}"]`)?.focus();
  });

  $('chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]');
    if (!c) return;
    $('q').value = '';
    loadCategory(c.dataset.cat);
  });
  $('q').addEventListener('input', (e) => onType(e.target.value));
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.results[0]) addPlace(state.results[0]);
    if (e.key === 'Escape') closeAdd();
  });
  resultsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pid]');
    if (!b) return;
    const p = state.results.find((x) => x.id === b.dataset.pid);
    if (p) addPlace(p);
  });
  const hoverResult = (e) => {
    const b = e.target.closest('[data-pid]');
    const id = b ? b.dataset.pid : null;
    if (id === state.activeId) return;
    state.activeId = id;
    resultsEl.querySelectorAll('.result').forEach((r) => r.classList.toggle('is-active', r.dataset.pid === id));
    mapApi && mapApi.setActive(id);
  };
  resultsEl.addEventListener('pointerover', hoverResult);
  resultsEl.addEventListener('focusin', hoverResult);

  $('closeAdd').addEventListener('click', closeAdd);
  $('startBtn').addEventListener('click', () => {
    state.navigating = true;
    hideSnack();
    renderSummary();
    setView('nav');
  });
  $('navAdd').addEventListener('click', openAdd);
  $('exitNav').addEventListener('click', () => { state.navigating = false; setView('route'); });
  $('undoBtn').addEventListener('click', () => { if (undoFn) { const f = undoFn; undoFn = null; f(); } });
  document.querySelector('.fab').addEventListener('click', () => {
    if (state.view === 'add') closeAdd();
    else if (state.navigating) { state.navigating = false; setView('route'); }
    else snack('This prototype starts on the route preview.');
  });
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.mode === 'transit') snack('Stops are not available for transit routes. Drive, walk or cycle to add stops.');
    else if (b.dataset.mode === 'walk') snack('This prototype covers driving routes.');
  }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.view === 'add') closeAdd(); });

  /* ---------------- boot ---------------- */
  async function boot() {
    const host = $('map');
    const wantLive = !!cfg.apiKey && !params.has('demo');
    if (wantLive) {
      try {
        window.gm_authFailure = () => switchToDemo('Demo · key rejected');
        mapApi = await createGoogleMap(host);
        state.live = true;
        setBadge('Live map', true);
        badge.title = 'Google Maps Platform: Maps JavaScript API, Places API (New), Routes API';
      } catch (err) {
        console.warn(err);
        mapApi = null;
      }
    }
    if (!mapApi) {
      mapApi = createDemoMap(host);
      setBadge(cfg.apiKey ? 'Demo · Maps did not load' : 'Demo map', false);
      badge.title = 'Schematic map with sample places. Add a Google Maps key in config.js for the live map.';
    }
    mapApi.onCandidate((id) => { const p = state.results.find((x) => x.id === id); if (p) addPlace(p); });

    renderChips();
    await recompute();
    renderStops(false);
    renderSummary();
    setView('route');

    const initial = params.get('state');
    if (initial === 'add') {
      await openAdd();
      if (STATIC && state.results[0]) { state.activeId = state.results[0].id; renderResults(); mapApi.setActive(state.activeId); }
    } else if (initial === 'added' || initial === 'nav') {
      const list = await searchCategory(state.cat).catch(() => []);
      if (list[0]) await addPlace(list[0]);
      if (STATIC) { const r = stopsEl.querySelector('.is-stop'); r && r.classList.add('is-new'); }
      if (initial === 'nav') { state.navigating = true; hideSnack(); renderSummary(); setView('nav'); }
    }
    document.documentElement.dataset.ready = '1';
  }

  async function switchToDemo(text) {
    if (!state.live && mapApi) return;
    state.live = false;
    catCache.clear();
    $('map').replaceChildren();
    mapApi = createDemoMap($('map'));
    mapApi.onCandidate((id) => { const p = state.results.find((x) => x.id === id); if (p) addPlace(p); });
    setBadge(text, false);
    await recompute();
    renderStops(false);
    renderSummary();
    if (state.view === 'add') await loadCategory(state.cat);
    syncMap();
    lastVisible = 0;
    layout();
  }

  boot();
})();
