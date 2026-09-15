FROM node:20-alpine
WORKDIR /app

COPY shared/package.json ./shared/package.json
RUN cd shared && npm install --omit=dev

COPY shared/src ./shared/src

COPY services/fraud-service/package.json ./services/fraud-service/package.json
RUN cd services/fraud-service && npm install --omit=dev

COPY services/fraud-service/src ./services/fraud-service/src

WORKDIR /app/services/fraud-service
ENV NODE_ENV=production
EXPOSE 3005
CMD ["node", "src/index.js"]
