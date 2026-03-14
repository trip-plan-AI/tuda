const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head>
        <script src="https://api-maps.yandex.ru/3.0/?apikey=${process.env.NEXT_PUBLIC_YANDEX_MAPS_KEY || '6d06a9cc-e9d6-4e55-9b2f-cd8fc32223bb'}&lang=ru_RU"></script>
      </head>
      <body>
        <script>
          async function test() {
            try {
              await ymaps3.ready;
              const route = await ymaps3.route({
                 points: [[37.6, 55.7], [37.7, 55.8]]
              });
              console.log('ymaps3.route exists! Result:', JSON.stringify(Object.keys(route)));
            } catch(e) {
              console.log('Error with ymaps3.route:', e.message);
              try {
                const mod = await ymaps3.import('@yandex/ymaps3-router');
                console.log('Router module keys:', Object.keys(mod));
              } catch (e2) {
                console.log('Error importing @yandex/ymaps3-router:', e2.message);
              }
            }
          }
          test();
        </script>
      </body>
    </html>
  `);
  
  await new Promise(r => setTimeout(r, 4000));
  await browser.close();
})();
