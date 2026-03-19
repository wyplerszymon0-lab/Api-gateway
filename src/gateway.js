const http = require("http");
const https = require("https");
const { URL } = require("url");

class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.buckets = new Map();
  }

  isAllowed(key) {
    const now = Date.now();
    const bucket = this.buckets.get(key) || { count: 0, resetAt: now + this.windowMs };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + this.windowMs;
    }

    if (bucket.count >= this.maxRequests) {
      this.buckets.set(key, bucket);
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }

    bucket.count++;
    this.buckets.set(key, bucket);
    return { allowed: true, remaining: this.maxRequests - bucket.count, resetAt: bucket.resetAt };
  }
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(pattern, upstream, options = {}) {
    this.routes.push({ pattern: new RegExp(pattern), upstream, options });
  }

  match(path) {
    for (const route of this.routes) {
      if (route.pattern.test(path)) return route;
    }
    return null;
  }
}

class Gateway {
  constructor(options = {}) {
    this.router = new Router();
    this.rateLimiter = options.rateLimit
      ? new RateLimiter(options.rateLimit.windowMs, options.rateLimit.maxRequests)
      : null;
    this.apiKeys = options.apiKeys || null;
    this.requestHooks = [];
  }

  route(pattern, upstream, options = {}) {
    this.router.add(pattern, upstream, options);
    return this;
  }

  use(hook) {
    this.requestHooks.push(hook);
    return this;
  }

  _send(res, status, body) {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const isJson = typeof body !== "string";
    res.writeHead(status, {
      "Content-Type": isJson ? "application/json" : "text/plain",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  _collectBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  _proxy(req, res, route, body) {
    const target = new URL(route.upstream);
    const isHttps = target.protocol === "https:";
    const lib = isHttps ? https : http;

    const options = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: target.hostname,
        "X-Forwarded-For": req.socket.remoteAddress,
        "X-Gateway-Version": "1.0.0",
      },
    };

    const proxyReq = lib.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, {
        ...proxyRes.headers,
        "X-Gateway": "true",
      });
      proxyRes.pipe(res);
    });

    proxyReq.on("error", err => {
      this._send(res, 502, { error: "Bad Gateway", detail: err.message });
    });

    if (body && body.length > 0) proxyReq.write(body);
    proxyReq.end();
  }

  handler() {
    return async (req, res) => {
      for (const hook of this.requestHooks) {
        const result = await hook(req, res);
        if (result === false) return;
      }

      if (this.apiKeys) {
        const key = req.headers["x-api-key"];
        if (!key || !this.apiKeys.includes(key)) {
          return this._send(res, 401, { error: "Unauthorized" });
        }
      }

      const clientIp = req.socket.remoteAddress || "unknown";
      if (this.rateLimiter) {
        const { allowed, remaining, resetAt } = this.rateLimiter.isAllowed(clientIp);
        res.setHeader("RateLimit-Remaining", remaining);
        res.setHeader("RateLimit-Reset", Math.ceil(resetAt / 1000));
        if (!allowed) {
          return this._send(res, 429, { error: "Too Many Requests" });
        }
      }

      const route = this.router.match(req.url);
      if (!route) {
        return this._send(res, 404, { error: "No route matched" });
      }

      const body = await this._collectBody(req);
      this._proxy(req, res, route, body);
    };
  }

  listen(port, cb) {
    const server = http.createServer(this.handler());
    server.listen(port, cb);
    return server;
  }
}

module.exports = { Gateway, Router, RateLimiter };
