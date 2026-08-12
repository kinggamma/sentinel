# --- assets stage: bundle the replay player -------------------------------
# The viewer page is static and CSP-locked with no CDN access, so rrweb-player
# is bundled into one self-contained file here rather than fetched at runtime.
FROM node:20-alpine AS assets

WORKDIR /build
COPY package.json ./
RUN npm install --include=dev
COPY vendor ./vendor
COPY public ./public
RUN npm run build:player

# --- runtime --------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
COPY --from=assets /build/public/vendor ./public/vendor

RUN mkdir -p /data
VOLUME /data

EXPOSE 4000
CMD ["node", "src/index.js"]
