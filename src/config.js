'use strict';

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** 允许 0(限速配置里 0=不启用是合法值) */
function num0(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const config = {
  // 监听
  host: process.env.HOST || '0.0.0.0',
  port: num(process.env.PORT, 8787),

  // 客户端鉴权(逗号分隔多个 key;为空则拒绝所有请求并告警)
  proxyApiKeys: (process.env.PROXY_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // 上游
  upstreamBase: (process.env.UPSTREAM_BASE || 'https://opencode.ai/zen/v1').replace(/\/+$/, ''),

  // 出站代理(访问上游与 console 均走它);支持 http/https/socks5(/socks5h),可带 user:pass
  // 优先级:UPSTREAM_PROXY > HTTPS_PROXY > HTTP_PROXY;也可运行时在 Web 控制台修改
  upstreamProxy: process.env.UPSTREAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',

  // OpenCode 控制台(设备码流程)
  consoleBase: (process.env.CONSOLE_BASE || 'https://console.opencode.ai').replace(/\/+$/, ''),
  clientId: process.env.OAUTH_CLIENT_ID || 'opencode-cli',

  // Zen 通道授权模式:
  //   public = 匿名(Bearer public,官方匿名层,仅免费模型,零登录)
  //   oauth  = OpenCode 账号设备码授权(可用付费模型)
  //   auto   = 有已授权令牌则用 oauth,否则自动回退 public(默认)
  authMode: (process.env.AUTH_MODE || 'auto').toLowerCase(),

  // GitHub Copilot 通道(可选):模型名加 copilot/ 前缀或 X-Channel: copilot 头路由
  copilotEnabled: bool(process.env.COPILOT_ENABLED, false),
  copilotApiBase: (process.env.COPILOT_API_BASE || 'https://api.githubcopilot.com').replace(/\/+$/, ''),
  githubDeviceBase: (process.env.GITHUB_DEVICE_BASE || 'https://github.com').replace(/\/+$/, ''),
  githubClientId: process.env.GITHUB_CLIENT_ID || 'Ov23li8tweQw6odWQebz',
  githubApiVersion: process.env.GITHUB_API_VERSION || '2026-06-01',

  // 令牌刷新
  refreshIntervalMin: num(process.env.TOKEN_REFRESH_MINUTES, 20), // 周期性检查并刷新
  refreshBeforeSec: num(process.env.REFRESH_BEFORE_SECONDS, 300), // 过期前多久主动刷新

  // 流式保活
  keepaliveSec: num(process.env.KEEPALIVE_SECONDS, 15), // SSE 空闲多久发一次心跳注释

  // 并发与重试
  maxConcurrency: num(process.env.MAX_CONCURRENCY, 8),
  queueTimeoutMs: num(process.env.QUEUE_TIMEOUT_MS, 120000),
  headerTimeoutMs: num(process.env.HEADER_TIMEOUT_MS, 300000), // 等上游响应头的最长时间  streamIdleTimeoutMs: num(process.env.STREAM_IDLE_TIMEOUT_MS, 600000), // 流式无数据的超时
  retry429: num(process.env.RETRY_429, 3),
  retry5xx: num(process.env.RETRY_5XX, 1),
  retryNetwork: num(process.env.RETRY_NETWORK, 2),
  maxBodyBytes: num(process.env.MAX_BODY_MB, 100) * 1024 * 1024,

  // 主动限速(令牌桶,超速直接 429 + Retry-After;0=不启用)
  rateLimitFreeRpm: num0(process.env.RATE_LIMIT_FREE_RPM, 30), // 免费模型(*-free 后缀)RPM
  rateLimitFreeTpm: num0(process.env.RATE_LIMIT_FREE_TPM, 0), // 免费模型 TPM(按请求体估算)
  rateLimitGlobalRpm: num0(process.env.RATE_LIMIT_GLOBAL_RPM, 0), // 全局 RPM
  rateLimitBurst: num(process.env.RATE_LIMIT_BURST, 5), // 突发容量(桶大小)

  // 工具定义格式自动修复(chat/completions):扁平/残缺的 tools 条目转标准嵌套格式,
  // 避免 Codex 等客户端混发 Responses 扁平格式导致上游 400。0=关闭纯透传
  sanitizeTools: bool(process.env.SANITIZE_TOOLS, true),

  // 推理模型兜底:max_tokens 低于此值时直接删除该字段(= 上游用模型最大输出,零截断)。0=不干预
  maxTokensFloor: num0(process.env.MAX_TOKENS_FLOOR, 65536),

  // 持久化
  dataDir: process.env.DATA_DIR || './data',

  // 可选:直接注入 opencode CLI 的 auth.json 内容(跳过首次设备码授权)
  bootstrapAuthJson: process.env.BOOTSTRAP_AUTH_JSON || '',

  userAgent: process.env.UPSTREAM_UA || 'opencode/1.18.18 opencode-zen-proxy/1.0',
};

module.exports = config;
