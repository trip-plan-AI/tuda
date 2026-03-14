#!/usr/bin/env python3
"""Quick test runner with better timeout handling."""

import json
import subprocess
import sys
from pathlib import Path
from datetime import datetime

TEST_DATA_DIR = Path(__file__).parent / "data"
RESULTS_DIR = Path(__file__).parent / "results"
API_URL = "http://localhost:3001"

RESULTS_DIR.mkdir(exist_ok=True)

def run_test(test_file):
    """Run a single test."""
    with open(test_file) as f:
        test_data = json.load(f)

    city = test_data['city']
    scenario = test_data.get('scenario', '')

    payload = {
        'city': city,
        'preferences': test_data.get('preferences', ''),
        'pois': test_data.get('pois', [])
    }

    print(f"  📍 {city:20} | {scenario[:40]:40} ", end='', flush=True)

    try:
        result = subprocess.run(
            ['curl', '-s', '--max-time', '30', '-X', 'POST',
             f'{API_URL}/api/ai/test/compare-providers',
             '-H', 'Content-Type: application/json',
             '-d', json.dumps(payload)],
            capture_output=True,
            text=True,
            timeout=35
        )

        response = json.loads(result.stdout)
        y_count = response['yandex']['count']
        o_count = response['openrouter']['count']
        y_time = response['yandex']['duration_ms']
        o_time = response['openrouter']['duration_ms']

        # Calculate agreement
        y_names = {p['name'] for p in response['yandex']['pois']}
        o_names = {p['name'] for p in response['openrouter']['pois']}
        overlap = len(y_names & o_names)
        max_count = max(y_count, o_count, 1)
        agreement = (overlap / max_count) * 100 if max_count > 0 else 0

        print(f"✅ Y:{y_count} O:{o_count} {agreement:.0f}% | {y_time}ms vs {o_time}ms")

        return {
            'test': test_file.stem,
            'city': city,
            'scenario': scenario,
            'yandex': {'count': y_count, 'time_ms': y_time, 'pois': response['yandex']['pois']},
            'openrouter': {'count': o_count, 'time_ms': o_time, 'pois': response['openrouter']['pois']},
            'agreement': agreement
        }

    except subprocess.TimeoutExpired:
        print(f"⏱️ TIMEOUT")
        return None
    except Exception as e:
        print(f"❌ {str(e)[:40]}")
        return None

# Find all tests
tests = sorted(TEST_DATA_DIR.glob('*.json'))
print(f"\n🧪 Running {len(tests)} tests...\n")

results = []
for test_file in tests:
    result = run_test(test_file)
    if result:
        results.append(result)

# Save results
if results:
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    results_file = RESULTS_DIR / f'results_{timestamp}.json'
    with open(results_file, 'w') as f:
        json.dump(results, f, indent=2)

    print(f"\n✅ Saved {len(results)} results to: {results_file}")

    # Summary stats
    total_y = sum(r['yandex']['count'] for r in results)
    total_o = sum(r['openrouter']['count'] for r in results)
    avg_agreement = sum(r['agreement'] for r in results) / len(results)
    avg_y_time = sum(r['yandex']['time_ms'] for r in results) / len(results)
    avg_o_time = sum(r['openrouter']['time_ms'] for r in results) / len(results)

    print(f"\n📊 Summary:")
    print(f"   Yandex: {total_y} POI ({total_y/len(results):.1f}/test), {avg_y_time:.0f}ms avg")
    print(f"   OpenRouter: {total_o} POI ({total_o/len(results):.1f}/test), {avg_o_time:.0f}ms avg")
    print(f"   Agreement: {avg_agreement:.1f}%")
else:
    print("❌ No successful tests")
    sys.exit(1)
