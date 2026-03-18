import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000/api';

async function testCity(city, countryCode = null) {
  console.log(`\n--- Testing City: ${city} (${countryCode || 'WW'}) ---`);
  try {
    const response = await axios.post(`${API_URL}/ai/plan`, {
      user_query: `Поездка в ${city} на 1 день, хочу увидеть главные достопримечательности`,
      city: city,
      country_code: countryCode,
      days: 1
    });

    console.log(`Status: ${response.status}`);
    console.log(`City: ${response.data.city}`);
    console.log(`Total Points: ${response.data.days[0].points.length}`);
    
    // Check for provider stats if available in shadowDiagnostics
    // (In real app we might need to look at logs or internal state)
    
    const points = response.data.days[0].points;
    points.slice(0, 3).forEach(p => {
      console.log(`  - ${p.poi.name} (${p.poi.provider || 'unknown'})`);
    });

    return { success: true, data: response.data };
  } catch (error) {
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log(`Error Code: ${error.response.data.code}`);
      console.log(`Message: ${error.response.data.message}`);
      return { success: false, status: error.response.status, code: error.response.data.code };
    } else {
      console.log(`Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}

async function runTests() {
  console.log('Starting POI Pipeline V4 Verification...');

  // 1. CIS City: Balakovo (should use Overpass/Kudago, No Photon/Nominatim)
  await testCity('Балаково', 'RU');

  // 2. World City: Paris (should use Overpass/OsmFetch/Photon)
  await testCity('Paris', 'FR');

  // 3. Non-existent city: "QwertyCity123" (should trigger Hard Stop 422)
  const res3 = await testCity('QwertyCity123');
  if (res3.status === 422 && res3.code === 'CITY_DATA_UNAVAILABLE') {
    console.log('✅ Hard Stop verification PASSED');
  } else {
    console.log('❌ Hard Stop verification FAILED');
  }
}

runTests();
