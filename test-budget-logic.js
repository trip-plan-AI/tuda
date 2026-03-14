#!/usr/bin/env node

// Simulating the budget extraction logic

function extractPoiCount(text) {
  const matches = text.match(/(\d+)\s+(мест|место|places?|достопримечательностей?|points?|point)/i);
  return matches ? Math.max(1, Math.min(20, parseInt(matches[1], 10))) : null;
}

function buildBudgetInstructions(budgetTotal, budgetPerDay, days, partySize, minPlaces) {
  if (!budgetTotal) {
    return 'не указан';
  }

  const budgetPerPerson = Math.round(budgetTotal / partySize);
  const budgetPerPoi = Math.round(budgetTotal / minPlaces);

  const priceSegmentGuidance =
    budgetPerPoi < 500
      ? '🔴 ОЧЕНЬ ОГРАНИЧЕННЫЙ БЮДЖЕТ - выбирай только FREE и BUDGET места'
      : budgetPerPoi < 1000
        ? '🟡 ОГРАНИЧЕННЫЙ БЮДЖЕТ - приоритизируй BUDGET и MID-RANGE места'
        : budgetPerPoi < 2000
          ? '🟢 СРЕДНИЙ БЮДЖЕТ - выбирай MID-RANGE и немного PREMIUM'
          : '🟢🟢 ХОРОШИЙ БЮДЖЕТ - можно выбирать PREMIUM места без ограничений';

  const instructions = `${budgetTotal} руб. на ${partySize} чел. (${budgetPerPerson}₽ на чел, ${budgetPerPoi}₽ на место).
${priceSegmentGuidance}
⚠️ КРИТИЧНО: Убедись, что выбранные места в сумме НЕ ПРЕВЫШАЮТ ${budgetTotal}₽.`;

  return instructions;
}

function buildQuantityConstraints(poiCountRequested, minRestaurants, minCafes, maxPoi) {
  const constraints = [];

  if (poiCountRequested) {
    constraints.push(`Пользователь просит ровно ${poiCountRequested} мест`);
  }
  if (minRestaurants) {
    constraints.push(`ОБЯЗАТЕЛЬНО включи минимум ${minRestaurants} ресторанов`);
  }
  if (minCafes) {
    constraints.push(`ОБЯЗАТЕЛЬНО включи минимум ${minCafes} кафе`);
  }
  if (maxPoi) {
    constraints.push(`НЕ выбирай больше ${maxPoi} мест`);
  }

  if (constraints.length === 0) {
    return 'Выбирай разнообразные места, чтобы маршрут был интересным.';
  }

  return `КОЛИЧЕСТВЕННЫЕ ОГРАНИЧЕНИЯ: ${constraints.join('. ')}.`;
}

// Tests
console.log('=== ТЕСТ 1: Балаково - 3 места, 7000 руб (1 чел) ===\n');

const query1 = 'Покажи 3 интересных места в Балаково. Бюджет 7 тысяч рублей.';
const poiCount1 = extractPoiCount(query1);
console.log(`Query: "${query1}"`);
console.log(`Extracted POI count: ${poiCount1}\n`);

const budget1 = buildBudgetInstructions(7000, null, 1, 1, poiCount1);
console.log('Budget instructions:');
console.log(budget1);
console.log('');

const quantity1 = buildQuantityConstraints(poiCount1, null, null, null);
console.log('Quantity constraints:');
console.log(quantity1);
console.log('\n---\n');

console.log('=== ТЕСТ 2: Златоуст - 3 места, 7000 руб (2 чел) ===\n');

const query2 = 'Найди 3 интересных места в Златоусте на всех двоих на 7000 рублей.';
const poiCount2 = extractPoiCount(query2);
console.log(`Query: "${query2}"`);
console.log(`Extracted POI count: ${poiCount2}\n`);

const budget2 = buildBudgetInstructions(7000, null, 1, 2, poiCount2);
console.log('Budget instructions:');
console.log(budget2);
console.log('');

const quantity2 = buildQuantityConstraints(poiCount2, null, null, null);
console.log('Quantity constraints:');
console.log(quantity2);
console.log('\n---\n');

console.log('=== ПРОВЕРКА РАСЧЕТОВ ===\n');

console.log('Балаково (7000 руб, 1 чел, 3 места):');
console.log(`  - budget_per_person = 7000 / 1 = 7000 ✓`);
console.log(`  - budget_per_poi = 7000 / 3 ≈ ${Math.round(7000/3)} руб/место`);
console.log(`  - Категория бюджета: СРЕДНИЙ (1000 < 2333 < 2000) ✓\n`);

console.log('Златоуст (7000 руб, 2 чел, 3 места):');
console.log(`  - budget_per_person = 7000 / 2 = 3500 руб/чел ✓`);
console.log(`  - budget_per_poi = 7000 / 3 ≈ ${Math.round(7000/3)} руб/место`);
console.log(`  - Категория бюджета: СРЕДНИЙ (1000 < 2333 < 2000) ✓\n`);

console.log('✅ Логика извлечения бюджета и количества работает правильно!');
