# --- assets stage: bundle the player, then the app ------------------------
# The viewer page is static and CSP-locked with no CDN access, so rrweb-player
# is bundled into one self-contained file here rather than fetched at runtime.
#
# The app is bundled too, in the same stage and after it: its own module graph
# is around twenty files, which is twenty requests before anything appears.
# The player stays out of that bundle — reports.js imports it through an
# expression the bundler can't follow, so it is still fetched only by the
# screens that show a replay.
FROM node:20-alpine AS assets

WORKDIR /build
COPY package.json ./
RUN npm install --include=dev
COPY vendor ./vendor
COPY public ./public
RUN npm run build:assets

# --- runtime --------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
COPY --from=assets /build/public/vendor ./public/vendor
COPY --from=assets /build/public/app.bundle.js ./public/app.bundle.js

RUN mkdir -p /data
VOLUME /data

EXPOSE 4000
CMD ["node", "src/index.js"]
