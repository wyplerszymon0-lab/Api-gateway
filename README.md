# api-gateway

Lightweight API gateway for Node.js. Zero dependencies. Supports request routing, rate limiting, API key auth and custom middleware hooks.

## Features

- Pattern-based routing (regex)
- Sliding window rate limiter with `RateLimit-*` headers
- API key authentication
- Custom middleware hooks with short-circuit support
- HTTP/HTTPS upstream proxying
- `X-Forwarded-For` and `X-Gateway-Version` headers

## Usage
```javascript
const { Gateway } = require("./src/gateway");

const gw = new Gateway({
  apiKeys: ["my-secret-key"],
  rateLimit: { windowMs: 60000, maxRequests: 100 },
});

gw.use(async (req, res) => {
  console.log(`${req.method} ${req.url}`);
});

gw.route("^/api/users", "http://users-service:3001")
  .route("^/api/orders", "http://orders-service:3002");

gw.listen(8080, () => console.log("Gateway running on :8080"));
```

## Test
```bash
npm install
npm test
```
