#!/usr/bin/env python3
"""
Compare 3 POI collection strategies:
1. LLM-only (generate POI from scratch)
2. Provider-only (KudaGo + Overpass)
3. Hybrid (Provider first, supplement with LLM if needed)

Metrics: accuracy, diversity, speed, coverage
"""

import json
import subprocess
import sys
from pathlib import Path
from collections import Counter
from datetime import datetime

API_URL = "http://localhost:3001"
TEST_DATA_DIR = Path("/home/dmitriy/projects/trip/travel-planner/tests/ai/provider-comparison/data")

def load_queries():
    """Load all test queries from test_queries.json"""
    query_file = TEST_DATA_DIR / "test_queries.json"
    with open(query_file) as f:
        queries = json.load(f)
    return queries

def test_strategy(strategy: str, query: str) -> dict:
    """Test a single query against one strategy"""
    payload = {"query": query}

    try:
        result = subprocess.run(
            ["curl", "-s", "-X", "POST",
             f"{API_URL}/api/ai/test/strategy/{strategy}",
             "-H", "Content-Type: application/json",
             "-d", json.dumps(payload)],
            capture_output=True, text=True, timeout=120
        )

        if result.returncode != 0:
            return {"error": f"curl error: {result.stderr}"}

        resp = json.loads(result.stdout)
        return resp
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}
    except json.JSONDecodeError as e:
        return {"error": f"json error: {e}"}

def extract_city(query: str) -> str:
    """Extract city name from query"""
    first_part = query.split(".")[0].strip()
    return first_part

def categorize_query(query: str) -> str:
    """Categorize query by intent"""
    query_lower = query.lower()
    if any(word in query_lower for word in ["бюджет", "тысяч", "дешево", "недорого", "максимум", "ровно"]):
        return "budget"
    elif any(word in query_lower for word in ["еда", "ресторан", "кафе", "паэлья", "кухня", "поесть"]):
        return "food"
    elif any(word in query_lower for word in ["культур", "музе", "театр", "историч", "дворец", "памятник"]):
        return "culture"
    elif any(word in query_lower for word in ["вайбов", "крутые", "атмосфер", "ночн", "клуб", "бар"]):
        return "vibe"
    elif any(word in query_lower for word in ["храм", "духовн", "медитац", "церковь", "религи", "монастырь"]):
        return "spiritual"
    else:
        return "general"

def main():
    queries = load_queries()
    strategies = ["llm-only", "provider-only", "hybrid"]

    results = {
        "timestamp": datetime.now().isoformat(),
        "total_queries": len(queries),
        "strategies": strategies,
        "tests": []
    }

    print(f"\n{'='*100}")
    print(f"🧪 STRATEGY COMPARISON TEST")
    print(f"{'='*100}")
    print(f"Testing {len(queries)} queries × {len(strategies)} strategies = {len(queries) * len(strategies)} total tests")
    print(f"API: {API_URL}\n")

    for i, query_obj in enumerate(queries, 1):
        query = query_obj["query"]
        city = extract_city(query)
        category = categorize_query(query)

        print(f"\n[{i:2d}/{len(queries)}] {city:<20} ({category:10s}) ", end="", flush=True)

        test_results = {
            "query": query,
            "city": city,
            "category": category,
            "strategies": {}
        }

        for strategy in strategies:
            print(f"{strategy[0]}.", end="", flush=True)
            response = test_strategy(strategy, query)

            if "error" in response:
                test_results["strategies"][strategy] = {
                    "error": response["error"],
                    "poi_count": 0,
                    "duration_ms": 0
                }
            else:
                pois = response.get("pois", [])
                cats = Counter(p.get("category", "unknown") for p in pois)

                test_results["strategies"][strategy] = {
                    "poi_count": response.get("poi_count", 0),
                    "duration_ms": response.get("duration_ms", 0),
                    "categories": dict(cats),
                    "fallbacks": response.get("fallbacks"),
                    "error": response.get("error")
                }

        print(" ✓", flush=True)
        results["tests"].append(test_results)

    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = Path(__file__).parent / "results" / f"strategies_{timestamp}.json"
    results_file.parent.mkdir(exist_ok=True)

    with open(results_file, "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    # Print summary
    print_summary(results)
    print(f"\n📁 Results saved: {results_file}\n")

def print_summary(results: dict):
    """Print summary statistics"""
    tests = results["tests"]
    strategies = results["strategies"]

    print(f"\n{'='*100}")
    print("📊 SUMMARY")
    print(f"{'='*100}\n")

    # By strategy
    print("By Strategy:")
    print("-" * 100)
    for strategy in strategies:
        total_pois = sum(t["strategies"][strategy].get("poi_count", 0) for t in tests)
        avg_pois = total_pois / len(tests) if tests else 0
        avg_time = sum(t["strategies"][strategy].get("duration_ms", 0) for t in tests) / len(tests) if tests else 0
        errors = sum(1 for t in tests if "error" in t["strategies"][strategy])

        print(f"  {strategy:15s}: {total_pois:3d} POI total, {avg_pois:5.1f} avg/query, {avg_time:6.0f}ms, {errors:2d} errors")

    # By category
    print("\nBy Query Category:")
    print("-" * 100)
    categories = set(t["category"] for t in tests)
    for category in sorted(categories):
        cat_tests = [t for t in tests if t["category"] == category]
        cat_count = len(cat_tests)

        print(f"  {category:15s} ({cat_count:2d} queries):")
        for strategy in strategies:
            total = sum(t["strategies"][strategy].get("poi_count", 0) for t in cat_tests)
            avg = total / len(cat_tests) if cat_tests else 0
            print(f"    • {strategy:13s}: {avg:5.1f} POI/query")

    # By city
    print("\nBy City (first 10):")
    print("-" * 100)
    cities = {}
    for t in tests:
        city = t["city"]
        if city not in cities:
            cities[city] = []
        cities[city].append(t)

    for city in sorted(cities.keys())[:10]:
        city_tests = cities[city]
        print(f"  {city:20s} ({len(city_tests)} queries):")
        for strategy in strategies:
            total = sum(t["strategies"][strategy].get("poi_count", 0) for t in city_tests)
            avg = total / len(city_tests) if city_tests else 0
            print(f"    • {strategy:13s}: {avg:5.1f} POI/query")

if __name__ == "__main__":
    main()
