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
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

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

        if ((now - basisTs) >= TWO_HOURS_MS) {
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

// Helper: Extract latitude from incident data
function extractLat(data) {
  if (!data) return null;
  const candidates = [
    data.lat, data.latitude, data.Latitude,
    data.latlng?.lat, data.latLng?.lat, data.LatLng?.lat,
    data.location?.lat, data.coords?.lat, data.position?.lat,
    data.gps_lat, data.gpsLat
  ];
  for (const c of candidates) {
    const v = Number(c);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// Helper: Extract longitude from incident data
function extractLng(data) {
  if (!data) return null;
  const candidates = [
    data.lng, data.longitude, data.Longitude,
    data.latlng?.lng, data.latLng?.lng, data.LatLng?.lng,
    data.location?.lng, data.coords?.lng, data.position?.lng,
    data.gps_lng, data.gpsLng
  ];
  for (const c of candidates) {
    const v = Number(c);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// Auto-verify clustered incidents: 5+ reports within 200m, same category, within 2 hours
// Once a cluster is verified, subsequent reports in that cluster will NOT be verified
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const CLUSTER_RADIUS_METERS = 200;
const MIN_REPORTS_FOR_AUTO_VERIFY = 5;

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
    let skippedIncidents = 0;
    
    rootSnap.forEach((userSnap) => {
      const userId = userSnap.key;
      userSnap.forEach((incSnap) => {
        const incidentId = incSnap.key;
        const data = incSnap.val() || {};
        const status = String(data.rdInc_status || '').toLowerCase();
        totalIncidents++;
        
        // Debug: Log first few incidents
        if (totalIncidents <= 3) {
          console.log(`[autoVerifyClusteredIncidents] Incident ${incidentId}: status="${status}", rdInc_status="${data.rdInc_status}"`);
        }
        
        const lat = extractLat(data);
        const lng = extractLng(data);
        const tsNum = normalizeTimestamp(data.timestamp) || normalizeTimestamp(data.createdAt) || now;
        const category = String(data.category || '').trim().toLowerCase();
        
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
          if (status === 'verified') {
            verifiedIncidents.add(`${lat.toFixed(6)}_${lng.toFixed(6)}_${category}`);
          }
        }
      });
    });

    // Collect ONLY pending incidents (not rejected or deleted)
    const pendingIncidents = allIncidents.filter(inc => {
      const status = String(inc.data.rdInc_status || '').toLowerCase();
      return status !== 'verified' && status !== 'rejected' && status !== 'deleted';
    });

    console.log(`[autoVerifyClusteredIncidents] Total incidents: ${totalIncidents}, Pending: ${pendingIncidents.length}, Min required: ${MIN_REPORTS_FOR_AUTO_VERIFY}`);

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
        if (seed.category !== other.category) continue;
        
        // Check time window
        if (Math.abs(seed.tsNum - other.tsNum) > TWO_HOURS_MS) continue;
        
        // Check distance
        const dist = haversineMeters(seed.lat, seed.lng, other.lat, other.lng);
        if (dist <= CLUSTER_RADIUS_METERS) {
          neighbors.push(j);
        }
      }

      // If cluster has enough reports (including seed), mark for auto-verification
      if (neighbors.length + 1 >= MIN_REPORTS_FOR_AUTO_VERIFY) {
        const clusterMembers = [i, ...neighbors];
        clusters.push(clusterMembers);
        clusterMembers.forEach(idx => visited.add(idx));
        console.log(`[autoVerifyClusteredIncidents] Found cluster with ${clusterMembers.length} reports, category: ${seed.category}`);
      } else {
        visited.add(i);
      }
    }

    console.log(`[autoVerifyClusteredIncidents] Total clusters found: ${clusters.length}`);

    // Auto-verify only the latest report in each cluster
    // BUT: Skip clusters that already have a verified incident (cluster is locked)
    let autoVerifiedCount = 0;
    const updates = [];

    for (const clusterMembers of clusters) {
      // Find the latest report in the cluster
      let latestIdx = clusterMembers[0];
      let latestTime = pendingIncidents[clusterMembers[0]].tsNum;
      
      for (let i = 1; i < clusterMembers.length; i++) {
        const idx = clusterMembers[i];
        const tsNum = pendingIncidents[idx].tsNum;
        if (tsNum > latestTime) {
          latestTime = tsNum;
          latestIdx = idx;
        }
      }
      
      const latestIncident = pendingIncidents[latestIdx];
      
      // Check if this cluster already has a verified incident
      const clusterKey = `${latestIncident.lat.toFixed(6)}_${latestIncident.lng.toFixed(6)}_${latestIncident.category}`;
      if (verifiedIncidents.has(clusterKey)) {
        // Cluster already locked; do not verify new reports
        console.log(`Skipping cluster ${clusterKey}: already has 1 verified incident`);
        continue;
      }
      
      // Verify only the latest report in this cluster
      const updateData = {
        rdInc_status: 'Verified',
        autoVerifiedAt: now,
        autoVerifiedReason: `Auto-verified: latest of ${clusterMembers.length} reports within 200m, category: ${latestIncident.category}, within 2 hours. Cluster locked.`,
        moderatedBy: 'system-auto-verify',
        moderatedAt: now,
        verifiedBy: 'system-auto-verify',
        verifiedAt: now,
        clusterLocked: true // Mark cluster as locked
      };

      updates.push(
        db.ref(`incidents/${latestIncident.userId}/${latestIncident.incidentId}`).update(updateData)
          .then(() => {
            autoVerifiedCount++;
            // Log auto-verification (best-effort)
            return db.ref('moderation_logs').push({
              incidentUser: latestIncident.userId,
              incidentId: latestIncident.incidentId,
              action: 'Verified',
              previousStatus: latestIncident.data.rdInc_status || 'Pending',
              moderatorUid: 'system-auto-verify',
              moderatorEmail: 'system@auto-verify',
              at: now,
              reason: `Auto-verified: latest of ${clusterMembers.length} reports in proximity cluster (200m). Cluster now locked.`
            }).catch(() => null); // logging is best-effort
          })
          .catch(err => console.warn(`Failed to auto-verify ${latestIncident.userId}/${latestIncident.incidentId}:`, err))
      );
    }

    if (updates.length > 0) await Promise.all(updates);
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
