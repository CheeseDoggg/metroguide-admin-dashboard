/* eslint-disable indent, max-len */
"use strict";

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const {getApps, initializeApp} = require("firebase-admin/app");
const {getDatabase} = require("firebase-admin/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");

// Initialize Admin SDK exactly once (default app) with explicit RTDB URL
// Using the same databaseURL as the client to avoid default instance resolution issues.
const app = getApps().length ? getApps()[0] : initializeApp({
  databaseURL: 'https://metro-guide-6b52a-default-rtdb.asia-southeast1.firebasedatabase.app',
});
const rtdb = getDatabase(app);

// Set default region to match your RTDB for lower latency.
setGlobalOptions({region: "asia-southeast1"});

const ALLOWLIST_EMAILS = new Set([
  'metroguidenu@gmail.com',
]);

function isValidTimestamp(v) {
  if (v == null) return false;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return true;
  // ISO string or other
  const p = Date.parse(v);
  return !Number.isNaN(p);
}
function normalizeTimestamp(v) {
  if (v == null) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const p = Date.parse(v);
  return Number.isNaN(p) ? null : p;
}

exports.adminListSOS = onCall({ region: 'asia-southeast1' }, async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in.');

  const email = (auth.token.email || '').toLowerCase();
  const uid = auth.uid;

  // Admin gate: email allowlist OR admins/<uid> = true
  let isAdmin = ALLOWLIST_EMAILS.has(email);
  if (!isAdmin) {
    try {
      const snap = await rtdb.ref(`admins/${uid}`).get();
      isAdmin = snap.exists() && snap.val() === true;
    } catch (error) {
      // ignore admin check error
    }
  }
  if (!isAdmin) {
    throw new HttpsError('permission-denied', 'Not authorized to list all SOS.');
  }

  const db = rtdb;
  const limit = Math.max(1, Math.min(10000, Number(req.data?.limit) || 1000));

  // Fetch users map to enrich (keyed by firebaseUID)
  let usersByUid = {};
  try {
    const usersSnap = await db.ref('users').get();
    const usersMap = usersSnap.exists() ? usersSnap.val() : {};
    Object.keys(usersMap || {}).forEach(k => {
      const u = usersMap[k];
      if (u && (u.firebaseUID || u.uid)) {
        usersByUid[u.firebaseUID || u.uid] = u;
      }
    });
  } catch (error) {
    // enrichment optional
  }

  const results = [];

  // Try to extract a userId from a log object using common fields
  function extractUserIdFromLog(log, fallbackUserId) {
    const cand = log?.userId || log?.uid || log?.user_id || log?.firebaseUID || log?.ownerId || log?.owner;
    return String(cand || fallbackUserId || '').trim() || null;
  }

  function toItem(logId, uidKeyOrNull, log) {
    if (!log || typeof log !== 'object') return null;
    if (log.deleted) return null;
    const userId = extractUserIdFromLog(log, uidKeyOrNull);
    const tsNum = normalizeTimestamp(log.timestamp);
    return {
      id: String(logId),
      userId,
      email: log.email || (userId ? usersByUid[userId]?.email : null) || null,
      username: log.username || (userId ? (usersByUid[userId]?.name || usersByUid[userId]?.username) : null) || null,
      latitude: (log.latitude != null && !Number.isNaN(Number(log.latitude))) ? Number(log.latitude) : null,
      longitude: (log.longitude != null && !Number.isNaN(Number(log.longitude))) ? Number(log.longitude) : null,
      timestamp: isValidTimestamp(log.timestamp) ? (typeof log.timestamp === 'number' ? log.timestamp : String(log.timestamp)) : null,
      _tsNum: tsNum,
    };
  }

  async function collectFrom(base) {
    const rootSnap = await db.ref(base).get();
    if (!rootSnap.exists()) return;
    const val = rootSnap.val() || {};
    const keysLevel1 = Object.keys(val);
    for (const k1 of keysLevel1) {
      if (results.length >= limit) return;
      const node = val[k1];
      // Case A: node itself looks like a log
      const itemA = toItem(k1, /*uid*/ null, node);
      if (itemA) {
        results.push(itemA);
        if (results.length >= limit) return;
        continue;
      }
      // Case B: node is an object of logs (nested under uid)
      if (node && typeof node === 'object') {
        const entries = Object.entries(node);
        for (const [k2, maybeLog] of entries) {
          if (results.length >= limit) return;
          const itemB = toItem(k2, /*uid*/ k1, maybeLog);
          if (itemB) {
            results.push(itemB);
            if (results.length >= limit) return;
          }
        }
      }
    }
  }

  // Try sos_logs first, then sos
  try { await collectFrom('sos_logs'); } catch (e) { /* swallow to keep function resilient */ }
  if (results.length < limit) {
    try { await collectFrom('sos'); } catch (e) { /* swallow to keep function resilient */ }
  }

  // Sort newest-first and trim to limit
  results.sort((a, b) => {
    const at = Number.isFinite(a._tsNum) ? a._tsNum : -Infinity;
    const bt = Number.isFinite(b._tsNum) ? b._tsNum : -Infinity;
    return bt - at;
  });
  const items = results.slice(0, limit).map(({ _tsNum, ...rest }) => rest);

  return { items };
});

// Callable function to verify/reject incidents using Admin SDK.
exports.moderateIncident = onCall(async (req) => {
    if (!req.auth) {
        throw new HttpsError("unauthenticated", "Sign-in required.");
    }

    const payload = req.data || {};
    const userId = payload.userId;
    const incidentId = payload.incidentId;
    const status = payload.status;

    if (!userId || !incidentId || !status) {
        throw new HttpsError(
                "invalid-argument", "Missing userId, incidentId, or status.");
    }

    const callerUid = req.auth.uid;
  const db = getDatabase();

    // Authorize: admins/<uid> or allowlisted email.
    const adminSnap = await db.ref(`admins/${callerUid}`).get();
    const token = req.auth.token || {};
    const email = String(token.email || "").toLowerCase();
    const allowlist = new Set(["metroguidenu@gmail.com"]);

    const isAdminFlag = adminSnap.exists() && adminSnap.val() === true;
    const isAllowlisted = allowlist.has(email);

    if (!isAdminFlag && !isAllowlisted) {
        throw new HttpsError("permission-denied", "Not authorized to moderate.");
    }

    const refPath = `incidents/${userId}/${incidentId}`;
    const now = Date.now();
    // Fetch existing for audit (non-fatal if fails)
    let prev = {};
    try {
      const prevSnap = await db.ref(refPath).get();
      if (prevSnap.exists()) prev = prevSnap.val() || {};
    } catch (_) { /* ignore */ }

    await db.ref(refPath).update({
      rdInc_status: String(status),
      moderatedBy: callerUid,
      moderatedAt: now,
      // legacy compatibility
      verifiedBy: callerUid,
      verifiedAt: now,
    });

    // Write moderation log (best-effort)
    try {
      await db.ref('moderation_logs').push({
        incidentUser: userId,
        incidentId,
        action: String(status),
        previousStatus: prev.rdInc_status || null,
        moderatorUid: callerUid,
        moderatorEmail: email,
        at: now,
      });
    } catch (e) {
      // logging is best-effort; do not fail the call
      console.warn('Failed to write moderation log', e);
    }

    return {ok: true};
});

// Scheduled cleanup: remove Verified or Rejected incidents after 3 hours
exports.expireVerifiedIncidents = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Asia/Manila' }, async () => {
  const now = Date.now();
  const db = rtdb;
  try {
    const rootSnap = await db.ref('incidents').get();
    if (!rootSnap.exists()) return null;

    const tasks = [];
    rootSnap.forEach((userSnap) => {
      const userId = userSnap.key;
      userSnap.forEach((incSnap) => {
        const incidentId = incSnap.key;
        const d = incSnap.val() || {};
        const status = String(d.rdInc_status || '').toLowerCase();
        if (status !== 'verified' && status !== 'rejected') return; // only expire verified or rejected

        // Determine moderation time; prefer moderatedAt / verifiedAt
        const basisTs = normalizeTimestamp(d.moderatedAt)
          || normalizeTimestamp(d.verifiedAt)
          || normalizeTimestamp(d.verificationTime)
          || normalizeTimestamp(d.updatedAt)
          || normalizeTimestamp(d.timestamp)
          || null;
        if (!basisTs) return; // no reliable timestamp; skip to avoid accidental deletions

        if ((now - basisTs) >= THREE_HOURS_MS_EXPIRE) {
          // Archive then remove
          const incidentRef = db.ref(`incidents/${userId}/${incidentId}`);
          const archiveRef = db.ref(`archived_incidents/${userId}/${incidentId}`);
          tasks.push(
            archiveRef.set({ ...d, archivedAt: now }).then(() => incidentRef.remove()).catch(() => null)
          );
        }
      });
    });
    if (tasks.length) await Promise.all(tasks);
    return { removed: tasks.length };
  } catch (e) {
    console.error('expireVerifiedIncidents error:', e);
    return null;
  }
});

// Helper: Calculate haversine distance in meters
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Helper: Extract latitude from incident data (matches frontend pickLat)
function extractLat(data) {
  if (!data || typeof data !== 'object') return null;
  
  function toNum(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
  }
  
  function parseLatLngString(s) {
    if (!s || typeof s !== 'string') return { lat: null };
    const parts = s.split(/[ ,]+/).filter(Boolean);
    if (parts.length < 1) return { lat: null };
    return { lat: toNum(parts[0]) };
  }
  
  // Combined string/object latlng fields
  if (typeof data.latlng === 'string') {
    const p = parseLatLngString(data.latlng);
    if (p.lat != null) return p.lat;
  }
  if (typeof data.latLng === 'string') {
    const p = parseLatLngString(data.latLng);
    if (p.lat != null) return p.lat;
  }
  if (typeof data.LatLng === 'string') {
    const p = parseLatLngString(data.LatLng);
    if (p.lat != null) return p.lat;
  }
  if (data.latlng && typeof data.latlng === 'object') {
    const v = toNum(data.latlng.lat ?? data.latlng.latitude);
    if (v != null) return v;
  }
  if (data.latLng && typeof data.latLng === 'object') {
    const v = toNum(data.latLng.lat ?? data.latLng.latitude);
    if (v != null) return v;
  }
  if (data.LatLng && typeof data.LatLng === 'object') {
    const v = toNum(data.LatLng.lat ?? data.LatLng.latitude);
    if (v != null) return v;
  }
  
  const candidates = [
    data.lat, data.latitude, data.Latitude, data.LAT, data.Lat, data.LATITUDE,
    data.location?.lat, data.location?.latitude,
    data.coords?.lat, data.coords?.latitude,
    data.coord?.lat, data.coord?.latitude,
    data.position?.lat, data.position?.latitude,
    data.geo?.lat, data.geo?.latitude,
    data.gps_lat, data.gpsLat, data.gpsLatitude,
    data.latLong?.lat, data.latlong?.lat, data.LatLong?.lat
  ];
  for (const c of candidates) {
    const v = toNum(c);
    if (v != null) return v;
  }
  return null;
}

// Helper: Extract longitude from incident data (matches frontend pickLng)
function extractLng(data) {
  if (!data || typeof data !== 'object') return null;
  
  function toNum(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
  }
  
  function parseLatLngString(s) {
    if (!s || typeof s !== 'string') return { lng: null };
    const parts = s.split(/[ ,]+/).filter(Boolean);
    if (parts.length < 2) return { lng: null };
    return { lng: toNum(parts[1]) };
  }
  
  // Combined string/object latlng fields
  if (typeof data.latlng === 'string') {
    const p = parseLatLngString(data.latlng);
    if (p.lng != null) return p.lng;
  }
  if (typeof data.latLng === 'string') {
    const p = parseLatLngString(data.latLng);
    if (p.lng != null) return p.lng;
  }
  if (typeof data.LatLng === 'string') {
    const p = parseLatLngString(data.LatLng);
    if (p.lng != null) return p.lng;
  }
  if (data.latlng && typeof data.latlng === 'object') {
    const v = toNum(data.latlng.lng ?? data.latlng.longitude);
    if (v != null) return v;
  }
  if (data.latLng && typeof data.latLng === 'object') {
    const v = toNum(data.latLng.lng ?? data.latLng.longitude);
    if (v != null) return v;
  }
  if (data.LatLng && typeof data.LatLng === 'object') {
    const v = toNum(data.LatLng.lng ?? data.LatLng.longitude);
    if (v != null) return v;
  }
  
  const candidates = [
    data.lng, data.longitude, data.Longitude, data.LNG, data.lon, data.Lon, data.LONGITUDE,
    data.location?.lng, data.location?.longitude,
    data.coords?.lng, data.coords?.longitude,
    data.coord?.lng, data.coord?.longitude,
    data.position?.lng, data.position?.longitude,
    data.geo?.lng, data.geo?.longitude,
    data.gps_lng, data.gpsLng, data.gpsLongitude,
    data.latLong?.lng, data.latlong?.lng, data.LatLong?.lng,
    data.longtitude, data.Longtitude
  ];
  for (const c of candidates) {
    const v = toNum(c);
    if (v != null) return v;
  }
  return null;
}

// Auto-verify clustered incidents: 5+ reports within 200m, same category, within 2 hours
// Once a cluster is verified, subsequent reports in that cluster will NOT be verified
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const THREE_HOURS_MS_EXPIRE = 3 * 60 * 60 * 1000;
const CLUSTER_RADIUS_METERS = 200;
const MIN_REPORTS_FOR_AUTO_VERIFY = 5;

// Helper: Check if incident has an image
function hasImage(data) {
  if (!data || typeof data !== 'object') return false;
  // Check multiple possible field names for images
  const imageCandidates = [
    data.imagefile, data.image, data.imagePath, data.photo, data.picture,
    data.img, data.imageUrl, data.photoUrl, data.imageFile,
    data.file, data.attachment, data.imageData
  ];
  for (const candidate of imageCandidates) {
    if (candidate && String(candidate).trim()) return true;
  }
  return false;
}

exports.autoVerifyClusteredIncidents = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Asia/Manila' }, async () => {
  const now = Date.now();
  const db = rtdb;
  
  try {
    const rootSnap = await db.ref('incidents').get();
    if (!rootSnap.exists()) {
      console.log('[autoVerifyClusteredIncidents] No incidents found');
      return { autoVerified: 0 };
    }

    // Collect all incidents with valid coordinates (including verified ones to identify locked clusters)
    const allIncidents = [];
    const verifiedIncidents = new Set(); // track which clusters are already verified
    let totalIncidents = 0;
    
    rootSnap.forEach((userSnap) => {
      const userId = userSnap.key;
      userSnap.forEach((incSnap) => {
        const incidentId = incSnap.key;
        const data = incSnap.val() || {};
        const status = String(data.rdInc_status || '').toLowerCase().trim();
        totalIncidents++;
        
        // Debug: Log first few incidents
        if (totalIncidents <= 3) {
          console.log(`[autoVerifyClusteredIncidents] Incident ${incidentId}: status="${status}", rdInc_status="${data.rdInc_status}"`);
        }
        
        const lat = extractLat(data);
        const lng = extractLng(data);
        const tsNum = normalizeTimestamp(data.timestamp) || normalizeTimestamp(data.createdAt) || now;
        const category = String(data.category || '').trim().toLowerCase();
        
        // Debug: Log coordinates for first few incidents
        if (totalIncidents <= 3) {
          console.log(`[autoVerifyClusteredIncidents] Coords for ${incidentId}: lat=${lat}, lng=${lng}, category="${category}", hasLat=${Number.isFinite(lat)}, hasLng=${Number.isFinite(lng)}`);
        }
        
        // Must have coordinates and category
        if (Number.isFinite(lat) && Number.isFinite(lng) && category) {
          allIncidents.push({
            userId,
            incidentId,
            data,
            lat,
            lng,
            tsNum,
            category,
            status
          });
          
          // Mark verified incidents (they indicate a locked cluster)
          if (status === 'verified' || status === 'auto-verified') {
            verifiedIncidents.add(`${lat.toFixed(6)}_${lng.toFixed(6)}_${category}`);
          }
        }
      });
    });

    // Collect ONLY pending incidents (not rejected, verified, or deleted)
    const pendingIncidents = allIncidents.filter((inc, idx) => {
      const status = String(inc.data.rdInc_status || '').toLowerCase().trim();
      // Accept pending/unverified incidents (anything not explicitly verified/rejected/deleted)
      const isPending = !['verified', 'rejected', 'deleted', 'auto-verified', 'archived'].includes(status);
      if (idx < 5) {
        console.log(`[autoVerifyClusteredIncidents] Filter check [${idx}]: status="${status}", isPending=${isPending}`);
      }
      return isPending;
    });

    console.log(`[autoVerifyClusteredIncidents] Total incidents: ${totalIncidents}, Pending: ${pendingIncidents.length}, Min required: ${MIN_REPORTS_FOR_AUTO_VERIFY}`);

    // Debug: Log all pending incidents with their coordinates
    pendingIncidents.forEach((inc, idx) => {
      console.log(`[autoVerifyClusteredIncidents] Pending[${idx}]: lat=${inc.lat}, lng=${inc.lng}, category="${inc.category}", timestamp=${new Date(inc.tsNum).toISOString()}`);
    });

    if (pendingIncidents.length < MIN_REPORTS_FOR_AUTO_VERIFY) {
      console.log(`[autoVerifyClusteredIncidents] Not enough pending incidents (${pendingIncidents.length} < ${MIN_REPORTS_FOR_AUTO_VERIFY})`);
      return { autoVerified: 0, pendingCount: pendingIncidents.length };
    }

    // Simple DBSCAN-like clustering
    const visited = new Set();
    const clusters = [];

    for (let i = 0; i < pendingIncidents.length; i++) {
      if (visited.has(i)) continue;
      
      const seed = pendingIncidents[i];
      const neighbors = [];
      
      // Find all neighbors within 200m, same category, within 2 hours
      for (let j = 0; j < pendingIncidents.length; j++) {
        if (i === j || visited.has(j)) continue;
        const other = pendingIncidents[j];
        
        // Check category
        if (seed.category !== other.category) {
          continue;
        }
        
        // Check time window
        if (Math.abs(seed.tsNum - other.tsNum) > TWO_HOURS_MS) {
          continue;
        }
        
        // Check distance
        const dist = haversineMeters(seed.lat, seed.lng, other.lat, other.lng);
        console.log(`[autoVerifyClusteredIncidents] Distance between incident ${i} and ${j}: ${dist.toFixed(2)}m (threshold: ${CLUSTER_RADIUS_METERS}m)`);
        if (dist <= CLUSTER_RADIUS_METERS) {
          neighbors.push(j);
          console.log(`[autoVerifyClusteredIncidents]   ✓ Added as neighbor`);
        } else {
          console.log(`[autoVerifyClusteredIncidents]   ✗ Too far, not a neighbor`);
        }
      }

      // If cluster has enough reports (including seed), mark for auto-verification
      if (neighbors.length + 1 >= MIN_REPORTS_FOR_AUTO_VERIFY) {
        const clusterMembers = [i, ...neighbors];
        clusters.push(clusterMembers);
        clusterMembers.forEach(idx => visited.add(idx));
        console.log(`[autoVerifyClusteredIncidents] Found cluster with ${clusterMembers.length} reports, category: ${seed.category}`);
      } else {
        console.log(`[autoVerifyClusteredIncidents] Incident ${i}: Only ${neighbors.length + 1} reports in cluster (need ${MIN_REPORTS_FOR_AUTO_VERIFY})`);
        visited.add(i);
      }
    }

    console.log(`[autoVerifyClusteredIncidents] Total clusters found: ${clusters.length}`);

    // Auto-verify reports in each cluster
    // PRIORITY: 
    // 1. If any report has an image, verify the LATEST one WITH an image
    // 2. If none have images, verify ONLY the LATEST one
    // BUT: Skip clusters that already have a verified incident (cluster is locked)
    let autoVerifiedCount = 0;
    const updates = [];

    for (const clusterMembers of clusters) {
      // Get all members with their picture status
      const membersWithStatus = clusterMembers.map(idx => ({
        idx,
        incident: pendingIncidents[idx],
        hasPicture: hasImage(pendingIncidents[idx].data),
        timestamp: pendingIncidents[idx].tsNum
      }));
      
      // Separate reports with and without pictures
      const withPictures = membersWithStatus.filter(m => m.hasPicture);
      const withoutPictures = membersWithStatus.filter(m => !m.hasPicture);
      
      // Sort both groups by timestamp (most recent first)
      withPictures.sort((a, b) => b.timestamp - a.timestamp);
      withoutPictures.sort((a, b) => b.timestamp - a.timestamp);
      
      let selectedMembers = [];
      
      // Rule 1: If any have pictures, verify ALL that have pictures (latest ones first)
      if (withPictures.length > 0) {
        // Verify all reports with pictures
        selectedMembers = withPictures;
        console.log(`[autoVerifyClusteredIncidents] Cluster with pictures: selecting ${selectedMembers.length} reports WITH pictures`);
      } else if (withoutPictures.length > 0) {
        // If no pictures, verify only the latest one
        selectedMembers = [withoutPictures[0]];
        console.log(`[autoVerifyClusteredIncidents] Cluster without pictures: selecting 1 report (latest)`);
      }
      
      // Check if this cluster already has a verified incident
      const latestIncident = selectedMembers[0]?.incident || pendingIncidents[clusterMembers[0]];
      const clusterKey = `${latestIncident.lat.toFixed(6)}_${latestIncident.lng.toFixed(6)}_${latestIncident.category}`;
      if (verifiedIncidents.has(clusterKey)) {
        // Cluster already locked; do not verify new reports
        console.log(`[autoVerifyClusteredIncidents] Skipping cluster ${clusterKey}: already has 1 verified incident`);
        continue;
      }
      
      // Verify selected reports in this cluster
      for (const selectedMember of selectedMembers) {
        const incident = selectedMember.incident;
        const pictureNote = selectedMember.hasPicture ? ' (with picture)' : ' (latest, no picture)';
        const updateData = {
          rdInc_status: 'Verified',
          autoVerifiedAt: now,
          autoVerifiedReason: `Auto-verified: ${selectedMember.hasPicture ? 'report with picture' : 'latest'} of ${clusterMembers.length} reports in proximity cluster (200m, ${incident.category}, within 2 hours). Cluster locked.${pictureNote}`,
          moderatedBy: 'system-auto-verify',
          moderatedAt: now,
          verifiedBy: 'system-auto-verify',
          verifiedAt: now,
          clusterLocked: true // Mark cluster as locked
        };

        updates.push(
          db.ref(`incidents/${incident.userId}/${incident.incidentId}`).update(updateData)
            .then(() => {
              autoVerifiedCount++;
              console.log(`[autoVerifyClusteredIncidents] Auto-verified: ${incident.userId}/${incident.incidentId}`);
              // Log auto-verification (best-effort)
              return db.ref('moderation_logs').push({
                incidentUser: incident.userId,
                incidentId: incident.incidentId,
                action: 'Verified',
                previousStatus: incident.data.rdInc_status || 'Pending',
                moderatorUid: 'system-auto-verify',
                moderatorEmail: 'system@auto-verify',
                at: now,
                reason: `Auto-verified: ${selectedMember.hasPicture ? 'report with picture' : 'latest'} of ${clusterMembers.length} reports in proximity cluster (200m). Cluster now locked.`
              }).catch(() => null); // logging is best-effort
            })
            .catch(err => console.warn(`Failed to auto-verify ${incident.userId}/${incident.incidentId}:`, err))
        );
      }
    }

    if (updates.length > 0) await Promise.all(updates);
    console.log(`[autoVerifyClusteredIncidents] Auto-verified ${autoVerifiedCount} reports total`);
    return { autoVerified: autoVerifiedCount, clustersFound: clusters.length };
  } catch (e) {
    console.error('autoVerifyClusteredIncidents error:', e);
    return { autoVerified: 0, error: e.message };
  }
});

// Automatically purge incident reports marked as deleted after 2 hours
exports.purgeDeletedIncidents = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Asia/Manila' }, async () => {
  try {
    const now = Date.now();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
    let purgedCount = 0;

    // Scan all incidents
    const incidentsSnapshot = await rtdb.ref('incidents').get();
    if (!incidentsSnapshot.exists()) {
      return { purged: 0 };
    }

    const allIncidents = incidentsSnapshot.val();
    const updates = [];

    // Iterate through all users and their incidents
    Object.keys(allIncidents).forEach(userId => {
      const userIncidents = allIncidents[userId];
      if (!userIncidents || typeof userIncidents !== 'object') return;

      Object.keys(userIncidents).forEach(incidentId => {
        const incident = userIncidents[incidentId];
        if (!incident || typeof incident !== 'object') return;

        // Check if incident is marked as deleted
        if (incident.rdInc_status === 'deleted' && incident.deletedAt) {
          const deletedAt = normalizeTimestamp(incident.deletedAt);
          if (deletedAt && (now - deletedAt) >= TWO_HOURS_MS) {
            // Purge this incident
            updates.push(
              rtdb.ref(`incidents/${userId}/${incidentId}`).remove()
                .then(() => {
                  purgedCount++;
                  console.log(`Purged deleted incident: ${userId}/${incidentId}`);
                })
                .catch(err => console.warn(`Failed to purge ${userId}/${incidentId}:`, err))
            );
          }
        }
      });
    });

    if (updates.length > 0) await Promise.all(updates);
    return { purged: purgedCount };
  } catch (e) {
    console.error('purgeDeletedIncidents error:', e);
    return { purged: 0, error: e.message };
  }
});

// One-time cleanup: Remove all incidents with status='deleted' (legacy from old deletion method)
exports.cleanupOldDeletedIncidents = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Asia/Manila' }, async () => {
  try {
    const incidentsSnapshot = await rtdb.ref('incidents').get();
    if (!incidentsSnapshot.exists()) {
      return { cleaned: 0 };
    }

    const allIncidents = incidentsSnapshot.val();
    const updates = [];
    let cleanedCount = 0;

    // Iterate through all users and their incidents
    Object.keys(allIncidents).forEach(userId => {
      const userIncidents = allIncidents[userId];
      if (!userIncidents || typeof userIncidents !== 'object') return;

      Object.keys(userIncidents).forEach(incidentId => {
        const incident = userIncidents[incidentId];
        if (!incident || typeof incident !== 'object') return;

        // Remove any incident with status='deleted' (old deletion method)
        if (incident.rdInc_status === 'deleted') {
          updates.push(
            rtdb.ref(`incidents/${userId}/${incidentId}`).remove()
              .then(() => {
                cleanedCount++;
                console.log(`Cleaned up deleted incident: ${userId}/${incidentId}`);
              })
              .catch(err => console.warn(`Failed to clean ${userId}/${incidentId}:`, err))
          );
        }
      });
    });

    if (updates.length > 0) await Promise.all(updates);
    return { cleaned: cleanedCount };
  } catch (e) {
    console.error('cleanupOldDeletedIncidents error:', e);
    return { cleaned: 0, error: e.message };
  }
});
