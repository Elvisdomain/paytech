FROM node:20-alpine
WORKDIR /app

COPY shared/package.json ./shared/package.json
RUN cd shared && npm install --omit=dev

COPY shared/src ./shared/src

COPY services/notification-service/package.json ./services/notification-service/package.json
RUN cd services/notification-service && npm install --omit=dev

COPY services/notification-service/src ./services/notification-service/src

WORKDIR /app/services/notification-service
ENV NODE_ENV=production
EXPOSE 3004
CMD ["node", "src/index.js"]
