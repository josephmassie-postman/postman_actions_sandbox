const http = require('http');

const PORT = process.env.PORT || 3000;

const randomId = () => Math.random().toString(36).slice(2, 10);
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomFloat = (min, max, decimals = 2) =>
  Number((Math.random() * (max - min) + min).toFixed(decimals));

const routes = {
  '/api/profile': () => ({
    id: randomId(),
    name: `User-${randomInt(100, 999)}`,
    score: randomInt(1, 100),
    active: Math.random() > 0.5,
  }),
  '/api/weather': () => ({
    location: `City-${randomInt(1, 50)}`,
    temperatureF: randomInt(40, 100),
    humidity: randomFloat(0.2, 0.9),
    condition: ['sunny', 'cloudy', 'rainy', 'windy'][randomInt(0, 3)],
  }),
  '/api/metrics': () => ({
    requestId: randomId(),
    cpuLoad: randomFloat(0, 1, 3),
    memoryMb: randomInt(128, 4096),
    latencyMs: randomInt(10, 500),
  }),
};

const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
};

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    console.log(`${req.method} ${url.pathname} -> ${res.statusCode} (${durationMs}ms)`);
  });

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/') {
    sendJson(res, 200, {
      message: 'Simple random JSON server',
      endpoints: Object.keys(routes),
    });
    return;
  }

  const routeHandler = routes[url.pathname];

  if (!routeHandler) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  sendJson(res, 200, routeHandler());
});

server.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
