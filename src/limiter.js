'use strict';

/** 简单的并发闸门:超过 maxConcurrency 时排队,排队超时抛错。 */
class Gate {
  constructor(max, timeoutMs) {
    this.max = max;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    this.waiting = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return this._release.bind(this);
    }
    this.waiting++;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, timer: null };
      item.timer = setTimeout(() => {
        const idx = this.queue.indexOf(item);
        if (idx >= 0) this.queue.splice(idx, 1);
        this.waiting--;
        const e = new Error(`并发排队超时(${Math.round((Date.now() - started) / 1000)}s),当前 in-flight=${this.active}`);
        e.code = 'QUEUE_TIMEOUT';
        e.statusCode = 503;
        reject(e);
      }, this.timeoutMs);
      this.queue.push(item);
    });
  }

  _release() {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      this.active++; // 直接移交名额
      next.resolve(this._release.bind(this));
    }
  }

  stats() {
    return { max: this.max, active: this.active, waiting: this.waiting };
  }
}

/**
 * 令牌桶(惰性补充,无定时器):take() 返回 0 表示通过,否则返回建议等待毫秒数。
 */
class TokenBucket {
  constructor(perSecond, burst) {
    this.rate = perSecond;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }

  take(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return 0;
    }
    return Math.ceil(((n - this.tokens) / this.rate) * 1000);
  }
}

/**
 * 主动限速:按 key 维护令牌桶,支持 RPM(请求数/分钟)与 TPM(估算 token/分钟)。
 * 免费模型(*-free)与全局分别配置,0 表示不启用;参数支持运行时热更新。
 */
class RateLimiter {
  constructor({ freeRpm = 0, freeTpm = 0, globalRpm = 0, burst = 5 } = {}, persistFile = null) {
    this.freeRpm = freeRpm;
    this.freeTpm = freeTpm;
    this.globalRpm = globalRpm;
    this.burst = Math.max(1, burst);
    this.persistFile = persistFile;
    this.source = 'constructor';
    this.buckets = new Map(); // key -> TokenBucket
    this.rejected = 0;
    if (persistFile) this._load();
  }

  _bucket(key, perMinute, capacity) {
    const cap = Math.max(1, capacity || perMinute); // 默认容量=整分钟配额
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(perMinute / 60, cap);
      this.buckets.set(key, b);
    } else {
      // 热更新:同步速率与容量
      b.rate = perMinute / 60;
      b.burst = cap;
    }
    return b;
  }

  /**
   * 请求是否放行。返回 null=放行;否则 {retryAfterMs, scope}。
   * @param model 模型名(免费模型单独限)
   * @param estTokens 请求估算 token 数(TPM 用)
   */
  check(model, estTokens = 0) {
    const isFree = typeof model === 'string' && model.endsWith('-free');
    if (this.globalRpm > 0) {
      const wait = this._bucket('__global__', this.globalRpm, this.burst).take();
      if (wait > 0) { this.rejected++; return { retryAfterMs: wait, scope: 'global-rpm' }; }
    }
    if (isFree && this.freeRpm > 0) {
      const wait = this._bucket('__free_rpm__', this.freeRpm, this.burst).take();
      if (wait > 0) { this.rejected++; return { retryAfterMs: wait, scope: 'free-rpm' }; }
    }
    if (isFree && this.freeTpm > 0 && estTokens > 0) {
      const wait = this._bucket('__free_tpm__', this.freeTpm).take(estTokens);
      if (wait > 0) { this.rejected++; return { retryAfterMs: wait, scope: 'free-tpm' }; }
    }
    return null;
  }

  /** 运行时更新(部分字段);立即生效并持久化 */
  update({ free_rpm, free_tpm, global_rpm, burst } = {}) {
    if (free_rpm !== undefined) this.freeRpm = Math.max(0, Math.floor(Number(free_rpm) || 0));
    if (free_tpm !== undefined) this.freeTpm = Math.max(0, Math.floor(Number(free_tpm) || 0));
    if (global_rpm !== undefined) this.globalRpm = Math.max(0, Math.floor(Number(global_rpm) || 0));
    if (burst !== undefined) this.burst = Math.max(1, Math.floor(Number(burst) || 1));
    this.source = 'runtime';
    // 既有桶同步新参数(下次 check 时生效 _bucket 的热更新逻辑)
    this._save();
    return this.stats();
  }

  stats() {
    return {
      free_rpm: this.freeRpm, free_tpm: this.freeTpm,
      global_rpm: this.globalRpm, burst: this.burst,
      rejected: this.rejected, source: this.source,
    };
  }

  _save() {
    if (!this.persistFile) return;
    try {
      const fs = require('fs');
      fs.writeFileSync(this.persistFile, JSON.stringify({
        free_rpm: this.freeRpm, free_tpm: this.freeTpm, global_rpm: this.globalRpm, burst: this.burst, saved_at: Date.now(),
      }, null, 2));
    } catch { /* 持久化失败不影响运行 */ }
  }

  _load() {
    try {
      const fs = require('fs');
      if (!fs.existsSync(this.persistFile)) return;
      const s = JSON.parse(fs.readFileSync(this.persistFile, 'utf8'));
      this.freeRpm = Number(s.free_rpm) || 0;
      this.freeTpm = Number(s.free_tpm) || 0;
      this.globalRpm = Number(s.global_rpm) || 0;
      this.burst = Number(s.burst) || 5;
      this.source = 'runtime(saved)';
    } catch { /* 读取失败用构造参数 */ }
  }
}

module.exports = { Gate, TokenBucket, RateLimiter };
