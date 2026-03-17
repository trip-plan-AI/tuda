// Тест Pixabay API
const PIXABAY_API_KEY = '55021291-3645bdd8151a00faddeac0212';

async function testPixabay() {
  const query = 'beautiful cityscape ekaterinburg';
  const params = new URLSearchParams({
    key: PIXABAY_API_KEY,
    q: query,
    image_type: 'photo',
    safesearch: 'true',
    orientation: 'horizontal',
    order: 'popular',
    per_page: '1',
  });

  const url = `https://pixabay.com/api/?${params.toString()}`;
  console.log('Testing Pixabay API...');
  console.log('URL:', url);
  
  try {
    const response = await fetch(url);
    console.log('Status:', response.status, response.statusText);
    
    const body = await response.text();
    console.log('Response body:', body.substring(0, 500));
    
    if (response.ok) {
      const data = JSON.parse(body);
      console.log('Hits:', data.hits?.length || 0);
      if (data.hits?.[0]) {
        console.log('First hit URL:', data.hits[0].webformatURL);
      }
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

testPixabay();
