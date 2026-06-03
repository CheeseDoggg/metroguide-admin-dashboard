const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { readFileSync } = require("fs");
const path = require("path");

// Get service account key
const serviceAccountPath = path.join(__dirname, 'metro-guide-6b52a-firebase-adminsdk-rkdpd-abc12345def67.json');
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));

const app = initializeApp({
  credential: require("firebase-admin/app").cert(serviceAccount),
  databaseURL: 'https://metro-guide-6b52a-default-rtdb.asia-southeast1.firebasedatabase.app',
});

const db = getDatabase(app);

async function debugCoordinates() {
  try {
    console.log('=== Debugging Incident Coordinates ===\n');
    
    const snapshot = await db.ref('incidents').limitToFirst(10).get();
    
    if (!snapshot.exists()) {
      console.log('No incidents found');
      process.exit(0);
    }

    snapshot.forEach((userSnap) => {
      const userId = userSnap.key;
      console.log(`\n--- User: ${userId} ---`);
      
      userSnap.forEach((incSnap) => {
        const incidentId = incSnap.key;
        const data = incSnap.val() || {};
        
        console.log(`\nIncident ID: ${incidentId}`);
        console.log(`Status: ${data.rdInc_status || 'N/A'}`);
        console.log(`Category: ${data.category || 'N/A'}`);
        console.log('\nAll fields:');
        Object.keys(data).forEach(key => {
          const val = data[key];
          if (typeof val !== 'object') {
            console.log(`  ${key}: ${val}`);
          } else {
            console.log(`  ${key}: [object]`);
          }
        });
        
        // Check for coordinate fields
        console.log('\nCoordinate analysis:');
        console.log(`  lat: ${data.lat}`);
        console.log(`  latitude: ${data.latitude}`);
        console.log(`  Latitude: ${data.Latitude}`);
        console.log(`  lng: ${data.lng}`);
        console.log(`  longitude: ${data.longitude}`);
        console.log(`  Longitude: ${data.Longitude}`);
        console.log(`  latlng: ${JSON.stringify(data.latlng)}`);
        console.log(`  latLng: ${JSON.stringify(data.latLng)}`);
        console.log(`  location: ${JSON.stringify(data.location)}`);
        console.log(`  coords: ${JSON.stringify(data.coords)}`);
        console.log(`  position: ${JSON.stringify(data.position)}`);
      });
    });

    process.exit(0);
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}

debugCoordinates();
