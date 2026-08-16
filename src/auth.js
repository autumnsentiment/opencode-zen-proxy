'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { pfetch } = require('./proxy-fetch');

/**
 * OpenCode 控制台设备码授权 + 令牌刷新管理。
 *
 * 流程(与 opencode CLI 一致):
 *   POST {console}/auth/device/code   {"client_id":"opencode-cli"}
 *     -> {device_code,user_code,verification_uri_complete,expires_in,interval}
 *   浏览器打开 {console}{verification_uri_complete} 输入 user_code
 *   POST {console}/auth/device/token  {"grant_type":"urn:ietf:params:oauth:grant-type:device_code",...}
 *     -> {access_token,refresh_token,expires_in}
 *   刷新: POST {console}/auth/device/token {"grant_type":"refresh_token","refresh_token":...,"client_id":...}
 */
class AuthManager {
  constructor(config) {
    this.cfg = config;
    this.file = path.join(config.dataDir, 'auth.json');
    this.mode = ['public', 'oauth', 'auto'].includes(config.authMode) ? config.authMode : 'auto';

    // state: 'empty' | 'pending' | 'authorized'
    this.state = 'empty';
    this.tokens = null; // {access_token, refresh_token, expires_at(ms)}
    this.pending = null; // {device_code,user_code,verification_url,expires_at(ms),interval}
    this.lastError = null;
    this.lastRefreshAt = null;

    this._refreshInFlight = null;
    this._pollAbort = null;
    this._timer = null;
  }

  // ---------------------------------------------------------------- 生命周期

  async init() {
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    this._load();
    if (!this.tokens && this.cfg.bootstrapAuthJson) {
      this._importBootstrap(this.cfg.bootstrapAuthJson);
    }
    if (this.tokens) {
      this.state = 'authorized';
      logger.info('auth', '已从磁盘加载令牌', {
        expires_at: new Date(this.tokens.expires_at).toISOString(),
      });
    }
    // 启动后台循环:定期检查/刷新,必要时发起设备码授权
    this._schedule(this.cfg.refreshIntervalMin * 60 * 1000);
    this._tick().catch((e) => logger.error('auth', '启动检查失败', errStr(e)));
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    if (this._pollAbort) this._pollAbort.abort();
  }

  // ---------------------------------------------------------------- 对外接口

  status() {
    return {
      mode: this.mode,
      effective: this.mode === 'public' ? 'public' : this.tokens ? 'oauth' : this.mode === 'oauth' ? 'oauth(pending)' : 'public',
      state: this.state,
      has_token: !!this.tokens,
      expires_at: this.tokens ? this.tokens.expires_at : null,
      expires_in_sec: this.tokens ? Math.max(0, Math.floor((this.tokens.expires_at - Date.now()) / 1000)) : null,
      last_refresh_at: this.lastRefreshAt,
      last_error: this.lastError,
      pending: this.pending
        ? {
            user_code: this.pending.userCode,
            verification_url: this.pending.verificationUrl,
            expires_at: this.pending.expiresAt,
          }
        : null,
    };
  }

  /**
   * 取一个可用的 access token。
   * public 模式:恒为 'public'(官方匿名层,仅免费模型,零登录)。
   * auto 模式:有已授权令牌用之;没有则回退 'public',后台照常发起设备码,
   *           授权完成后自动升级为 oauth。
   * oauth 模式:必须有令牌,否则抛 AUTH_PENDING(转 503 提示)。
   */
  async getAccessToken() {
    if (this.mode === 'public') return 'public';
    if (!this.tokens) {
      if (this.mode === 'auto') return 'public';
      await this._tick(); // 触发一次设备码授权(幂等)
      const e = new Error('opencode 账号尚未授权完成,请查看日志或 /auth/status 获取设备码链接');
      e.code = 'AUTH_PENDING';
      e.pending = this.pending;
      throw e;
    }
    if (this._expiresWithin(this.cfg.refreshBeforeSec * 1000)) {
      await this._refresh().catch((e) => {
        if (!this.tokens) {
          if (this.mode === 'auto') {
            logger.warn('auth', '授权已失效,auto 模式回退匿名(public)通道');
            return;
          }
          throw e;
        }
        logger.warn('auth', '刷新失败,继续使用旧令牌', errStr(e));
      });
    }
    return this.tokens ? this.tokens.access_token : 'public';
  }

  /** 强制刷新(管理接口) */
  async forceRefresh() {
    if (!this.tokens) throw new Error('当前没有令牌,无法刷新');
    return this._refresh();
  }

  /** 作废现有授权,重新发起设备码流程(管理接口) */
  async restart() {
    this.tokens = null;
    this.state = 'empty';
    this._save();
    if (this._pollAbort) this._pollAbort.abort();
    await this._startDeviceFlow();
    return this.status();
  }

  // ---------------------------------------------------------------- 内部实现

  _expiresWithin(ms) {
    return this.tokens && this.tokens.expires_at - Date.now() <= ms;
  }

  async _tick() {
    if (this._timer) clearTimeout(this._timer);
    try {
      if (!this.tokens) {
        if (this.mode === 'public') return; // 匿名模式不发起设备码
        if (!this.pending) await this._startDeviceFlow();
        return; // 轮询循环由 _startDeviceFlow 自己驱动
      }
      if (this._expiresWithin(Math.max(this.cfg.refreshBeforeSec * 1000, 60_000))) {
        await this._refresh();
      }
    } catch (e) {
      this.lastError = errStr(e);
      logger.error('auth', '后台检查出错', this.lastError);
    } finally {
      this._schedule(this.cfg.refreshIntervalMin * 60 * 1000);
    }
  }

  _schedule(ms) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._tick().catch(() => {}), ms);
    this._timer.unref?.();
  }

  // ---- 设备码授权 ----

  async _startDeviceFlow() {
    const { consoleBase, clientId } = this.cfg;
    const resp = await pfetch(`${consoleBase}/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId }),
    });
    if (!resp.ok) throw new Error(`device/code HTTP ${resp.status}: ${await safeText(resp)}`);
    const data = await resp.json();
    if (!data.device_code || !data.user_code) throw new Error(`device/code 响应异常: ${JSON.stringify(data).slice(0, 200)}`);

    this.pending = {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUrl: data.verification_uri_complete.startsWith('http')
        ? data.verification_uri_complete
        : consoleBase + data.verification_uri_complete,
      expiresAt: Date.now() + (data.expires_in || 600) * 1000,
      interval: (data.interval || 5) * 1000,
    };
    this.state = 'pending';
    this.lastError = null;

    logger.info('auth', '======== 等待设备授权 ========');
    logger.info('auth', `打开此链接并输入设备码: ${this.pending.verificationUrl}`);
    logger.info('auth', `设备码 (user_code): ${this.pending.userCode}`);
    logger.info('auth', '================================');

    this._pollDeviceToken().catch((e) => {
      this.lastError = errStr(e);
      logger.error('auth', '设备码轮询终止', this.lastError);
      this.pending = null;
      if (!this.tokens) this.state = 'empty';
      // 稍后自动重试整个流程
      this._schedule(30_000);
    });
  }

  async _pollDeviceToken() {
    const { consoleBase, clientId } = this.cfg;
    const pending = this.pending;
    const abort = new AbortController();
    this._pollAbort = abort;

    let interval = pending.interval;
    while (!abort.signal.aborted && Date.now() < pending.expiresAt) {
      await sleep(interval, abort.signal);
      if (abort.signal.aborted) return;

      const resp = await pfetch(`${consoleBase}/auth/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: pending.deviceCode,
          client_id: clientId,
        }),
        signal: abort.signal,
      });
      const body = await resp.json().catch(() => ({}));

      if (body.access_token) {
        this._applyTokens(body);
        this.pending = null;
        this.state = 'authorized';
        this.lastError = null;
        logger.info('auth', `设备授权完成,令牌有效期至 ${new Date(this.tokens.expires_at).toISOString()}`);
        return;
      }
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      if (body.error === 'expired_token') {
        logger.warn('auth', '设备码已过期,重新发起授权');
        this.pending = null;
        return this._startDeviceFlow();
      }
      throw new Error(`device/token 授权失败: ${body.error} ${body.error_description || ''}`);
    }
  }

  // ---- 刷新 ----

  async _refresh() {
    if (this._refreshInFlight) return this._refreshInFlight;
    this._refreshInFlight = this._doRefresh().finally(() => {
      this._refreshInFlight = null;
    });
    return this._refreshInFlight;
  }

  async _doRefresh() {
    const { consoleBase, clientId } = this.cfg;
    const refreshToken = this.tokens && this.tokens.refresh_token;
    if (!refreshToken) throw new Error('没有 refresh_token,无法刷新');

    const resp = await pfetch(`${consoleBase}/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.access_token) {
      const err = new Error(`刷新失败 HTTP ${resp.status}: ${body.error || ''} ${body.error_description || ''}`);
      err.code = body.error || 'refresh_failed';
      // refresh token 失效 -> 清空令牌并重新走设备码授权
      if (['invalid_grant', 'invalid_refresh_token', 'unauthorized', 'invalid_token'].includes(body.error) || resp.status === 401) {
        logger.warn('auth', 'refresh_token 已失效,转重新设备码授权', errStr(err));
        this.tokens = null;
        this._save();
        if (!this.pending) this._startDeviceFlow().catch((e) => (this.lastError = errStr(e)));
      }
      throw err;
    }
    this._applyTokens(body);
    logger.info('auth', `令牌已刷新,有效期至 ${new Date(this.tokens.expires_at).toISOString()}`);
    return this.tokens;
  }

  _applyTokens(body) {
    this.tokens = {
      access_token: body.access_token,
      refresh_token: body.refresh_token || (this.tokens && this.tokens.refresh_token) || '',
      expires_at: Date.now() + (body.expires_in || 3600) * 1000,
    };
    this.lastRefreshAt = Date.now();
    this._save();
  }

  // ---- 持久化 ----

  _save() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, saved_at: Date.now(), ...this.tokens }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      logger.error('auth', '令牌持久化失败', errStr(e));
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.access_token) this.tokens = {
        access_token: raw.access_token,
        refresh_token: raw.refresh_token || '',
        expires_at: Number(raw.expires_at) > 1e12 ? Number(raw.expires_at) : Date.now() + 3600_000,
      };
    } catch (e) {
      logger.warn('auth', '读取持久化令牌失败', errStr(e));
    }
  }

  /** 支持 opencode CLI 的 auth.json(取 opencode 条目)或简化 JSON */
  _importBootstrap(text) {
    try {
      let obj = JSON.parse(text);
      if (obj.opencode && typeof obj.opencode === 'object') obj = obj.opencode; // ~/.local/share/opencode/auth.json
      const accessToken = obj.access_token || obj.access;
      if (!accessToken) throw new Error('缺少 access_token/access 字段');
      let expiresAt = Number(obj.expires_at || obj.expires) || 0;
      if (expiresAt && expiresAt < 1e12) expiresAt *= 1000; // 秒级时间戳
      if (!expiresAt) expiresAt = Date.now(); // 立即过期,触发刷新
      this.tokens = { access_token: accessToken, refresh_token: obj.refresh_token || obj.refresh || '', expires_at: expiresAt };
      this._save();
      logger.info('auth', '已从 BOOTSTRAP_AUTH_JSON 导入令牌');
    } catch (e) {
      logger.warn('auth', 'BOOTSTRAP_AUTH_JSON 解析失败', errStr(e));
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function safeText(resp) {
  return resp.text().then((t) => t.slice(0, 200)).catch(() => '');
}

function errStr(e) {
  return e && e.stack ? String(e.stack).split('\n').slice(0, 2).join(' | ') : String(e);
}

module.exports = { AuthManager };
