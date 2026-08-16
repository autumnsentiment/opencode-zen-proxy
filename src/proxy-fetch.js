'use strict';

/**
 * 代理感知的 fetch:
 *   - 未配置代理:直接使用全局 fetch(原路径,零开销)
 *   - 配置了 UPSTREAM_PROXY:先与代理建立隧道(HTTP CONNECT 或 SOCKS5),
 *     再在隧道上用 node:http/node:https 发请求,返回与 fetch 兼容的
 *     {status, ok, headers, body(async iterable), text(), json()}
 *
 * 支持的代理协议:http:// https:// socks5:// socks5h://
 * 认证:http(s) 代理走 Basic(Proxy-Authorization),socks5 走 RFC1929 用户名/密码。
 * 代理地址可含用户名密码:http://user:pass@host:port
 */
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let currentProxy = null; // URL | null
let source = 'none'; // env | runtime
let persistFile = null;

// ---------------------------------------------------------------- 配置管理

function parseProxyUrl(str) {
  if (!str || !str.trim()) return null;
  let s = str.trim();
  if (!s.includes('://')) s = 'http://' + s;
  const u = new URL(s);
  if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:'].includes(u.protocol)) {
    throw new Error(`不支持的代理协议: ${u.protocol}(支持 http/https/socks5/socks5h)`);
  }
  return u;
}

function init(cfg) {
  persistFile = path.join(cfg.dataDir, 'proxy.json');
  const fromEnv = cfg.upstreamProxy;
  try {
    if (fromEnv) {
      currentProxy = parseProxyUrl(fromEnv);
      source = 'env';
    } else {
      // 运行时保存的配置(未被 env 覆盖时)恢复
      if (fs.existsSync(persistFile)) {
        const saved = JSON.parse(fs.readFileSync(persistFile, 'utf8'));
        if (saved.proxy) {
          currentProxy = parseProxyUrl(saved.proxy);
          source = 'runtime';
        }
      }
    }
  } catch (e) {
    logger.warn('proxy', '代理配置无效,将直连', String(e && e.message || e));
    currentProxy = null;
    source = 'none';
  }
  if (currentProxy) logger.info('proxy', `出站代理已启用(${source}): ${mask(currentProxy)}`);
}

function setProxy(str) {
  const u = parseProxyUrl(str); // '' -> null
  currentProxy = u;
  source = u ? 'runtime' : 'none';
  try {
    fs.mkdirSync(path.dirname(persistFile), { recursive: true });
    fs.writeFileSync(persistFile, JSON.stringify({ proxy: u ? u.href : '', saved_at: Date.now() }, null, 2));
  } catch (e) {
    logger.warn('proxy', '代理配置持久化失败', String(e && e.message || e));
  }
  logger.info('proxy', u ? `出站代理已更新: ${mask(u)}` : '出站代理已清除,恢复直连');
  return u;
}

function getProxy() {
  return currentProxy ? currentProxy.href : null;
}

function getProxySource() {
  return source;
}

function mask(u) {
  const c = new URL(u.href);
  if (c.password) c.password = '***';
  return c.href;
}

// ---------------------------------------------------------------- pfetch

/**
 * 用法与 fetch(url, opts) 一致;额外支持 opts.signal。
 * 未配置代理时直接透传全局 fetch。
 */
async function pfetch(url, opts = {}) {
  if (!currentProxy) return globalThis.fetch(url, opts);
  return tunnelFetch(new URL(url), opts);
}

function tunnelFetch(target, opts) {
  const isHttps = target.protocol === 'https:';
  const mod = isHttps ? https : http;

  return openTunnel(target).then((tunSock) => {
    const socket = isHttps
      ? tls.connect({ socket: tunSock, servername: target.hostname, rejectUnauthorized: true })
      : tunSock;

    const headers = { ...opts.headers };
    if (opts.body && headers['content-type'] && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = Buffer.byteLength(opts.body);
    }

    const req = mod.request({
      method: opts.method || 'GET',
      host: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers,
      agent: false,
      createConnection: () => socket,
    });

    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (opts.signal) {
      if (opts.signal.aborted) { tunSock.destroy(); return Promise.reject(new DOMException('This operation was aborted', 'AbortError')); }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    return new Promise((resolve, reject) => {
      req.on('response', (res) => {
        res.on('end', () => opts.signal && opts.signal.removeEventListener('abort', onAbort));
        resolve(wrapResponse(res));
      });
      req.on('error', (e) => { opts.signal && opts.signal.removeEventListener('abort', onAbort); reject(e); });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  });
}

function wrapResponse(res) {
  const raw = res.rawHeaders; // [k1,v1,k2,v2,...] 保留原始大小写
  const lower = new Map();
  for (let i = 0; i < raw.length; i += 2) {
    if (!lower.has(raw[i].toLowerCase())) lower.set(raw[i].toLowerCase(), raw[i + 1]);
  }
  const headers = {
    get: (k) => lower.get(String(k).toLowerCase()) || null,
    has: (k) => lower.has(String(k).toLowerCase()),
    forEach: (fn) => { for (let i = 0; i < raw.length; i += 2) fn(raw[i + 1], raw[i]); },
  };
  const readAll = () => new Promise((resolve, reject) => {
    if (res.complete) return resolve('');
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
  return {
    status: res.statusCode,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    headers,
    body: res, // IncomingMessage 是 async iterable(Buffer chunks)
    text: readAll,
    json: async () => JSON.parse(await readAll()),
  };
}

// ---------------------------------------------------------------- 隧道建立

async function openTunnel(target) {
  const p = currentProxy;
  const tPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);

  let sock = net.connect({ host: p.hostname, port: proxyPort(p) });
  await waitConnect(sock);

  if (p.protocol === 'https:') {
    sock = tls.connect({ socket: sock, servername: p.hostname });
    await new Promise((resolve, reject) => {
      sock.once('secureConnect', resolve);
      sock.once('error', reject);
    });
  }

  try {
    if (p.protocol === 'http:' || p.protocol === 'https:') {
      await httpConnect(sock, p, target.hostname, tPort);
    } else if (p.protocol.startsWith('socks5')) {
      await socks5Connect(sock, p, target.hostname, tPort);
    } else {
      throw new Error('socks4 代理暂不支持,请使用 http/socks5');
    }
  } catch (e) {
    sock.destroy();
    throw e;
  }
  return sock;
}

function proxyPort(p) {
  if (p.port) return Number(p.port);
  return p.protocol === 'https:' ? 443 : p.protocol.startsWith('socks') ? 1080 : 8080;
}

function waitConnect(sock) {
  return new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
}

/** HTTP CONNECT 隧道 */
async function httpConnect(sock, proxy, host, port) {
  const auth = proxy.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
    : '';
  sock.write(
    `CONNECT ${host}:${port} HTTP/1.1\r\n` +
    `Host: ${host}:${port}\r\n` +
    (auth ? `Proxy-Authorization: ${auth}\r\n` : '') +
    `\r\n`
  );
  const reader = new SocketReader(sock);
  const statusLine = (await reader.readLine()).trim();
  for (;;) {
    const line = await reader.readLine();
    if (line === null || line.trim() === '') break; // 空行 = 头部结束
  }
  reader.release(); // 剩余字节 unshift 回 socket,交给上层协议
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
  if (!m || m[1] !== '200') throw new Error(`代理 CONNECT 失败: ${statusLine.slice(0, 120)}`);
}

/** SOCKS5(含 RFC1929 用户名/密码认证) */
async function socks5Connect(sock, proxy, host, port) {
  const reader = new SocketReader(sock);
  const user = Buffer.from(decodeURIComponent(proxy.username || ''));
  const pass = Buffer.from(decodeURIComponent(proxy.password || ''));

  // 方法协商:无认证 + 用户名密码
  sock.write(Buffer.concat([Buffer.from([0x05, 0x02, 0x00, 0x02])]));
  const [ver, method] = await reader.readN(2);
  if (ver !== 0x05) throw new Error(`非 SOCKS5 代理(版本字节 0x${ver.toString(16)})`);
  if (method === 0x02) {
    sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const [, status] = await reader.readN(2);
    if (status !== 0x00) throw new Error('SOCKS5 代理认证失败(用户名/密码错误)');
  } else if (method !== 0x00) {
    throw new Error('SOCKS5 代理不接受可用的认证方式');
  }

  // CONNECT(域名地址类型 0x03,远程解析)
  const h = Buffer.from(host);
  sock.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]));
  const head = await reader.readN(4);
  if (head[1] !== 0x00) throw new Error(`SOCKS5 CONNECT 失败(响应码 ${head[1]})`);
  const atyp = head[3];
  if (atyp === 0x01) await reader.readN(4);
  else if (atyp === 0x03) await reader.readN((await reader.readN(1))[0]);
  else if (atyp === 0x04) await reader.readN(16);
  else if (atyp !== 0x00) throw new Error(`SOCKS5 未知地址类型 ${atyp}`);
  await reader.readN(2); // bound port
  reader.release();
}

/** 隧道握手期的按需读取器;release() 把多余字节还回流 */
class SocketReader {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
    this.onData = (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this._drain();
    };
    this.onEnd = () => { this.closed = true; this._failAll(new Error('代理连接在握手期间关闭')); };
    this.onError = (e) => { this.closed = true; this._failAll(e); };
    sock.on('data', this.onData);
    sock.on('end', this.onEnd);
    sock.on('error', this.onError);
  }

  _drain() {
    while (this.waiters.length && this.waiters[0].need <= this.buf.length) {
      const w = this.waiters.shift();
      const chunk = this.buf.subarray(0, w.need);
      this.buf = this.buf.subarray(w.need);
      w.resolve(chunk);
    }
    // 按行的等待者
    while (this.waiters.length && this.waiters[0].line) {
      const w = this.waiters[0];
      const idx = this.buf.indexOf(0x0a);
      if (idx === -1) break;
      const chunk = this.buf.subarray(0, idx + 1);
      this.buf = this.buf.subarray(idx + 1);
      this.waiters.shift();
      w.resolve(chunk.toString('latin1'));
    }
  }

  _failAll(e) {
    while (this.waiters.length) this.waiters.shift().reject(e);
  }

  readN(n) {
    if (this.closed && this.buf.length < n) return Promise.reject(new Error('代理连接已关闭'));
    if (this.buf.length >= n) {
      const chunk = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      return Promise.resolve(chunk);
    }
    return new Promise((resolve, reject) => { this.waiters.push({ need: n, resolve, reject }); this._drain(); });
  }

  readLine() {
    return new Promise((resolve, reject) => { this.waiters.push({ line: true, need: Infinity, resolve, reject }); this._drain(); });
  }

  release() {
    this.sock.removeListener('data', this.onData);
    this.sock.removeListener('end', this.onEnd);
    this.sock.removeListener('error', this.onError);
    if (this.buf.length) this.sock.unshift(this.buf); // 交还早到的数据
    this._failAll(new Error('reader released'));
  }
}

module.exports = { init, pfetch, setProxy, getProxy, getProxySource, mask, parseProxyUrl };
