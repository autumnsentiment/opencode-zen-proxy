'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { pfetch } = require('./proxy-fetch');

/**
 * GitHub Copilot 通道授权(与 opencode CLI 的 github-copilot 插件同款流程):
 *   POST https://github.com/login/device/code        {"client_id","scope":"read:user"}
 *     -> {device_code,user_code,verification_uri,expires_in,interval}
 *   浏览器打开 https://github.com/login/device 输入 user_code,用自己的 GitHub 账号授权
 *   POST https://github.com/login/oauth/access_token {"client_id","device_code","grant_type":...}
 *     -> {access_token,token_type}(GitHub token 长期有效,直到用户撤销)
 *   调用:api.githubcopilot.com,Authorization: Bearer <github_token>,X-GitHub-Api-Version
 */
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

class CopilotAuth {
  constructor(config) {
    this.cfg = config;
    this.file = path.join(config.dataDir, 'copilot-auth.json');
    this.token = null; // {access_token, login?, saved_at}
    this.pending = null; // {deviceCode,userCode,verificationUrl,expiresAt,interval}
    this.lastError = null;
    this._pollAbort = null;
  }

  async init() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw.access_token) this.token = raw;
      }
    } catch (e) {
      logger.warn('copilot', '读取持久化 GitHub 令牌失败', String(e && e.message || e));
    }
    if (this.token) logger.info('copilot', `GitHub Copilot 通道已就绪${this.token.login ? '(' + this.token.login + ')' : ''}`);
  }

  stop() {
    if (this._pollAbort) this._pollAbort.abort();
  }

  status() {
    return {
      enabled: this.cfg.copilotEnabled,
      authorized: !!this.token,
      login: this.token ? this.token.login || null : null,
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

  /** 调用 Copilot API 的 token;未授权抛 COPILOT_PENDING */
  getAccessToken() {
    if (!this.token) {
      if (!this.pending) this.startDeviceFlow().catch(() => {});
      const e = new Error('GitHub Copilot 通道尚未授权,请查看 /copilot/status 获取设备码,在 github.com/login/device 完成授权');
      e.code = 'COPILOT_PENDING';
      e.pending = this.pending;
      throw e;
    }
    return this.token.access_token;
  }

  /** 发起 GitHub 设备码授权 */
  async startDeviceFlow() {
    const { githubDeviceBase, githubClientId } = this.cfg;
    const resp = await pfetch(`${githubDeviceBase}/login/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: githubClientId, scope: 'read:user' }),
    });
    if (!resp.ok) throw new Error(`github device/code HTTP ${resp.status}: ${await resp.text().catch(() => '')}`.slice(0, 200));
    const data = await resp.json();
    if (!data.device_code || !data.user_code) throw new Error(`github device/code 响应异常: ${JSON.stringify(data).slice(0, 200)}`);

    this.pending = {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUrl: data.verification_uri || `${githubDeviceBase}/login/device`,
      expiresAt: Date.now() + (data.expires_in || 900) * 1000,
      interval: (data.interval || 5) * 1000,
    };
    this.lastError = null;

    logger.info('copilot', '======== 等待 GitHub 授权 ========');
    logger.info('copilot', `打开 ${this.pending.verificationUrl} 并输入设备码: ${this.pending.userCode}`);
    logger.info('copilot', '==================================');

    this._poll().catch((e) => {
      this.lastError = String(e && e.message || e).slice(0, 200);
      logger.error('copilot', 'GitHub 设备码轮询终止', this.lastError);
      this.pending = null;
    });
    return this.status();
  }

  async _poll() {
    const { githubDeviceBase, githubClientId } = this.cfg;
    const pending = this.pending;
    const abort = new AbortController();
    this._pollAbort = abort;
    let interval = pending.interval;

    while (!abort.signal.aborted && Date.now() < pending.expiresAt) {
      await new Promise((r) => setTimeout(r, interval));
      if (abort.signal.aborted) return;
      const resp = await pfetch(`${githubDeviceBase}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_id: githubClientId, device_code: pending.deviceCode, grant_type: DEVICE_GRANT }),
      });
      const body = await resp.json().catch(() => ({}));
      if (body.access_token) {
        this.token = { access_token: body.access_token, saved_at: Date.now() };
        this.pending = null;
        this.lastError = null;
        this._save();
        this._fetchLogin().catch(() => {});
        logger.info('copilot', 'GitHub 授权完成');
        return;
      }
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') { interval += 5000; continue; }
      if (body.error === 'expired_token') {
        logger.warn('copilot', 'GitHub 设备码已过期,重新发起');
        this.pending = null;
        return this.startDeviceFlow();
      }
      throw new Error(`github access_token 失败: ${body.error} ${body.error_description || ''}`);
    }
  }

  /** best-effort 取 GitHub 用户名用于展示 */
  async _fetchLogin() {
    try {
      const r = await pfetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${this.token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': this.cfg.userAgent },
      });
      if (r.ok) {
        const u = await r.json();
        if (u.login) { this.token.login = u.login; this._save(); logger.info('copilot', `GitHub 账号: ${u.login}`); }
      }
    } catch {}
  }

  /** 登出:作废本地令牌 */
  revoke() {
    this.token = null;
    try { fs.unlinkSync(this.file); } catch {}
    logger.info('copilot', 'GitHub 令牌已从本机移除(如需彻底撤销请到 GitHub -> Settings -> Applications)');
    return this.status();
  }

  _save() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.token, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      logger.error('copilot', '令牌持久化失败', String(e && e.message || e));
    }
  }
}

module.exports = { CopilotAuth };
