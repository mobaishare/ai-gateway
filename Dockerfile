# 零依赖 Node 应用，无需安装任何包
FROM node:20-alpine

WORKDIR /app

# 数据目录以卷挂载，容器升级不丢数据
VOLUME ["/app/data"]

COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "server.js"]
