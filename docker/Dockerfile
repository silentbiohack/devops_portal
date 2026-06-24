FROM node:20-alpine

WORKDIR /app

COPY app/package*.json ./
RUN npm install --omit=dev

COPY app/server.js ./
COPY app/views ./views
COPY app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
