# Telegram-бот для барбершопа (веб-чат деплоится на Vercel отдельно)
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bot ./bot
ENV DATA_DIR=/app/data
VOLUME /app/data
CMD ["node", "bot/index.js"]
