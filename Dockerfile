# 零 npm 依赖,直接拷贝即可运行
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
# 部分网络环境 DNS 优先返回 AAAA 但 IPv6 不通,强制 IPv4 优先
ENV NODE_OPTIONS=--dns-result-order=ipv4first

COPY package.json ./
COPY src ./src

# data 卷:持久化 OAuth 令牌,容器重启无需重新授权
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
