FROM node:20-alpine
WORKDIR /app

COPY shared/package.json ./shared/package.json
RUN cd shared && npm install --omit=dev

COPY shared/src ./shared/src

COPY services/payment-service/package.json ./services/payment-service/package.json
RUN cd services/payment-service && npm install --omit=dev

COPY services/payment-service/src ./services/payment-service/src

WORKDIR /app/services/payment-service
ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "src/index.js"]
