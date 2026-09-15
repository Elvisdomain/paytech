FROM node:20-alpine
WORKDIR /app

COPY shared/package.json ./shared/package.json
RUN cd shared && npm install --omit=dev

COPY shared/src ./shared/src

COPY services/order-service/package.json ./services/order-service/package.json
RUN cd services/order-service && npm install --omit=dev

COPY services/order-service/src ./services/order-service/src

WORKDIR /app/services/order-service
ENV NODE_ENV=production
EXPOSE 3003
CMD ["node", "src/index.js"]
