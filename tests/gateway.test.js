const http = require("http");
const { Gateway, RateLimiter } = require("../src/gateway");

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json || raw });
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function startUpstream(handler, port) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

let gatewayServer;
let upstreamServer;

afterEach(done => {
  const closeGateway = () => gatewayServer
    ? new Promise(r => gatewayServer.close(r))
    : Promise.resolve();
  const closeUpstream = () => upstreamServer
    ? new Promise(r => upstreamServer.close(r))
    : Promise.resolve();
  closeGateway().then(closeUpstream).then(done);
  gatewayServer = null;
  upstreamServer = null;
});

test("proxies request to upstream", async () => {
  upstreamServer = await startUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, 9901);
  const gw = new Gateway();
  gw.route("^/api", "http://localhost:9901");
  gatewayServer = gw.listen(9801);
  await new Promise(r => gatewayServer.once("listening", r));
  const resp = await request({ hostname: "localhost", port: 9801, path: "/api/test", method: "GET" });
  expect(resp.status).toBe(200);
  expect(resp.body.ok).toBe(true);
});

test("returns 404 for unmatched route", async () => {
  const gw = new Gateway();
  gatewayServer = gw.listen(9802);
  await new Promise(r => gatewayServer.once("listening", r));
  const resp = await request({ hostname: "localhost", port: 9802, path: "/unknown", method: "GET" });
  expect(resp.status).toBe(404);
});

test("enforces api key authentication", async () => {
  const gw = new Gateway({ apiKeys: ["secret-key"] });
  gw.route("^/", "http://localhost:9999");
  gatewayServer = gw.listen(9803);
  await new Promise(r => gatewayServer.once("listening", r));
  const rejected = await request({ hostname: "localhost", port: 9803, path: "/test", method: "GET" });
  expect(rejected.status).toBe(401);
  const accepted = await request({
    hostname: "localhost", port: 9803, path: "/test", method: "GET",
    headers: { "x-api-key": "secret-key" },
  });
  expect(accepted.status).not.toBe(401);
});

test("rate limiter blocks after limit", async () => {
  const limiter = new RateLimiter(5000, 3);
  const results = [
    limiter.isAllowed("ip-1"),
    limiter.isAllowed("ip-1"),
    limiter.isAllowed("ip-1"),
    limiter.isAllowed("ip-1"),
  ];
  expect(results[0].allowed).toBe(true);
  expect(results[1].allowed).toBe(true);
  expect(results[2].allowed).toBe(true);
  expect(results[3].allowed).toBe(false);
});

test("rate limiter tracks different keys independently", () => {
  const limiter = new RateLimiter(5000, 1);
  expect(limiter.isAllowed("ip-a").allowed).toBe(true);
  expect(limiter.isAllowed("ip-b").allowed).toBe(true);
  expect(limiter.isAllowed("ip-a").allowed).toBe(false);
});

test("rate limit headers are set", async () => {
  upstreamServer = await startUpstream((req, res) => {
    res.writeHead(200); res.end("ok");
  }, 9902);
  const gw = new Gateway({ rateLimit: { windowMs: 10000, maxRequests: 5 } });
  gw.route("^/", "http://localhost:9902");
  gatewayServer = gw.listen(9804);
  await new Promise(r => gatewayServer.once("listening", r));
  const resp = await request({ hostname: "localhost", port: 9804, path: "/test", method: "GET" });
  expect(resp.headers["ratelimit-remaining"]).toBeDefined();
  expect(resp.headers["ratelimit-reset"]).toBeDefined();
});

test("custom middleware hook runs", async () => {
  const gw = new Gateway();
  let hookCalled = false;
  gw.use(async (req, res) => { hookCalled = true; });
  gw.route("^/", "http://localhost:9999");
  gatewayServer = gw.listen(9805);
  await new Promise(r => gatewayServer.once("listening", r));
  await request({ hostname: "localhost", port: 9805, path: "/test", method: "GET" });
  expect(hookCalled).toBe(true);
});

test("middleware can short-circuit request", async () => {
  const gw = new Gateway();
  gw.use(async (req, res) => {
    res.writeHead(403);
    res.end("Forbidden");
    return false;
  });
  gw.route("^/", "http://localhost:9999");
  gatewayServer = gw.listen(9806);
  await new Promise(r => gatewayServer.once("listening", r));
  const resp = await request({ hostname: "localhost", port: 9806, path: "/test", method: "GET" });
  expect(resp.status).toBe(403);
});
