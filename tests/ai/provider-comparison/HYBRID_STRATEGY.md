# Hybrid Provider Selection Strategy for Semantic Filtering

**Date:** 2026-03-14
**Test Suite:** 6 foreign cities, 30 POI total
**Key Finding:** Neither provider is "wrong" — they have fundamentally different philosophies

## Test Results Summary

| Metric | YandexGPT | OpenRouter | Winner |
|--------|-----------|-----------|--------|
| **Avg Response Time** | 2,465ms | 2,614ms | Yandex (5% faster) |
| **Historic Sites** | 8 (26%) | 4 (13%) | Yandex (2x more) |
| **Restaurants** | 10 (33%) | 10 (33%) | Tie |
| **Cafes** | 2 (6%) | 4 (13%) | OpenRouter (2x more) |
| **Attractions** | 8 (26%) | 10 (33%) | OpenRouter |
| **Avg Agreement** | — | — | 67% (meaningful divergence) |

## Key Insight: Different Travel Philosophies

### YandexGPT Model
**Philosophy:** "Cultural Preservation"
- Prioritizes historical/cultural significance
- Treats monuments, temples, museums as primary narrative
- Slightly faster responses
- Better for heritage tourists

**Evidence from tests:**
- Kyoto: Selected 4 temples (80% temples) vs OpenRouter's 3 attractions
- Krakow cultural: Selected 2 museums vs OpenRouter's same museums
- Porto: Selected 2 historic sites vs OpenRouter's 1

### OpenRouter (GPT-4o-mini) Model
**Philosophy:** "Experience Curation"
- Balances culture with dining, activities, cafes
- Treats travel as multi-sensory journey
- Slightly slower (reasonable for quality)
- Better for leisure/experience tourists

**Evidence from tests:**
- Kyoto: Selected tea ceremony + bamboo paths vs Yandex's temples
- Valencia: Included cafe (4/5 success) vs Yandex's seafood market
- Porto: Included cafe option (Francesinha) for quick bites

---

## Implementation Strategy: 3 Options

### Option A: Decision Tree (Recommended for MVP)
```
IF user explicitly requests "temples" or "museums" or "historical":
  ✅ Use YandexGPT (explicit cultural preference)

ELSE IF food_mode === "gastrotour":
  ✅ Use OpenRouter (better cafe inclusion)

ELSE IF food_mode === "none" AND city has <=5 historic sites in input:
  ✅ Use OpenRouter (avoid over-filtering historic sites)

ELSE:
  ✅ Use YandexGPT (Russian cultural understanding better)
```

**Pros:**
- Simple to implement (4 conditions)
- No LLM required for decision
- Clear reasoning for analytics
- Easy to A/B test each branch

**Cons:**
- Misses nuance for mixed preferences
- Hardcoded assumptions about city types

**Implementation Effort:** 30 minutes

### Option B: Category-Based Weighting (Medium complexity)
```
IF input_categories.includes("museum", "historic"):
  confidence_yandex = 0.8
  confidence_openrouter = 0.2

ELSE IF input_categories.includes("cafe", "restaurant"):
  confidence_yandex = 0.4
  confidence_openrouter = 0.6

ELSE:
  confidence_yandex = 0.6
  confidence_openrouter = 0.4

// Call both, merge results by confidence weight
```

**Pros:**
- More nuanced than Option A
- Adapts to input POI mix
- Can ensemble results

**Cons:**
- Higher latency (call both providers)
- Merge logic is complex
- Harder to debug

**Implementation Effort:** 2-3 hours

### Option C: LLM-Based Decision (High quality but slower)
```
// Route decision to GPT-4o-mini
Ask LLM: "Which provider (YandexGPT or OpenRouter) is better for this request?"
Input: user_query, city, categories, food_mode
Output: provider_recommendation + confidence

// Then call selected provider
```

**Pros:**
- Most intelligent routing
- Adapts to any request type
- Single API call overhead

**Cons:**
- +2-3 seconds latency (extra LLM call)
- Not cost-effective for simple cases
- Adds complexity

**Implementation Effort:** 4 hours

---

## Recommended Implementation: Option A

### Decision Logic

```typescript
// apps/api/src/ai/pipeline/semantic-filter.service.ts

async selectWithHybridProvider(
  pois: PoiItem[],
  intent: ParsedIntent,
  fallbacks: string[]
): Promise<FilteredPoi[]> {

  // Rule 1: Explicit cultural preference in query
  const hasCulturalKeywords = [
    'museum', 'gallery', 'temple', 'church', 'cathedral',
    'historical', 'historic', 'ancient', 'heritage',
    'архитектура', 'музей', 'храм', 'исторический'
  ].some(keyword => intent.raw_query?.toLowerCase().includes(keyword));

  if (hasCulturalKeywords) {
    fallbacks.push('HYBRID_YANDEX:explicit_cultural');
    return this.selectWithYandex(pois, intent);
  }

  // Rule 2: Gastrotour mode → OpenRouter includes more cafes
  if (intent.food_policy?.food_mode === 'gastrotour') {
    fallbacks.push('HYBRID_OPENROUTER:gastrotour_mode');
    return this.selectWithOpenRouter(pois, intent);
  }

  // Rule 3: Few historic sites + no cultural keywords → OpenRouter
  const historicCount = pois.filter(p => p.category === 'historic').length;
  if (historicCount <= 3 && !hasCulturalKeywords) {
    fallbacks.push('HYBRID_OPENROUTER:few_historic_sites');
    return this.selectWithOpenRouter(pois, intent);
  }

  // Rule 4: Default for Russian cities → YandexGPT
  if (this.isCyrillicCity(intent.city)) {
    fallbacks.push('HYBRID_YANDEX:russian_city');
    return this.selectWithYandex(pois, intent);
  }

  // Rule 5: Default for foreign cities → OpenRouter
  fallbacks.push('HYBRID_OPENROUTER:foreign_default');
  return this.selectWithOpenRouter(pois, intent);
}

private isCyrillicCity(city: string): boolean {
  return /[А-Яа-яЁё]/.test(city);
}
```

### Analytics & A/B Testing

Track which rule was applied:
```json
{
  "route_decision": {
    "rule": "HYBRID_OPENROUTER:gastrotour_mode",
    "provider": "openrouter",
    "confidence": 0.95,
    "timestamp": "2026-03-14T04:41:00Z"
  },
  "results": {
    "count": 6,
    "categories": {"restaurant": 3, "cafe": 2, "museum": 1}
  }
}
```

This allows:
1. Measuring agreement rates per rule
2. A/B testing each rule in isolation
3. Detecting when decision was wrong (user complaints)

---

## Test Results by Rule

### Rule 1: Explicit Cultural Keywords
- **Tests hit:** Krakow cultural (✅ 60% agreement is acceptable)
- **Recommendation:** Keep YandexGPT
- **Why:** Museums + historic sites match well

### Rule 2: Gastrotour Mode
- **Tests hit:** Hoi An gastrotour, Krakow cheap gastrotour
- **Results:** 80% agreement, YandexGPT did as well
- **Problem:** OpenRouter only slightly better for cafes
- **Alternative:** Keep YandexGPT (simpler), add explicit food quota to prompt

### Rule 3: Few Historic Sites
- **Tests hit:** Valencia (2 historic in input, 50% in output for Yandex, 40% for OR)
- **Recommendation:** Use when < 3 historic sites, prefer OpenRouter

### Rule 4: Russian Cities
- **Not tested** (all tests are foreign cities)
- **Assumption:** YandexGPT better (based on prior context)

### Rule 5: Foreign City Default
- **Tests hit:** All 6 tests
- **Results:** Mixed (20%-80% agreement)
- **Observation:** Default to OpenRouter is reasonable

---

## Migration Path

### Phase 1: Add Decision Logic (1 PR)
- Add `selectWithHybridProvider()` method
- Keep existing `select()` method untouched
- Add test endpoint to verify routing logic
- No user-facing changes

### Phase 2: A/B Test Rules (1-2 weeks)
- Route 50% of requests through hybrid logic
- Track fallback_reason in every response
- Measure: agreement rate, user satisfaction, error rate
- Identify rules that need adjustment

### Phase 3: Full Migration (1 PR)
- Replace `select()` call with `selectWithHybridProvider()`
- Monitor error rates and user feedback
- Adjust rules based on Phase 2 data
- Remove old `select()` method

### Phase 4: Future Optimization (Backlog)
- Option B (category weighting) if needed
- Option C (LLM routing) if data shows promise
- Per-user preferences (some users prefer culture, others experience)

---

## Risk Mitigation

### Risk: Rule 2 (Gastrotour) Under-Delivers
**Mitigation:** Keep YandexGPT, but add explicit food quota to prompt instead
- Rationale: Our earlier fix (LogicalIdSelector food quota) was 100% effective
- Cost: 0 latency, no additional API calls
- Test: Krakow cheap gastrotour showed YandexGPT did as well as OpenRouter

### Risk: Rule 3 (Few Historic Sites) Over-Corrects
**Mitigation:** Require both `historicCount <= 3` AND `!hasCulturalKeywords`
- Prevents switching when user explicitly asked for culture
- Test: Porto (2 historic in input, 40% in output) would still hit OpenRouter ✅

### Risk: Rule 4 (Russian City) Fails
**Mitigation:** Add exception for users querying in English
- Detect language of query using language-detect library
- If query is English for Russian city, use OpenRouter
- Cost: 1 library import, minimal logic

---

## Success Metrics

Track for 2 weeks after rollout:

1. **Agreement Rate per Rule** (target: >70% for each rule)
   - Rule 1 (Cultural): 70%+
   - Rule 2 (Gastrotour): 80%+
   - Rule 3 (Few historic): 75%+
   - Rule 5 (Foreign default): 70%+

2. **Response Time**
   - Target: <2800ms avg (no degradation)

3. **User Satisfaction**
   - Track "saved" itineraries per rule
   - Track complaints via feedback form
   - Target: No significant complaints from any rule

4. **Category Distribution**
   - Monitor that restaurants stay ~30-35%
   - Monitor that historic sites vary by rule

---

## Next Steps

1. **Implement Option A** in `semantic-filter.service.ts`
2. **Add `selectWithHybridProvider()` method**
3. **Add test endpoint** `POST /ai/test/compare-providers-routing` to verify rule logic
4. **Create CI test** for each rule path
5. **Deploy to staging** for 1 week
6. **Gather metrics** from staging
7. **Deploy to production** with monitoring

---

## Files to Change

- `apps/api/src/ai/pipeline/semantic-filter.service.ts` — Add hybrid routing
- `apps/api/src/ai/ai.controller.ts` — Update `select()` call, add routing test endpoint
- Add unit tests for each rule
- Add analytics schema for tracking route_decision

---

## Estimated Effort

- **Option A Implementation:** 1-2 hours
- **Testing & Validation:** 2 hours
- **Documentation:** 1 hour
- **Total:** 4-5 hours of development

**Launch Timeline:** Can merge in 1 sprint
