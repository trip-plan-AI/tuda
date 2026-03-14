#!/usr/bin/env node

/**
 * TRI-108-6: Food Venue Detection via Photon/Nominatim
 *
 * Tests for supplemental food venue search when:
 * 1. Food intent detected (hasFoodFocus = true)
 * 2. KudaGo/Overpass returned < 2 food POIs
 * 3. Photon search supplements food venues
 *
 * Test queries focus on food-centric searches in different cities
 */

const BASE_URL = 'http://localhost:3001';

async function getJWT() {
  const emailSuffix = Math.floor(Math.random() * 1000000);
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `test-tri108-6-${emailSuffix}@example.com`,
      password: 'testPassword123',
      username: `test-user-${emailSuffix}`,
    }),
  });

  if (!res.ok) throw new Error(`Register failed: ${res.status}`);
  const { access_token } = await res.json();
  return access_token;
}

async function testQuery(token, query, testName) {
  console.log(`\n📍 TEST: ${testName}`);
  console.log(`Query: "${query}"`);

  const res = await fetch(`${BASE_URL}/api/ai/plan`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    console.error(`❌ HTTP ${res.status}`);
    return { pass: false, reason: `HTTP ${res.status}` };
  }

  const data = await res.json();
  const schedule = data.schedule || [];

  // Collect all POIs from all days
  const allPois = [];
  for (const day of schedule) {
    if (day.points && Array.isArray(day.points)) {
      for (const point of day.points) {
        if (point.poi) allPois.push(point.poi);
      }
    }
  }

  // Count food venues
  const cafes = allPois.filter(p => p.category === 'cafe').length;
  const restaurants = allPois.filter(p => p.category === 'restaurant').length;
  const totalFood = cafes + restaurants;

  console.log(`Total POIs: ${allPois.length}`);
  console.log(`  - Cafes: ${cafes}`);
  console.log(`  - Restaurants: ${restaurants}`);
  console.log(`  - Total food: ${totalFood}`);

  // List food venues
  const foodVenues = allPois.filter(p =>
    p.category === 'cafe' || p.category === 'restaurant'
  );
  if (foodVenues.length > 0) {
    console.log(`Food venues:`);
    foodVenues.forEach((v, i) => {
      console.log(`  ${i + 1}. ${v.name} (${v.category}, rating: ${v.rating || 'N/A'})`);
    });
  }

  const pass = totalFood >= 1;
  if (pass) {
    console.log(`✅ PASS: Found ${totalFood} food venues (threshold: 1)`);
  } else {
    console.log(`❌ FAIL: Expected >= 1 food venue, got ${totalFood}`);
  }

  return { pass, totalFood, cafes, restaurants };
}

async function runTests() {
  console.log('='.repeat(70));
  console.log('TRI-108-6: Food Venue Detection Tests');
  console.log('='.repeat(70));

  let token;
  try {
    token = await getJWT();
    console.log('✅ Authenticated successfully');
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    process.exit(1);
  }

  const tests = [
    // Russian food-centric queries
    {
      query: 'Рассчитай гастрономический тур по Москве на 1 день с лучшими кафе',
      name: 'Gastro tour with cafes in Moscow',
    },
    {
      query: 'Покажи маршрут по Санкт-Петербургу с ресторанами и кофейнями на день',
      name: 'Restaurants and coffee shops in SPB',
    },
    {
      query: 'Куда сходить в Казани поесть хорошо? На день, с посещением интересных кафе',
      name: 'Food-focused day in Kazan',
    },
    {
      query: 'День в Екатеринбурге: музеи, парки и кафе на 1 день за 5000 рублей',
      name: 'Mixed tour with cafes in Ekaterinburg',
    },
    {
      query: 'Кулинарный тур по Нижнему Новгороду - ресторан, кафе, местная кухня на день',
      name: 'Culinary tour in Nizhny Novgorod',
    },
    {
      query: 'Я хочу провести день в Волгограде с хорошей едой и кафе',
      name: 'Day in Volgograd with food focus',
    },
    {
      query: 'Спланируй маршрут по кафе Ярославля на 1 день',
      name: 'Cafe tour in Yaroslavl',
    },
    {
      query: 'Хочу попробовать местные блюда в Уфе, покажи маршрут с ресторанами на день',
      name: 'Local cuisine in Ufa',
    },
    {
      query: 'День в Краснодаре: что посмотреть и где хорошо поесть?',
      name: 'Sightseeing + food in Krasnodar',
    },
    {
      query: 'Мне нужен маршрут по кафе и пекарням Новосибирска на день',
      name: 'Cafes and bakeries in Novosibirsk',
    },
  ];

  const results = [];
  for (const test of tests) {
    const result = await testQuery(token, test.query, test.name);
    results.push({ ...test, ...result });
    // Small delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const passed = results.filter(r => r.pass).length;
  const passRate = ((passed / results.length) * 100).toFixed(1);

  console.log(`Total tests: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${results.length - passed}`);
  console.log(`Pass rate: ${passRate}%`);

  console.log('\nResults by test:');
  results.forEach((r, i) => {
    const status = r.pass ? '✅' : '❌';
    console.log(
      `${status} ${i + 1}. ${r.name.padEnd(45)} | Food: ${r.totalFood} ` +
      `(${r.restaurants}R + ${r.cafes}C)`
    );
  });

  // Threshold for TRI-108-6 success: at least 70% of food-focused queries return >= 1 food venue
  const successThreshold = 0.7;
  if (passed / results.length >= successThreshold) {
    console.log(`\n🎉 TRI-108-6 PASS: ${passRate}% >= ${(successThreshold * 100).toFixed(0)}%`);
  } else {
    console.log(`\n⚠️ TRI-108-6 NEEDS WORK: ${passRate}% < ${(successThreshold * 100).toFixed(0)}%`);
  }
}

runTests().catch(error => {
  console.error('Test suite error:', error);
  process.exit(1);
});
