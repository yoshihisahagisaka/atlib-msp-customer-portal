# --- build stage ---
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# puppeteerはmonthly-report-batch(batch/)専用の依存で、このAlpineイメージでは
# 実際に起動しない(Chromiumバイナリのダウンロードも不要)ため省略する
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
RUN npm run build

# --- runtime stage ---
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
# Alpine 3.23 fixes measured in GCP Artifact Analysis, with fail-closed versions.
# Keep the build-stage source digest unchanged and update only runtime OS packages.
RUN apk add --no-cache --upgrade \
    'openssl=3.5.9-r1' \
    'libcrypto3=3.5.9-r1' \
    'libssl3=3.5.9-r1' \
    'zlib=1.4-r0'
WORKDIR /app
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json* ./
# Install once, then remove the npm CLI from the runtime image.
# Secure Guard executes Node directly. npm's bundled dependencies contain
# unrelated vulnerable copies of undici / brace-expansion.
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist
COPY public ./public
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
