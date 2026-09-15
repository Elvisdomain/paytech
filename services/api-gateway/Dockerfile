FROM node:20-alpine
WORKDIR /app

# 1. Install shared lib dependencies first (better layer caching)
COPY shared/package.json ./shared/package.json
RUN cd shared && npm install --omit=dev

# 2. Copy shared source after installing its deps
COPY shared/src ./shared/src

# 3. Install service dependencies (resolves @paytech/shared via file: link)
COPY services/api-gateway/package.json ./services/api-gateway/package.json
RUN cd services/api-gateway && npm install --omit=dev

# 4. Copy service source
COPY services/api-gateway/src ./services/api-gateway/src

WORKDIR /app/services/api-gateway
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
