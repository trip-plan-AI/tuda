const https = require('https');
https.get('https://api-maps.yandex.ru/3.0/?apikey=some_key&lang=ru_RU', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const urls = data.match(/https:\/\/[^"']+/g);
    console.log("URLs in loader:", urls);
  });
});
