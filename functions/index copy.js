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
    await db.ref(refPath).update({
        rdInc_status: String(status),
        verifiedBy: callerUid,
        verifiedAt: Date.now(),
    });

    return {ok: true};
});

// Scheduled cleanup: remove Verified incidents after 3 hours
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

exports.expireVerifiedIncidents = onSchedule({ schedule: 'every 5 minutes', timeZone: 'UTC' }, async () => {
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
        if (status !== 'verified') return; // only expire verified incidents

        // Determine the verification time; prefer verifiedAt set by moderateIncident
        const basisTs = normalizeTimestamp(d.verifiedAt)
          || normalizeTimestamp(d.verificationTime)
          || normalizeTimestamp(d.updatedAt)
          || normalizeTimestamp(d.timestamp)
          || null;
        if (!basisTs) return; // no reliable timestamp; skip to avoid accidental deletions

        if ((now - basisTs) >= THREE_HOURS_MS) {
          // Remove the incident entirely
          tasks.push(db.ref(`incidents/${userId}/${incidentId}`).remove().catch(() => null));
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
