# No build step and no dependencies — the image is node plus four files.
FROM node:22-alpine

WORKDIR /srv/secret-wars

COPY server.mjs .
COPY public ./public
# The default reading order. The server refuses to start without it rather than
# serving an empty list, so leaving this out is a crash loop, not a soft
# failure — which is exactly what shipping it once without this line did.
COPY seed ./seed

# /data is a bind mount from the host. The node user is uid 1000, so the
# mounted directory must be owned by uid 1000 for state writes to succeed.
RUN mkdir -p /data && chown node:node /data
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

EXPOSE 8080

HEALTHCHECK --interval=1m --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "server.mjs"]
