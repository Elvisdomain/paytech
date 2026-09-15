FROM node:20-alpine
WORKDIR /app

COPY shared/package.json ./shared/package.json
RUN cd shared && npm install --omit=dev

COPY shared/src ./shared/src

COPY services/ledger-service/package.json ./services/ledger-service/package.json
RUN cd services/ledger-service && npm install --omit=dev

COPY services/ledger-service/src ./services/ledger-service/src

WORKDIR /app/services/ledger-service
ENV NODE_ENV=production
EXPOSE 3006
CMD ["node", "src/index.js"]
