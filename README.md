# opencode-zen-proxy

把 [OpenCode Zen](https://opencode.ai/zen)(opencode CLI 的模型网关)**透明反向代理**成一个标准 API URL,供其他设备或 [new-api](https://github.com/QuantumNous/new-api) 等网关接入。

- 只做两件事:**客户端鉴权** + **API 透传**(不改写任何请求/响应体)
- 双端点透传:`/v1/chat/completions`(OpenAI Chat)与 `/v1/responses`(OpenAI Responses),另有 `/v1/messages`(Anthropic)与 `/v1/models`
- **出站代理**:访问上游/控制台可走 HTTP(S) CONNECT 或 SOCKS5 代理(支持用户名密码),可用 `UPSTREAM_PROXY` 环境变量配置,也可在 Web 控制台运行时修改并持久化
- **流式不阻断**:SSE 逐块转发;上游长时间"思考"时,空闲超过 `KEEPALIVE_SECONDS` 自动发送 `: keepalive` 注释行保活,OpenAI SDK / new-api 均按规范忽略,事件流不受影响
- **设备码自动维护**:首次启动走 OpenCode 控制台设备码授权(与 opencode CLI 同款流程);运行期间周期性用 refresh_token 刷新令牌;上游返回 401 时立即强制刷新并重试;refresh_token 失效时自动重新发起设备码授权
- **429 防护(双层)**:主动限速(令牌桶,免费模型单独 RPM 配额,超速直接 429+Retry-After 不惊动上游)+ 并发闸门排队 + 上游 429 自动退避重试(遵守 `Retry-After`)
- 零 npm 运行时依赖(Node ≥ 18),令牌持久化在 `data/` 卷,重启容器无需重新授权

```
客户端 / new-api ──Bearer PROXY_API_KEYS──▶ opencode-zen-proxy ──Bearer OAuth token──▶ https://opencode.ai/zen/v1
                                                │
                                                └──设备码/刷新──▶ https://console.opencode.ai
```

## 快速开始(Docker)

```bash
cp .env.example .env
# 编辑 .env,至少改掉 PROXY_API_KEYS

docker compose up -d --build

# 查看日志,会出现设备码:
#   打开此链接并输入设备码: https://console.opencode.ai/device?user_code=XXXX-XXXX&client_id=opencode-cli
#   设备码 (user_code): XXXX-XXXX
docker compose logs -f
```

在**任意有浏览器的设备**打开该链接、登录 OpenCode 账号并确认授权,代理会在几秒内拿到令牌并开始服务。之后令牌自动刷新,无需人工干预。

### 已有 opencode CLI?跳过首次授权

把本机 `~/.local/share/opencode/auth.json`(Windows: `%USERPROFILE%\.local\share\opencode\auth.json`)中 `opencode` 条目的内容填进 `.env` 的 `BOOTSTRAP_AUTH_JSON`,重启容器即可直接复用 CLI 的登录态:

```bash
BOOTSTRAP_AUTH_JSON={"access_token":"eyJ...","refresh_token":"rt_...","expires":1755300000000}
```

## 接入 new-api

1. new-api 管理后台 → **渠道** → 新建:
   - 类型:**OpenAI**
   - Base URL:`http://<部署机IP>:8787` (new-api 会自动拼接 `/v1/chat/completions`;部分版本需填 `http://<IP>:8787/v1`,两种都兼容,因为代理对 `/v1/x` 与 `/x` 均透传)
   - 密钥:`PROXY_API_KEYS` 中的任意一个
   - 模型:点"获取模型列表"(即 `GET /v1/models`)或手填 zen 模型名,如 `claude-sonnet-5`、`gpt-5.1`、`glm-5.3`
2. Responses 端点(`/v1/responses`)为原样透传,new-api 的 Responses 直通/转换功能按其自身配置使用。

直连测试:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer <你的PROXY_API_KEYS>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.1","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Web 控制台

浏览器打开 `http://<部署机IP>:8787/` 即可使用内置状态页(零依赖、单文件内嵌,无需额外部署):

- **授权卡片**:未授权时显示设备码大字 + 授权链接 + **二维码**(手机扫码即授权),已授权时显示令牌剩余时长,每 2 秒自动刷新
- **出站代理卡片**:查看当前代理(密码脱敏)、运行时修改(保存即生效并持久化)、一键"测试连通"(经当前代理访问上游 `/models`)
- **运行统计**:总请求 / 并发 / 排队 / 上游 429 / 401 / 自动重试 / 心跳发送(填入管理密钥后显示)
- **管理操作**:一键"立即刷新令牌"、"重新设备码授权(换号)"
- **连通性测试**:页面直接发流式测试请求,实时显示模型输出,默认模型 `deepseek-v4-flash-free`

页面本身无需登录即可查看授权状态(设备码本身无敏感性,完成授权仍需登录你的 OpenCode 账号);统计与管理操作需输入 `PROXY_API_KEYS` 之一(存在浏览器 localStorage)。公网部署建议套一层带认证的反代或限制访问来源。

## 管理接口

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /` 或 `/web` | 无 | Web 控制台页面 |
| `GET /healthz` | 无 | 存活检查 |
| `GET /info` | 无 | 服务信息(JSON) |
| `GET /proxy/config` | 无 | 当前出站代理(密码脱敏) |
| `POST /proxy/config` | key | 运行时设置/清除出站代理,`{"proxy":"socks5://user:pass@host:port"}`,立即生效并持久化 |
| `POST /proxy/test` | key | 经当前代理访问上游 `/models` 做连通性检测 |
| `GET /auth/status` | 无 | 授权状态;未授权时返回 `user_code` 与验证链接 |
| `GET /stats` | key | 请求数 / 429 / 重试 / 心跳 / 并发统计 |
| `POST /auth/refresh` | key | 立即刷新令牌 |
| `POST /auth/restart` | key | 作废令牌,重新发起设备码授权(换账号用) |

## 工作机制备注

- **鉴权**:客户端必须携带 `Authorization: Bearer <PROXY_API_KEYS 之一>`;代理校验通过后,把上游请求的 Authorization 替换为 OpenCode OAuth access token。
- **设备码刷新策略**:每 `TOKEN_REFRESH_MINUTES` 检查一次,临期(`REFRESH_BEFORE_SECONDS`)即用 refresh_token 换新;上游 401 触发即时刷新+单次重试;refresh_token 失效(如改密/撤销)自动重新走设备码并在日志打印新的 user_code。容器长时间离线也不会丢授权(令牌落盘在 `./data/auth.json`,权限 600)。
- **流式保活**:心跳为 SSE 注释行 `": keepalive\n\n"`,仅在上游静默期发送(不会切断事件),同时响应头带 `X-Accel-Buffering: no`、`Cache-Control: no-cache`,配合 nginx 时请对该 location 设置 `proxy_buffering off;`。
- **背压处理**:客户端消费慢时代理会等待 `drain` 而不是丢弃或断开,保证字节完整。

## 本地开发与自测

```bash
npm run test:mock   # 拉起 mock 上游,验证鉴权/透传/SSE 心跳/429 重试/401 刷新重试
npm start           # 本地直接运行(需 Node>=18)
```

## 常见问题

- **请求 503 `proxy_auth_pending`**:还没完成设备码授权,看日志或 `/auth/status` 里的链接完成授权。
- **频繁 429**:先看 `Retry-After`/错误码——`proxy_rate_limited` 是代理主动限速(`RATE_LIMIT_FREE_RPM`,默认 30,上游匿名层约 40RPM 按 IP 计),按提示等待或调大配额;上游返回的 429 则由代理自动退避重试,仍频繁就调小 `MAX_CONCURRENCY`、调大 `RETRY_429`。多账号请部署多个实例(不同端口/数据目录),在 new-api 里做负载。
- **放在 nginx 后面断流**:location 加 `proxy_buffering off; proxy_read_timeout 600s;`。
- **换绑账号**:`POST /auth/restart` 或删除 `data/auth.json` 后重启。
