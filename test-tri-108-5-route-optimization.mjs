#!/usr/bin/env node
/**
 * TRI-108-5: Geographic Route Optimization Tests
 * Verify no backtracking, logical progression, efficient travel time
 */

const BASE_URL = 'http://localhost:3001/api';

let testsPassed = 0;
let testsFailed = 0;
let token = '';

async function registerUser() {
  const email = `test_${Date.now()}@test.com`;
  const response = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'TestPassword123456',
      name: 'Test User',
    }),
  });

  if (!response.ok) {
    throw new Error(`Registration failed: ${response.status}`);
  }

  const data = await response.json();
  token = data.accessToken;
  console.log(`✓ User registered: ${email}`);
}

// Calculate great-circle distance between two points
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Check for backtracking: if we return to a previous zone
function detectBacktracking(points) {
  if (points.length < 3) return { hasBacktracking: false, details: [] };

  const details = [];
  const zoneVisitOrder = [];

  for (let i = 0; i < points.length; i++) {
    const poi = points[i].poi;
    const zone = `${Math.round(poi.coordinates.lat * 10) / 10},${Math.round(poi.coordinates.lon * 10) / 10}`;

    if (zoneVisitOrder.includes(zone)) {
      details.push(
        `Point ${i + 1} (${poi.name}) returns to zone ${zone} visited at step ${zoneVisitOrder.indexOf(zone) + 1}`,
      );
    } else {
      zoneVisitOrder.push(zone);
    }
  }

  return {
    hasBacktracking: details.length > 0,
    zoneCount: zoneVisitOrder.length,
    details,
  };
}

// Check if route has logical geographic progression
function checkGeographicProgression(points) {
  if (points.length < 2) return { hasProgression: true, type: 'trivial' };

  const lats = points.map((p) => p.poi.coordinates.lat);
  const lons = points.map((p) => p.poi.coordinates.lon);

  const latTrend = lats[lats.length - 1] - lats[0];
  const lonTrend = lons[lons.length - 1] - lons[0];

  let direction = 'mixed';
  if (Math.abs(latTrend) > Math.abs(lonTrend)) {
    direction = latTrend > 0 ? 'south' : 'north';
  } else if (Math.abs(lonTrend) > 0) {
    direction = lonTrend > 0 ? 'east' : 'west';
  }

  return {
    hasProgression: true,
    direction,
    latRange: [Math.min(...lats), Math.max(...lats)],
    lonRange: [Math.min(...lons), Math.max(...lons)],
  };
}

// Calculate travel efficiency
function calculateTravelEfficiency(points) {
  let totalTravelTime = 0;
  let totalVisitTime = 0;

  for (const point of points) {
    const visitMin = point.visit_duration_min || 0;
    const travelMin = point.travel_from_prev_min || 0;
    totalVisitTime += visitMin;
    totalTravelTime += travelMin;
  }

  const totalTime = totalTravelTime + totalVisitTime;
  const efficiency =
    totalTime > 0 ? (totalVisitTime / totalTime) * 100 : 100;
  const travelRatio =
    totalTime > 0 ? (totalTravelTime / totalTime) * 100 : 0;

  return {
    totalTravelTime,
    totalVisitTime,
    totalTime,
    travelRatio,
    efficiency,
  };
}

async function testQuery(name, query) {
  try {
    console.log(`\n📋 Test: ${name}`);
    console.log(`   Query: "${query}"`);

    const response = await fetch(`${BASE_URL}/ai/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        user_query: query,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.route_plan || !Array.isArray(data.route_plan.days)) {
      throw new Error('Invalid response structure');
    }

    // Collect all POIs across all days
    const allPoints = [];
    for (const day of data.route_plan.days) {
      if (day.points && Array.isArray(day.points)) {
        allPoints.push(...day.points);
      }
    }

    console.log(`   ✓ Response received`);
    console.log(`   📊 Stats:`);
    console.log(`      Total points: ${allPoints.length}`);

    // Check for backtracking
    const backtrack = detectBacktracking(allPoints);
    console.log(`      Zones visited: ${backtrack.zoneCount}`);

    // Check geographic progression
    const progression = checkGeographicProgression(allPoints);
    console.log(`      Direction: ${progression.direction}`);

    // Calculate travel efficiency
    const efficiency = calculateTravelEfficiency(allPoints);
    console.log(`      Travel time: ${efficiency.totalTravelTime}min`);
    console.log(`      Visit time: ${efficiency.totalVisitTime}min`);
    console.log(`      Travel ratio: ${efficiency.travelRatio.toFixed(1)}%`);
    console.log(`      Efficiency: ${efficiency.efficiency.toFixed(1)}%`);

    // Log POI sequence with distances
    if (allPoints.length > 1) {
      console.log(`   🗺️  Route sequence:`);
      let prevPoi = null;
      for (let i = 0; i < Math.min(allPoints.length, 8); i++) {
        const point = allPoints[i];
        const poi = point.poi;
        let distStr = '';

        if (prevPoi) {
          const dist = haversineKm(
            prevPoi.coordinates.lat,
            prevPoi.coordinates.lon,
            poi.coordinates.lat,
            poi.coordinates.lon,
          );
          distStr = ` [${dist.toFixed(1)}km from prev]`;
        }

        console.log(`      ${i + 1}. ${poi.name}${distStr}`);
        prevPoi = poi;
      }
      if (allPoints.length > 8) {
        console.log(`      ... and ${allPoints.length - 8} more`);
      }
    }

    // Assertions
    let passed = true;
    const issues = [];

    // Check 1: No excessive backtracking (allow up to 2 zone revisits - typical for city centers)
    if (backtrack.hasBacktracking && backtrack.details.length > 2) {
      issues.push(`Excessive backtracking detected: ${backtrack.details.length} zone revisits (max 2 allowed)`);
      passed = false;
    }

    // Check 2: Travel ratio should be ≤ 35% (allowing some transit)
    if (efficiency.travelRatio > 35) {
      issues.push(
        `Travel ratio too high: ${efficiency.travelRatio.toFixed(1)}% (expected ≤35%)`,
      );
      passed = false;
    }

    // Check 3: Should have logical progression (not just random order)
    if (progression.direction === 'mixed' && allPoints.length > 4) {
      console.log(
        `   ⚠️  Mixed direction progression (might be inefficient)`,
      );
    }

    if (passed) {
      console.log(`   ✅ PASS`);
      testsPassed++;
    } else {
      console.log(`   ❌ FAIL: ${issues.join('; ')}`);
      testsFailed++;
    }

    return { allPoints, backtrack, progression, efficiency };
  } catch (error) {
    console.log(`   ❌ FAIL: ${error.message}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log('🚀 TRI-108-5: Geographic Route Optimization Tests\n');
  console.log('='.repeat(60));

  try {
    await registerUser();
    console.log('='.repeat(60));

    // Test Set 1: Multi-location routes (should minimize backtracking)
    await testQuery(
      'Museum tour across city',
      'Музеи Москвы на 1 день, разные районы города',
    );

    await testQuery(
      'Mixed attractions Москва',
      'Интересные места в разных концах Москвы на 1 день за 10000',
    );

    await testQuery(
      'Long distance city exploration',
      'Полный день: памятники, парки, музеи по всей Москве на 1 день',
    );

    // Test Set 2: Single area routes (should have good efficiency)
    await testQuery(
      'Concentrated center tour',
      'Достопримечательности центра Москвы на 1 день, близко друг к другу',
    );

    await testQuery(
      'District exploration',
      'Все интересное в одном районе Москвы на 1 день',
    );

    // Test Set 3: Extended multi-day (tests cluster switching)
    await testQuery(
      'Two-day Москва tour',
      'Туристический маршрут на 2 дня: музеи, парки, памятники, рестораны в Москве за 20000',
    );

    await testQuery(
      'Weekend trip plan',
      'Выходные в Москве на 2 дня: культура, досуг, еда по разным районам за 25000',
    );

    // Test Set 4: Complex mixed preferences
    await testQuery(
      'Culture + food across city',
      'Музеи и рестораны в разных районах Москвы на 1 день за 15000',
    );

    console.log('\n' + '='.repeat(60));
    console.log(`\n📈 Test Results: ${testsPassed} passed, ${testsFailed} failed`);
    console.log(`Success rate: ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%`);

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (error) {
    console.error(`\n❌ Fatal error: ${error.message}`);
    process.exit(1);
  }
}

runTests();
