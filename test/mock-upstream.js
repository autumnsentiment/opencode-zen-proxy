'use strict';

/**
 * 本地 mock:同时扮演 OpenCode Zen 上游与 console 授权服务器,用于自测。
 *   node test/mock-upstream.js            # 正常模式
 *   GAP_MS=12000 node test/mock-upstream.js   # SSE 中间停顿 12s(测心跳)
 *   FAIL_429_FIRST=1 / FAIL_401_FIRST=1       # 首个 POST 分别回 429 / 401(测重试与刷新)
 */
const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 9911);
const GAP_MS = Number(process.env.GAP_MS || 12000);
const failed = { '429': false, '401': false };
let tokenSeq = 0;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const json = body ? JSON.parse(body) : {};
  const path = req.url.split('?')[0];
  const log = (msg) => console.log(new Date().toISOString(), 'mock', req.method, path, msg);

  // ---- console 授权端点 ----
  if (path === '/auth/device/code') {
    log('');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      device_code: 'dev_mock', user_code: 'MOCK-CODE',
      verification_uri_complete: '/auth/device?code=MOCK-CODE', expires_in: 600, interval: 1,
    }));
  }
  if (path === '/auth/device/token') {
    if (json.grant_type === 'refresh_token') {
      tokenSeq++;
      log(`refresh -> token #${tokenSeq}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: `mock-access-${tokenSeq}`, refresh_token: `mock-refresh-${tokenSeq}`, token_type: 'Bearer', expires_in: 3600 }));
    }
    log('device grant -> pending');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'authorization_pending', error_description: 'mock' }));
  }

  // ---- GitHub 设备码端点(mock) ----
  if (path === '/login/device/code') {
    log('');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      device_code: 'gh_dev_code', user_code: 'GHMO-CK99',
      verification_uri: 'http://127.0.0.1:9911/login/device', expires_in: 600, interval: 1,
    }));
  }
  if (path === '/login/oauth/access_token') {
    if (json.grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && json.device_code === 'gh_dev_code') {
      if (process.env.GH_APPROVE === '1') {
        log('approved');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'gh-token-1', token_type: 'bearer', scope: 'read:user' }));
      }
      log('pending');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'authorization_pending', error_description: '' }));
    }
    res.writeHead(400); return res.end(JSON.stringify({ error: 'bad_verification_code' }));
  }
  if (path === '/user') {
    log('github user');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ login: 'mock-github-user', id: 42 }));
  }

  // ---- 上游 API ----
  if (path === '/models') {
    log('');
    const isCopilot = !!req.headers['x-github-api-version'];
    res.writeHead(200, { 'content-type': 'application/json' });
    if (isCopilot) {
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5-copilot' }, { id: 'claude-5-copilot' }] }));
    }
    return res.end(JSON.stringify({
      object: 'list',
      _auth: req.headers['authorization'] || null, // 回显鉴权,验证 public/oauth token
      data: [{ id: 'gpt-5.1' }, { id: 'claude-sonnet-5' }, { id: 'glm-5.3' }],
    }));
  }

  // Copilot 通道的 chat(以 x-github-api-version 头区分)
  if ((path === '/chat/completions' || path === '/responses') && req.headers['x-github-api-version']) {
    const authz = req.headers['authorization'] || '';
    log(`copilot chat auth=${authz.slice(0, 24)} model=${json.model}`);
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'mock-copilot', object: 'chat.completion', model: json.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'copilot-ok ' + authz }, finish_reason: 'stop' }],
      }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'copilot-ok ' + authz } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  if (path === '/chat/completions' || path === '/responses' || path === '/messages') {
    if (process.env.FAIL_429_FIRST && !failed['429']) {
      failed['429'] = true;
      log('inject 429');
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end(JSON.stringify({ error: { message: 'mock rate limit', type: 'rate_limit_error' } }));
    }
    if (process.env.FAIL_401_FIRST && !failed['401']) {
      failed['401'] = true;
      log('inject 401');
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'mock token expired', type: 'authentication_error' } }));
    }

    const authz = req.headers['authorization'] || '';
    log(`auth=${authz.slice(0, 24)} stream=${!!json.stream} tools=${(json.tools || []).length} tool_choice=${JSON.stringify(json.tool_choice ?? null)}`);

    // ---- tools 场景:回显参数并返回 tool_calls(验证代理透传不丢参数)----
    const toolName = json.tools?.[0]?.function?.name || 'get_weather';
    const toolArgs = JSON.stringify({ city: '上海', unit: 'celsius' });

    if (json.tools?.length && !json.stream && path === '/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'mock-tool', object: 'chat.completion', model: json.model || 'mock',
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: toolName, arguments: toolArgs } }],
          },
          finish_reason: 'tool_calls',
        }],
        _echo: {
          tools: json.tools.length,
          tool_names: (json.tools || []).map((t) => (t.function && t.function.name) || t.name || null),
          tool_choice: json.tool_choice ?? null, parallel_tool_calls: json.parallel_tool_calls ?? null,
        },
      }));
    }

    if (json.tools?.length && json.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const ev = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      ev({ id: 'mock-tool', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: toolName, arguments: '' } }] } }] });
      const mid = Math.ceil(toolArgs.length / 2);
      ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: toolArgs.slice(0, mid) } }] } }] });
      ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: toolArgs.slice(mid) } }] } }] });
      ev({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'mock-resp', object: path === '/responses' ? 'response' : 'chat.completion',
        model: json.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: `hello from mock, token=${authz.slice(0, 24)}` }, finish_reason: 'stop' }],
        output: [{ type: 'message', content: [{ type: 'output_text', text: `hello from mock, token=${authz.slice(0, 24)}` }] }],
        _echo: path === '/responses'
          ? { tool_names: (json.tools || []).map((t) => t.name || t.type || null) }
          : { tools: (json.tools || []).length, tool_names: (json.tools || []).map((t) => (t.function && t.function.name) || t.name || null), tool_choice: json.tool_choice ?? null, parallel_tool_calls: json.parallel_tool_calls ?? null },
      }));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta, extra) => ev(Object.assign({ id: 'mock-stream', object: 'chat.completion.chunk', model: json.model || 'mock', choices: [{ index: 0, delta }] }, extra || {}));
    chunk({ role: 'assistant', content: 'part-1' });
    await sleep(200);
    chunk({ content: 'part-2' });
    log(`gap ${GAP_MS}ms...`);
    await sleep(GAP_MS); // 长停顿:代理必须在期间发心跳且不掐断
    chunk({ content: 'part-3' });
    await sleep(200);
    ev({ id: 'mock-stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
    log('stream done');
    return;
  }

  res.writeHead(404); res.end('{}');
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
server.listen(PORT, () => console.log(new Date().toISOString(), 'mock listening on', PORT));
