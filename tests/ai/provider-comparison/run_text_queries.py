#!/usr/bin/env python3
"""
Test runner for YandexGPT vs OpenRouter semantic filtering.
Uses text-only queries (like real users would type).

Usage:
  python3 run_text_queries.py
  python3 run_text_queries.py --api-url http://localhost:3001
"""

import json
import subprocess
import sys
from pathlib import Path
from collections import Counter
from datetime import datetime

API_URL = "http://localhost:3001"
TEST_QUERIES_FILE = Path(__file__).parent / "data" / "test_queries.json"
RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)

def run_query(query: str) -> dict:
    """Run a single query against the comparison endpoint."""
    try:
        result = subprocess.run(
            [
                "curl", "-s", "-X", "POST",
                f"{API_URL}/api/ai/test/compare-providers",
                "-H", "Content-Type: application/json",
                "-d", json.dumps({"query": query}),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode != 0:
            return {"error": f"Curl error: {result.stderr}"}

        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        return {"error": "Request timeout"}
    except json.JSONDecodeError as e:
        return {"error": f"JSON decode error: {e}"}

def format_result(response: dict) -> None:
    """Pretty print a single test result."""
    if "error" in response:
        print(f"   ❌ Error: {response['error']}")
        return

    city = response.get("city", "Unknown")
    input_poi = response.get("input_poi_count", 0)

    print(f"\n   📍 City: {city} | Input POI: {input_poi}")

    # Yandex results
    y = response.get("yandex", {})
    y_pois = y.get("pois", [])
    y_cats = Counter(p.get("category", "unknown") for p in y_pois)

    print(f"   🔷 YANDEX ({y.get('duration_ms', 0)}ms): {y.get('count', 0)} POI")
    print(f"      Categories: {dict(y_cats)}")
    for i, p in enumerate(y_pois[:3], 1):
        print(f"      {i}. {p['name']} [{p['category']}]")
    if len(y_pois) > 3:
        print(f"      ... +{len(y_pois) - 3} more")

    # OpenRouter results
    o = response.get("openrouter", {})
    o_pois = o.get("pois", [])
    o_cats = Counter(p.get("category", "unknown") for p in o_pois)

    print(f"   🔶 OPENROUTER ({o.get('duration_ms', 0)}ms): {o.get('count', 0)} POI")
    print(f"      Categories: {dict(o_cats)}")
    for i, p in enumerate(o_pois[:3], 1):
        print(f"      {i}. {p['name']} [{p['category']}]")
    if len(o_pois) > 3:
        print(f"      ... +{len(o_pois) - 3} more")

    # Agreement
    y_names = {p['name'] for p in y_pois}
    o_names = {p['name'] for p in o_pois}
    overlap = len(y_names & o_names)
    max_count = max(len(y_names), len(o_names), 1)
    pct = (overlap / max_count) * 100
    print(f"   📊 Agreement: {pct:.0f}% ({overlap}/{max_count})")

def main():
    # Parse arguments
    if len(sys.argv) > 1 and sys.argv[1] == "--api-url" and len(sys.argv) > 2:
        global API_URL
        API_URL = sys.argv[2]

    # Load test queries
    try:
        with open(TEST_QUERIES_FILE) as f:
            test_queries = json.load(f)
    except FileNotFoundError:
        print(f"❌ Test queries file not found: {TEST_QUERIES_FILE}")
        return

    print(f"\n🧪 Text-Only Query Test Suite")
    print(f"📡 API: {API_URL}")
    print(f"📝 Tests: {len(test_queries)}\n")

    results = []

    for i, test in enumerate(test_queries, 1):
        query = test.get("query", "")
        if not query:
            continue

        # Extract city for display
        city = query.split(".")[0].strip() if "." in query else "Unknown"
        print(f"{i:2d}. {city} — Running...", end=" ", flush=True)

        response = run_query(query)
        format_result(response)

        results.append({
            "query": query,
            "city": response.get("city", "unknown"),
            "input_poi": response.get("input_poi_count", 0),
            "yandex_count": response.get("yandex", {}).get("count", 0),
            "openrouter_count": response.get("openrouter", {}).get("count", 0),
            "yandex_time": response.get("yandex", {}).get("duration_ms", 0),
            "openrouter_time": response.get("openrouter", {}).get("duration_ms", 0),
            "error": response.get("error"),
        })

    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = RESULTS_DIR / f"text_queries_{timestamp}.json"

    with open(results_file, "w") as f:
        json.dump(
            {
                "timestamp": timestamp,
                "api_url": API_URL,
                "total_tests": len(results),
                "results": results,
            },
            f,
            indent=2,
        )

    print(f"\n\n✅ Results saved to: {results_file}\n")

    # Summary
    print("="*90)
    print("📊 SUMMARY")
    print("="*90)
    print(f"{'City':<15} {'Input':<6} {'Yandex':<8} {'OpenRouter':<11} {'Y Time':<8} {'O Time':<8}")
    print("-"*90)

    for r in results:
        if not r.get("error"):
            print(
                f"{r['city']:<15} {r['input_poi']:<6} {r['yandex_count']:<8} "
                f"{r['openrouter_count']:<11} {r['yandex_time']:<8} {r['openrouter_time']:<8}"
            )

    avg_y = sum(r['yandex_count'] for r in results if not r.get('error')) / max(len([r for r in results if not r.get('error')]), 1)
    avg_o = sum(r['openrouter_count'] for r in results if not r.get('error')) / max(len([r for r in results if not r.get('error')]), 1)

    print("-"*90)
    print(f"Avg POI:         Yandex: {avg_y:.1f}  |  OpenRouter: {avg_o:.1f}")
    print(f"Total POI:       Yandex: {sum(r['yandex_count'] for r in results if not r.get('error'))}  |  OpenRouter: {sum(r['openrouter_count'] for r in results if not r.get('error'))}")

if __name__ == "__main__":
    main()
