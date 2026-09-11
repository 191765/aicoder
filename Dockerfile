FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
COPY README.md .env.example ./
EXPOSE 8787
# 默认启动网页版；数据目录挂载到 /data
ENV AICODER_WORKDIR=/workspace
ENV AICODER_HOME=/data
VOLUME ["/workspace", "/data"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["web"]
