#!/usr/bin/env python3
"""
Comprehensive test runner for YandexGPT vs OpenRouter semantic filtering.

Usage:
  python3 run_tests.py                    # Run all tests
  python3 run_tests.py krakow_cultural    # Run specific test
  python3 run_tests.py --api-url http://localhost:3001
"""

import json
import subprocess
import sys
import time
from pathlib import Path
from collections import Counter
from datetime import datetime
from typing import Any

API_URL = "http://localhost:3001"
TEST_DATA_DIR = Path(__file__).parent / "data"
RESULTS_DIR = Path(__file__).parent / "results"
REPORTS_DIR = Path(__file__).parent / "reports"

RESULTS_DIR.mkdir(exist_ok=True)
REPORTS_DIR.mkdir(exist_ok=True)


def load_test(test_name: str) -> dict[str, Any]:
    """Load test data from JSON file."""
    test_file = TEST_DATA_DIR / f"{test_name}.json"
    if not test_file.exists():
        raise FileNotFoundError(f"Test not found: {test_file}")

    with open(test_file) as f:
        return json.load(f)


def run_test(test_data: dict[str, Any], api_url: str) -> dict[str, Any]:
    """Run a single test by calling the comparison endpoint."""
    payload = {
        "city": test_data["city"],
        "preferences": test_data.get("preferences", "интересные места"),
        "pois": test_data.get("pois", []),
    }

    if test_data.get("budget"):
        payload["budget"] = test_data["budget"]
    if test_data.get("food_mode"):
        payload["food_mode"] = test_data["food_mode"]

    print(f"  🔄 Testing {test_data['city']} — {test_data.get('scenario', 'default')}...", end=" ", flush=True)

    try:
        result = subprocess.run(
            [
                "curl",
                "-s",
                "-X",
                "POST",
                f"{api_url}/api/ai/test/compare-providers",
                "-H",
                "Content-Type: application/json",
                "-d",
                json.dumps(payload),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode != 0:
            print(f"❌ Curl error: {result.stderr}")
            return None

        response = json.loads(result.stdout)
        print(f"✅")
        return response
    except subprocess.TimeoutExpired:
        print("⏱️ Timeout")
        return None
    except json.JSONDecodeError as e:
        print(f"❌ JSON error: {e}")
        return None


def analyze_result(test_name: str, test_data: dict, result: dict) -> dict[str, Any]:
    """Analyze a single test result."""
    if not result:
        return None

    yandex = result["yandex"]
    openrouter = result["openrouter"]

    y_pois = yandex["pois"]
    o_pois = openrouter["pois"]

    y_cats = Counter(p["category"] for p in y_pois)
    o_cats = Counter(p["category"] for p in o_pois)

    y_names = {p["name"] for p in y_pois}
    o_names = {p["name"] for p in o_pois}
    overlap = len(y_names & o_names)
    overlap_pct = (overlap / max(len(y_names), len(o_names), 1)) * 100

    return {
        "test_name": test_name,
        "city": test_data["city"],
        "scenario": test_data.get("scenario", ""),
        "preferences": test_data.get("preferences", ""),
        "budget": test_data.get("budget"),
        "food_mode": test_data.get("food_mode", "default"),
        "input_poi_count": result["input_poi_count"],
        "yandex": {
            "count": yandex["count"],
            "categories": dict(y_cats),
            "duration_ms": yandex["duration_ms"],
            "restaurants": sum(1 for p in y_pois if p["category"] in ["restaurant", "cafe"]),
            "historic": sum(1 for p in y_pois if p["category"] == "historic"),
            "museums": sum(1 for p in y_pois if p["category"] == "museum"),
            "attractions": sum(1 for p in y_pois if p["category"] == "attraction"),
            "pois": [{"name": p["name"], "category": p["category"], "rating": p.get("rating", 0)} for p in y_pois],
        },
        "openrouter": {
            "count": openrouter["count"],
            "categories": dict(o_cats),
            "duration_ms": openrouter["duration_ms"],
            "restaurants": sum(1 for p in o_pois if p["category"] in ["restaurant", "cafe"]),
            "historic": sum(1 for p in o_pois if p["category"] == "historic"),
            "museums": sum(1 for p in o_pois if p["category"] == "museum"),
            "attractions": sum(1 for p in o_pois if p["category"] == "attraction"),
            "pois": [{"name": p["name"], "category": p["category"], "rating": p.get("rating", 0)} for p in o_pois],
        },
        "agreement": {
            "overlap_count": overlap,
            "overlap_pct": overlap_pct,
        },
        "error": result.get("error"),
    }


def print_result(analysis: dict):
    """Pretty print a single test result."""
    print(f"\n{'='*90}")
    print(f"📍 {analysis['city'].upper()} | {analysis['scenario']}")
    print(f"{'─'*90}")
    print(f"Preferences: {analysis['preferences']}")
    if analysis["budget"]:
        print(f"Budget: {analysis['budget']} RUB | Food mode: {analysis['food_mode']}")

    y = analysis["yandex"]
    o = analysis["openrouter"]

    print(f"\n🔷 YANDEX ({y['duration_ms']}ms): {y['count']} POI")
    print(f"   Categories: {y['categories']}")
    print(f"   Distribution: {y['historic']} historic, {y['museums']} museums, {y['restaurants']} food")
    for i, p in enumerate(y["pois"], 1):
        print(f"   {i}. {p['name']} [{p['category']}] {p['rating']}★")

    print(f"\n🔶 OPENROUTER ({o['duration_ms']}ms): {o['count']} POI")
    print(f"   Categories: {o['categories']}")
    print(f"   Distribution: {o['historic']} historic, {o['museums']} museums, {o['restaurants']} food")
    for i, p in enumerate(o["pois"], 1):
        print(f"   {i}. {p['name']} [{p['category']}] {p['rating']}★")

    print(f"\n📊 Agreement: {analysis['agreement']['overlap_pct']:.1f}% ({analysis['agreement']['overlap_count']}/{max(y['count'], o['count'])} POI)")


def save_results(all_analyses: list[dict]):
    """Save test results to JSON file."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = RESULTS_DIR / f"test_run_{timestamp}.json"

    with open(results_file, "w") as f:
        json.dump(
            {
                "timestamp": timestamp,
                "total_tests": len(all_analyses),
                "results": all_analyses,
                "summary": generate_summary(all_analyses),
            },
            f,
            indent=2,
        )

    return results_file


def generate_summary(analyses: list[dict]) -> dict:
    """Generate summary statistics across all tests."""
    if not analyses:
        return {}

    total_y_selected = sum(a["yandex"]["count"] for a in analyses)
    total_o_selected = sum(a["openrouter"]["count"] for a in analyses)
    avg_agreement = sum(a["agreement"]["overlap_pct"] for a in analyses) / len(analyses)

    total_y_restaurants = sum(a["yandex"]["restaurants"] for a in analyses)
    total_o_restaurants = sum(a["openrouter"]["restaurants"] for a in analyses)
    total_y_historic = sum(a["yandex"]["historic"] for a in analyses)
    total_o_historic = sum(a["openrouter"]["historic"] for a in analyses)

    return {
        "tests_run": len(analyses),
        "yandex": {
            "total_poi_selected": total_y_selected,
            "avg_per_test": total_y_selected / len(analyses),
            "avg_response_time": sum(a["yandex"]["duration_ms"] for a in analyses) / len(analyses),
            "restaurant_total": total_y_restaurants,
            "historic_total": total_y_historic,
        },
        "openrouter": {
            "total_poi_selected": total_o_selected,
            "avg_per_test": total_o_selected / len(analyses),
            "avg_response_time": sum(a["openrouter"]["duration_ms"] for a in analyses) / len(analyses),
            "restaurant_total": total_o_restaurants,
            "historic_total": total_o_historic,
        },
        "avg_agreement_pct": avg_agreement,
    }


def main():
    if len(sys.argv) > 1:
        if sys.argv[1] == "--api-url" and len(sys.argv) > 2:
            globals()["API_URL"] = sys.argv[2]
            test_filter = sys.argv[3] if len(sys.argv) > 3 else None
        else:
            test_filter = sys.argv[1]
    else:
        test_filter = None

    # Find all test files
    test_files = sorted(TEST_DATA_DIR.glob("*.json"))
    if test_filter:
        test_files = [f for f in test_files if test_filter in f.stem]

    if not test_files:
        print(f"❌ No tests found matching: {test_filter}")
        return

    print(f"\n🧪 Running {len(test_files)} test(s)...")
    print(f"📡 API: {API_URL}\n")

    all_analyses = []

    for test_file in test_files:
        test_name = test_file.stem
        try:
            test_data = load_test(test_name)
            result = run_test(test_data, API_URL)

            if result:
                analysis = analyze_result(test_name, test_data, result)
                all_analyses.append(analysis)
                print_result(analysis)
                time.sleep(1)  # Avoid hammering the API
            else:
                print(f"  ⚠️ Test failed: {test_name}")

        except Exception as e:
            print(f"  ❌ Error: {e}")

    # Save results
    if all_analyses:
        results_file = save_results(all_analyses)
        print(f"\n\n✅ Results saved to: {results_file}\n")

        # Print summary
        summary = generate_summary(all_analyses)
        print("📊 SUMMARY")
        print("=" * 90)
        print(f"Tests run: {summary['tests_run']}")
        print(f"\nYandex GPT:")
        print(f"  Total POI: {summary['yandex']['total_poi_selected']} ({summary['yandex']['avg_per_test']:.1f}/test)")
        print(f"  Avg response: {summary['yandex']['avg_response_time']:.0f}ms")
        print(f"  Restaurants: {summary['yandex']['restaurant_total']}")
        print(f"  Historic sites: {summary['yandex']['historic_total']}")
        print(f"\nOpenRouter:")
        print(f"  Total POI: {summary['openrouter']['total_poi_selected']} ({summary['openrouter']['avg_per_test']:.1f}/test)")
        print(f"  Avg response: {summary['openrouter']['avg_response_time']:.0f}ms")
        print(f"  Restaurants: {summary['openrouter']['restaurant_total']}")
        print(f"  Historic sites: {summary['openrouter']['historic_total']}")
        print(f"\nAvg agreement across tests: {summary['avg_agreement_pct']:.1f}%")


if __name__ == "__main__":
    main()
