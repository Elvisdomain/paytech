FROM node:20-alpine
WORKDIR /app

COPY shared/package.json ./shared/package.json
RUN cd shared && npm install --omit=dev

COPY shared/src ./shared/src

COPY services/user-service/package.json ./services/user-service/package.json
RUN cd services/user-service && npm install --omit=dev

COPY services/user-service/src ./services/user-service/src

WORKDIR /app/services/user-service
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "src/index.js"]
