#!/usr/bin/env node

/**
 * Quick Test Suite (10 key scenarios)
 * Fast feedback on budget, POI selection, food detection
 */

const BASE_URL = 'http://localhost:3001';

async function getJWT() {
  const emailSuffix = Math.floor(Math.random() * 9999999);
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `test-quick-${emailSuffix}@example.com`,
      password: 'testPassword123',
      name: `Test User ${emailSuffix}`,
    }),
  });

  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const { accessToken } = await res.json();
  return accessToken;
}

async function testQuery(token, query, testName) {
  console.log(`\n📍 ${testName}`);
  console.log(`   Query: "${query.substring(0, 60)}..."`);

  const startTime = Date.now();
  const res = await fetch(`${BASE_URL}/api/ai/plan`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_query: query }),
  });

  const elapsed = Date.now() - startTime;

  if (!res.ok) {
    console.log(`   ❌ FAIL: HTTP ${res.status} (${elapsed}ms)`);
    return { pass: false };
  }

  const data = await res.json();
  const days = data.route_plan?.days || [];

  // Collect metrics
  let totalPois = 0,
    cafes = 0,
    restaurants = 0,
    totalCost = 0,
    totalBudget = 0;

  for (const day of days) {
    if (day.points && Array.isArray(day.points)) {
      for (const point of day.points) {
        if (point.poi) {
          totalPois++;
          if (point.poi.category === 'cafe') cafes++;
          else if (point.poi.category === 'restaurant') restaurants++;
          if (point.estimated_cost) totalCost += point.estimated_cost;
        }
      }
    }
    if (day.day_budget_estimated) totalBudget += day.day_budget_estimated;
  }

  const budgetUtilization = totalBudget > 0
    ? ((totalCost / totalBudget) * 100).toFixed(1)
    : 0;

  console.log(`   ✅ OK (${elapsed}ms)`);
  console.log(
    `   Metrics: ${totalPois} POIs | ${cafes}C+${restaurants}R food | Budget: ${totalCost}/${totalBudget}₽ (${budgetUtilization}%)`
  );

  return {
    pass: true,
    totalPois,
    food: cafes + restaurants,
    budgetUtilization: parseFloat(budgetUtilization),
  };
}

async function main() {
  console.log('='.repeat(70));
  console.log('QUICK TEST SUITE (10 Key Scenarios)');
  console.log('='.repeat(70));

  let token;
  try {
    token = await getJWT();
    console.log('✅ Authenticated\n');
  } catch (error) {
    console.error('❌ Auth failed:', error.message);
    process.exit(1);
  }

  const tests = [
    {
      name: '1. Moscow, 1 day, 5k budget, cultural focus',
      query: 'День в Москве на 5000 рублей - музеи, культура, галереи',
    },
    {
      name: '2. St. Petersburg, 2 days, 15k budget, mixed',
      query: 'Выходные в СПб на 15000 рублей - театры, парки, кафе',
    },
    {
      name: '3. Small town (Kazan), 1 day, 7k budget',
      query: 'День в Казани за 7000 рублей - что посмотреть, где поесть',
    },
    {
      name: '4. Food-focused, Moscow, 1 day, 10k budget',
      query: 'Гастрономический тур по Москве - рестораны и кафе на день, 10000 рублей',
    },
    {
      name: '5. Budget-tight, any city, 3k RUB',
      query: 'Маршрут на день в любом крупном городе за 3000 рублей',
    },
    {
      name: '6. Luxury, Moscow, 3 days, 50k budget',
      query: 'Роскошный тур по Москве на 3 дня за 50000 рублей - максимум',
    },
    {
      name: '7. Family trip, parks + food, 2 days',
      query: 'Выходные с семьей - парки, развлечения, хорошие рестораны, 20000 рублей',
    },
    {
      name: '8. Night life, Moscow, 1 evening',
      query: 'Ночной тур по Москве - клубы, бары, живая музыка, 8000 рублей',
    },
    {
      name: '9. Nature focus, 5 days, moderate budget',
      query: 'Неделя на природе - озера, лес, парки, 5 дней, 25000 рублей',
    },
    {
      name: '10. Architecture tour, small budget',
      query: 'Архитектурный тур - дворцы, старинные здания, памятники на день, 6000 рублей',
    },
  ];

  const results = [];
  for (const test of tests) {
    const result = await testQuery(token, test.query, test.name);
    results.push(result);

    // Delay between requests
    await new Promise(r => setTimeout(r, 1000));
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const passed = results.filter(r => r.pass).length;
  console.log(`Passed: ${passed}/10`);

  const withFood = results.filter(r => r.pass && r.food > 0).length;
  console.log(`With food venues: ${withFood}/10`);

  const avgBudget = results.filter(r => r.pass).length > 0
    ? (results
      .filter(r => r.pass)
      .reduce((sum, r) => sum + r.budgetUtilization, 0) / passed).toFixed(1)
    : 0;
  console.log(`Average budget utilization: ${avgBudget}%`);

  const avgPois = results.filter(r => r.pass).length > 0
    ? Math.round(
      results
        .filter(r => r.pass)
        .reduce((sum, r) => sum + r.totalPois, 0) / passed
    )
    : 0;
  console.log(`Average POIs/route: ${avgPois}`);

  console.log('\n' + '='.repeat(70));
  console.log('ASSESSMENT');
  console.log('='.repeat(70));

  const foodScore = ((withFood / 10) * 100).toFixed(0);
  const budgetScore = avgBudget;
  const poiScore = avgPois >= 8 ? 'Good' : avgPois >= 5 ? 'Fair' : 'Low';

  console.log(`Food Detection: ${foodScore}% (${withFood}/10 have food)`);
  console.log(`Budget Handling: ${budgetScore}% utilization`);
  console.log(`POI Selection: ${poiScore} (avg ${avgPois} POIs)`);

  const overallScore =
    foodScore >= 70 && budgetScore >= 80 && avgPois >= 8 ? '🟢 EXCELLENT' :
    foodScore >= 50 && budgetScore >= 70 && avgPois >= 5 ? '🟡 GOOD' :
    '🔴 NEEDS WORK';

  console.log(`\nOverall: ${overallScore}`);
}

main().catch(error => {
  console.error('Test error:', error.message);
  process.exit(1);
});
