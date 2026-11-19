FROM node:20-alpine

WORKDIR /app

# 依赖只有 mysql2；备份快照目录以卷挂载
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=8787
EXPOSE 8787

# MySQL 连接通过环境变量注入（compose 或 docker run -e）：
#   MYSQL_URL="mysql://user:pass@mysql:3306/ai_gateway"
# 或分项 MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "server.js"]
