'use strict';

/**
 * 本地 mock 代理,用于自测隧道逻辑:
 *   HTTP 代理(CONNECT 隧道)+ SOCKS5 代理(无认证),全部转发到指定上游。
 *   GET /__stats 返回 {connects:N}(直连访问,不走隧道)
 * 用法: MOCK_PROXY_PORT=9912 UPSTREAM_HOST=127.0.0.1 UPSTREAM_PORT=9911 node test/mock-proxy.js
 *       SOCKS_PORT=9913(为 0 时不启 SOCKS)
 */
const http = require('http');
const net = require('net');

const HTTP_PORT = Number(process.env.MOCK_PROXY_PORT || 9912);
const SOCKS_PORT = Number(process.env.SOCKS_PORT || 0);
const UP_HOST = process.env.UPSTREAM_HOST || '127.0.0.1';
const UP_PORT = Number(process.env.UPSTREAM_PORT || 9911);

let connects = 0;

const proxy = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ connects }));
  }
  res.writeHead(405); res.end('only CONNECT / __stats');
});

proxy.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  connects++;
  console.log(new Date().toISOString(), 'mock-proxy CONNECT', req.url, 'total=' + connects);
  // 校验 Basic 认证(如果带了 Proxy-Authorization,必须匹配 mockuser:mockpass)
  const authz = req.headers['proxy-authorization'];
  if (authz) {
    const expect = 'Basic ' + Buffer.from('mockuser:mockpass').toString('base64');
    if (authz !== expect) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return clientSocket.destroy();
    }
  }
  const up = net.connect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(clientSocket);
    clientSocket.pipe(up);
  });
  up.on('error', () => { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); clientSocket.destroy(); });
  clientSocket.on('error', () => up.destroy());
});

proxy.listen(HTTP_PORT, () => console.log(new Date().toISOString(), 'mock http proxy on', HTTP_PORT, '-> upstream', UP_HOST + ':' + UP_PORT));

// ---- 最小 SOCKS5 服务端(无认证 + 用户名密码) ----
if (SOCKS_PORT > 0) {
  const socks = net.createServer((sock) => {
    let stage = 'greeting';
    let userLen = 0, passLen = 0, authOk = false;
    sock.on('data', (buf) => {
      if (stage === 'greeting') {
        // 客户端 [5, nmethods, ...];我们选 0x02(用户名密码)若客户端支持,否则 0x00
        const supportsUser = buf.includes(0x02);
        const method = supportsUser ? 0x02 : 0x00;
        stage = supportsUser ? 'auth' : 'request';
        sock.write(Buffer.from([0x05, method]));
        return;
      }
      if (stage === 'auth') {
        // [1, ulen, user, plen, pass]
        let off = 1;
        userLen = buf[off]; off += 1 + userLen;
        passLen = buf[off]; off += 1;
        const user = buf.subarray(off - userLen - 1, off - 1).toString();
        const pass = buf.subarray(off, off + passLen).toString();
        authOk = user === 'mockuser' && pass === 'mockpass';
        stage = 'request';
        sock.write(Buffer.from([0x01, authOk ? 0x00 : 0x01]));
        if (!authOk) return sock.destroy();
        return;
      }
      if (stage === 'request') {
        // [5, cmd(1), rsv, atyp, addr..., port]
        if (buf[1] !== 0x01) { sock.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return sock.destroy(); }
        const atyp = buf[3];
        let host = '', off = 4;
        if (atyp === 1) { host = [...buf.subarray(off, off + 4)].join('.'); off += 4; }
        else if (atyp === 3) { const l = buf[off]; off += 1; host = buf.subarray(off, off + l).toString(); off += l; }
        else if (atyp === 4) { host = 'v6'; off += 16; }
        const port = (buf[off] << 8) | buf[off + 1];
        connects++;
        console.log(new Date().toISOString(), 'mock-socks CONNECT', host + ':' + port, 'total=' + connects);
        const up = net.connect(port, host, () => {
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); // 成功,绑定地址任意
          stage = 'pipe';
          up.pipe(sock); sock.pipe(up);
        });
        up.on('error', () => { sock.write(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); sock.destroy(); });
        return;
      }
    });
    sock.on('error', () => {});
  });
  socks.listen(SOCKS_PORT, () => console.log(new Date().toISOString(), 'mock socks5 proxy on', SOCKS_PORT));
}
