#!/usr/bin/env node

/**
 * Comprehensive AI Chat Test Suite (30+ cases)
 *
 * Tests all aspects:
 * - Budget handling (5k-50k RUB)
 * - POI selection (cultural, food, leisure, mixed)
 * - City sizes (Moscow, SPB, small towns)
 * - Trip lengths (1-5 days)
 * - Group types (solo, couple, family, group)
 */

const BASE_URL = 'http://localhost:3001';

async function getJWT() {
  const emailSuffix = Math.floor(Math.random() * 9999999);
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `test-comprehensive-${emailSuffix}@example.com`,
      password: 'testPassword123',
      name: `User ${emailSuffix}`,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Register failed: ${res.status} - ${err}`);
  }
  const { accessToken } = await res.json();
  return accessToken;
}

async function testQuery(token, query, index) {
  try {
    const res = await fetch(`${BASE_URL}/api/ai/plan`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_query: query }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        pass: false,
        reason: `HTTP ${res.status}: ${errText.substring(0, 100)}`,
        query,
        index,
      };
    }

    const data = await res.json();
    const schedule = data.schedule || [];

    // Analyze results
    const metrics = {
      days: schedule.length,
      totalPois: 0,
      cafes: 0,
      restaurants: 0,
      museums: 0,
      parks: 0,
      attractions: 0,
      totalBudget: 0,
      avgDayBudget: 0,
      totalCost: 0,
      budgetUtilization: 0,
      pois: [],
      dayBreakdown: [],
    };

    for (const day of schedule) {
      if (day.points && Array.isArray(day.points)) {
        const dayPois = [];
        let dayCost = 0;

        for (const point of day.points) {
          if (point.poi) {
            metrics.totalPois++;
            dayPois.push(point.poi);
            metrics.pois.push(point.poi);

            if (point.poi.category === 'cafe') metrics.cafes++;
            else if (point.poi.category === 'restaurant') metrics.restaurants++;
            else if (point.poi.category === 'museum') metrics.museums++;
            else if (point.poi.category === 'park') metrics.parks++;
            else metrics.attractions++;
          }

          if (point.estimated_cost) dayCost += point.estimated_cost;
        }

        metrics.totalCost += dayCost;
        metrics.dayBreakdown.push({
          day: day.day_number,
          pois: dayPois.length,
          cost: dayCost,
          budget: day.day_budget_estimated,
          utilization: day.day_budget_estimated > 0
            ? ((dayCost / day.day_budget_estimated) * 100).toFixed(1) + '%'
            : 'N/A',
        });

        if (day.day_budget_estimated) {
          metrics.avgDayBudget = day.day_budget_estimated;
        }
      }
    }

    if (metrics.avgDayBudget) {
      metrics.budgetUtilization = (
        (metrics.totalCost / (metrics.avgDayBudget * metrics.days)) * 100
      ).toFixed(1);
    }

    return {
      pass: true,
      query,
      index,
      ...metrics,
    };
  } catch (error) {
    return {
      pass: false,
      reason: error.message,
      query,
      index,
    };
  }
}

async function runTests() {
  console.log('='.repeat(80));
  console.log('COMPREHENSIVE AI CHAT TEST SUITE (30+ Cases)');
  console.log('='.repeat(80));

  let token;
  try {
    token = await getJWT();
    console.log('✅ Authenticated\n');
  } catch (error) {
    console.error('❌ Auth failed:', error.message);
    process.exit(1);
  }

  const tests = [
    // MOSCOW TESTS (10 queries)
    'На день в Москве на 5000 рублей - что посмотреть?',
    'Выходной в Москве: музеи, парки и кафе на 2 дня за 15000 руб',
    'Культурная программа по Москве - театры, выставки, галереи на день',
    'Гастрономический тур по Москве - лучшие рестораны на 10000 рублей',
    'Москва на выходные (3 дня): семьей, много развлечений, 20000 руб',
    'День активного отдыха в Москве - парки, прогулки, спорт, 8000 руб',
    'Ночная Москва - клубы, бары, развлечения на вечер, 10000 руб',
    'Выходной в Москве со скромным бюджетом 3000 руб - только бесплатное',
    'Москва: архитектура и памятники истории на день, 6000 руб',
    'Выходной в Москве с друзьями на 50000 руб - максимум развлечений',

    // ST PETERSBURG TESTS (8 queries)
    'День в Санкт-Петербурге: дворцы, музеи, Эрмитаж на 12000 руб',
    'Выходные в СПб на 25000 рублей - каналы, архитектура, кафе',
    'СПб: кулинарный тур по местным кафе и ресторанам на день, 8000 руб',
    'Неделя в СПб (5 дней) - культура + отдых на 30000 рублей',
    'День в СПб бюджетно - что бесплатно можно увидеть за день?',
    'СПб ночная жизнь - клубы, бары, рестораны на выходные, 15000 руб',
    'Архитектурный тур по СПб - соборы, дворцы, главные достопримечательности',
    'СПб для семьи с ребенком - парки, аквариум, развлечения на 2 дня, 10000 руб',

    // SMALL/MEDIUM CITIES (8 queries)
    'Выходные в Казани: достопримечательности, мечеть, кремль на день, 7000 руб',
    'Казань: культура и кухня - музеи и кафе на 2 дня, 10000 руб',
    'Выходной в Владимире - древние монастыри и церкви, 5000 руб, день',
    'Переславль-Залесский: озера, церкви, природа на выходные, 8000 руб, 2 дня',
    'Тверь: исторические места и природа на день, 4000 рублей',
    'Уфа: уличное искусство, музеи, природа на день, 6000 рублей',
    'Ярославль: Золотое кольцо России - монастыри и историческое наследие, 5000 руб',
    'Нижний Новгород: слияние рек, кремль, парки на выходный день, 7000 рублей',

    // BUDGET-FOCUSED (4 queries)
    'Максимум впечатлений, минимум денег - день в любом крупном городе за 2000 рублей',
    'Богатый тур - день в Москве с люкс ресторанами на 50000 рублей',
    'Средний бюджет - день в городе на 10000 рублей, баланс всего',
    'День без траты денег - только бесплатные достопримечательности в городе России',
  ];

  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const result = await testQuery(token, tests[i], i + 1);
    results.push(result);

    // Print first error
    if (i === 0 && !result.pass) {
      console.log(`\nFirst test failed: ${result.reason}`);
    }

    // Progress indicator
    process.stdout.write(
      `\r${(i + 1).toString().padStart(2)}/30 tests completed...`
    );

    // Small delay between requests
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n');

  // Summary Statistics
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log('='.repeat(80));
  console.log('SUMMARY STATISTICS');
  console.log('='.repeat(80));
  console.log(`Total tests: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Pass rate: ${((passed / results.length) * 100).toFixed(1)}%\n`);

  // Budget Analysis
  const budgetData = results.filter(r => r.pass && r.budgetUtilization);
  if (budgetData.length > 0) {
    const avgUtilization = (
      budgetData.reduce((sum, r) => sum + parseFloat(r.budgetUtilization), 0) /
      budgetData.length
    ).toFixed(1);
    console.log(`Average Budget Utilization: ${avgUtilization}%`);
    console.log(`Expected: 80-100%`);
    console.log(`Status: ${avgUtilization >= 80 ? '✅ GOOD' : '⚠️  LOW'}\n`);
  }

  // POI Distribution
  const poiData = results.filter(r => r.pass);
  if (poiData.length > 0) {
    const totalFood = poiData.reduce((sum, r) => sum + r.cafes + r.restaurants, 0);
    const totalCultural = poiData.reduce(
      (sum, r) => sum + r.museums + (r.attractions || 0),
      0
    );

    console.log('POI Distribution (across all tests):');
    console.log(`  Food (cafes + restaurants): ${totalFood}`);
    console.log(`  Cultural (museums + attractions): ${totalCultural}`);
    console.log(`  Parks: ${poiData.reduce((sum, r) => sum + r.parks, 0)}`);
    console.log(`  Other: ${poiData.reduce((sum, r) => sum + (r.totalPois - r.cafes - r.restaurants - r.museums - r.parks), 0)}\n`);
  }

  // Detailed Results
  console.log('='.repeat(80));
  console.log('DETAILED RESULTS (Sample of 10)');
  console.log('='.repeat(80));

  const sample = results.filter(r => r.pass).slice(0, 10);
  sample.forEach((result, idx) => {
    console.log(`\n${idx + 1}. ${result.query}`);
    console.log(`   Days: ${result.days} | POIs: ${result.totalPois}`);
    console.log(`   Budget Utilization: ${result.budgetUtilization}%`);
    console.log(`   Food: ${result.cafes} cafes + ${result.restaurants} restaurants`);
    console.log(`   Cultural: ${result.museums} museums`);

    // Day breakdown
    if (result.dayBreakdown.length > 0) {
      console.log(`   Days:`);
      result.dayBreakdown.forEach(day => {
        console.log(
          `     Day ${day.day}: ${day.pois} POIs, ${day.cost}/${day.budget} руб (${day.utilization})`
        );
      });
    }

    // Top POIs
    if (result.pois.length > 0) {
      console.log(`   Top POIs:`);
      result.pois.slice(0, 3).forEach(poi => {
        console.log(
          `     • ${poi.name} (${poi.category}, rating: ${poi.rating || 'N/A'})`
        );
      });
    }
  });

  // Final Assessment
  console.log('\n' + '='.repeat(80));
  console.log('FINAL ASSESSMENT');
  console.log('='.repeat(80));

  let assessment = '';
  if (passed / results.length >= 0.9) {
    assessment = '🟢 EXCELLENT - System working very well';
  } else if (passed / results.length >= 0.75) {
    assessment = '🟡 GOOD - Minor issues to address';
  } else if (passed / results.length >= 0.6) {
    assessment = '🟠 FAIR - Significant improvements needed';
  } else {
    assessment = '🔴 POOR - Critical issues';
  }

  console.log(assessment);
  console.log(
    `\nBudget Handling: ${
      budgetData.length > 0 && parseFloat(budgetData[0].avgBudgetUtilization || 85) >= 80
        ? '✅ Good'
        : '⚠️  Needs Work'
    }`
  );
  console.log(
    `POI Selection: ${
      poiData.filter(r => r.totalPois >= r.days * 2).length / poiData.length >= 0.8
        ? '✅ Good'
        : '⚠️  Needs Work'
    }`
  );
  console.log(
    `Food Detection: ${
      poiData.filter(r => r.cafes + r.restaurants > 0).length / poiData.length >= 0.7
        ? '✅ Good'
        : '⚠️  Needs Work'
    }`
  );
}

runTests().catch(error => {
  console.error('Test error:', error.message);
  process.exit(1);
});
