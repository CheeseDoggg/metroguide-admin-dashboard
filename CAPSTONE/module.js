import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
    import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
  import { getDatabase, ref, onValue, update, get, off } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
  import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-functions.js";

    const firebaseConfig = {
      apiKey: "AIzaSyA0t-0Cq6JQr5PfgdZC8XvmvLvq_E3C088",
      authDomain: "metro-guide-6b52a.firebaseapp.com",
      databaseURL: "https://metro-guide-6b52a-default-rtdb.asia-southeast1.firebasedatabase.app",
      projectId: "metro-guide-6b52a",
      storageBucket: "metro-guide-6b52a.firebasestorage.app",
      messagingSenderId: "389866237139",
      appId: "1:389866237139:web:c08e31880beea53c593826",
      measurementId: "G-7RKQXWNPGL"
    };

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);
  const functions = getFunctions(app, 'asia-southeast1');
  // prevent multiple onValue listeners for SOS when switching tabs
  let sosListenerAttached = false;
  let sosPathSelected = null; // 'sos_logs' or 'sos'
  let sosRefCurrent = null; // current ref used for onValue
  let sosTriedFallback = false; // avoid infinite retries
  let sosPerUserMode = false; // when true, listening under sos_path/<auth.uid>
  let sosTriedFunctionFallback = false; // try callable only once
  // prevent multiple onValue listeners for History
  let historyRefCurrent = null; // current ref used for history onValue
  // current admin state
  let isAdmin = false;
  // Attempt to resolve admin status from several possible locations
  async function refreshAdminStatus(user) {
    isAdmin = false;
    if (!user) return;
    const uid = user.uid;
    try {
      // 1. Check users/<uid>/role === 'admin'
      const userRoleSnap = await get(ref(db, `users/${uid}/role`));
      if (userRoleSnap.exists() && String(userRoleSnap.val()).toLowerCase() === 'admin') {
        isAdmin = true;
        return;
      }
    } catch(_) {}
    try {
      // 2. Check admins/<uid> exists (boolean true)
      const adminFlagSnap = await get(ref(db, `admins/${uid}`));
      if (adminFlagSnap.exists()) { isAdmin = true; return; }
    } catch(_) {}
    try {
      // 3. Allowlist by email
      const allow = ['metroguidenu@gmail.com'];
      if (user.email && allow.includes(user.email.toLowerCase())) { isAdmin = true; return; }
    } catch(_) {}
  }

  // Auth state listener
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      console.log('[Auth] No user signed in. Redirect to login?');
      // window.location.href = 'login.html'; // uncomment if desired
      return;
    }
    await refreshAdminStatus(user);
    console.log('[Auth] User logged in, admin =', isAdmin);
    // Show/hide admin badge
    const badge = document.getElementById('adminBadge');
    if (badge) badge.style.display = isAdmin ? 'inline-block' : 'none';
    // Default load incidents tab
    loadReports();
    loadVehicleReports(); // optional pre-load
  });

  // Logout button wiring (if present)
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try { await signOut(auth); } catch(e) { console.warn('Sign out failed', e); }
      window.location.href = 'login.html';
    });
  }
  let latestIncidents = [];
  // Incident filtering & pagination state
  let incidentFiltered = [];
  let incidentCurrentPage = 1;
  let incidentPageSize = 50;

  // Utility: render incident table (active incidents)
  function renderIncidentTable(list) {
    const reportsTable = document.getElementById('reportsTable');
    if (!reportsTable) return;
    // Header
    reportsTable.innerHTML = `
      <tr>
        <th>Location</th>
        <th>Description</th>
        <th>Category</th>
        <th>Email</th>
        <th>Username</th>
        <th>Timestamp</th>
        <th>Status</th>
        <th>Image</th>
        <th>Actions</th>
      </tr>`;

    if (!list.length) {
      reportsTable.innerHTML += `<tr><td colspan='9'>No reports found.</td></tr>`;
      return;
    }

    // Pagination slice
    const startIdx = (incidentCurrentPage - 1) * incidentPageSize;
    const paginated = list.slice(startIdx, startIdx + incidentPageSize);
    paginated.forEach(({userId, incidentId, data, tsNum}) => {
      let tsDisplay = 'N/A';
      if (Number.isFinite(tsNum)) tsDisplay = new Date(tsNum).toLocaleString();
      else if (data.timestamp) {
        const d = new Date(data.timestamp);
        if (!isNaN(d.getTime())) tsDisplay = d.toLocaleString();
      }
      const row = document.createElement('tr');
      const imageHtml = buildImageCell(data.imagefile, `incidents/${userId}/${incidentId}`);
      row.innerHTML = `
        <td>${data.address || 'Unknown'}</td>
        <td class="description-cell">${data.description || 'No description'}</td>
        <td>${data.category || 'N/A'}</td>
        <td>${data.email || 'N/A'}</td>
        <td>${data.username || 'N/A'}</td>
        <td>${tsDisplay}</td>
        <td>${data.rdInc_status || 'Pending'}</td>
        <td>${imageHtml}</td>
        <td>
          <button class="btn btn-verify" data-user="${userId}" data-key="${incidentId}" ${!isAdmin ? 'disabled title="Admins only"' : ''}>Verify</button>
          <button class="btn btn-reject" data-user="${userId}" data-key="${incidentId}" ${!isAdmin ? 'disabled title="Admins only"' : ''}>Reject</button>
        </td>`;
      reportsTable.appendChild(row);
    });

    // Wire moderation buttons
    document.querySelectorAll('.btn-verify').forEach(btn => {
      btn.addEventListener('click', () => updateStatus(btn.dataset.user, btn.dataset.key, 'Verified'));
    });
    document.querySelectorAll('.btn-reject').forEach(btn => {
      btn.addEventListener('click', () => updateStatus(btn.dataset.user, btn.dataset.key, 'Rejected'));
    });

    // Page info UI
    const info = document.getElementById('incPageInfo');
    if (info) {
      const total = list.length;
      const start = total ? startIdx + 1 : 0;
      const end = Math.min(startIdx + incidentPageSize, total);
      info.textContent = `${start}-${end} of ${total}`;
    }
  }

  // Update category dropdown based on latestIncidents
  function refreshIncidentCategories() {
    const select = document.getElementById('incidentCategoryFilter');
    if (!select) return;
    const prevVal = select.value; // try to preserve selection
    const cats = new Set();
    latestIncidents.forEach(it => {
      const c = (it.data?.category || '').trim();
      if (c) cats.add(c);
    });
    const sorted = Array.from(cats).sort((a,b)=> a.localeCompare(b));
    select.innerHTML = '<option value="">All Categories</option>' + sorted.map(c => `<option value="${c}">${c}</option>`).join('');
    // Restore previous selection if still present
    if (prevVal && (prevVal === '' || cats.has(prevVal))) {
      select.value = prevVal;
    }
  }

  // Apply filters (category + search) to latestIncidents and re-render
  function applyIncidentFilters() {
    const categorySel = document.getElementById('incidentCategoryFilter');
    const searchInput = document.getElementById('incidentSearch');
    const statusSpan = document.getElementById('incidentStatus');
    const cat = (categorySel?.value || '').trim();
    const qRaw = (searchInput?.value || '').trim().toLowerCase();
    incidentFiltered = latestIncidents.filter(it => {
      if (cat && (it.data?.category || '').trim() !== cat) return false;
      if (qRaw) {
        const hay = [it.data?.description, it.data?.email, it.data?.category, it.data?.address, it.data?.username]
          .map(v => (v || '').toString().toLowerCase())
          .join(' | ');
        if (!hay.includes(qRaw)) return false;
      }
      return true;
    });
    incidentCurrentPage = 1; // reset to first page when filters change
    renderIncidentTable(incidentFiltered);
    if (statusSpan) statusSpan.textContent = `Showing ${incidentFiltered.length} / ${latestIncidents.length} active`; 
  }

  // Pagination control listeners
  function wireIncidentControlsOnce() {
    if (window.__incidentControlsWired) return; // idempotent
    window.__incidentControlsWired = true;
    const categorySel = document.getElementById('incidentCategoryFilter');
    const searchInput = document.getElementById('incidentSearch');
    const prevBtn = document.getElementById('incPrevPage');
    const nextBtn = document.getElementById('incNextPage');
    const pageSizeSel = document.getElementById('incPageSize');
    if (categorySel) categorySel.addEventListener('change', () => applyIncidentFilters());
    if (searchInput) {
      let t;
      searchInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(applyIncidentFilters, 250); });
    }
    if (pageSizeSel) pageSizeSel.addEventListener('change', () => {
      incidentPageSize = Number(pageSizeSel.value) || 50;
      incidentCurrentPage = 1;
      renderIncidentTable(incidentFiltered);
    });
    if (prevBtn) prevBtn.addEventListener('click', () => {
      if (incidentCurrentPage > 1) {
        incidentCurrentPage--;
        renderIncidentTable(incidentFiltered);
      }
    });
    if (nextBtn) nextBtn.addEventListener('click', () => {
      const maxPage = Math.ceil(incidentFiltered.length / incidentPageSize) || 1;
      if (incidentCurrentPage < maxPage) {
        incidentCurrentPage++;
        renderIncidentTable(incidentFiltered);
      }
    });
  }

  // Load active (non-verified/non-rejected/non-deleted) incident reports
  function loadReports() {
    const reportsTable = document.getElementById('reportsTable');
    if (!reportsTable) return;
    reportsTable.innerHTML = `
      <tr>
        <th>Location</th>
        <th>Description</th>
        <th>Category</th>
        <th>Email</th>
        <th>Username</th>
        <th>Timestamp</th>
        <th>Status</th>
        <th>Image</th>
        <th>Actions</th>
      </tr>`;

    const reportsRef = ref(db, 'incidents');
  onValue(reportsRef, (snapshot) => {
      reportsTable.innerHTML = `
        <tr>
          <th>Location</th>
          <th>Description</th>
          <th>Category</th>
          <th>Email</th>
          <th>Username</th>
          <th>Timestamp</th>
          <th>Status</th>
          <th>Image</th>
          <th>Actions</th>
        </tr>`;
      const statusSpan = document.getElementById('incidentStatus');
      if (!snapshot.exists()) {
        latestIncidents = [];
        incidentFiltered = [];
        renderIncidentTable([]);
        renderClusters([]);
        if (statusSpan) statusSpan.textContent = 'No active reports.';
        return;
      }
      const incidents = [];
      snapshot.forEach(userSnap => {
        const userId = userSnap.key;
        userSnap.forEach(incidentSnap => {
          const data = incidentSnap.val() || {};
            const incidentId = incidentSnap.key;
            const status = String(data.rdInc_status || '').toLowerCase();
            if (status === 'deleted' || status === 'verified' || status === 'rejected') return; // skip non-active
            const tsNum = pickTimestamp(data);
            const lat = pickLat(data);
            const lng = pickLng(data);
            incidents.push({ userId, incidentId, data, tsNum, lat, lng });
        });
      });
      incidents.sort((a,b)=> (Number.isFinite(b.tsNum)?b.tsNum:-Infinity) - (Number.isFinite(a.tsNum)?a.tsNum:-Infinity));
      latestIncidents = incidents;
      refreshIncidentCategories();
      wireIncidentControlsOnce();
      applyIncidentFilters();
      // Clusters still based on full active set (not filtered) for broader pattern insight
      const epsMeters = validNumberOrDefault(document.getElementById('clusterRadius')?.value, 200);
      const minPts = Math.max(2, Math.floor(validNumberOrDefault(document.getElementById('clusterMinPts')?.value, 2)));
      const timeWindowMin = Math.max(1, Math.floor(validNumberOrDefault(document.getElementById('clusterTimeWindow')?.value, 120)));
      const sameDateOnly = !!document.getElementById('clusterSameDate')?.checked;
      const clusters = clusterIncidents(latestIncidents, epsMeters, minPts, timeWindowMin * 60000, sameDateOnly);
      const pts = countValidCoord(latestIncidents);
      const withTs = latestIncidents.reduce((a, it) => a + (Number.isFinite(it.tsNum) ? 1 : 0), 0);
      const withCat = latestIncidents.reduce((a, it) => a + (it.data?.category ? 1 : 0), 0);
      console.log(`[Clusters] initial: points=${pts} withTs=${withTs} withCategory=${withCat} clusters=${clusters.length} eps=${epsMeters} minPts=${minPts} timeWindowMin=${timeWindowMin} sameDateOnly=${sameDateOnly}`);
      renderClusters(clusters, pts);
    });
  }

    // Recompute clusters on demand
    document.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'clusterRecompute') {
        const epsMeters = validNumberOrDefault(document.getElementById('clusterRadius')?.value, 200);
        const minPts = Math.max(2, Math.floor(validNumberOrDefault(document.getElementById('clusterMinPts')?.value, 2)));
        const timeWindowMin = Math.max(1, Math.floor(validNumberOrDefault(document.getElementById('clusterTimeWindow')?.value, 120)));
        const sameDateOnly = !!document.getElementById('clusterSameDate')?.checked;
        const clusters = clusterIncidents(latestIncidents, epsMeters, minPts, timeWindowMin * 60000, sameDateOnly);
        const pts = countValidCoord(latestIncidents);
        console.log(`[Clusters] recompute: points=${pts} clusters=${clusters.length} eps=${epsMeters} minPts=${minPts} timeWindowMin=${timeWindowMin} sameDateOnly=${sameDateOnly}`);
        renderClusters(clusters, pts);
      }
    });

    // Helpers to extract coordinates from data with different schemas
    function toNum(n) {
      const v = Number(n);
      return Number.isFinite(v) ? v : null;
    }
    function parseLatLngString(s) {
      if (!s || typeof s !== 'string') return { lat: null, lng: null };
      const parts = s.split(/[ ,]+/).filter(Boolean);
      if (parts.length < 2) return { lat: null, lng: null };
      return { lat: toNum(parts[0]), lng: toNum(parts[1]) };
    }
    function pickLat(d) {
      if (!d) return null;
      // Combined string/object latlng fields
      if (typeof d.latlng === 'string') { const p = parseLatLngString(d.latlng); if (p.lat != null) return p.lat; }
      if (typeof d.latLng === 'string') { const p = parseLatLngString(d.latLng); if (p.lat != null) return p.lat; }
      if (typeof d.LatLng === 'string') { const p = parseLatLngString(d.LatLng); if (p.lat != null) return p.lat; }
      if (d.latlng && typeof d.latlng === 'object') { const v = toNum(d.latlng.lat ?? d.latlng.latitude); if (v != null) return v; }
      if (d.latLng && typeof d.latLng === 'object') { const v = toNum(d.latLng.lat ?? d.latLng.latitude); if (v != null) return v; }
      if (d.LatLng && typeof d.LatLng === 'object') { const v = toNum(d.LatLng.lat ?? d.LatLng.latitude); if (v != null) return v; }
      const cands = [
        d.lat, d.latitude, d.Latitude, d.LAT, d.Lat, d.LATITUDE,
        d.location?.lat, d.location?.latitude,
        d.coords?.lat, d.coords?.latitude,
        d.coord?.lat, d.coord?.latitude,
        d.position?.lat, d.position?.latitude,
        d.geo?.lat, d.geo?.latitude,
        d.gps_lat, d.gpsLat, d.gpsLatitude,
        d.latLong?.lat, d.latlong?.lat, d.LatLong?.lat
      ];
      for (const c of cands) { const v = toNum(c); if (v != null) return v; }
      return null;
    }
    function pickLng(d) {
      if (!d) return null;
      // Combined string/object latlng fields
      if (typeof d.latlng === 'string') { const p = parseLatLngString(d.latlng); if (p.lng != null) return p.lng; }
      if (typeof d.latLng === 'string') { const p = parseLatLngString(d.latLng); if (p.lng != null) return p.lng; }
      if (typeof d.LatLng === 'string') { const p = parseLatLngString(d.LatLng); if (p.lng != null) return p.lng; }
      if (d.latlng && typeof d.latlng === 'object') { const v = toNum(d.latlng.lng ?? d.latlng.longitude); if (v != null) return v; }
      if (d.latLng && typeof d.latLng === 'object') { const v = toNum(d.latLng.lng ?? d.latLng.longitude); if (v != null) return v; }
      if (d.LatLng && typeof d.LatLng === 'object') { const v = toNum(d.LatLng.lng ?? d.LatLng.longitude); if (v != null) return v; }
      const cands = [
        d.lng, d.longitude, d.Longitude, d.LNG, d.lon, d.Lon, d.LONGITUDE,
        d.location?.lng, d.location?.longitude,
        d.coords?.lng, d.coords?.longitude,
        d.coord?.lng, d.coord?.longitude,
        d.position?.lng, d.position?.longitude,
        d.geo?.lng, d.geo?.longitude,
        d.gps_lng, d.gpsLng, d.gpsLongitude,
        d.latLong?.lng, d.latlong?.lng, d.LatLong?.lng,
        d.longtitude, d.Longtitude
      ];
      for (const c of cands) { const v = toNum(c); if (v != null) return v; }
      return null;
    }

    // Timestamp helpers
    function pickTimestamp(d) {
      if (!d) return null;
      const tryNum = (x) => {
        const n = Number(x);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n < 1e12 ? n * 1000 : n;
      };
      // Direct candidates (numeric or string)
      const direct = [d.ts, d.time, d.timestamp, d.createdAt, d.updatedAt, d.incidentTime, d.reportTime];
      for (const c of direct) {
        if (typeof c === 'number' || typeof c === 'string') {
          const n = tryNum(c);
          if (n != null) return n;
          if (typeof c === 'string') {
            const parsed = Date.parse(c);
            if (!Number.isNaN(parsed)) return parsed;
          }
        }
      }
      // Firestore-like
      const fs = d.timestamp || d.createdAt || d.updatedAt;
      if (fs && typeof fs === 'object') {
        if (typeof fs.seconds === 'number') return fs.seconds * 1000;
        if (typeof fs._seconds === 'number') return fs._seconds * 1000;
      }
      // Separate date/time strings
      if (d.date && d.time) {
        const parsed = Date.parse(`${d.date} ${d.time}`);
        if (!Number.isNaN(parsed)) return parsed;
      }
      if (d.date) {
        const parsed = Date.parse(d.date);
        if (!Number.isNaN(parsed)) return parsed;
      }
      return null;
    }

    function ymdKey(ms) {
      const dt = new Date(ms);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const d = String(dt.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    // Haversine distance (meters)
    function haversineMeters(lat1, lon1, lat2, lon2) {
      const R = 6371000; // Earth radius in meters
      const toRad = (x) => x * Math.PI / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    }

    // Simple DBSCAN-like clustering for proximity
    function clusterIncidents(items, epsMeters = 200, minPts = 2, timeWindowMs = 120 * 60000, sameDateOnly = true) {
      const points = items
        .map((it, idx) => ({
          idx, it,
          lat: it.lat, lng: it.lng,
          ts: Number.isFinite(it.tsNum) ? it.tsNum : null,
          cat: (it.data?.category || '').toString().trim().toLowerCase(),
          dateKey: Number.isFinite(it.tsNum) ? ymdKey(it.tsNum) : null
        }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      const n = points.length;
      if (n === 0) return [];

      const visited = new Array(n).fill(false);
      const assigned = new Array(n).fill(false);
      const clusters = [];

      function regionQuery(i) {
        const res = [];
        const a = points[i];
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const b = points[j];
          // spatial check
          const dist = haversineMeters(a.lat, a.lng, b.lat, b.lng);
          if (dist > epsMeters) continue;
          // category similarity (require exact match, non-empty)
          if (!a.cat || !b.cat || a.cat !== b.cat) continue;
          // time proximity
          if (a.ts == null || b.ts == null) continue;
          if (Math.abs(a.ts - b.ts) > timeWindowMs) continue;
          // same date requirement
          if (sameDateOnly) {
            if (!a.dateKey || !b.dateKey || a.dateKey !== b.dateKey) continue;
          }
          res.push(j);
        }
        return res;
      }

      for (let i = 0; i < n; i++) {
        if (visited[i]) continue;
        visited[i] = true;
        const neighbors = regionQuery(i);
        if (neighbors.length + 1 < minPts) {
          continue; // noise or singleton below threshold
        }
        const clusterIdxs = new Set([i, ...neighbors]);
        const queue = [...neighbors];
        while (queue.length) {
          const q = queue.shift();
          if (!visited[q]) {
            visited[q] = true;
            const nbs = regionQuery(q);
            if (nbs.length + 1 >= minPts) {
              for (const nb of nbs) if (!clusterIdxs.has(nb)) { clusterIdxs.add(nb); queue.push(nb); }
            }
          }
        }
        // mark assigned
        clusterIdxs.forEach(idx => assigned[idx] = true);

        // build cluster summary
        const members = Array.from(clusterIdxs).map(k => points[k].it);
        const center = computeCentroid(members);
        clusters.push({ size: members.length, center, members });
      }

      // sort clusters by size desc
      clusters.sort((a, b) => b.size - a.size);
      return clusters;
    }

    function computeCentroid(members) {
      if (!members.length) return { lat: null, lng: null };
      let slat = 0, slng = 0, c = 0;
      for (const m of members) {
        if (Number.isFinite(m.lat) && Number.isFinite(m.lng)) { slat += m.lat; slng += m.lng; c++; }
      }
      return c ? { lat: slat / c, lng: slng / c } : { lat: null, lng: null };
    }

    function validNumberOrDefault(v, def) {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : def;
    }

    function countValidCoord(items) {
      if (!Array.isArray(items)) return 0;
      return items.reduce((acc, it) => acc + (Number.isFinite(it.lat) && Number.isFinite(it.lng) ? 1 : 0), 0);
    }

    // Render clusters table with expandable rows
    function renderClusters(clusters, pointsWithCoords = undefined) {
      const table = document.getElementById('clustersTable');
      if (!table) return;
      table.innerHTML = `
        <tr>
          <th>#</th>
          <th>Reports</th>
          <th>Center (lat, lng)</th>
          <th>Top categories</th>
          <th>Top locations</th>
          <th>Most recent</th>
          <th>Actions</th>
        </tr>`;
      if (!clusters || clusters.length === 0) {
        const pts = (pointsWithCoords == null) ? countValidCoord(latestIncidents) : pointsWithCoords;
        table.innerHTML += `<tr><td colspan="7">No clusters found. ${pts} report(s) have coordinates. Try increasing Radius or lowering Min reports, then click Recompute.</td></tr>`;
        return;
      }
      // sort clusters by newest member timestamp desc, then by size desc
      const clustersWithNewest = clusters.map(cl => {
        let newest = -Infinity;
        for (const m of cl.members) {
          if (Number.isFinite(m.tsNum) && m.tsNum > newest) newest = m.tsNum;
        }
        return { ...cl, _newestTs: newest };
      }).sort((a, b) => {
        const d = (b._newestTs - a._newestTs);
        if (d !== 0 && Number.isFinite(d)) return d;
        return b.size - a.size;
      });

      clustersWithNewest.forEach((cl, idx) => {
        const topCats = topN(cl.members.map(m => (m.data?.category || 'N/A')), 2).join(', ');
        const topLocs = topN(cl.members.map(m => (m.data?.address || 'Unknown')), 2).join(', ');
        const centerText = (Number.isFinite(cl.center.lat) && Number.isFinite(cl.center.lng)) ? `${cl.center.lat.toFixed(5)}, ${cl.center.lng.toFixed(5)}` : 'N/A';
        const newestText = Number.isFinite(cl._newestTs) && cl._newestTs > 0 ? new Date(cl._newestTs).toLocaleString() : 'N/A';
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${idx + 1}</td>
          <td>${cl.size}</td>
          <td>${centerText}</td>
          <td>${topCats}</td>
          <td>${topLocs}</td>
          <td>${newestText}</td>
          <td>
            <button class="btn" data-expands="cluster-${idx}">View</button>
          </td>`;
        table.appendChild(row);

        const detail = document.createElement('tr');
        detail.id = `cluster-${idx}`;
        detail.style.display = 'none';
        const membersHtml = cl.members
          .slice()
          .sort((a, b) => {
            const aT = Number.isFinite(a.tsNum) ? a.tsNum : -Infinity;
            const bT = Number.isFinite(b.tsNum) ? b.tsNum : -Infinity;
            return bT - aT;
          })
          .map(m => {
          const when = Number.isFinite(m.tsNum) ? new Date(m.tsNum).toLocaleString() : (m.data?.timestamp || 'N/A');
          return `<li>
            <strong>${m.data?.category || 'N/A'}</strong> - ${m.data?.address || 'Unknown'}
            <br/><small>${when}</small>
          </li>`;
        }).join('');
        detail.innerHTML = `<td colspan="7"><ul style="margin:0; padding-left:18px;">${membersHtml}</ul></td>`;
        table.appendChild(detail);
      });

      // wire expand/collapse
      table.querySelectorAll('button[data-expands]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-expands');
          const tr = document.getElementById(id);
          if (!tr) return;
          tr.style.display = (tr.style.display === 'none') ? '' : 'none';
        });
      });
    }

    function topN(arr, n = 2) {
      const freq = new Map();
      for (const v of arr) freq.set(v, (freq.get(v) || 0) + 1);
      return Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k]) => k);
    }

  async function updateStatus(reportId, newStatus) {
      // Accept userId and incidentId for nested structure
      const userId = arguments[0];
      const incidentId = arguments[1];
      const status = arguments[2];
      if (!isAdmin) {
        alert("You do not have permission to perform this action.");
        return;
      }
      // Preferred: use callable Cloud Function to bypass client rules safely
      try {
        const moderateIncident = httpsCallable(functions, 'moderateIncident');
        await moderateIncident({ userId, incidentId, status });
        alert(`Report marked as ${status}`);
        return;
      } catch (fnErr) {
        console.warn('[Verify] callable function failed, falling back to direct write', fnErr);
      }
      // Fallback: direct DB update attempts (may fail due to rules)
      const reportRef = ref(db, `incidents/${userId}/${incidentId}`);
      update(reportRef, { rdInc_status: status })
        .then(() => alert(`Report marked as ${status}`))
        .catch((error) => {
          const extended = {
            rdInc_status: status,
            verifiedBy: auth.currentUser ? auth.currentUser.uid : null,
            verifiedAt: Date.now()
          };
          update(reportRef, extended)
            .then(() => alert(`Report marked as ${status}`))
            .catch((err2) => {
              console.error('[Verify] all client attempts failed', err2);
              alert("Permission denied by database rules. Your account may not be authorized to update this report.");
            });
        });
    }

    // 🚨 Verified History
    function loadHistory() {
      // Detach any existing listener to avoid duplicates
      if (historyRefCurrent) {
        try { off(historyRefCurrent); } catch (_) {}
      }
      historyRefCurrent = ref(db, 'incidents');
      onValue(historyRefCurrent, (snapshot) => {
        const historyTable = document.getElementById('historyTable');
        // Header
        historyTable.innerHTML = `
          <tr>
            <th>Location</th>
            <th>Description</th>
            <th>Category</th>
            <th>Email</th>
            <th>Username</th>
            <th>Timestamp</th>
            <th>Status</th>
            <th>Image</th>
            <th>Actions</th>
          </tr>`;
        if (!snapshot.exists()) {
          historyTable.innerHTML += "<tr><td colspan='9'>No verified reports found.</td></tr>";
          return;
        }

        // Collect nested incidents and filter Verified and Rejected
        const historyReports = [];
        snapshot.forEach((userSnap) => {
          const userId = userSnap.key;
          userSnap.forEach((incidentSnap) => {
            const data = incidentSnap.val() || {};
            const incidentId = incidentSnap.key;
            const status = String(data.rdInc_status || '').toLowerCase();
            if (status === 'verified' || status === 'rejected') {
              const tsNum = pickTimestamp(data);
              historyReports.push({ userId, incidentId, data, tsNum });
            }
          });
        });

        if (historyReports.length === 0) {
          historyTable.innerHTML += "<tr><td colspan='9'>No verified or rejected reports found.</td></tr>";
          return;
        }

        historyReports.sort((a, b) => {
          const at = Number.isFinite(a.tsNum) ? a.tsNum : -Infinity;
          const bt = Number.isFinite(b.tsNum) ? b.tsNum : -Infinity;
          return bt - at; // newest first
        });

        // keep a global copy for export
        window.__historyExportRaw = historyReports.map(h => ({
          location: h.data.address || 'Unknown',
          description: h.data.description || 'No description',
          category: h.data.category || 'N/A',
          email: h.data.email || 'N/A',
          username: h.data.username || 'N/A',
          status: h.data.rdInc_status || 'Unknown',
          tsNum: h.tsNum,
          image: h.data.imagefile || null,
          timestamp: (Number.isFinite(h.tsNum)
            ? new Date(h.tsNum).toLocaleString()
            : (h.data.timestamp ? (isNaN(new Date(h.data.timestamp).getTime()) ? 'N/A' : new Date(h.data.timestamp).toLocaleString()) : 'N/A'))
        }));

        // Render with current UI filters instead of raw list
        renderHistoryTable();
      });
    }

    // Render history table applying current filter controls
    function renderHistoryTable() {
      const table = document.getElementById('historyTable');
      if (!table) return;
      table.innerHTML = `
        <tr>
          <th>Location</th>
          <th>Description</th>
          <th>Category</th>
          <th>Email</th>
          <th>Username</th>
          <th>Timestamp</th>
          <th>Status</th>
          <th>Image</th>
          <th>Actions</th>
        </tr>`;
      const raw = Array.isArray(window.__historyExportRaw) ? window.__historyExportRaw : [];
      if (!raw.length) {
        table.innerHTML += `<tr><td colspan='9'>No history data loaded.</td></tr>`;
        return;
      }
      const statusFilter = (document.getElementById('historyStatusFilter')?.value || '').trim();
      const fromVal = document.getElementById('historyDateFrom')?.value;
      const toVal = document.getElementById('historyDateTo')?.value;
      let fromMs = null, toMs = null;
      if (fromVal) { const d = new Date(fromVal + 'T00:00:00'); if (!isNaN(d.getTime())) fromMs = d.getTime(); }
      if (toVal) { const d = new Date(toVal + 'T23:59:59'); if (!isNaN(d.getTime())) toMs = d.getTime(); }
      const filtered = raw.filter(r => {
        if (statusFilter && r.status !== statusFilter) return false;
        if (fromMs != null && Number.isFinite(r.tsNum) && r.tsNum < fromMs) return false;
        if (toMs != null && Number.isFinite(r.tsNum) && r.tsNum > toMs) return false;
        return true;
      });
      if (!filtered.length) {
        table.innerHTML += `<tr><td colspan='9'>No rows match filters.</td></tr>`;
        const hs = document.getElementById('historyStatus');
        if (hs) hs.textContent = 'Showing 0 row(s)';
        return;
      }
      filtered.sort((a,b)=>(Number.isFinite(b.tsNum)?b.tsNum:-Infinity)-(Number.isFinite(a.tsNum)?a.tsNum:-Infinity));
      filtered.forEach(r => {
        const color = r.status.toLowerCase() === 'verified' ? '#4caf50' : '#f44336';
        const imgHtml = buildImageCell(r.image, `history/${r.username}/${r.tsNum||''}`);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${r.location}</td>
          <td class="description-cell">${r.description}</td>
          <td>${r.category}</td>
          <td>${r.email}</td>
          <td>${r.username}</td>
          <td>${r.timestamp}</td>
          <td style="color:${color};font-weight:bold;">${r.status}</td>
          <td>${imgHtml}</td>
          <td><!-- actions optional --></td>`;
        table.appendChild(tr);
      });
      const hs = document.getElementById('historyStatus');
      if (hs) hs.textContent = `Showing ${filtered.length} row(s)`;
    }

    // CSV export
    function exportHistoryCsv() {
      const raw = Array.isArray(window.__historyExportRaw) ? window.__historyExportRaw : [];
      if (!raw.length) return alert('No data to export');
      const statusFilter = (document.getElementById('historyStatusFilter')?.value || '').trim();
      const fromVal = document.getElementById('historyDateFrom')?.value;
      const toVal = document.getElementById('historyDateTo')?.value;
      let fromMs=null,toMs=null;
      if (fromVal){const d=new Date(fromVal+'T00:00:00'); if(!isNaN(d.getTime())) fromMs=d.getTime();}
      if (toVal){const d=new Date(toVal+'T23:59:59'); if(!isNaN(d.getTime())) toMs=d.getTime();}
      const filtered = raw.filter(r=>{
        if (statusFilter && r.status!==statusFilter) return false;
        if (fromMs!=null && Number.isFinite(r.tsNum) && r.tsNum<fromMs) return false;
        if (toMs!=null && Number.isFinite(r.tsNum) && r.tsNum>toMs) return false;
        return true;
      });
      if (!filtered.length) return alert('No rows match filters');
      const headers = ['Location','Description','Category','Email','Username','Status','Timestamp'];
      const lines = [headers.join(',')];
      filtered.forEach(r=>{
        const esc = v => '"'+String(v).replace(/"/g,'""')+'"';
        lines.push([r.location,r.description,r.category,r.email,r.username,r.status,r.timestamp].map(esc).join(','));
      });
      const blob = new Blob([lines.join('\n')], { type:'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `incident_history_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 400);
    }
    
    // Vehicle CSV export
    function exportVehicleCsv() {
      const raw = Array.isArray(window.__vehicleExportRaw) ? window.__vehicleExportRaw : [];
      if (!raw.length) return alert('No vehicle data to export');
      const statusFilter = (document.getElementById('vehicleStatusFilter')?.value || '').trim();
      const fromVal = document.getElementById('vehicleDateFrom')?.value;
      const toVal = document.getElementById('vehicleDateTo')?.value;
      let fromMs=null,toMs=null;
      if (fromVal){const d=new Date(fromVal+'T00:00:00'); if(!isNaN(d.getTime())) fromMs=d.getTime();}
      if (toVal){const d=new Date(toVal+'T23:59:59'); if(!isNaN(d.getTime())) toMs=d.getTime();}
      const filtered = raw.filter(r=>{
        if (statusFilter && r.status!==statusFilter) return false;
        if (fromMs!=null && Number.isFinite(r.tsNum) && r.tsNum<fromMs) return false;
        if (toMs!=null && Number.isFinite(r.tsNum) && r.tsNum>toMs) return false;
        return true;
      });
      if (!filtered.length) return alert('No vehicle reports match filters');
      const headers = ['Plate Number','Type','Date','Time','Location','Report','Status','Timestamp'];
      const lines = [headers.join(',')];
      filtered.forEach(r=>{
        const esc = v => '"'+String(v).replace(/"/g,'""')+'"';
        lines.push([r.plateNo,r.type,r.date,r.time,r.location,r.detail,r.status,r.timestamp].map(esc).join(','));
      });
      const blob = new Blob([lines.join('\n')], { type:'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vehicle_reports_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 400);
    }
    
    // SOS CSV export
    function exportSOSCsv() {
      const raw = Array.isArray(window.__sosExportRaw) ? window.__sosExportRaw : [];
      if (!raw.length) return alert('No SOS data to export');
      const fromVal = document.getElementById('sosDateFrom')?.value;
      const toVal = document.getElementById('sosDateTo')?.value;
      const includeCoords = !!document.getElementById('sosIncludeCoords')?.checked;
      let fromMs=null,toMs=null;
      if (fromVal){const d=new Date(fromVal+'T00:00:00'); if(!isNaN(d.getTime())) fromMs=d.getTime();}
      if (toVal){const d=new Date(toVal+'T23:59:59'); if(!isNaN(d.getTime())) toMs=d.getTime();}
      const filtered = raw.filter(r=>{
        if (fromMs!=null && Number.isFinite(r.tsNum) && r.tsNum<fromMs) return false;
        if (toMs!=null && Number.isFinite(r.tsNum) && r.tsNum>toMs) return false;
        return true;
      });
      if (!filtered.length) return alert('No SOS reports match filters');
      const headers = includeCoords ? ['Email','Username','Latitude','Longitude','Timestamp'] : ['Email','Username','Timestamp'];
      const lines = [headers.join(',')];
      filtered.forEach(r=>{
        const esc = v => '"'+String(v).replace(/"/g,'""')+'"';
        const row = includeCoords ? [r.email,r.username,r.latitude,r.longitude,r.timestamp] : [r.email,r.username,r.timestamp];
        lines.push(row.map(esc).join(','));
      });
      const blob = new Blob([lines.join('\n')], { type:'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sos_reports_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 400);
    }
    
    // Render SOS table with filters
    function renderSOSTable() {
      // This function can be used for future SOS filtering if needed
      // For now, we rely on the real-time listener updates
      console.log('SOS table render requested - using real-time data');
    }

    // Wire History filter apply & CSV export
    document.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'historyApplyFilters') {
        renderHistoryTable();
      }
      if (e.target && e.target.id === 'exportHistoryCsvBtn') {
        exportHistoryCsv();
      }
      // Vehicle Reports filters and exports
      if (e.target && e.target.id === 'vehicleApplyFilters') {
        renderVehicleTable();
      }
      if (e.target && e.target.id === 'exportVehicleCsvBtn') {
        exportVehicleCsv();
      }
      // SOS Reports filters and exports
      if (e.target && e.target.id === 'sosApplyFilters') {
        renderSOSTable();
      }
      if (e.target && e.target.id === 'exportSOSCsvBtn') {
        exportSOSCsv();
      }
    });

    // History export (print + PDF)
    document.addEventListener('click', async (e) => {
      if (e.target && e.target.id === 'printHistoryBtn') {
        const statusEl = document.getElementById('historyExportStatus');
        try {
          const rawRows = Array.isArray(window.__historyExportRaw) ? window.__historyExportRaw : [];
          if (!rawRows.length) {
            if (statusEl) statusEl.textContent = 'Nothing to export.';
            return;
          }
          // Apply filters
          const statusFilter = (document.getElementById('historyStatusFilter')?.value || '').trim();
          const fromVal = document.getElementById('historyDateFrom')?.value;
          const toVal = document.getElementById('historyDateTo')?.value;
          const includeImages = !!document.getElementById('historyIncludeImages')?.checked;
          const imageSizeSel = (document.getElementById('historyImageSize')?.value || 'sm');
          let thumbW = 50, thumbH = 38;
          if (imageSizeSel === 'md') { thumbW = 80; thumbH = 60; }
          if (imageSizeSel === 'lg') { thumbW = 120; thumbH = 90; }
          let fromMs = null, toMs = null;
          if (fromVal) {
            const d = new Date(fromVal + 'T00:00:00');
            if (!isNaN(d.getTime())) fromMs = d.getTime();
          }
          if (toVal) {
            const d = new Date(toVal + 'T23:59:59');
            if (!isNaN(d.getTime())) toMs = d.getTime();
          }
          let rows = rawRows.filter(r => {
            if (statusFilter && r.status !== statusFilter) return false;
            if (fromMs != null && Number.isFinite(r.tsNum) && r.tsNum < fromMs) return false;
            if (toMs != null && Number.isFinite(r.tsNum) && r.tsNum > toMs) return false;
            return true;
          });
          if (!rows.length) {
            if (statusEl) statusEl.textContent = 'No rows after filters.';
            return;
          }
          if (!rows.length) {
            if (statusEl) statusEl.textContent = 'Nothing to export.';
            return;
          }
          if (statusEl) statusEl.textContent = 'Preparing jsPDF…';

          // Ensure jsPDF & autotable are available (dynamic fallback if CDN with SRI failed earlier)
          async function ensureJsPDF() {
            if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
            // load core
            await new Promise((resolve, reject) => {
              const s = document.createElement('script');
              s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
              s.onload = () => resolve();
              s.onerror = () => reject(new Error('Failed to load jsPDF core'));
              document.head.appendChild(s);
            });
            if (!window.jspdf?.jsPDF) throw new Error('jsPDF constructor missing after load');
            // load autotable (optional)
            if (!window.jspdf?.jsPDF.API.autoTable) {
              await new Promise((resolve) => {
                const a = document.createElement('script');
                a.src = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js';
                a.onload = () => resolve();
                a.onerror = () => resolve(); // continue without
                document.head.appendChild(a);
              });
            }
            return window.jspdf.jsPDF;
          }

          let JsPDFCtor = null;
          try {
            JsPDFCtor = await ensureJsPDF();
          } catch (loadErr) {
            console.warn('jsPDF dynamic load failed', loadErr);
            if (statusEl) statusEl.textContent = 'Unable to load jsPDF library.';
            return;
          }

          if (!JsPDFCtor) {
            if (statusEl) statusEl.textContent = 'jsPDF not loaded.';
            return;
          }
          if (statusEl) statusEl.textContent = 'Generating PDF…';
          const doc = new JsPDFCtor({ orientation: 'landscape', unit: 'pt', format: 'A4' });
          const title = 'Incident History Report';
          doc.setFontSize(16);
            doc.text(title, 40, 40);
          doc.setFontSize(10);
          doc.text(`Generated: ${new Date().toLocaleString()}`, 40, 58);
          doc.setFontSize(10);
          doc.text('METROGUIDE • Safety & Incident Intelligence', 480, 58, { align: 'right' });
          // Column definitions
          const head = [['Location', 'Description', 'Category', 'Email', 'Username', 'Status', 'Timestamp']];
          const body = rows.map(r => [r.location, r.description, r.category, r.email, r.username, r.status, r.timestamp]);
          if (doc.autoTable) {
            doc.autoTable({
              head,
              body,
              startY: 70,
              styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
              headStyles: { fillColor: [197,99,69] },
              columnStyles: {
                0: { cellWidth: 90 }, // Location
                1: { cellWidth: 160 }, // Description
                2: { cellWidth: 80 },
                3: { cellWidth: 120 },
                4: { cellWidth: 80 },
                5: { cellWidth: 60 },
                6: { cellWidth: 110 }
              },
              didDrawPage: (data) => {
                // Footer branding & pagination
                const pageCount = doc.getNumberOfPages();
                const pageSize = doc.internal.pageSize;
                const pageWidth = pageSize.getWidth();
                const footerY = pageSize.getHeight() - 20;
                doc.setFontSize(8);
                doc.text('METROGUIDE • Confidential Incident Report', 40, footerY);
                doc.text(`Page ${data.pageNumber} of ${pageCount}`, pageWidth - 100, footerY);
              }
            });
            // If images requested, append a simple gallery after table
            if (includeImages) {
              if (statusEl) statusEl.textContent = 'Embedding images (0%)…';
              let y = doc.lastAutoTable.finalY + 24;
              doc.setFontSize(12);
              doc.text('Images', 40, y);
              y += 14;
              const usableWidth = doc.internal.pageSize.getWidth() - 80;
              const gap = 8;
              const maxPerRow = Math.max(1, Math.floor((usableWidth + gap) / (thumbW + gap)));
              let col = 0;
              let processed = 0;
              const withImages = rows.filter(r => !!r.image);
              const totalImgs = withImages.length;
              for (const r of withImages) {
                const imgSrc = normalizeImageSource(r.image);
                if (!imgSrc || !/^data:image\//i.test(imgSrc)) { processed++; continue; }
                const x = 40 + col * (thumbW + gap);
                if (x + thumbW > doc.internal.pageSize.getWidth() - 40) col = 0;
                const x2 = 40 + col * (thumbW + gap);
                if (x2 + thumbW > doc.internal.pageSize.getWidth() - 40) {
                  doc.addPage();
                  y = 60;
                  doc.setFontSize(12);
                  doc.text('Images (cont.)', 40, y);
                  y += 14;
                  col = 0;
                }
                try { doc.addImage(imgSrc, 'JPEG', 40 + col * (thumbW + gap), y, thumbW, thumbH); } catch(_) {}
                col++;
                if (col >= maxPerRow) {
                  col = 0;
                  y += thumbH + gap;
                  if (y > doc.internal.pageSize.getHeight() - 60) {
                    doc.addPage();
                    y = 60;
                    doc.setFontSize(12);
                    doc.text('Images (cont.)', 40, y);
                    y += 14;
                  }
                }
                processed++;
                if (statusEl && totalImgs) {
                  const pct = Math.round((processed / totalImgs) * 100);
                  if (processed === totalImgs || processed % 3 === 0) statusEl.textContent = `Embedding images (${pct}%)…`;
                }
              }
            }
          } else {
            // Fallback basic table if autoTable missing
            let y = 80;
            doc.setFontSize(9);
            body.forEach(r => {
              doc.text(r.join(' | ').slice(0, 180), 40, y);
              y += 14;
              if (y > 550) { doc.addPage(); y = 60; }
            });
          }
          const fileName = `incident_history_${Date.now()}.pdf`;
          doc.save(fileName);
          // Also trigger print dialog (optional). If you want only download, remove next line.
          try { doc.autoPrint && doc.autoPrint(); window.open(doc.output('bloburl'), '_blank'); } catch(_) {}
          if (statusEl) statusEl.textContent = `Exported ${rows.length} rows.`;
        } catch (err) {
          console.error('History export error', err);
          const statusEl2 = document.getElementById('historyExportStatus');
          if (statusEl2) statusEl2.textContent = 'Export failed.';
        }
      }
      
      // Vehicle Reports PDF Export
      if (e.target && e.target.id === 'printVehicleBtn') {
        await exportVehiclePDF();
      }
      
      // SOS Reports PDF Export
      if (e.target && e.target.id === 'printSOSBtn') {
        await exportSOSPDF();
      }
    });

    // 🚗 Vehicle Reports
    function loadVehicleReports() {
      const vehicleRef = ref(db, "vehicle_reports");
      onValue(vehicleRef, (snapshot) => {
        const vehicleTable = document.getElementById("vehicleReportsTable");
        vehicleTable.innerHTML = "";
        
        // Store raw data for export
        const vehicleReports = [];
        
        if (!snapshot.exists()) {
          vehicleTable.innerHTML = "<tr><td colspan='8'>No vehicle reports found.</td></tr>";
          window.__vehicleExportRaw = [];
          return;
        }
        
        snapshot.forEach((userSnap) => {
          const userId = userSnap.key;
          userSnap.forEach((reportSnap) => {
            const data = reportSnap.val();
            const reportId = reportSnap.key;
            
            // Parse date for sorting and filtering
            let tsNum = null;
            if (data.date && data.time) {
              const parsed = Date.parse(`${data.date} ${data.time}`);
              if (!isNaN(parsed)) tsNum = parsed;
            } else if (data.date) {
              const parsed = Date.parse(data.date);
              if (!isNaN(parsed)) tsNum = parsed;
            }
            
            vehicleReports.push({
              userId,
              reportId,
              data,
              tsNum,
              plateNo: data.plate_no || "Unknown",
              type: data.type || "N/A",
              date: data.date || "N/A",
              time: data.time || "N/A",
              location: data.location || "N/A",
              detail: data.detail || "No details",
              status: data.rdInc_status || "Pending",
              image: data.imagefile || null,
              timestamp: (tsNum ? new Date(tsNum).toLocaleString() : 'N/A')
            });
          });
        });
        
        // Sort by timestamp (newest first)
        vehicleReports.sort((a,b) => {
          const at = Number.isFinite(a.tsNum) ? a.tsNum : -Infinity;
          const bt = Number.isFinite(b.tsNum) ? b.tsNum : -Infinity;
          return bt - at;
        });
        
        // Store for export
        window.__vehicleExportRaw = vehicleReports;
        
        // Render table
        renderVehicleTable();
      });
    }
    
    // Render vehicle table with current filters
    function renderVehicleTable() {
      const table = document.getElementById('vehicleReportsTable');
      if (!table) return;
      
      const raw = Array.isArray(window.__vehicleExportRaw) ? window.__vehicleExportRaw : [];
      if (!raw.length) {
        table.innerHTML = '<tr><td colspan="8">No vehicle reports found.</td></tr>';
        return;
      }
      
      // Apply filters
      const statusFilter = (document.getElementById('vehicleStatusFilter')?.value || '').trim();
      const fromVal = document.getElementById('vehicleDateFrom')?.value;
      const toVal = document.getElementById('vehicleDateTo')?.value;
      
      let fromMs = null, toMs = null;
      if (fromVal) {
        const d = new Date(fromVal + 'T00:00:00');
        if (!isNaN(d.getTime())) fromMs = d.getTime();
      }
      if (toVal) {
        const d = new Date(toVal + 'T23:59:59');
        if (!isNaN(d.getTime())) toMs = d.getTime();
      }
      
      const filtered = raw.filter(r => {
        if (statusFilter && r.status !== statusFilter) return false;
        if (fromMs != null && Number.isFinite(r.tsNum) && r.tsNum < fromMs) return false;
        if (toMs != null && Number.isFinite(r.tsNum) && r.tsNum > toMs) return false;
        return true;
      });
      
      if (!filtered.length) {
        table.innerHTML = '<tr><td colspan="8">No vehicle reports match filters.</td></tr>';
        return;
      }
      
      // Render rows
      filtered.forEach(report => {
        const row = document.createElement("tr");
        const imageHtml = buildImageCell(report.image, `vehicle_reports/${report.userId}/${report.reportId}`);
        row.innerHTML = `
          <td>${report.plateNo}</td>
          <td>${report.type}</td>
          <td>${report.date}</td>
          <td>${report.time}</td>
          <td>${report.location}</td>
          <td>${report.detail}</td>
          <td>${report.status}</td>
          <td>${imageHtml}</td>
        `;
        table.appendChild(row);
      });
    }

    // 👤 Users & Stats
    function loadUsers() {
      const userCountRef = ref(db, "user_count");
      const usersRef = ref(db, "users");

      // total users
      onValue(userCountRef, (snapshot) => {
        document.getElementById("userCount").innerText = snapshot.val() || 0;
      });

      // user list
      onValue(usersRef, (snapshot) => {
        const usersTable = document.getElementById("usersTable");
        usersTable.innerHTML = "";
        if (!snapshot.exists()) {
          usersTable.innerHTML = "<tr><td colspan='4'>No users found.</td></tr>";
          return;
        }
        snapshot.forEach((child) => {
          const data = child.val();
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${child.key}</td>
            <td>${data.email || "N/A"}</td>
            <td>${data.name || "N/A"}</td>
            <td>${data.role || "User"}</td>
          `;
          usersTable.appendChild(row);
        });
      });
    }

    // Tab Handlers
    document.getElementById("tabSOS").addEventListener("click", () => {
      document.getElementById("incidentReportsSection").style.display = "none";
      document.getElementById("historySection").style.display = "none";
      document.getElementById("vehicleReportsSection").style.display = "none";
      document.getElementById("sosSection").style.display = "block";
      document.getElementById("usersSection").style.display = "none";
      document.getElementById("tabSOS").classList.add("active");
      document.getElementById("tabReports").classList.remove("active");
      document.getElementById("tabHistory").classList.remove("active");
      document.getElementById("tabVehicle").classList.remove("active");
      document.getElementById("tabUsers").classList.remove("active");
      loadSOSReports();
    });
    // 🚨 SOS Reports
    async function loadSOSReports() {
      if (sosListenerAttached) return;
      const sosTable = document.getElementById('sosTable');
      const sosStatus = document.getElementById('sosStatus');
      const viewNote = document.getElementById('sosViewNote');
      if (sosTable) sosTable.innerHTML = "<tr><td colspan='6'>Loading SOS reports…</td></tr>";
      if (sosStatus) sosStatus.textContent = 'Status: probing paths…';
      sosPerUserMode = false;
      if (sosRefCurrent) { try { off(sosRefCurrent); } catch(_) {} }

      const candidatePaths = ['sos_logs', 'sos'];
      let attached = false;

      for (const p of candidatePaths) {
        try {
          const testRef = ref(db, p);
          // test read once
          await get(testRef);
          // success (even if empty) => attach listener here
          sosPathSelected = p;
          sosRefCurrent = testRef;
          attachSOSListener();
          attached = true;
          break;
        } catch (e) {
          if ((e?.code || '').toString().toUpperCase().includes('PERMISSION')) {
            console.warn(`[SOS] Permission denied on path '${p}', trying next…`);
            continue; // try next path
          } else {
            console.warn(`[SOS] Non-permission error accessing '${p}':`, e);
            continue; // still try next path
          }
        }
      }

      if (!attached) {
        // all global paths failed; try per-user fallback if signed-in
        if (auth.currentUser) {
          const uid = auth.currentUser.uid;
          console.warn('[SOS] Falling back to per-user path due to global permission failures.');
          if (sosStatus) sosStatus.textContent = 'Status: global access denied, loading your SOS entries…';
          await attachPerUserSOSListener(uid);
          if (viewNote) viewNote.textContent = 'Per-user SOS view (global access denied by rules).';
        } else {
          if (sosStatus) sosStatus.textContent = 'Status: permission denied (not signed in or rules restrictive).';
          if (sosTable) sosTable.innerHTML = `<tr><td colspan='6'>No permission to read SOS logs.</td></tr>`;
        }
        return;
      }
      if (viewNote) viewNote.textContent = isAdmin ? 'Admin view (all SOS reports).' : 'All SOS reports (shared view).';

      function render(snapshot) {
        if (!sosTable) return;
        sosTable.innerHTML = '';
        const list = [];
        const viewNote = document.getElementById('sosViewNote');
        if (snapshot && snapshot.exists()) {
          snapshot.forEach(userSnap => {
            const k = userSnap.key;
            const v = userSnap.val();
            const nested = v && typeof v === 'object' && Object.values(v).some(val => val && typeof val === 'object' && ('timestamp' in val || 'latitude' in val || 'latlng' in val));
            if (nested) {
              userSnap.forEach(logSnap => {
                const log = logSnap.val() || {};
                if (log.deleted) return;
                list.push({
                  userId: k,
                  logId: logSnap.key,
                  email: log.email || 'N/A',
                  username: log.username || 'N/A',
                  lat: pickLat(log) ?? log.latitude ?? 'N/A',
                  lng: pickLng(log) ?? log.longitude ?? 'N/A',
                  tsNum: pickTimestamp(log),
                  rawTs: log.timestamp
                });
              });
            } else {
              const log = v || {};
              if (log.deleted) return;
              list.push({
                userId: log.userId || log.uid || k,
                logId: k,
                email: log.email || 'N/A',
                username: log.username || 'N/A',
                lat: pickLat(log) ?? log.latitude ?? 'N/A',
                lng: pickLng(log) ?? log.longitude ?? 'N/A',
                tsNum: pickTimestamp(log),
                rawTs: log.timestamp
              });
            }
          });
        }
        
        // Store for export
        window.__sosExportRaw = list.map(e => ({
          email: e.email,
          username: e.username,
          latitude: e.lat,
          longitude: e.lng,
          tsNum: e.tsNum,
          timestamp: Number.isFinite(e.tsNum) ? new Date(e.tsNum).toLocaleString() : (e.rawTs ? (isNaN(new Date(e.rawTs).getTime()) ? 'N/A' : new Date(e.rawTs).toLocaleString()) : 'N/A')
        }));
        
        if (!list.length) {
          sosTable.innerHTML = `<tr><td colspan='6'>No SOS reports found.</td></tr>`;
          if (sosStatus) sosStatus.textContent = 'Status: 0 items';
          if (viewNote) viewNote.textContent = sosPerUserMode ? 'Showing only your SOS entries.' : (isAdmin ? 'No SOS reports yet.' : 'No accessible SOS reports.');
          return;
        }
        list.sort((a,b)=>(Number.isFinite(b.tsNum)?b.tsNum:-Infinity)-(Number.isFinite(a.tsNum)?a.tsNum:-Infinity));
        list.forEach(e => {
          const tsDisplay = Number.isFinite(e.tsNum) ? new Date(e.tsNum).toLocaleString() : (e.rawTs ? (isNaN(new Date(e.rawTs).getTime()) ? 'N/A' : new Date(e.rawTs).toLocaleString()) : 'N/A');
            const tr = document.createElement('tr');
            const hasValidCoords = Number.isFinite(e.lat) && Number.isFinite(e.lng);
            tr.innerHTML = `
              <td>${e.email}</td>
              <td>${e.username}</td>
              <td>${e.lat}</td>
              <td>${e.lng}</td>
              <td>${tsDisplay}</td>
              <td>
                ${hasValidCoords ? `<button class="btn btn-view" onclick="openMapModal(${e.lat}, ${e.lng}, '${e.email}', '${e.username}')">View</button>` : ''}
                <button class="btn btn-reject" data-user="${e.userId}" data-key="${e.logId}">Delete</button>
              </td>`;
            sosTable.appendChild(tr);
        });
        if (sosStatus) sosStatus.textContent = `Status: ${list.length} item(s)`;
        if (viewNote) viewNote.textContent = sosPerUserMode ? 'Per-user view (limited to your own SOS submissions).' : (isAdmin ? 'Admin view (all SOS reports).' : 'Limited view. Trying to load what you can access.');
        document.querySelectorAll('#sosSection .btn-reject').forEach(btn => {
          btn.addEventListener('click', () => deleteSOS(btn.dataset.user, btn.dataset.key));
        });
      }

    function attachSOSListener() {
      sosListenerAttached = true;
      if (sosStatus) sosStatus.textContent = `Status: listening at ${sosPathSelected}…`;
      get(sosRefCurrent).then(snap => {
        render(snap);
      }).catch(e => {
        console.warn('[SOS] initial read failed after attach', e);
        if (sosStatus) sosStatus.textContent = `Status: error (${e?.code||'error'}) initial read at ${sosPathSelected}`;
      });
      onValue(sosRefCurrent, (snap) => render(snap), (err) => {
        console.warn('[SOS] listener error', err);
        if ((err?.code || '').toString().toUpperCase().includes('PERMISSION')) {
          // detach and fall back to per-user
          try { off(sosRefCurrent); } catch(_) {}
          sosListenerAttached = false;
          if (auth.currentUser) {
            if (sosStatus) sosStatus.textContent = 'Status: lost global permission, switching to per-user…';
            attachPerUserSOSListener(auth.currentUser.uid);
            const vn = document.getElementById('sosViewNote');
            if (vn) vn.textContent = 'Per-user SOS view (global listener permission lost).';
            return;
          }
        }
        if (sosStatus) sosStatus.textContent = `Status: listener error (${err?.code||'error'})`;
      });
    }
  }

    // (Removed unused renderSosSnapshot helper)

  // (Callable fallback retained but rarely needed now that global read is open)
  async function tryFunctionFallbackRender() {
      const sosTable = document.getElementById('sosTable');
      const sosStatus = document.getElementById('sosStatus');
      sosTriedFunctionFallback = true;
      try {
        if (sosStatus) sosStatus.textContent = 'Status: fetching via server (adminListSOS)…';
        const call = httpsCallable(functions, 'adminListSOS');
        const result = await call({ limit: 500 });
        const list = Array.isArray(result?.data) ? result.data : (result?.data?.items || []);
        if (!Array.isArray(list) || list.length === 0) {
          if (sosTable) sosTable.innerHTML = `<tr><td colspan='6'>No SOS reports returned by server function.</td></tr>`;
          if (sosStatus) sosStatus.textContent = `Status: 0 items (server) at ${new Date().toLocaleTimeString()}`;
          return true;
        }
        // Normalize then render
        const entries = list.map(item => {
          const tsNum = pickTimestamp(item) ?? (typeof item.ts === 'number' ? item.ts : null);
          const lat = pickLat(item);
          const lng = pickLng(item);
          return {
            userId: item.userId || item.uid || 'unknown',
            logId: item.id || item.logId || item.key || '',
            email: item.email || 'N/A',
            username: item.username || item.userName || item.name || 'N/A',
            lat: Number.isFinite(lat) ? lat : (item.latitude ?? null),
            lng: Number.isFinite(lng) ? lng : (item.longitude ?? null),
            tsNum,
            rawTs: item.timestamp
          };
        });
        entries.sort((a,b)=> (Number.isFinite(b.tsNum)?b.tsNum:-Infinity) - (Number.isFinite(a.tsNum)?a.tsNum:-Infinity));
        
        // Store for export
        window.__sosExportRaw = entries.map(e => ({
          email: e.email,
          username: e.username,
          latitude: e.lat,
          longitude: e.lng,
          tsNum: e.tsNum,
          timestamp: Number.isFinite(e.tsNum) ? new Date(e.tsNum).toLocaleString() : (e.rawTs ? (isNaN(new Date(e.rawTs).getTime()) ? 'N/A' : new Date(e.rawTs).toLocaleString()) : 'N/A')
        }));
        
        sosTable.innerHTML = '';
        let count = 0;
        for (const e of entries) {
          const tsDisplay = Number.isFinite(e.tsNum) ? new Date(e.tsNum).toLocaleString() : (e.rawTs ? (isNaN(new Date(e.rawTs).getTime()) ? 'N/A' : new Date(e.rawTs).toLocaleString()) : 'N/A');
          const tr = document.createElement('tr');
          const hasValidCoords = Number.isFinite(e.lat) && Number.isFinite(e.lng);
          tr.innerHTML = `
            <td>${e.email}</td>
            <td>${e.username}</td>
            <td>${e.lat ?? 'N/A'}</td>
            <td>${e.lng ?? 'N/A'}</td>
            <td>${tsDisplay}</td>
            <td>
              ${hasValidCoords ? `<button class="btn btn-view" onclick="openMapModal(${e.lat}, ${e.lng}, '${e.email}', '${e.username}')">View</button>` : ''}
              <!-- server data: delete disabled -->
            </td>`;
          sosTable.appendChild(tr);
          count++;
        }
        if (sosStatus) sosStatus.textContent = `Status: ${count} items (server) at ${new Date().toLocaleTimeString()}`;
        return true;
      } catch (e) {
        console.warn('[SOS] adminListSOS callable failed', e);
        if (sosStatus) sosStatus.textContent = `Status: server function failed (${e?.code || 'error'}) at ${new Date().toLocaleTimeString()}`;
        return false;
      }
    }

  // (Per-user listener kept for backwards compatibility if you later tighten rules)
  async function attachPerUserSOSListener(uid) {
      try { if (sosRefCurrent) off(sosRefCurrent); } catch (_) {}
      sosPerUserMode = true;
      const sosStatus = document.getElementById('sosStatus');
      if (sosStatus) sosStatus.textContent = `Status: trying per-user read…`;
      const candidates = ['sos_logs', 'sos'];
      let chosenBase = null;
      for (const base of candidates) {
        try {
          const testRef = ref(db, `${base}/${uid}`);
          await get(testRef); // success means path is accessible (exists or not)
          chosenBase = base;
          sosPathSelected = base; // reflect actual base path
          sosRefCurrent = testRef;
          break;
        } catch (e) {
          if ((e?.code || '').toString().toUpperCase().includes('PERMISSION')) {
            continue; // try next base
          } else {
            // Non-permission error, still try next
            continue;
          }
        }
      }
      if (!chosenBase) {
        const table = document.getElementById('sosTable');
        if (table) table.innerHTML = `<tr><td colspan='6'>Unable to access per-user SOS under sos_logs/${uid} or sos/${uid} due to permissions.</td></tr>`;
        if (sosStatus) sosStatus.textContent = `Status: per-user access denied at ${new Date().toLocaleTimeString()}`;
        return;
      }
      if (sosStatus) sosStatus.textContent = `Status: listening (per-user) at ${chosenBase}/${uid}…`;
      sosListenerAttached = true;
      onValue(sosRefCurrent, async (userSnap) => {
        const table = document.getElementById('sosTable');
        table.innerHTML = '';
        const entries = [];
        if (userSnap.exists()) {
          userSnap.forEach((logSnap) => {
            const log = logSnap.val() || {};
            if (log.deleted) return;
            const tsNum = pickTimestamp(log);
            const lat = pickLat(log);
            const lng = pickLng(log);
            const email = log.email || (auth.currentUser?.email || 'N/A');
            const username = log.username || auth.currentUser?.displayName || 'N/A';
            entries.push({
              userId: uid,
              logId: logSnap.key,
              email, username,
              lat: Number.isFinite(lat) ? lat : (log.latitude ?? null),
              lng: Number.isFinite(lng) ? lng : (log.longitude ?? null),
              tsNum,
              rawTs: log.timestamp
            });
          });
        }
        if (entries.length === 0) {
          table.innerHTML = `<tr><td colspan='6'>No SOS reports found for your account at ${chosenBase}/${uid}.</td></tr>`;
          if (sosStatus) sosStatus.textContent = `Status: 0 items (per-user) at ${chosenBase}/${uid} (updated ${new Date().toLocaleTimeString()})`;
          return;
        }
        entries.sort((a,b)=> (Number.isFinite(b.tsNum)?b.tsNum:-Infinity) - (Number.isFinite(a.tsNum)?a.tsNum:-Infinity));
        
        // Store for export
        window.__sosExportRaw = entries.map(e => ({
          email: e.email,
          username: e.username,
          latitude: e.lat,
          longitude: e.lng,
          tsNum: e.tsNum,
          timestamp: Number.isFinite(e.tsNum) ? new Date(e.tsNum).toLocaleString() : (e.rawTs ? (isNaN(new Date(e.rawTs).getTime()) ? 'N/A' : new Date(e.rawTs).toLocaleString()) : 'N/A')
        }));
        
        let count = 0;
        for (const e of entries) {
          const tsDisplay = Number.isFinite(e.tsNum) ? new Date(e.tsNum).toLocaleString() : (e.rawTs ? (isNaN(new Date(e.rawTs).getTime()) ? 'N/A' : new Date(e.rawTs).toLocaleString()) : 'N/A');
          const tr = document.createElement('tr');
          const hasValidCoords = Number.isFinite(e.lat) && Number.isFinite(e.lng);
          tr.innerHTML = `
            <td>${e.email}</td>
            <td>${e.username}</td>
            <td>${e.lat ?? 'N/A'}</td>
            <td>${e.lng ?? 'N/A'}</td>
            <td>${tsDisplay}</td>
            <td>
              ${hasValidCoords ? `<button class="btn btn-view" onclick="openMapModal(${e.lat}, ${e.lng}, '${e.email}', '${e.username}')">View</button>` : ''}
              <button class="btn btn-reject" data-user="${e.userId}" data-key="${e.logId}">Delete</button>
            </td>`;
          table.appendChild(tr);
          count++;
        }
        document.querySelectorAll('#sosSection .btn-reject').forEach(btn => {
          btn.addEventListener('click', () => deleteSOS(btn.dataset.user, btn.dataset.key));
        });
        if (sosStatus) sosStatus.textContent = `Status: ${count} items (per-user) at ${chosenBase}/${uid} (updated ${new Date().toLocaleTimeString()})`;
      }, (err) => {
        const table2 = document.getElementById('sosTable');
        if (table2) table2.innerHTML = `<tr><td colspan='6'>Unable to read per-user SOS at ${chosenBase}/${uid} (${err?.code || 'error'}).</td></tr>`;
        if (sosStatus) sosStatus.textContent = `Status: error (${err?.code || 'error'}) reading ${chosenBase}/${uid}`;
      });
    }

    // Refresh button: detach and reload
    document.addEventListener('click', async (e) => {
      if (e.target && e.target.id === 'sosRefreshBtn') {
        if (sosRefCurrent) {
          try { off(sosRefCurrent); } catch (_) {}
        }
        sosListenerAttached = false;
        await loadSOSReports();
      }
    });

    // Delete SOS entry helper
    function deleteSOS(userId, logId) {
      // Respect current selected path and shape
      // If per-user nested path
      let path;
      if (sosPerUserMode || (userId && userId !== 'unknown')) {
        path = `${sosPathSelected}/${userId}/${logId}`;
      } else {
        // flat path fallback
        path = `${sosPathSelected}/${logId}`;
      }
      const refToDelete = ref(db, path);
      update(refToDelete, { deleted: true })
        .then(() => alert('SOS entry marked as deleted.'))
        .catch(err => alert('Error deleting SOS entry: ' + err.message));
    }
    document.getElementById("tabReports").addEventListener("click", () => {
  document.getElementById("tabSOS").classList.remove("active");
  document.getElementById("incidentReportsSection").style.display = "block";
  document.getElementById("historySection").style.display = "none";
  document.getElementById("vehicleReportsSection").style.display = "none";
  document.getElementById("usersSection").style.display = "none";
  document.getElementById("sosSection").style.display = "none";
  document.getElementById("tabReports").classList.add("active");
  document.getElementById("tabHistory").classList.remove("active");
  document.getElementById("tabVehicle").classList.remove("active");
  document.getElementById("tabUsers").classList.remove("active");
  loadReports();
    });

    document.getElementById("tabHistory").addEventListener("click", () => {
  document.getElementById("tabSOS").classList.remove("active");
  document.getElementById("incidentReportsSection").style.display = "none";
  document.getElementById("historySection").style.display = "block";
  document.getElementById("vehicleReportsSection").style.display = "none";
  document.getElementById("usersSection").style.display = "none";
  document.getElementById("sosSection").style.display = "none";
  document.getElementById("tabHistory").classList.add("active");
  document.getElementById("tabReports").classList.remove("active");
  document.getElementById("tabVehicle").classList.remove("active");
  document.getElementById("tabUsers").classList.remove("active");
  loadHistory();
    });

    document.getElementById("tabVehicle").addEventListener("click", () => {
  document.getElementById("tabSOS").classList.remove("active");
  document.getElementById("incidentReportsSection").style.display = "none";
  document.getElementById("historySection").style.display = "none";
  document.getElementById("vehicleReportsSection").style.display = "block";
  document.getElementById("usersSection").style.display = "none";
  document.getElementById("sosSection").style.display = "none";
  document.getElementById("tabVehicle").classList.add("active");
  document.getElementById("tabReports").classList.remove("active");
  document.getElementById("tabHistory").classList.remove("active");
  document.getElementById("tabUsers").classList.remove("active");
  loadVehicleReports();
    });

    document.getElementById("tabUsers").addEventListener("click", () => {
  document.getElementById("tabSOS").classList.remove("active");
  document.getElementById("incidentReportsSection").style.display = "none";
  document.getElementById("historySection").style.display = "none";
  document.getElementById("vehicleReportsSection").style.display = "none";
  document.getElementById("usersSection").style.display = "block";
  document.getElementById("sosSection").style.display = "none";
  document.getElementById("tabUsers").classList.add("active");
  document.getElementById("tabReports").classList.remove("active");
  document.getElementById("tabHistory").classList.remove("active");
  document.getElementById("tabVehicle").classList.remove("active");
  loadUsers();
    });

    // Image Modal Functions
    function openImageModal(imageSrc) {
      const modal = document.getElementById('imageModal');
      const modalImg = document.getElementById('modalImage');
      modal.style.display = 'block';
      modalImg.src = imageSrc;
    }

    function closeImageModal() {
      const modal = document.getElementById('imageModal');
      modal.style.display = 'none';
    }

    // Close modal when clicking outside the image
    document.getElementById('imageModal').addEventListener('click', function(e) {
      if (e.target === this) {
        closeImageModal();
      }
    });

    // Close modal with Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        closeImageModal();
      }
    });

    // Make functions global for onclick handlers
    window.openImageModal = openImageModal;
    window.closeImageModal = closeImageModal;

    // Map Modal Functions
    let map;
    let marker;

    function openMapModal(lat, lng, email, username) {
      const modal = document.getElementById('mapModal');
      const title = document.getElementById('mapModalTitle');
      
      title.textContent = `SOS Location - ${username} (${email})`;
      modal.style.display = 'block';
      
      // Initialize map after modal is visible
      setTimeout(() => {
        initializeMap(lat, lng, username);
      }, 100);
    }

    function closeMapModal() {
      const modal = document.getElementById('mapModal');
      modal.style.display = 'none';
      
      // Clean up map
      if (map) {
        map = null;
      }
    }

    function initializeMap(lat, lng, username) {
      const mapContainer = document.getElementById('map');
      
      if (!window.google || !window.google.maps) {
        alert('Google Maps API is not loaded. Please check your internet connection.');
        return;
      }

      const position = { lat: parseFloat(lat), lng: parseFloat(lng) };
      
      // Create map
      map = new google.maps.Map(mapContainer, {
        zoom: 15,
        center: position,
        mapTypeId: google.maps.MapTypeId.ROADMAP
      });

      // Create marker
      marker = new google.maps.Marker({
        position: position,
        map: map,
        title: `SOS Location - ${username}`,
        icon: {
          url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
            <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
              <circle cx="16" cy="16" r="14" fill="#ff4444" stroke="#ffffff" stroke-width="2"/>
              <text x="16" y="20" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">SOS</text>
            </svg>`),
          scaledSize: new google.maps.Size(32, 32),
          anchor: new google.maps.Point(16, 16)
        }
      });

      // Create info window
      const infoWindow = new google.maps.InfoWindow({
        content: `
          <div style="padding: 10px; font-family: Arial, sans-serif;">
            <h4 style="margin: 0 0 5px 0; color: #c56345;">SOS Alert</h4>
            <p style="margin: 5px 0;"><strong>User:</strong> ${username}</p>
            <p style="margin: 5px 0;"><strong>Coordinates:</strong> ${lat}, ${lng}</p>
            <p style="margin: 5px 0; font-size: 12px; color: #666;">Emergency assistance requested at this location</p>
          </div>
        `
      });

      // Open info window by default
      infoWindow.open(map, marker);

      // Add click event to marker
      marker.addListener('click', () => {
        infoWindow.open(map, marker);
      });
    }

    // Close modal when clicking outside the content
    document.getElementById('mapModal').addEventListener('click', function(e) {
      if (e.target === this) {
        closeMapModal();
      }
    });

    // Close modal with Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        const mapModal = document.getElementById('mapModal');
        const imageModal = document.getElementById('imageModal');
        if (mapModal.style.display === 'block') {
          closeMapModal();
        }
        if (imageModal.style.display === 'block') {
          closeImageModal();
        }
      }
    });

    // Make map functions global
    window.openMapModal = openMapModal;
    window.closeMapModal = closeMapModal;
    
    // Vehicle PDF Export Function
    async function exportVehiclePDF() {
      const statusEl = document.getElementById('vehicleExportStatus');
      try {
        const rawRows = Array.isArray(window.__vehicleExportRaw) ? window.__vehicleExportRaw : [];
        if (!rawRows.length) {
          if (statusEl) statusEl.textContent = 'No vehicle data to export.';
          return;
        }
        
        // Apply filters
        const statusFilter = (document.getElementById('vehicleStatusFilter')?.value || '').trim();
        const fromVal = document.getElementById('vehicleDateFrom')?.value;
        const toVal = document.getElementById('vehicleDateTo')?.value;
        const includeImages = !!document.getElementById('vehicleIncludeImages')?.checked;
        const imageSizeSel = (document.getElementById('vehicleImageSize')?.value || 'sm');
        let thumbW = 50, thumbH = 38;
        if (imageSizeSel === 'md') { thumbW = 80; thumbH = 60; }
        if (imageSizeSel === 'lg') { thumbW = 120; thumbH = 90; }
        
        let fromMs = null, toMs = null;
        if (fromVal) {
          const d = new Date(fromVal + 'T00:00:00');
          if (!isNaN(d.getTime())) fromMs = d.getTime();
        }
        if (toVal) {
          const d = new Date(toVal + 'T23:59:59');
          if (!isNaN(d.getTime())) toMs = d.getTime();
        }
        
        let rows = rawRows.filter(r => {
          if (statusFilter && r.status !== statusFilter) return false;
          if (fromMs != null && Number.isFinite(r.tsNum) && r.tsNum < fromMs) return false;
          if (toMs != null && Number.isFinite(r.tsNum) && r.tsNum > toMs) return false;
          return true;
        });
        
        if (!rows.length) {
          if (statusEl) statusEl.textContent = 'No vehicle reports match filters.';
          return;
        }
        
        if (statusEl) statusEl.textContent = 'Generating vehicle PDF…';
        
        // Load jsPDF
        const JsPDFCtor = await ensureJsPDFAvailable();
        if (!JsPDFCtor) {
          if (statusEl) statusEl.textContent = 'PDF library unavailable.';
          return;
        }
        
        const doc = new JsPDFCtor({ orientation: 'landscape', unit: 'pt', format: 'A4' });
        const title = 'Vehicle Reports';
        doc.setFontSize(16);
        doc.text(title, 40, 40);
        doc.setFontSize(10);
        doc.text(`Generated: ${new Date().toLocaleString()}`, 40, 58);
        doc.text('METROGUIDE • Vehicle Incident Intelligence', 480, 58, { align: 'right' });
        
        const head = [['Plate Number', 'Type', 'Date', 'Time', 'Location', 'Report', 'Status']];
        const body = rows.map(r => [r.plateNo, r.type, r.date, r.time, r.location, r.detail, r.status]);
        
        if (doc.autoTable) {
          doc.autoTable({
            head,
            body,
            startY: 70,
            styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
            headStyles: { fillColor: [197,99,69] },
            columnStyles: {
              0: { cellWidth: 80 },  // Plate
              1: { cellWidth: 70 },  // Type
              2: { cellWidth: 80 },  // Date
              3: { cellWidth: 60 },  // Time
              4: { cellWidth: 120 }, // Location
              5: { cellWidth: 150 }, // Report
              6: { cellWidth: 60 }   // Status
            },
            didDrawPage: (data) => {
              const pageCount = doc.getNumberOfPages();
              const pageSize = doc.internal.pageSize;
              const pageWidth = pageSize.getWidth();
              const footerY = pageSize.getHeight() - 20;
              doc.setFontSize(8);
              doc.text('METROGUIDE • Vehicle Incident Report', 40, footerY);
              doc.text(`Page ${data.pageNumber} of ${pageCount}`, pageWidth - 100, footerY);
            }
          });
          
          // Add images if requested
          if (includeImages) {
            const withImages = rows.filter(r => r.image);
            if (withImages.length > 0) {
              let y = doc.lastAutoTable.finalY + 24;
              doc.setFontSize(12);
              doc.text('Vehicle Images', 40, y);
              // Add image gallery logic similar to history
              // ... (implementation similar to history images)
            }
          }
        }
        
        const fileName = `vehicle_reports_${Date.now()}.pdf`;
        doc.save(fileName);
        if (statusEl) statusEl.textContent = `Exported ${rows.length} vehicle reports.`;
      } catch (err) {
        console.error('Vehicle PDF export error', err);
        if (statusEl) statusEl.textContent = 'Vehicle export failed.';
      }
    }
    
    // SOS PDF Export Function
    async function exportSOSPDF() {
      const statusEl = document.getElementById('sosExportStatus');
      try {
        const rawRows = Array.isArray(window.__sosExportRaw) ? window.__sosExportRaw : [];
        if (!rawRows.length) {
          if (statusEl) statusEl.textContent = 'No SOS data to export.';
          return;
        }
        
        // Apply filters
        const fromVal = document.getElementById('sosDateFrom')?.value;
        const toVal = document.getElementById('sosDateTo')?.value;
        const includeCoords = !!document.getElementById('sosIncludeCoords')?.checked;
        
        let fromMs = null, toMs = null;
        if (fromVal) {
          const d = new Date(fromVal + 'T00:00:00');
          if (!isNaN(d.getTime())) fromMs = d.getTime();
        }
        if (toVal) {
          const d = new Date(toVal + 'T23:59:59');
          if (!isNaN(d.getTime())) toMs = d.getTime();
        }
        
        let rows = rawRows.filter(r => {
          if (fromMs != null && Number.isFinite(r.tsNum) && r.tsNum < fromMs) return false;
          if (toMs != null && Number.isFinite(r.tsNum) && r.tsNum > toMs) return false;
          return true;
        });
        
        if (!rows.length) {
          if (statusEl) statusEl.textContent = 'No SOS reports match filters.';
          return;
        }
        
        if (statusEl) statusEl.textContent = 'Generating SOS PDF…';
        
        // Load jsPDF
        const JsPDFCtor = await ensureJsPDFAvailable();
        if (!JsPDFCtor) {
          if (statusEl) statusEl.textContent = 'PDF library unavailable.';
          return;
        }
        
        const doc = new JsPDFCtor({ orientation: 'landscape', unit: 'pt', format: 'A4' });
        const title = 'SOS Emergency Reports';
        doc.setFontSize(16);
        doc.text(title, 40, 40);
        doc.setFontSize(10);
        doc.text(`Generated: ${new Date().toLocaleString()}`, 40, 58);
        doc.text('METROGUIDE • Emergency Response Intelligence', 480, 58, { align: 'right' });
        
        const head = includeCoords ? 
          [['Email', 'Username', 'Latitude', 'Longitude', 'Timestamp']] :
          [['Email', 'Username', 'Timestamp']];
        const body = includeCoords ?
          rows.map(r => [r.email, r.username, r.latitude, r.longitude, r.timestamp]) :
          rows.map(r => [r.email, r.username, r.timestamp]);
        
        if (doc.autoTable) {
          doc.autoTable({
            head,
            body,
            startY: 70,
            styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
            headStyles: { fillColor: [197,99,69] },
            columnStyles: includeCoords ? {
              0: { cellWidth: 140 }, // Email
              1: { cellWidth: 120 }, // Username
              2: { cellWidth: 100 }, // Latitude
              3: { cellWidth: 100 }, // Longitude
              4: { cellWidth: 120 }  // Timestamp
            } : {
              0: { cellWidth: 200 }, // Email
              1: { cellWidth: 150 }, // Username
              2: { cellWidth: 200 }  // Timestamp
            },
            didDrawPage: (data) => {
              const pageCount = doc.getNumberOfPages();
              const pageSize = doc.internal.pageSize;
              const pageWidth = pageSize.getWidth();
              const footerY = pageSize.getHeight() - 20;
              doc.setFontSize(8);
              doc.text('METROGUIDE • Confidential SOS Report', 40, footerY);
              doc.text(`Page ${data.pageNumber} of ${pageCount}`, pageWidth - 100, footerY);
            }
          });
        }
        
        const fileName = `sos_reports_${Date.now()}.pdf`;
        doc.save(fileName);
        if (statusEl) statusEl.textContent = `Exported ${rows.length} SOS reports.`;
      } catch (err) {
        console.error('SOS PDF export error', err);
        if (statusEl) statusEl.textContent = 'SOS export failed.';
      }
    }
    
    // Helper function to ensure jsPDF is available
    async function ensureJsPDFAvailable() {
      if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
      
      try {
        // Load core
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('Failed to load jsPDF core'));
          document.head.appendChild(s);
        });
        
        if (!window.jspdf?.jsPDF) throw new Error('jsPDF constructor missing after load');
        
        // Load autotable
        if (!window.jspdf?.jsPDF.API.autoTable) {
          await new Promise((resolve) => {
            const a = document.createElement('script');
            a.src = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js';
            a.onload = () => resolve();
            a.onerror = () => resolve(); // continue without
            document.head.appendChild(a);
          });
        }
        
        return window.jspdf.jsPDF;
      } catch (loadErr) {
        console.warn('jsPDF dynamic load failed', loadErr);
        return null;
      }
    }

    // ---- Image helpers ----
    function normalizeImageSource(raw) {
      if (!raw || typeof raw !== 'string') return null;
      const s = raw.trim();
      if (!s) return null;
      // Already data URI or http/https
      if (/^(data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,)/i.test(s)) return s;
      if (/^https?:\/\//i.test(s)) return s; // hosted URL
      // Common base64 starts (JPEG, PNG, GIF, WEBP)
      const looksBase64 = /^(?:[A-Za-z0-9+/]+=*)+$/.test(s.replace(/\s+/g,''));
      const jpegSig = s.startsWith('/9j/');
      const pngSig = s.startsWith('iVBOR');
      const gifSig = s.startsWith('R0lGOD');
      const webpSig = s.startsWith('UklGR');
      if (jpegSig || pngSig || gifSig || webpSig || looksBase64) {
        // Heuristic: pick mime
        let mime = 'image/jpeg';
        if (pngSig) mime = 'image/png';
        else if (gifSig) mime = 'image/gif';
        else if (webpSig) mime = 'image/webp';
        return `data:${mime};base64,${s.replace(/\s+/g,'')}`;
      }
      return s; // fallback, maybe path or storage URL
    }

    function buildImageCell(raw, pathLabel) {
      const normalized = normalizeImageSource(raw);
      if (!normalized) {
        return '<span style="color:#999;font-style:italic;">No image</span>';
      }
      // Basic size guard: if raw length extremely large, indicate truncated display risk
      if (raw && raw.length > 500000) { // ~500 KB base64
        console.warn('[Image] Large base64 string (', raw.length, 'bytes) at', pathLabel);
      }
      // Provide small overlay action
      return `<div style="position:relative;display:inline-block;">
        <img src="${normalized}" alt="Image" class="report-image" onclick="openImageModal(this.src)" title="Click to view full size" loading="lazy">
      </div>`;
    }