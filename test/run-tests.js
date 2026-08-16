'use strict';

/**
 * 端到端自测:拉起 mock 上游 + 代理,验证透传、SSE 心跳、429 重试、401 刷新重试、鉴权。
 * 用法: node test/run-tests.js
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail || ''}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startProc(cmd, args, env, tag) {
  const p = spawn(cmd, args, {
    cwd: ROOT, env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.log = () => out.split('\n').slice(-15).join('\n');
  p.on('exit', (c) => console.log(`  [${tag}] exited ${c}`));
  return p;
}

async function waitHealth(port, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

async function wait(ms) { await sleep(ms); }

async function runScenario(name, mockEnv, proxyEnv, fn) {
  console.log(`\n== 场景: ${name} ==`);
  const mockPort = 9911, proxyPort = 8790;
  const mock = startProc('node', ['test/mock-upstream.js'], { MOCK_PORT: mockPort, ...mockEnv }, 'mock');
  await waitHealth(mockPort, 8000);
  const noBootstrap = !!proxyEnv.NO_BOOTSTRAP;
  const bootstrap = noBootstrap ? '' : JSON.stringify({ access_token: 'boot-token', refresh_token: 'mock-refresh-0', expires_at: Date.now() + 3600_000 });
  const { NO_BOOTSTRAP, ...proxyEnvClean } = proxyEnv;
  const proxy = startProc('node', ['src/server.js'], {
    PORT: proxyPort,
    PROXY_API_KEYS: 'k1',
    UPSTREAM_BASE: `http://127.0.0.1:${mockPort}`,
    CONSOLE_BASE: `http://127.0.0.1:${mockPort}`,
    BOOTSTRAP_AUTH_JSON: bootstrap,
    KEEPALIVE_SECONDS: '2',
    DATA_DIR: path.join(require('os').tmpdir(), 'ocp-test-' + Date.now()),
    ...proxyEnvClean,
  }, 'proxy');
  try {
    if (!(await waitHealth(proxyPort))) throw new Error('proxy 未启动:\n' + proxy.log());
    await fn(`http://127.0.0.1:${proxyPort}`, proxy);
  } catch (e) {
    failed++;
    console.log(`  FAIL 场景异常: ${e.message}\n--- proxy log ---\n${proxy.log()}`);
  } finally {
    proxy.kill(); mock.kill();
    await wait(500);
  }
}

(async () => {
  // ---------- 场景 A:基础鉴权 + 透传 + SSE 心跳 ----------
  await runScenario('SSE 流式 + 心跳保活', { GAP_MS: '8000' }, {}, async (base, proxy) => {
    let r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer bad' } });
    ok('错误 key 返回 401', r.status === 401);

    r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer k1' } });
    const models = await r.json();
    ok('GET /v1/models 透传', r.status === 200 && models.data && models.data.length === 3, JSON.stringify(models).slice(0, 100));

    r = await fetch(base + '/v1/responses', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', input: 'hi' }),
    });
    const resp = await r.json();
    ok('POST /v1/responses 非流式透传', r.status === 200 && resp.output && resp.output[0].content[0].text.includes('hello from mock'), JSON.stringify(resp).slice(0, 150));

    const t0 = Date.now();
    r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', stream: true, messages: [] }),
    });
    ok('流式响应头是 SSE', (r.headers.get('content-type') || '').includes('text/event-stream'));
    let text = '';
    for await (const c of r.body) text += Buffer.from(c).toString('utf8');
    const dur = Date.now() - t0;
    const keepalives = (text.match(/: keepalive/g) || []).length;
    const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    const allJson = events.filter((e) => e !== '[DONE]').every((e) => { try { JSON.parse(e); return true; } catch { return false; } });
    ok('SSE 事件全部完整(JSON 可解析,心跳未破坏事件)', allJson, text.slice(0, 200));
    ok('长停顿期间收到心跳注释', keepalives >= 1, `keepalives=${keepalives}`);
    const deltas = events.filter((e) => e !== '[DONE]').map((e) => JSON.parse(e).choices?.[0]?.delta?.content).filter(Boolean);
    ok('数据事件按序全部到达', deltas.join('|') === 'part-1|part-2|part-3' && events[events.length - 1] === '[DONE]', JSON.stringify(deltas));
    ok('流未被提前掐断(总时长>=8s)', dur >= 7500, `dur=${dur}ms`);
  });

  // ---------- 场景 B:上游 429 自动重试 ----------
  await runScenario('429 重试', { FAIL_429_FIRST: '1' }, { RETRY_429: '2' }, async (base, proxy) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', messages: [] }),
    });
    const j = await r.json();
    ok('429 后重试成功', r.status === 200 && j.choices[0].message.content.includes('hello from mock'));
    ok('代理日志记录了重试', /429.*重试/.test(proxy.log()));
  });

  // ---------- 场景 C:上游 401 -> 刷新令牌 -> 重试 ----------
  await runScenario('401 触发令牌刷新', { FAIL_401_FIRST: '1' }, {}, async (base, proxy) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', messages: [] }),
    });
    const j = await r.json();
    ok('401 后刷新并重试成功', r.status === 200 && j.choices[0].message.content.includes('mock-access-1'), JSON.stringify(j).slice(0, 200));
    ok('代理日志记录了刷新', /401.*刷新/.test(proxy.log()));
    const st = await (await fetch(base + '/auth/status')).json();
    ok('状态为已授权', st.state === 'authorized');
  });

  // ---------- 场景 D:tools / tool_choice 参数与 tool_calls 流式分片 ----------
  await runScenario('tools 参数透传与 tool_calls 流式', {}, {}, async (base) => {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询城市天气',
        parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string' } }, required: ['city'] },
      },
    }];

    // 非流式:mock 回显收到的参数,证明代理未丢弃/改写
    let r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', messages: [], tools, tool_choice: 'auto', parallel_tool_calls: true }),
    });
    let j = await r.json();
    ok('tools/tool_choice/parallel 参数原样到达上游', j._echo && j._echo.tools === 1 && j._echo.tool_choice === 'auto' && j._echo.parallel_tool_calls === true, JSON.stringify(j._echo));
    ok('非流式返回 tool_calls', j.choices[0].message.tool_calls?.[0]?.function?.name === 'get_weather');

    // 流式:tool_calls arguments 被拆成多个 delta 分片,验证分片完整拼接
    r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', stream: true, messages: [], tools, tool_choice: { type: 'function', function: { name: 'get_weather' } } }),
    });
    let text = '';
    for await (const c of r.body) text += Buffer.from(c).toString('utf8');
    const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).filter((e) => e !== '[DONE]');
    let args = '', finish = null, nameOk = false;
    for (const e of events) {
      const chunk = JSON.parse(e);
      const tc = chunk.choices?.[0]?.delta?.tool_calls?.[0];
      if (tc?.function?.name) nameOk = tc.function.name === 'get_weather';
      if (tc?.function?.arguments) args += tc.function.arguments;
      if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
    }
    let parsed = null;
    try { parsed = JSON.parse(args); } catch {}
    ok('流式 tool_calls 分片完整拼接(可直接 JSON.parse)', parsed && parsed.city === '上海' && parsed.unit === 'celsius', `args=${args}`);
    ok('函数名与 finish_reason 正确', nameOk && finish === 'tool_calls', `name=${nameOk} finish=${finish}`);
  });

  // ---------- 场景 E:HTTP CONNECT 代理 + 运行时代理配置 ----------
  await runScenario('HTTP 代理隧道', {}, { UPSTREAM_PROXY: 'http://127.0.0.1:9912' }, async (base, proxy) => {
    const { spawn } = require('child_process');
    const mp = spawn('node', ['test/mock-proxy.js'], { cwd: ROOT, env: { ...process.env, MOCK_PROXY_PORT: '9912', UPSTREAM_PORT: '9911' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await wait(800);
    try {
      let r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer k1' } });
      const j = await r.json();
      ok('经 HTTP 代理透传请求成功', r.status === 200 && j.data && j.data.length === 3, JSON.stringify(j).slice(0, 120));

      let st = await (await fetch(base + '/proxy/config')).json();
      ok('代理配置可见(脱敏)', st.proxy && st.proxy.includes('9912') && st.source === 'env', JSON.stringify(st));

      const before = (await (await fetch('http://127.0.0.1:9912/__stats')).json()).connects;
      r = await fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.1', messages: [] }),
      });
      const after = (await (await fetch('http://127.0.0.1:9912/__stats')).json()).connects;
      ok('上游请求确实走了代理(CONNECT 计数增加)', r.status === 200 && after > before, `before=${before} after=${after}`);

      // 运行时切换到坏代理 -> 请求失败;切回 -> 恢复
      r = await fetch(base + '/proxy/config', {
        method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
        body: JSON.stringify({ proxy: 'http://127.0.0.1:9 invalid' }),
      });
      ok('非法代理地址被拒绝(400)', r.status === 400, `status=${r.status}`);

      await fetch(base + '/proxy/config', {
        method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
        body: JSON.stringify({ proxy: 'http://127.0.0.1:1/' }),
      });
      r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer k1' } });
      ok('坏代理下请求失败(可感知)', r.status >= 500, `status=${r.status}`);

      await fetch(base + '/proxy/config', {
        method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
        body: JSON.stringify({ proxy: 'http://127.0.0.1:9912' }),
      });
      r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer k1' } });
      ok('切回好代理后恢复', r.status === 200, `status=${r.status}`);

      r = await fetch(base + '/proxy/test', { method: 'POST', headers: { authorization: 'Bearer k1' } });
      const t = await r.json();
      ok('/proxy/test 连通性检测', t.ok === true && t.via_proxy === true && t.status === 200, JSON.stringify(t));
    } finally {
      mp.kill();
    }
  });

  // ---------- 场景 F:SOCKS5 代理隧道 ----------
  await runScenario('SOCKS5 代理隧道', {}, { UPSTREAM_PROXY: 'socks5://mockuser:mockpass@127.0.0.1:9913' }, async (base) => {
    const { spawn } = require('child_process');
    const ms = spawn('node', ['test/mock-proxy.js'], { cwd: ROOT, env: { ...process.env, MOCK_PROXY_PORT: '9914', SOCKS_PORT: '9913', UPSTREAM_PORT: '9911' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await wait(800);
    try {
      let r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer k1' } });
      const j = await r.json();
      ok('经 SOCKS5(用户名密码)透传请求成功', r.status === 200 && j.data && j.data.length === 3, JSON.stringify(j).slice(0, 120));

      const stats = await (await fetch('http://127.0.0.1:9914/__stats')).json();
      ok('SOCKS5 CONNECT 已发生', stats.connects >= 1, JSON.stringify(stats));

      // 流式也走代理
      r = await fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.1', stream: true, messages: [] }),
      });
      let text = '';
      for await (const c of r.body) text += Buffer.from(c).toString('utf8');
      ok('经 SOCKS5 流式输出正常', text.includes('part-1') && text.includes('[DONE]'), text.slice(0, 100));
    } finally {
      ms.kill();
    }
  });

  // ---------- 场景 G:public 匿名模式(零登录) ----------
  await runScenario('public 匿名模式', {}, { AUTH_MODE: 'public', NO_BOOTSTRAP: 1 }, async (base) => {
    const st = await (await fetch(base + '/auth/status')).json();
    ok('public 模式状态正确', st.mode === 'public' && st.effective === 'public' && st.pending === null, JSON.stringify(st).slice(0, 150));

    let r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer k1' } });
    const j = await r.json();
    ok('匿名请求直接可用(上游收到 Bearer public)', r.status === 200 && j._auth === 'Bearer public' && j.data.length === 3, JSON.stringify(j).slice(0, 150));

    r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash-free', messages: [] }),
    });
    const c = await r.json();
    ok('匿名调用 chat 透传正常', r.status === 200 && c.choices[0].message.content.includes('hello from mock'));
  });

  // ---------- 场景 H:GitHub Copilot 通道 ----------
  await runScenario('GitHub Copilot 通道', { GH_APPROVE: '1' }, {
    COPILOT_ENABLED: '1',
    COPILOT_API_BASE: 'http://127.0.0.1:9911',
    GITHUB_DEVICE_BASE: 'http://127.0.0.1:9911',
  }, async (base) => {
    // 发起 GitHub 设备码授权(mock 立即批准)
    let r = await fetch(base + '/copilot/start', { method: 'POST', headers: { authorization: 'Bearer k1' } });
    ok('copilot/start 返回设备码', r.status === 200 && (await r.json()).pending.user_code === 'GHMO-CK99');
    await wait(1800); // 轮询 interval=1s
    let st = await (await fetch(base + '/copilot/status')).json();
    ok('GitHub 授权完成(mock 批准)', st.authorized === true, JSON.stringify(st));

    // copilot/ 前缀路由:前缀被剥离,GitHub token 与 API 版本头送达上游
    r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'copilot/gpt-5-copilot', messages: [] }),
    });
    let j = await r.json();
    ok('copilot/ 前缀路由成功', r.status === 200 && j.choices[0].message.content === 'copilot-ok Bearer gh-token-1', JSON.stringify(j).slice(0, 150));
    ok('模型前缀已剥离', j.model === 'gpt-5-copilot');

    // X-Channel 头路由
    r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json', 'x-channel': 'copilot' },
      body: JSON.stringify({ model: 'gpt-5-copilot', messages: [] }),
    });
    j = await r.json();
    ok('X-Channel: copilot 头路由成功', r.status === 200 && j.choices[0].message.content.includes('copilot-ok'), JSON.stringify(j).slice(0, 120));

    // models 聚合(zen 3 + copilot 2,带前缀)
    r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer k1' } });
    j = await r.json();
    const ids = j.data.map((m) => m.id);
    ok('models 双通道聚合', ids.includes('gpt-5.1') && ids.includes('copilot/gpt-5-copilot') && j.data.length === 5, JSON.stringify(ids));

    // 流式经 copilot 通道
    r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'copilot/gpt-5-copilot', stream: true, messages: [] }),
    });
    let text = '';
    for await (const c of r.body) text += Buffer.from(c).toString('utf8');
    ok('copilot 流式输出', text.includes('copilot-ok') && text.includes('[DONE]'), text.slice(0, 120));
  });

  // ---------- 场景 I:Copilot 未授权时的 503 提示 ----------
  await runScenario('Copilot 未授权提示', {}, {
    COPILOT_ENABLED: '1',
    COPILOT_API_BASE: 'http://127.0.0.1:9911',
    GITHUB_DEVICE_BASE: 'http://127.0.0.1:9911',
  }, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'copilot/gpt-5-copilot', messages: [] }),
    });
    const j = await r.json();
    ok('未授权返回 503 + 设备码提示', r.status === 503 && j.error.type === 'copilot_auth_pending' && j.error.user_code === 'GHMO-CK99', JSON.stringify(j).slice(0, 200));
  });

  // ---------- 场景 J:主动限速(免费模型令牌桶) ----------
  await runScenario('主动 RPM 限速', {}, { RATE_LIMIT_FREE_RPM: '120', RATE_LIMIT_BURST: '1' }, async (base, proxy) => {
    const chat = (model) => fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [] }),
    });

    let r1 = await chat('deepseek-v4-flash-free'); // 桶初始 1 个令牌
    ok('第 1 个免费模型请求放行', r1.status === 200);
    let r2 = await chat('deepseek-v4-flash-free'); // 立刻第 2 个,桶空
    ok('第 2 个立即请求被 429 拦截', r2.status === 429, `status=${r2.status}`);
    const ra = r2.headers.get('retry-after');
    const scope = r2.headers.get('x-ratelimit-scope');
    const j2 = await r2.json();
    ok('429 响应带 Retry-After 与范围标识', Number(ra) >= 1 && scope === 'free-rpm' && j2.error.code === 'proxy_rate_limited', `ra=${ra} scope=${scope}`);

    let r3 = await chat('gpt-5.1'); // 付费模型不受免费桶影响
    ok('付费模型不受免费桶限制', r3.status === 200, `status=${r3.status}`);

    await wait(700); // 120rpm = 0.5s/个
    let r4 = await chat('deepseek-v4-flash-free');
    ok('等待后令牌恢复,请求放行', r4.status === 200, `status=${r4.status}`);

    const st = await (await fetch(base + '/stats', { headers: { authorization: 'Bearer k1' } })).json();
    ok('限速拦截计数正常', st.limiter && st.limiter.rejected === 1 && st.limiter.free_rpm === 120, JSON.stringify(st.limiter));
    ok('代理日志记录了拦截', /限速拦截/.test(proxy.log()));
  });

  // ---------- 场景 K:TPM 限速 + 运行时热更新 ----------
  await runScenario('TPM 限速与热更新', {}, { RATE_LIMIT_FREE_RPM: '0', RATE_LIMIT_FREE_TPM: '400' }, async (base) => {
    const chat = (big) => fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash-free', messages: [{ role: 'user', content: big ? 'x'.repeat(4000) : 'hi' }] }),
    });

    let r1 = await chat(true); // ~4000+ 字节 -> est >1000 tok > 400 TPM 桶容量
    ok('超大 token 请求被 TPM 拦截', r1.status === 429 && r1.headers.get('x-ratelimit-scope') === 'free-tpm', `status=${r1.status}`);
    let r2 = await chat(false); // 小请求 est 少,桶里还有令牌
    ok('小请求正常放行', r2.status === 200, `status=${r2.status}`);

    // 运行时关闭 TPM(热更新)
    let r = await fetch(base + '/ratelimit/config', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ free_tpm: 0 }),
    });
    const j = await r.json();
    ok('运行时更新限速配置', r.status === 200 && j.free_tpm === 0 && j.source === 'runtime', JSON.stringify(j));
    let r3 = await chat(true);
    ok('关闭 TPM 后大请求放行(热更新立即生效)', r3.status === 200, `status=${r3.status}`);

    const cfg = await (await fetch(base + '/ratelimit/config')).json();
    ok('GET 配置可读', cfg.free_rpm === 0 && cfg.free_tpm === 0, JSON.stringify(cfg));
  });

  // ---------- 场景 L:tools 格式自动修复(Codex 混发扁平/残缺格式) ----------
  await runScenario('tools 格式自动修复', {}, {}, async (base, proxy) => {
    const tools = [
      { type: 'function', function: { name: 'ok_nested', description: '标准嵌套', parameters: { type: 'object', properties: {} } } }, // 0: 标准格式
      { type: 'function', name: 'flat_tool', description: 'Responses 扁平格式', parameters: { type: 'object', properties: {} } }, // 1: 扁平
      { description: '无 name 残缺项', parameters: { type: 'object' } }, // 2: 无法修复
      {}, // 3: 空对象
    ];
    let r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', messages: [], tools }),
    });
    const j = await r.json();
    ok('混发格式请求不再 400', r.status === 200, `status=${r.status}`);
    ok('扁平格式已转嵌套且带 name', JSON.stringify(j._echo.tool_names) === JSON.stringify(['ok_nested', 'flat_tool']), JSON.stringify(j._echo.tool_names));
    const st = await (await fetch(base + '/stats', { headers: { authorization: 'Bearer k1' } })).json();
    ok('修复/丢弃计数正确', st.tools_sanitized === 1 && st.tools_dropped === 2, JSON.stringify({ s: st.tools_sanitized, d: st.tools_dropped }));
    ok('代理日志记录了修复', /tools 修复/.test(proxy.log()));

    // responses 端点不做转换(本来就是扁平格式)
    r = await fetch(base + '/v1/responses', {
      method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', input: 'x', tools: [{ type: 'function', name: 'flat_ok', parameters: { type: 'object' } }] }),
    });
    ok('responses 端点保持透传不转换', r.status === 200);
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
