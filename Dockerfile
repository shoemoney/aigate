FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=20200 CCLB_DB=/app/data/cclb.db
VOLUME /app/data
EXPOSE 20200
CMD ["node","src/server.js"]
