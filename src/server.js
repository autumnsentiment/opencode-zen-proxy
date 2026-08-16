'use strict';

const http = require('http');
const config = require('./config');
const logger = require('./logger');
const { AuthManager } = require('./auth');
const { CopilotAuth } = require('./copilot');
const { Gate, RateLimiter } = require('./limiter');
const { pageHtml } = require('./web');
const proxyFetch = require('./proxy-fetch');
const { pfetch } = proxyFetch;

const auth = new AuthManager(config);
const copilot = new CopilotAuth(config);
const gate = new Gate(config.maxConcurrency, config.queueTimeoutMs);
const limiter = new RateLimiter({
  freeRpm: config.rateLimitFreeRpm,
  freeTpm: config.rateLimitFreeTpm,
  globalRpm: config.rateLimitGlobalRpm,
  burst: config.rateLimitBurst,
}, require('path').join(config.dataDir, 'ratelimit.json'));

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
  'content-length', 'accept-encoding', 'authorization',
]);

const stats = {
  started_at: Date.now(),
  requests: 0,
  upstream_429: 0,
  upstream_401: 0,
  retries: 0,
  keepalives_sent: 0,
  tools_sanitized: 0,
  tools_dropped: 0,
};

// ---------------------------------------------------------------- 入口

const server = http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch((e) => {
    logger.error('http', '处理请求未捕获错误', String(e && e.stack || e).slice(0, 300));
    if (!res.headersSent) sendJson(res, 500, { error: { message: 'proxy internal error', type: 'proxy_error' } });
    else res.destroy();
  });
});

server.keepAliveTimeout = 0; // 流式可能很久,不让 server 主动断 keep-alive
server.headersTimeout = 0;
server.requestTimeout = 0;

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  // ---- 限速设置(运行时热更新) ----
  if (path === '/ratelimit/config' && req.method === 'GET') {
    return sendJson(res, 200, { ...limiter.stats(), hint: 'POST 部分字段即可更新:{free_rpm,free_tpm,global_rpm,burst}(需 key),立即生效并持久化' });
  }
  if (path === '/ratelimit/config' && req.method === 'POST') {
    if (!checkKey(req)) return sendJson(res, 401, errJson('invalid proxy api key', 'proxy_auth'));
    const body = await readBody(req).catch(() => null);
    let parsed;
    try { parsed = JSON.parse(body ? body.toString('utf8') : '{}'); } catch { return sendJson(res, 400, errJson('body 不是合法 JSON', 'bad_request')); }
    return sendJson(res, 200, limiter.update(parsed));
  }

  // ---- 出站代理设置 ----
  if (path === '/proxy/config' && req.method === 'GET') {
    const cur = proxyFetch.getProxy();
    return sendJson(res, 200, {
      proxy: cur ? proxyFetch.mask(new URL(cur)) : null,
      source: proxyFetch.getProxySource(),
      hint: 'POST /proxy/config {"proxy":"http://user:pass@host:port 或 socks5://..."} 可运行时修改(需 key)',
    });
  }
  if (path === '/proxy/config' && req.method === 'POST') {
    if (!checkKey(req)) return sendJson(res, 401, errJson('invalid proxy api key', 'proxy_auth'));
    const body = await readBody(req).catch(() => null);
    let parsed;
    try { parsed = JSON.parse(body ? body.toString('utf8') : '{}'); } catch { return sendJson(res, 400, errJson('body 不是合法 JSON', 'bad_request')); }
    try {
      const u = proxyFetch.setProxy(typeof parsed.proxy === 'string' ? parsed.proxy : '');
      return sendJson(res, 200, { ok: true, proxy: u ? proxyFetch.mask(u) : null });
    } catch (e) {
      return sendJson(res, 400, errJson(String(e && e.message || e), 'bad_proxy'));
    }
  }
  if (path === '/proxy/test' && req.method === 'POST') {
    if (!checkKey(req)) return sendJson(res, 401, errJson('invalid proxy api key', 'proxy_auth'));
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    // 用真实调用会用的通道令牌(public 匿名层或 OAuth token)测试
    let token = 'public', modeUsed = 'public(匿名)';
    try {
      token = await auth.getAccessToken();
      modeUsed = token === 'public' ? 'public(匿名)' : 'oauth(账号)';
    } catch { /* 未授权且 oauth 模式,回退匿名探测 */ }
    try {
      const r = await pfetch(config.upstreamBase + '/models', {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': config.userAgent },
        signal: ac.signal,
      });
      clearTimeout(timer);
      return sendJson(res, 200, {
        ok: true, status: r.status, ms: Date.now() - t0,
        via_proxy: !!proxyFetch.getProxy(),
        note: r.status === 200
          ? `上游连通且通道可用,当前通道 ${modeUsed}`
          : `已到达上游(HTTP ${r.status}),但当前通道 ${modeUsed} 未被接受`,
      });
    } catch (e) {
      clearTimeout(timer);
      return sendJson(res, 200, { ok: false, ms: Date.now() - t0, via_proxy: !!proxyFetch.getProxy(), error: String(e && e.message || e).slice(0, 200) });
    }
  }

  // ---- 本地管理路由 ----
  if (path === '/healthz') return sendJson(res, 200, { ok: true, uptime_sec: Math.floor((Date.now() - stats.started_at) / 1000) });
  if (path === '/' || path === '/web' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(pageHtml());
  }
  if (path === '/info') return sendJson(res, 200, infoPayload());
  if (path === '/auth/status') return sendJson(res, 200, auth.status());
  if (path === '/stats') {
    if (!checkKey(req)) return sendJson(res, 401, errJson('invalid proxy api key', 'proxy_auth'));
    return sendJson(res, 200, { ...stats, gate: gate.stats(), limiter: limiter.stats(), auth_state: auth.state });
  }
  if (path === '/auth/refresh' && req.method === 'POST') {
    if (!checkKey(req)) return sendJson(res, 401, errJson('invalid proxy api key', 'proxy_auth'));
    try {
      const t = await auth.forceRefresh();
      return sendJson(res, 200, { ok: true, expires_at: t.expires_at });
    } catch (e) {
      return sendJson(res, 502, errJson(String(e.message || e), 'refresh_failed'));
    }
  }
  if (path === '/auth/restart' && req.method === 'POST') {
    if (!checkKey(req)) return sendJson(res, 401, errJson('invalid proxy api key', 'proxy_auth'));
    const st = await auth.restart();
    return sendJson(res, 200, st);
  }

  // ---- GitHub Copilot 通道管理 ----
  if (path === '/copilot/status') {
    return sendJson(res, 200, copilot.status());
  }
  if (path === '/copilot/start' && req.method === 'POST') {
    if (!checkKey(req)) return sendJson(res, 401, errJson('invalid proxy api key', 'proxy_auth'));
    try {
      return sendJson(res, 200, await copilot.startDeviceFlow());
    } catch (e) {
      return sendJson(res, 502, errJson(String(e && e.message || e), 'copilot_start_failed'));
    }
  }
  if (path === '/copilot/revoke' && req.method === 'POST') {
    if (!checkKey(req)) return sendJson(res, 401, errJson('invalid proxy api key', 'proxy_auth'));
    return sendJson(res, 200, copilot.revoke());
  }

  // ---- API 透传路由(/v1/* 或直接 /chat/completions 等) ----
  let sub = path;
  if (sub.startsWith('/v1/') || sub === '/v1') sub = sub.slice(3);
  else if (sub.startsWith('/zen/v1/')) sub = sub.slice(8);
  if (!sub.startsWith('/')) sub = '/' + sub;

  if (!/^\/(chat\/completions|responses|messages|models|completions|embeddings)/.test(sub)) {
    return sendJson(res, 404, errJson(`unknown route: ${path}`, 'proxy_route'));
  }

  if (!checkKey(req)) return sendJson(res, 401, errJson('invalid or missing proxy api key (Authorization: Bearer <PROXY_API_KEYS>)', 'proxy_auth'));

  stats.requests++;
  await proxyApi(req, res, sub + (u.search || ''));
}

// ---------------------------------------------------------------- 核心:透传

async function proxyApi(req, res, upstreamPath) {
  let release;
  try {
    release = await gate.acquire();
  } catch (e) {
    return sendJson(res, e.statusCode || 503, errJson(e.message, e.code || 'busy'));
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, e.statusCode || 400, errJson(e.message, 'body_error'));
  }
  const id = Math.random().toString(36).slice(2, 8);
  const startedAt = Date.now();

  // ---- 通道判定:X-Channel 头或模型名 copilot/ 前缀(转发时剥前缀) ----
  let channel = req.headers['x-channel'] === 'copilot' ? 'copilot' : 'zen';
  let sanitizeInfo = null;
  if (body.length) {
    try {
      const j = JSON.parse(body.toString('utf8'));
      // tools 格式修复(默认开,可 SANITIZE_TOOLS=0 关闭):
      //   /chat/completions -> 标准嵌套; /responses -> 标准扁平
      if (config.sanitizeTools && Array.isArray(j.tools)) {
        const p = upstreamPath.split('?')[0];
        let s = null;
        if (/chat\/completions\/?$/.test(p)) s = sanitizeTools(j.tools);
        else if (/responses\/?$/.test(p)) s = sanitizeToolsResponses(j.tools);
        if (s && (s.dropped || s.converted)) {
          j.tools = s.tools;
          sanitizeInfo = s;
          body = Buffer.from(JSON.stringify(j));
          stats.tools_sanitized += s.converted;
          if (s.dropped) stats.tools_dropped += s.dropped;
          logger.info('proxy', `tools 修复 [${id}] 转换=${s.converted} 丢弃=${s.dropped} 保留=${s.tools.length}`);
        }
      }
      // Zen /responses 不认字符串 input(内部转 messages 为空报 400),自动转数组
      if (config.sanitizeTools && /responses\/?$/.test(upstreamPath.split('?')[0]) && typeof j.input === 'string') {
        j.input = [{ role: 'user', content: j.input }];
        body = Buffer.from(JSON.stringify(j));
        logger.info('proxy', `input 兼容 [${id}] 字符串 input 已转为数组`);
      }
      if (typeof j.model === 'string' && j.model.startsWith('copilot/')) {
        channel = 'copilot';
        j.model = j.model.slice('copilot/'.length);
        body = Buffer.from(JSON.stringify(j));
      }
    } catch { /* 非 JSON body 不改写 */ }
  }
  if (channel === 'copilot' && !config.copilotEnabled) {
    return sendJson(res, 400, errJson('copilot 通道未启用(需设置 COPILOT_ENABLED=1)', 'copilot_disabled'));
  }
  const isModels = upstreamPath.split('?')[0] === '/models' || upstreamPath.split('?')[0] === '/models/';

  // ---- 主动限速(在并发闸门之前,被拒不占并发名额) ----
  let model;
  if (body.length) {
    try { model = JSON.parse(body.toString('utf8')).model; } catch { /* 保留 channel 判定时的解析 */ }
  }
  // TPM 估算:请求体 UTF-8 字节数 / 4(英文≈4B/token,中文略保守)
  const estTokens = Math.ceil(body.length / 4);
  const limited = limiter.check(model, estTokens);
  if (limited) {
    const sec = Math.max(1, Math.ceil(limited.retryAfterMs / 1000));
    logger.warn('proxy', `!! 限速拦截 [${limited.scope}] model=${model || '-'} est=${estTokens}tok ${sec}s 后可用`);
    res.writeHead(429, {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': String(sec),
      'x-ratelimit-scope': limited.scope,
    });
    return res.end(JSON.stringify({
      error: {
        message: `代理主动限速(${limited.scope}):请求频率/用量超过配额,请 ${sec} 秒后重试`,
        type: 'rate_limit_error',
        code: 'proxy_rate_limited',
      },
    }));
  }

  logger.info('proxy', `-> [${channel}] ${req.method} ${upstreamPath} [${id}] body=${body.length}B gate=${JSON.stringify(gate.stats())}`);

  try {
    if (channel === 'copilot') {
      await copilotForward(id, req, res, upstreamPath, body, startedAt);
    } else if (isModels && config.copilotEnabled) {
      await aggregatedModels(req, res, upstreamPath, id, startedAt);
    } else {
      await forwardWithRetry(id, req, res, upstreamPath, body, startedAt);
    }
  } catch (e) {
    if (e.code === 'CLIENT_CLOSED') {
      logger.warn('proxy', `<- [${id}] 客户端提前断开`);
      return;
    }
    logger.error('proxy', `<- [${id}] 失败: ${String(e && e.message || e).slice(0, 300)}`);
    if (!res.headersSent) sendJson(res, e.statusCode || 502, errJson(String(e && e.message || e), e.code || 'upstream_error'));
    else res.destroy();
  } finally {
    release();
  }
}

async function forwardWithRetry(id, req, res, upstreamPath, body, startedAt) {
  const maxAttempts =
    1 + Math.max(config.retry429, 0) + Math.max(config.retry5xx, 0) + Math.max(config.retryNetwork, 0) + 1; // 401 重试单独 +1
  let attempt = 0;
  let refreshedOn401 = false;

  while (true) {
    attempt++;
    let accessToken;
    try {
      accessToken = await auth.getAccessToken();
    } catch (e) {
      if (e.code === 'AUTH_PENDING') {
        return sendJson(res, 503, {
          error: {
            message: 'opencode 设备授权未完成:' + e.message,
            type: 'proxy_auth_pending',
            verification_url: e.pending ? e.pending.verificationUrl : null,
            user_code: e.pending ? e.pending.userCode : null,
            hint: '打开 verification_url 完成授权后重试;或查看 /auth/status',
          },
        });
      }
      throw e;
    }

    const ac = new AbortController();
    const onClientClose = () => ac.abort();
    res.on('close', onClientClose);
    const headerTimer = setTimeout(() => ac.abort(), config.headerTimeoutMs);

    let resp;
    try {
      resp = await pfetch(config.upstreamBase + upstreamPath, {
        method: req.method,
        headers: buildUpstreamHeaders(req, accessToken),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(headerTimer);
      res.removeListener('close', onClientClose);
      if (res.writableEnded || res.destroyed) { const err = new Error('client closed'); err.code = 'CLIENT_CLOSED'; throw err; }
      if (attempt <= config.retryNetwork + 1) {
        stats.retries++;
        const wait = backoffMs(attempt);
        logger.warn('proxy', `[${id}] 网络错误,${wait}ms 后重试 (${attempt}): ${String(e && e.cause && e.cause.message || e).slice(0, 150)}`);
        await sleep(wait);
        continue;
      }
      const err = new Error(`上游连接失败: ${String(e && e.cause && e.cause.message || e).slice(0, 150)}`);
      err.statusCode = 502;
      throw err;
    }
    clearTimeout(headerTimer);

    // ---- 已拿到响应头,根据状态码决定重试或转发 ----
    if (resp.status === 401 || resp.status === 403) {
      stats.upstream_401++;
      const errText = await resp.text().catch(() => '');
      res.removeListener('close', onClientClose);
      if (resp.status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        stats.retries++;
        logger.warn('proxy', `[${id}] 上游 401,强制刷新令牌后重试: ${errText.slice(0, 150)}`);
        try { await auth.forceRefresh(); } catch (e) { logger.warn('proxy', `[${id}] 刷新失败: ${String(e && e.message || e).slice(0, 150)}`); }
        continue;
      }
      const err = new Error(`上游鉴权失败 ${resp.status}: ${errText.slice(0, 150)}`);
      err.statusCode = 502;
      throw err;
    }

    if (resp.status === 429) {
      stats.upstream_429++;
      const errText = await resp.text().catch(() => '');
      res.removeListener('close', onClientClose);
      if (attempt - 1 < config.retry429) {
        stats.retries++;
        const wait = retryAfterMs(resp.headers.get('retry-after')) || backoffMs(attempt);
        logger.warn('proxy', `[${id}] 上游 429,${wait}ms 后重试 (${attempt}/${config.retry429}): ${errText.slice(0, 120)}`);
        await sleep(wait);
        continue;
      }
      logger.warn('proxy', `[${id}] 上游 429 重试耗尽,原样返回`);
      return relayResponse(id, req, res, new Response(errText, {
        status: 429,
        headers: pickRespHeaders(resp),
      }), ac, onClientClose, startedAt);
    }

    if (resp.status >= 500) {
      const errText = await resp.text().catch(() => '');
      res.removeListener('close', onClientClose);
      if (attempt - 1 < config.retry5xx) {
        stats.retries++;
        const wait = backoffMs(attempt);
        logger.warn('proxy', `[${id}] 上游 ${resp.status},${wait}ms 后重试 (${attempt}): ${errText.slice(0, 120)}`);
        await sleep(wait);
        continue;
      }
      const err = new Error(`上游 ${resp.status}: ${errText.slice(0, 150)}`);
      err.statusCode = 502;
      throw err;
    }

    res.removeListener('close', onClientClose);
    return relayResponse(id, req, res, resp, ac, onClientClose, startedAt);
  }
}

/** GitHub Copilot 通道转发(GitHub token 长期有效,不做自动刷新;401 提示重新授权) */
async function copilotForward(id, req, res, upstreamPath, body, startedAt) {
  let token;
  try {
    token = copilot.getAccessToken();
  } catch (e) {
    if (e.code === 'COPILOT_PENDING') {
      // 若设备码尚未发出,先发起一次拿到 user_code 再提示
      let pend = e.pending || copilot.pending;
      if (!pend) {
        try { await copilot.startDeviceFlow(); pend = copilot.pending; } catch { /* 发起失败按原样提示 */ }
      }
      return sendJson(res, 503, {
        error: {
          message: 'GitHub Copilot 通道尚未授权:' + e.message,
          type: 'copilot_auth_pending',
          verification_url: pend ? pend.verificationUrl : 'https://github.com/login/device',
          user_code: pend ? pend.userCode : null,
          hint: '打开 verification_url 输入 user_code 完成授权,或稍后重试',
        },
      });
    }
    throw e;
  }

  const ac = new AbortController();
  const onClientClose = () => ac.abort();
  res.on('close', onClientClose);
  const headerTimer = setTimeout(() => ac.abort(), config.headerTimeoutMs);

  let resp;
  try {
    resp = await pfetch(config.copilotApiBase + upstreamPath, {
      method: req.method,
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json, text/event-stream',
        'accept-encoding': 'identity',
        'x-github-api-version': config.githubApiVersion,
        'user-agent': config.userAgent,
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(headerTimer);
    res.removeListener('close', onClientClose);
    if (res.destroyed || res.writableEnded) { const err = new Error('client closed'); err.code = 'CLIENT_CLOSED'; throw err; }
    const err = new Error(`Copilot 通道连接失败: ${String(e && e.cause && e.cause.message || e).slice(0, 150)}`);
    err.statusCode = 502;
    throw err;
  }
  clearTimeout(headerTimer);
  if (resp.status === 401) {
    logger.warn('proxy', `[${id}] Copilot 401:GitHub 令牌可能已撤销,请 POST /copilot/start 重新授权`);
  }
  return relayResponse(id, req, res, resp, ac, onClientClose, startedAt);
}

/** 聚合 Zen + Copilot 两个通道的模型列表(copilot 模型带 copilot/ 前缀) */
async function aggregatedModels(req, res, upstreamPath, id, startedAt) {
  const zen = (async () => {
    const t = await auth.getAccessToken();
    const r = await pfetch(config.upstreamBase + upstreamPath, {
      headers: { authorization: `Bearer ${t}`, accept: 'application/json', 'user-agent': config.userAgent },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).data || [];
  })();
  const cp = (async () => {
    const t = copilot.getAccessToken();
    const r = await pfetch(config.copilotApiBase + '/models', {
      headers: { authorization: `Bearer ${t}`, accept: 'application/json', 'x-github-api-version': config.githubApiVersion, 'user-agent': config.userAgent },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()).data || [];
    return data.map((m) => ({ ...m, id: 'copilot/' + m.id, owned_by: m.owned_by || 'github-copilot' }));
  })();

  const [rz, rc] = await Promise.allSettled([zen, cp]);
  const data = [];
  const warn = [];
  if (rz.status === 'fulfilled') data.push(...rz.value);
  else warn.push('zen: ' + String(rz.reason && rz.reason.message || rz.reason).slice(0, 120));
  if (rc.status === 'fulfilled') data.push(...rc.value);
  else warn.push('copilot: ' + String(rc.reason && rc.reason.message || rc.reason).slice(0, 120));

  logger.info('proxy', `<- [${id}] models 聚合 zen=${rz.status === 'fulfilled' ? rz.value.length : 'fail'} copilot=${rc.status === 'fulfilled' ? rc.value.length : 'fail'} ${Math.round((Date.now() - startedAt) / 1000)}s`);
  sendJson(res, 200, { object: 'list', data, ...(warn.length ? { _warnings: warn } : {}) });
}

/**
 * 工具定义格式修复(chat/completions):
 * 部分客户端(如 Codex)会把 Responses API 的扁平 function 定义
 *   {"type":"function","name":"x","description":...,"parameters":...}
 * 甚至缺 name 的残缺对象混进 tools 数组,上游校验 function.name 直接 400。
 * 这里统一转为嵌套格式,无法修复的条目丢弃(响应头 x-sanitized-tools 标注)。
 */
function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return { tools, dropped: 0, converted: 0 };
  const out = [];
  let dropped = 0, converted = 0;
  for (const t of tools) {
    if (!t || typeof t !== 'object') { dropped++; continue; }
    const fn = t.function;
    if (fn && typeof fn === 'object' && fn.name) { out.push(t); continue; } // 标准嵌套
    const name = (fn && fn.name) || t.name;
    if (name && (t.type === 'function' || t.type === undefined || !t.type)) {
      // 扁平格式或缺 type:重组为标准嵌套
      out.push({
        type: 'function',
        function: {
          name,
          description: (fn && fn.description) || t.description || '',
          parameters: (fn && fn.parameters) || t.parameters || { type: 'object', properties: {} },
        },
      });
      converted++;
      continue;
    }
    dropped++; // 无 name 无法修复(如空对象)
  }
  return { tools: out, dropped, converted };
}

/**
 * Responses API 的 tools 修复:目标格式是扁平
 *   {"type":"function","name":"x","description":...,"parameters":...}
 * 嵌套 chat 格式转入的条目转扁平;缺 name 的残缺条目丢弃;
 * 非 function 类型(web_search 等内置工具)也丢弃——Zen 的 Responses->chat
 * 转换器不支持它们,会生成空 {} 导致上游 400。
 */
function sanitizeToolsResponses(tools) {
  if (!Array.isArray(tools)) return { tools, dropped: 0, converted: 0 };
  const out = [];
  let dropped = 0, converted = 0;
  for (const t of tools) {
    if (!t || typeof t !== 'object') { dropped++; continue; }
    if (t.type === 'function' || t.type === undefined || !t.type) {
      const name = t.name || (t.function && t.function.name);
      if (name) {
        const fn = t.function || {};
        out.push({
          type: 'function',
          name,
          description: t.description || fn.description || '',
          parameters: t.parameters || fn.parameters || { type: 'object', properties: {} },
          ...(t.strict !== undefined ? { strict: t.strict } : {}),
        });
        converted++;
        continue;
      }
    }
    dropped++; // 无 name / 非 function 类型(Zen 不支持)
  }
  return { tools: out, dropped, converted };
}

/** 把上游响应(含 SSE 流)转发给客户端,空闲时插入 SSE 心跳注释防止链路被掐断 */
async function relayResponse(id, req, res, resp, ac, onClientClose, startedAt) {
  const isSse = (resp.headers.get('content-type') || '').includes('text/event-stream');

  const headers = {};
  resp.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'content-encoding' || lk === 'content-length') return;
    headers[k] = v;
  });
  headers['x-accel-buffering'] = 'no';
  headers['cache-control'] = 'no-cache';

  res.writeHead(resp.status, headers);
  res.flushHeaders();
  if (res.socket) res.socket.setKeepAlive(true, 30_000);
  res.on('close', onClientClose);

  let kaTimer = null;
  let idleTimer = null;
  let lastActivity = Date.now();
  const stopTimers = () => { if (kaTimer) clearInterval(kaTimer); if (idleTimer) clearTimeout(idleTimer); };

  if (isSse && config.keepaliveSec > 0) {
    // 空闲超过 keepaliveSec 才发心跳(SSE 注释行,OpenAI SDK / new-api 都会忽略);
    // 上游正在出数据时绝不插话,避免把一个 SSE 事件从中切断
    const kaInterval = Math.max(1, Math.floor(config.keepaliveSec * 1000 / 2));
    kaTimer = setInterval(() => {
      if (res.writable && !res.destroyed && Date.now() - lastActivity >= config.keepaliveSec * 1000) {
        stats.keepalives_sent++;
        lastActivity = Date.now();
        res.write(': keepalive\n\n');
      }
    }, kaInterval);
    kaTimer.unref?.();
  }

  const touchIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (config.streamIdleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        logger.warn('proxy', `[${id}] 上游流式空闲超过 ${config.streamIdleTimeoutMs / 1000}s,断开`);
        ac.abort();
      }, config.streamIdleTimeoutMs);
      idleTimer.unref?.();
    }
  };
  touchIdle();

  try {
    for await (const chunk of resp.body) {
      lastActivity = Date.now();
      touchIdle();
      if (res.destroyed || res.writableEnded) break;
      if (!res.write(Buffer.from(chunk))) {
        // 背压:等客户端消费,但绝不断流
        await new Promise((r) => res.once('drain', r));
      }
    }
    stopTimers();
    res.end();
    logger.info('proxy', `<- [${id}] ${resp.status} 完成 ${Math.round((Date.now() - startedAt) / 1000)}s sse=${isSse}`);
  } catch (e) {
    stopTimers();
    if (res.destroyed || res.writableEnded) return;
    res.end();
    logger.error('proxy', `[${id}] 流转发中断: ${String(e && e.message || e).slice(0, 200)}`);
  } finally {
    stopTimers();
    res.removeListener('close', onClientClose);
  }
}

// ---------------------------------------------------------------- 工具函数

function buildUpstreamHeaders(req, accessToken) {
  const h = {
    'authorization': `Bearer ${accessToken}`,
    'user-agent': config.userAgent,
    'accept': req.headers['accept'] || 'application/json, text/event-stream',
    'accept-encoding': 'identity',
  };
  const ct = req.headers['content-type'];
  if (ct) h['content-type'] = ct;
  for (const k of ['x-org-id', 'opencode-account', 'x-session-id']) {
    if (req.headers[k]) h[k] = req.headers[k];
  }
  return h;
}

function pickRespHeaders(resp) {
  const h = {};
  resp.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (!HOP_BY_HOP.has(lk) && lk !== 'content-encoding' && lk !== 'content-length') h[k] = v;
  });
  return h;
}

function checkKey(req) {
  if (config.proxyApiKeys.length === 0) return false;
  const authz = req.headers['authorization'] || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    // 允许通过 x-api-key 兜底
    const alt = req.headers['x-api-key'];
    return alt && config.proxyApiKeys.includes(alt.trim());
  }
  return config.proxyApiKeys.includes(m[1].trim());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function errJson(message, type) {
  return { error: { message, type } };
}

function backoffMs(attempt) {
  return Math.min(8000, 500 * 2 ** (attempt - 1));
}

function retryAfterMs(v) {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, 60_000);
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function infoPayload() {
  return {
    name: 'opencode-zen-proxy',
    version: '1.0.0',
    description: 'OpenCode Zen 透明反向代理(鉴权 + 流式转发 + 设备码自动刷新)',
    auth_state: auth.state,
    endpoints: {
      web_console: 'GET / (Web 状态页)',
      info: 'GET /info',
      openai_chat: 'POST /v1/chat/completions',
      openai_responses: 'POST /v1/responses',
      anthropic_messages: 'POST /v1/messages',
      models: 'GET /v1/models',
      status: 'GET /auth/status',
      copilot: 'GET /copilot/status | POST /copilot/start | POST /copilot/revoke',
      stats: 'GET /stats (需 key)',
      refresh: 'POST /auth/refresh (需 key)',
      restart_device_auth: 'POST /auth/restart (需 key)',
      health: 'GET /healthz',
    },
    upstream: config.upstreamBase,
  };
}

// ---------------------------------------------------------------- 启动

if (config.proxyApiKeys.length === 0) {
  logger.warn('main', 'PROXY_API_KEYS 未配置,所有 API 请求都会被拒绝!请在 .env 中设置后重启');
}

proxyFetch.init(config);
Promise.all([auth.init(), copilot.init()]).then(() => {
  server.listen(config.port, config.host, () => {
    logger.info('main', `opencode-zen-proxy 已启动: http://${config.host}:${config.port}`);
    logger.info('main', `上游: ${config.upstreamBase} | 控制台: ${config.consoleBase} | 出站代理: ${proxyFetch.getProxy() ? proxyFetch.mask(new URL(proxyFetch.getProxy())) : '直连'}`);
    logger.info('main', `并发=${config.maxConcurrency} 心跳=${config.keepaliveSec}s 刷新检查=${config.refreshIntervalMin}min 限速:免费=${config.rateLimitFreeRpm || '不限'}rpm 全局=${config.rateLimitGlobalRpm || '不限'}rpm burst=${config.rateLimitBurst}`);
  });
});

process.on('SIGTERM', () => {
  logger.info('main', '收到 SIGTERM,关闭中');
  auth.stop();
  copilot.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
process.on('SIGINT', () => {
  auth.stop();
  copilot.stop();
  process.exit(0);
});
