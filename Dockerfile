FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app/runtime

COPY package.json ./
COPY secure-store.mjs ./
COPY tg-cf-dns-bot.mjs ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN addgroup -S cfbot \
  && adduser -S -G cfbot cfbot \
  && mkdir -p /app/data /run/cf-dns-bot \
  && chown -R cfbot:cfbot /app /run/cf-dns-bot /usr/local/bin/docker-entrypoint.sh \
  && chmod 755 /usr/local/bin/docker-entrypoint.sh

USER cfbot
WORKDIR /app/data

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "/app/runtime/tg-cf-dns-bot.mjs"]
