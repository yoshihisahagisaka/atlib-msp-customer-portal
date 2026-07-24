# 月次レポート自動生成バッチ(Puppeteer)用イメージ。
# msp-customer-portal本体(Dockerfile、node:20-alpine)とは別イメージ
# (AlpineはPuppeteerのChromiumバイナリと相性が悪いためDebian系を使う)。
# ビルドコンテキストは msp-customer-portal/ ルート(src/を共有参照するため)。

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY batch/package*.json ./batch/
# ビルド専用ステージではブラウザ本体は不要(型チェック・トランスパイルのみ)なのでダウンロードを省略する
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN cd batch && npm ci
COPY tsconfig.batch.json ./
COPY src ./src
COPY batch ./batch
RUN cd batch && npm run build

FROM node:20-bookworm-slim
WORKDIR /app

# Puppeteer(Chrome for Testing)が要求する共有ライブラリ・日本語フォント
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation fonts-noto-cjk \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
    libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxrandr2 libxshmfence1 xdg-utils wget \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY batch/package*.json ./batch/
RUN cd batch && npm ci --omit=dev
COPY --from=build /app/batch/dist ./batch/dist

WORKDIR /app/batch
CMD ["node", "dist/batch/generate-monthly-reports.js"]
