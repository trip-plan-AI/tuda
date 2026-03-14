import fetch from 'node-fetch';

const API_URL = 'http://localhost:3000';
const TOKEN = process.env.TEST_TOKEN || 'test-jwt-token';

async function registerUser() {
  const res = await fetch(`${API_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `test-${Date.now()}@example.com`,
      password: 'Test@1234',
    }),
  });

  if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function testFoodQuery(token, query, city) {
  console.log(`\n🍽️ Testing: "${query}" in ${city}`);
  
  const res = await fetch(`${API_URL}/api/ai/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      user_request: query,
      city,
      days: 1,
      budget_total: 15000,
      party_type: 'couple',
      party_size: 2,
    }),
  });

  if (!res.ok) {
    console.error(`  ❌ HTTP ${res.status}`);
    return null;
  }

  const plan = await res.json();
  const day1 = plan.itinerary?.[0];
  
  if (!day1) {
    console.log('  ❌ No itinerary returned');
    return null;
  }

  const foodPois = day1.points.filter(p => 
    p.poi.category === 'restaurant' || p.poi.category === 'cafe'
  );

  console.log(`  ✅ Total POIs: ${day1.points.length}`);
  console.log(`  🍽️  Food POIs: ${foodPois.length}`);
  
  if (foodPois.length > 0) {
    foodPois.forEach(p => {
      console.log(`     - ${p.poi.name} (${p.poi.category})`);
    });
  }

  return { total: day1.points.length, food: foodPois.length };
}

async function main() {
  console.log('🔍 TRI-108-6 FOOD DETECTION DIAGNOSTIC\n');
  
  try {
    const token = await registerUser();
    console.log('✅ User registered');

    const results = [];
    
    // Food-focused queries
    const queries = [
      { q: 'рассчитай культурную программу с крутыми кафе', city: 'Москва' },
      { q: 'найди лучшие рестораны и музеи', city: 'Москва' },
      { q: 'поешь хорошо и посмотри достопримечательности', city: 'Санкт-Петербург' },
      { q: 'маршрут с кофе-брейками', city: 'Казань' },
      { q: 'гастротур по городу', city: 'Москва' },
    ];

    for (const { q, city } of queries) {
      const result = await testFoodQuery(token, q, city);
      if (result) results.push(result);
      await new Promise(r => setTimeout(r, 500)); // Rate limit
    }

    console.log('\n📊 SUMMARY:');
    const totalTests = results.length;
    const withFood = results.filter(r => r.food > 0).length;
    const foodSuccess = totalTests > 0 ? ((withFood / totalTests) * 100).toFixed(1) : 0;
    
    console.log(`  Total tests: ${totalTests}`);
    console.log(`  With food: ${withFood}/${totalTests} (${foodSuccess}%)`);
    
    if (withFood === 0) {
      console.log('\n⚠️  FOOD DETECTION STILL NOT WORKING!');
      console.log('  Check /api logs for TRI-108-6 DEBUG messages');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

main();
