#!/usr/bin/env node
/**
 * TRI-108-4: Semantic POI Filtering Tests
 * Tests cultural vs entertainment distinction in AI pipeline
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

async function testQuery(name, query, expectedMinCulturalPois = 0) {
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
    const allPois = [];
    for (const day of data.route_plan.days) {
      if (day.points && Array.isArray(day.points)) {
        allPois.push(
          ...day.points.map((p) => ({
            ...p.poi,
            order: p.order,
          })),
        );
      }
    }

    // Count cultural vs entertainment POIs
    const culturalPois = allPois.filter((poi) =>
      /museum|музей|gallery|галере|theater|театр|cathedral|собор|monument|памятник|historical|историч/.test(
        (poi.category || '').toLowerCase(),
      ),
    );

    const entertainmentPois = allPois.filter((poi) =>
      /aquarium|аквариум|photo.zone|фото.*зона|event.space|развлечени/.test(
        (poi.category || '').toLowerCase(),
      ),
    );

    const foodPois = allPois.filter((poi) =>
      /restaurant|ресторан|cafe|кафе|bar|бар/.test((poi.category || '').toLowerCase()),
    );

    console.log(`   ✓ Response received`);
    console.log(`   📊 Stats:`);
    console.log(`      Total POIs: ${allPois.length}`);
    console.log(`      Cultural: ${culturalPois.length}`);
    console.log(`      Entertainment: ${entertainmentPois.length}`);
    console.log(`      Food: ${foodPois.length}`);

    // Log POI breakdown
    if (culturalPois.length > 0) {
      console.log(`   🏛️  Cultural: ${culturalPois.map((p) => p.name).join(', ')}`);
    }
    if (entertainmentPois.length > 0) {
      console.log(`   🎪 Entertainment: ${entertainmentPois.map((p) => p.name).join(', ')}`);
    }
    if (foodPois.length > 0) {
      console.log(`   🍽️  Food: ${foodPois.map((p) => p.name).join(', ')}`);
    }

    // Check budget utilization
    const totalBudget = data.route_plan.total_budget_estimated;
    const totalSpent = data.route_plan.days.reduce(
      (sum, day) => sum + (day.day_budget_estimated || 0),
      0,
    );
    const utilization = totalBudget > 0 ? ((totalSpent / totalBudget) * 100).toFixed(1) : 0;
    console.log(`   💰 Budget: ${totalSpent}/${totalBudget} (${utilization}%)`);

    // Assertions
    let passed = true;
    const issues = [];

    if (expectedMinCulturalPois > 0 && culturalPois.length < expectedMinCulturalPois) {
      issues.push(`Expected ≥${expectedMinCulturalPois} cultural POIs, got ${culturalPois.length}`);
      passed = false;
    }

    if (query.includes('культур') && entertainmentPois.length > 0) {
      issues.push(`Cultural query should not include entertainment venues (found ${entertainmentPois.length})`);
      passed = false;
    }

    if (query.includes('кафе') && foodPois.length === 0) {
      issues.push('Food-focused query should include food venues');
      passed = false;
    }

    if (passed) {
      console.log(`   ✅ PASS`);
      testsPassed++;
    } else {
      console.log(`   ❌ FAIL: ${issues.join('; ')}`);
      testsFailed++;
    }

    return { allPois, culturalPois, entertainmentPois, foodPois };
  } catch (error) {
    console.log(`   ❌ FAIL: ${error.message}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log('🚀 TRI-108-4: Semantic POI Filtering Tests\n');
  console.log('='.repeat(60));

  try {
    await registerUser();
    console.log('='.repeat(60));

    // Test Set 1: Cultural Queries (should have museums, galleries, theaters; NO aquariums)
    await testQuery(
      'Cultural program - museums focus',
      'Культурная программа: музеи и галереи в Москве на 1 день',
      2,
    );

    await testQuery(
      'Cultural with cafes (TRI-108-1 + TRI-108-4)',
      'Рассчитай культурную программу с крутыми кафе в Москве на 1 день за 15 тыс рублей',
      1, // Should have museums + cafes
    );

    await testQuery(
      'Theater and monuments',
      'Театры и памятники, исторические места в Москве на 1 день',
      1,
    );

    await testQuery(
      'Historical sites tour',
      'Исторический тур: старые районы, достопримечательности в Санкт-Петербурге',
      1,
    );

    // Test Set 2: Entertainment/Leisure Queries (should allow aquariums, parks, events)
    await testQuery(
      'Entertainment and fun',
      'Развлечения с парками и аквариумом для семьи в Москве на 1 день',
      0, // Not culturally focused
    );

    await testQuery(
      'Leisure activities',
      'Парки, природные объекты, активный отдых в Москве',
      0,
    );

    // Test Set 3: Food-First Queries (TRI-108-1)
    await testQuery(
      'Food exploration - cafes',
      'Классные кафе и рестораны в Москве на 1 день, бюджет 5000',
      0, // Food focus, not cultural
    );

    await testQuery(
      'Food and culture combined',
      'Музеи и хорошие рестораны в центре Москвы на 1 день',
      1, // Some cultural
    );

    // Test Set 4: Mixed Queries
    await testQuery(
      'Culture + leisure + food',
      'Полный день в Москве: музеи, парки, кафе - всё включить',
      1, // Should have mix
    );

    await testQuery(
      'City exploration',
      'Интересные места города, памятники, кофейни в Москве',
      1,
    );

    // Test Set 5: Exclusion Tests (verify aquarium doesn't appear in cultural queries)
    await testQuery(
      'Pure museum query',
      'Только музеи в Москве, ничего больше на 1 день',
      2, // Should be mostly museums
    );

    await testQuery(
      'Gallery tour',
      'Галереи, выставки, искусство в Санкт-Петербурге на 1 день',
      1,
    );

    // Test Set 6: Night life queries (should be distinct from cultural)
    await testQuery(
      'Nightlife - clubs and bars',
      'Ночная жизнь: клубы, бары, развлечения в Москве',
      0,
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
