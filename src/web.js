'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 内嵌二维码库(davidshimjs/qrcodejs,MIT)。优先磁盘缓存,便于本地替换。
function loadQrLib() {
  const candidates = [
    path.join(__dirname, 'qrcode.min.js'),
    path.join(os.tmpdir(), 'qrcode.min.js'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {}
  }
  return '/* QRCode library missing: user_code 仍会以文本与链接展示 */';
}

// 页面自身的 JS 不用反引号模板串,避免与外层模板串转义纠缠
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencode-zen-proxy</title>
<style>
  :root { --bg:#0f1420; --card:#171e2e; --line:#26304a; --tx:#dbe4f5; --dim:#7d8aa8; --acc:#4f8cff; --ok:#34d399; --warn:#fbbf24; --err:#f87171; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--tx); font:14px/1.6 system-ui,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif; }
  .wrap { max-width:880px; margin:0 auto; padding:24px 16px 60px; }
  h1 { font-size:18px; margin:0 0 4px; }
  h1 small { color:var(--dim); font-weight:400; margin-left:8px; }
  .sub { color:var(--dim); font-size:12px; margin-bottom:18px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:720px){ .grid { grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; }
  .card h2 { font-size:13px; margin:0 0 10px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; }
  .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .k { color:var(--dim); min-width:96px; display:inline-block; }
  .pill { padding:2px 10px; border-radius:999px; font-size:12px; border:1px solid var(--line); }
  .pill.ok { color:var(--ok); border-color:var(--ok); }
  .pill.warn { color:var(--warn); border-color:var(--warn); }
  .pill.err { color:var(--err); border-color:var(--err); }
  input[type=text],input[type=password]{ background:#0c111d; border:1px solid var(--line); color:var(--tx); border-radius:8px; padding:7px 10px; font-size:13px; }
  input[type=text]{ flex:1; min-width:180px; }
  button { background:var(--acc); border:0; color:#fff; border-radius:8px; padding:7px 14px; font-size:13px; cursor:pointer; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--tx); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .usercode { font-size:34px; letter-spacing:.18em; font-weight:700; color:#fff; margin:8px 0; font-family:ui-monospace,Consolas,monospace; }
  #qr { background:#fff; padding:10px; border-radius:10px; width:fit-content; margin:10px 0; }
  .muted { color:var(--dim); font-size:12px; }
  a { color:var(--acc); text-decoration:none; word-break:break-all; }
  .kv { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:8px; }
  .kv div { background:#0c111d; border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  .kv b { display:block; font-size:18px; font-family:ui-monospace,Consolas,monospace; }
  .kv span { color:var(--dim); font-size:12px; }
  #testout { background:#0c111d; border:1px solid var(--line); border-radius:8px; padding:10px; margin-top:10px; min-height:44px; max-height:260px; overflow:auto; white-space:pre-wrap; font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  .toast { position:fixed; right:16px; bottom:16px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 16px; display:none; max-width:70%; }
</style>
</head>
<body>
<div class="wrap">
  <h1>opencode-zen-proxy <small id="ver"></small></h1>
  <div class="sub">OpenCode Zen 透明反代 · 鉴权 / 流式转发 / 设备码自动刷新 · <span id="uptime"></span></div>

  <div class="card">
    <h2>管理密钥</h2>
    <div class="row">
      <input type="password" id="key" placeholder="PROXY_API_KEYS 之一(用于统计与管理操作)">
      <button id="savekey" class="ghost">保存</button>
      <span class="muted" id="keyhint"></span>
    </div>
  </div>

  <div class="grid">
    <div class="card" id="authcard">
      <h2>OpenCode 通道 <span class="muted" id="modehint"></span></h2>
      <div id="authbody"><span class="muted">加载中…</span></div>
    </div>
    <div class="card">
      <h2>GitHub Copilot 通道</h2>
      <div id="copilotbody"><span class="muted">加载中…</span></div>
      <div class="row" style="margin-top:10px">
        <button id="btn-copilot-start" class="ghost">发起 GitHub 授权</button>
        <button id="btn-copilot-revoke" class="ghost">移除 GitHub 令牌</button>
      </div>
    </div>
    <div class="card">
      <h2>运行统计 <span class="muted" id="stathint"></span></h2>
      <div id="stats" class="kv"><div><b>-</b><span>等待密钥</span></div></div>
    </div>
    <div class="card">
      <h2>管理操作</h2>
      <div class="row">
        <button id="btn-refresh">立即刷新令牌</button>
        <button id="btn-restart" class="ghost">重新设备码授权(换号)</button>
      </div>
      <div class="muted" style="margin-top:6px">刷新/重授权操作需要上方管理密钥;匿名模式下设备码授权可选</div>
    </div>
  </div>

  <div class="card">
    <h2>限速设置 <span class="muted" id="rlhint"></span></h2>
    <div class="row" style="margin-bottom:8px">
      <span class="k" style="min-width:110px">免费 RPM</span>
      <input type="text" id="rl-free-rpm" style="max-width:110px" placeholder="30">
      <span class="k" style="min-width:110px">免费 TPM</span>
      <input type="text" id="rl-free-tpm" style="max-width:110px" placeholder="0=不限">
    </div>
    <div class="row">
      <span class="k" style="min-width:110px">全局 RPM</span>
      <input type="text" id="rl-global-rpm" style="max-width:110px" placeholder="0=不限">
      <span class="k" style="min-width:110px">突发容量</span>
      <input type="text" id="rl-burst" style="max-width:110px" placeholder="5">
      <button id="btn-rl-save">保存限速</button>
    </div>
    <div class="muted" style="margin-top:8px">免费模型(*-free)单独限速;TPM 按请求体估算(字节/4);0=不限。保存立即生效并持久化,重启保留</div>
  </div>

  <div class="card">
    <h2>出站代理</h2>
    <div class="row" style="margin-bottom:8px">
      <span class="muted" id="proxystatus">当前:加载中…</span>
    </div>
    <div class="row">
      <input type="text" id="proxyurl" placeholder="http://user:pass@host:port 或 socks5://host:port(留空保存=清除)">
      <button id="btn-proxysave">保存代理</button>
      <button id="btn-proxytest" class="ghost">测试连通</button>
    </div>
    <div id="proxytestout" class="muted" style="margin-top:8px">上游与控制台请求都会经由该代理;保存后立即生效并持久化,重启容器仍保留(环境变量优先)</div>
  </div>

  <div class="card">
    <h2>连通性测试</h2>
    <div class="row">
      <input type="text" id="model" value="deepseek-v4-flash-free" placeholder="model id">
      <button id="btn-test">发送测试请求</button>
      <label class="muted"><input type="checkbox" id="stream" checked> 流式</label>
    </div>
    <div id="testout" class="muted">点击按钮向 /v1/chat/completions 发送 "ping"(使用管理密钥鉴权)</div>
  </div>

  <div class="sub" id="foot"></div>
</div>
<div class="toast" id="toast"></div>

<script>
${loadQrLib()}
</script>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var key = localStorage.getItem('ocp_key') || '';
  $('key').value = key;

  function toast(msg, isErr){
    var t = $('toast');
    t.textContent = msg;
    t.style.borderColor = isErr ? 'var(--err)' : 'var(--line)';
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(function(){ t.style.display = 'none'; }, 3500);
  }

  function api(path, opts){
    opts = opts || {};
    opts.headers = Object.assign({ 'content-type':'application/json' }, opts.headers || {});
    if (key) opts.headers['authorization'] = 'Bearer ' + key;
    return fetch(path, opts);
  }

  function fmtDur(ms){
    if (ms < 0) ms = 0;
    var s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + (s%60) + 's';
  }

  function saveKey(){
    key = $('key').value.trim();
    localStorage.setItem('ocp_key', key);
    $('keyhint').textContent = key ? '已保存' : '已清空';
    refresh();
  }
  $('savekey').onclick = saveKey;
  $('key').addEventListener('keydown', function(e){ if (e.key === 'Enter') saveKey(); });

  // ---- 授权卡片 ----
  function renderAuth(st){
    var el = $('authbody');
    $('modehint').textContent = st.mode === 'public' ? '(匿名模式)' : st.mode === 'auto' ? '(auto)' : '(账号模式)';
    if (st.state === 'authorized'){
      var left = st.expires_at - Date.now();
      el.innerHTML =
        '<div class="row"><span class="pill ok">已授权</span>' +
        (st.last_refresh_at ? '<span class="muted">上次刷新 ' + new Date(st.last_refresh_at).toLocaleTimeString() + '</span>' : '') +
        '</div>' +
        '<div style="margin-top:10px"><span class="k">令牌剩余</span><b>' + fmtDur(left) + '</b></div>' +
        (st.last_error ? '<div class="muted" style="color:var(--warn)">最近错误: ' + st.last_error + '</div>' : '');
      return;
    }
    if (st.state === 'pending' && st.pending){
      var url = st.pending.verification_url;
      el.innerHTML =
        '<div class="row"><span class="pill warn">等待浏览器授权</span>' +
        (st.mode === 'auto' ? '<span class="muted">匿名通道当前可用,授权后自动升级</span>' : '') + '</div>' +
        '<div style="margin-top:8px"><span class="k">设备码</span></div>' +
        '<div class="usercode">' + st.pending.user_code + '</div>' +
        '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>' +
        '<div id="qr"></div>' +
        '<div class="muted">任意设备扫码或打开链接,登录 OpenCode 账号并确认。本页每 2 秒自动检查。</div>';
      try {
        new QRCode($('qr'), { text: url, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M });
      } catch(e){}
      return;
    }
    el.innerHTML = '<div class="row"><span class="pill ' + (st.mode === 'oauth' ? 'err' : 'ok') + '">' +
      (st.mode === 'oauth' ? '未授权' : '匿名(public)') + '</span></div>' +
      '<div class="muted" style="margin-top:8px">' +
      (st.mode === 'oauth'
        ? '账号模式下必须完成设备码授权才能调用。'
        : '匿名通道已可用(免费模型直接调用,无需登录);完成设备码授权可解锁付费模型。') +
      '</div>' +
      (st.last_error ? '<div class="muted" style="color:var(--warn)">最近错误: ' + st.last_error + '</div>' : '');
  }

  // ---- GitHub Copilot 卡片 ----
  function renderCopilot(cs){
    var el = $('copilotbody');
    if (!cs.enabled){
      el.innerHTML = '<div class="row"><span class="pill">未启用</span></div>' +
        '<div class="muted" style="margin-top:6px">在 .env 设置 COPILOT_ENABLED=1 后重启开启;模型名用 copilot/ 前缀路由到该通道</div>';
      return;
    }
    if (cs.authorized){
      el.innerHTML = '<div class="row"><span class="pill ok">已授权</span>' +
        (cs.login ? '<span class="muted">' + cs.login + '</span>' : '') + '</div>' +
        '<div class="muted" style="margin-top:6px">调用时模型名加 copilot/ 前缀,如 copilot/gpt-5.1</div>';
      return;
    }
    if (cs.pending){
      el.innerHTML =
        '<div class="row"><span class="pill warn">等待 GitHub 授权</span></div>' +
        '<div style="margin-top:8px"><span class="k">设备码</span></div>' +
        '<div class="usercode">' + cs.pending.user_code + '</div>' +
        '<a href="' + cs.pending.verification_url + '" target="_blank" rel="noopener">' + cs.pending.verification_url + '</a>' +
        '<div id="qr2"></div>' +
        '<div class="muted">用自己的 GitHub 账号登录并授权(需 Copilot 订阅)</div>';
      try {
        new QRCode($('qr2'), { text: cs.pending.verification_url, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M });
      } catch(e){}
      return;
    }
    el.innerHTML = '<div class="row"><span class="pill err">未授权</span></div>' +
      '<div class="muted" style="margin-top:6px">点击下方按钮,用自己的 GitHub 账号授权' +
      (cs.last_error ? '<br>最近错误: ' + cs.last_error : '') + '</div>';
  }

  async function loadCopilot() {
    try { renderCopilot(await (await fetch('/copilot/status')).json()); }
    catch(e) { $('copilotbody').innerHTML = '<span class="muted" style="color:var(--err)">无法获取 Copilot 状态</span>'; }
  }
  loadCopilot();

  $('btn-copilot-start').onclick = async function(){
    if (!key) return toast('请先填写管理密钥', true);
    try {
      var r = await api('/copilot/start', { method:'POST' });
      var j = await r.json();
      toast(r.ok ? '已发起 GitHub 设备码授权' : '失败: ' + (j.error && j.error.message || j.error), !r.ok);
    } catch(e){ toast('请求失败: ' + e.message, true); }
    loadCopilot();
  };
  $('btn-copilot-revoke').onclick = async function(){
    if (!key) return toast('请先填写管理密钥', true);
    if (!confirm('移除本机保存的 GitHub 令牌?')) return;
    try {
      await api('/copilot/revoke', { method:'POST' });
      toast('已移除(彻底撤销请到 GitHub Settings -> Applications)');
    } catch(e){ toast('请求失败: ' + e.message, true); }
    loadCopilot();
  };

  // ---- 统计卡片 ----
  function renderStats(s){
    var items = [
      [s.requests, '总请求'], [s.gate ? s.gate.active : '-', '进行中'],
      [s.gate ? s.gate.waiting : '-', '排队中'], [s.limiter ? s.limiter.rejected : '-', '限速拦截'],
      [s.upstream_429, '上游429'], [s.upstream_401, '上游401'],
      [s.retries, '自动重试'], [s.keepalives_sent, '心跳发送'],
      [(s.tools_sanitized || 0) + '/' + (s.tools_dropped || 0), '工具修复/丢弃'],
      [Math.floor((Date.now()-s.started_at)/1000) + 's', '运行时长']
    ];
    $('stats').innerHTML = items.map(function(it){
      return '<div><b>' + it[0] + '</b><span>' + it[1] + '</span></div>';
    }).join('');
  }

  // ---- 轮询刷新 ----
  var first = true;
  async function refresh(){
    try {
      var r = await fetch('/auth/status');
      renderAuth(await r.json());
      loadCopilot();
      if (first) { var info = await (await fetch('/info')).json(); $('ver').textContent = 'v' + info.version; $('foot').textContent = 'upstream: ' + info.upstream; first = false; }
    } catch(e){ $('authbody').innerHTML = '<span class="muted" style="color:var(--err)">无法连接代理进程</span>'; }
    if (!key) { $('stathint').textContent = '(填入管理密钥查看)'; return; }
    try {
      var r2 = await api('/stats');
      if (r2.status === 401) { $('stathint').textContent = '(密钥无效)'; return; }
      $('stathint').textContent = '';
      renderStats(await r2.json());
    } catch(e){}
  }
  setInterval(refresh, 2000);
  refresh();

  // ---- 管理操作 ----
  $('btn-refresh').onclick = async function(){
    if (!key) return toast('请先填写管理密钥', true);
    try {
      var r = await api('/auth/refresh', { method:'POST' });
      var j = await r.json();
      toast(r.ok ? '已刷新,到期 ' + new Date(j.expires_at).toLocaleTimeString() : '失败: ' + (j.error && j.error.message), !r.ok);
    } catch(e){ toast('请求失败: ' + e.message, true); }
    refresh();
  };
  $('btn-restart').onclick = async function(){
    if (!key) return toast('请先填写管理密钥', true);
    if (!confirm('将作废当前授权并发起新的设备码流程,确定?')) return;
    try {
      var r = await api('/auth/restart', { method:'POST' });
      toast(r.ok ? '已重新发起设备码授权' : '失败: ' + r.status, !r.ok);
    } catch(e){ toast('请求失败: ' + e.message, true); }
    refresh();
  };

  // ---- 限速设置 ----
  async function loadRateLimit() {
    try {
      var j = await (await fetch('/ratelimit/config')).json();
      $('rl-free-rpm').value = j.free_rpm;
      $('rl-free-tpm').value = j.free_tpm;
      $('rl-global-rpm').value = j.global_rpm;
      $('rl-burst').value = j.burst;
      $('rlhint').textContent = j.source === 'constructor' ? '(来自环境变量)' : '(' + j.source + ')';
    } catch(e) { $('rlhint').textContent = '(读取失败)'; }
  }
  loadRateLimit();

  $('btn-rl-save').onclick = async function(){
    if (!key) return toast('请先填写管理密钥', true);
    try {
      var r = await api('/ratelimit/config', {
        method:'POST',
        body: JSON.stringify({
          free_rpm: Number($('rl-free-rpm').value) || 0,
          free_tpm: Number($('rl-free-tpm').value) || 0,
          global_rpm: Number($('rl-global-rpm').value) || 0,
          burst: Number($('rl-burst').value) || 1,
        }),
      });
      var j = await r.json();
      if (r.ok) { toast('限速配置已保存并生效: 免费' + j.free_rpm + 'rpm/' + j.free_tpm + 'tpm 全局' + j.global_rpm + 'rpm burst' + j.burst); loadRateLimit(); }
      else toast('保存失败: ' + (j.error && j.error.message), true);
    } catch(e){ toast('请求失败: ' + e.message, true); }
  };

  // ---- 出站代理 ----
  async function loadProxy() {
    try {
      var r = await fetch('/proxy/config');
      var j = await r.json();
      $('proxystatus').textContent = j.proxy
        ? '当前: ' + j.proxy + (j.source === 'env' ? '(来自环境变量,页面修改不会生效)' : '(运行时配置)')
        : '当前: 直连(未配置代理)';
    } catch(e) { $('proxystatus').textContent = '当前: 未知'; }
  }
  loadProxy();

  $('btn-proxysave').onclick = async function(){
    if (!key) return toast('请先填写管理密钥', true);
    var url = $('proxyurl').value.trim();
    try {
      var r = await api('/proxy/config', { method:'POST', body: JSON.stringify({ proxy: url }) });
      var j = await r.json();
      if (r.ok) { toast(url ? '代理已保存并生效' : '已清除代理,恢复直连'); loadProxy(); }
      else toast('保存失败: ' + (j.error && j.error.message), true);
    } catch(e){ toast('请求失败: ' + e.message, true); }
  };

  $('btn-proxytest').onclick = async function(){
    if (!key) return toast('请先填写管理密钥', true);
    var out = $('proxytestout');
    out.textContent = '测试中(经 ' + ($('proxystatus').textContent.indexOf('直连') >= 0 ? '直连' : '代理') + ' 访问上游 /models,最长 20s)…';
    try {
      var r = await api('/proxy/test', { method:'POST' });
      var j = await r.json();
      if (r.status === 401) { out.textContent = '✗ 管理密钥无效(401):请确认输入的是部署时设置的 PROXY_API_KEYS,点"保存"后重试'; return; }
      out.textContent = j.ok
        ? '✓ 连通: HTTP ' + j.status + ',耗时 ' + j.ms + 'ms' + (j.via_proxy ? '(经代理)' : '(直连)') + ' — ' + (j.note || '')
        : '✗ 不通: ' + j.error + '(' + j.ms + 'ms' + (j.via_proxy ? ',经代理' : ',直连') + ')';
    } catch(e){ out.textContent = '请求失败: ' + e.message; }
  };

  function esc(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function renderStream(reasoning, answer, done){
    var h = '';
    if (reasoning) h += '<span class="muted">〔思考〕' + esc(reasoning) + '</span>\n\n';
    h += answer
      ? '<b style="color:var(--tx)">〔回复〕</b>' + esc(answer) + (done ? '' : '')
      : (reasoning ? '<span class="muted">(思考中,等待最终回复…)</span>' : '<span class="muted">(等待模型输出…)</span>');
    return h;
  }

  // ---- 连通性测试(流式) ----
  $('btn-test').onclick = async function(){
    if (!key) return toast('请先填写管理密钥', true);
    var out = $('testout');
    out.textContent = '';
    out.classList.remove('muted');
    var model = $('model').value.trim() || 'deepseek-v4-flash-free';
    var isStream = $('stream').checked;
    try {
      var r = await api('/v1/chat/completions', {
        method:'POST',
        body: JSON.stringify({ model: model, stream: isStream, messages: [{ role:'user', content:'Reply with exactly: pong' }] })
      });
      if (!r.ok) {
        if (r.status === 401) { out.textContent = 'HTTP 401:管理密钥无效,请确认上方"管理密钥"输入框填的是 PROXY_API_KEYS 并已点"保存"'; return; }
        var t = await r.text();
        out.textContent = 'HTTP ' + r.status + '\\n' + t.slice(0, 500);
        return;
      }
      if (!isStream) {
        var j = await r.json();
        out.textContent = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : JSON.stringify(j).slice(0, 500);
        return;
      }
      var accR = '';   // 思考过程(reasoning_content)
      var accA = '';   // 最终回答(content)
      var text = '';   // SSE 缓冲
      var reader = r.body.getReader();
      var dec = new TextDecoder();
      while (true) {
        var rd = await reader.read();
        if (rd.done) break;
        text += dec.decode(rd.value, { stream:true });
        var lines = text.split('\\n');
        text = lines.pop();
        lines.forEach(function(line){
          if (line.indexOf('data: ') !== 0) return;
          var payload = line.slice(6);
          if (payload === '[DONE]') return;
          try {
            var cj = JSON.parse(payload);
            var d = cj.choices && cj.choices[0] && cj.choices[0].delta;
            if (d && d.reasoning_content) accR += d.reasoning_content;
            if (d && d.content) accA += d.content;
          } catch(e){}
        });
        out.innerHTML = renderStream(accR, accA, false);
        out.scrollTop = out.scrollHeight;
      }
      out.innerHTML = renderStream(accR, accA, true);
      if (!accA && !accR) out.innerHTML = '<span class="muted">(流结束,无文本输出)</span>';
    } catch(e) {
      out.textContent = '请求失败: ' + e.message;
    }
  };
})();
</script>
</body>
</html>`;
}

module.exports = { pageHtml: page };
