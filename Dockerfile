FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache \
      python3 make g++ \
      chromium nss freetype freetype-dev harfbuzz ca-certificates ttf-freefont \
      clamav \
      postgresql16-client \
 && ln -sf /usr/bin/python3 /usr/bin/python \
 && pg_dump --version && pg_restore --version

RUN mkdir -p /etc/ssl/rds \
 && wget -q -O /etc/ssl/rds/global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
 && echo "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /etc/ssl/rds/global-bundle.pem" | sha256sum -c - \
 && chmod 0644 /etc/ssl/rds/global-bundle.pem

RUN freshclam

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    UPLOAD_AV_MODE=required \
    CLAMAV_BIN=/usr/bin/clamscan

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js db.js ./
COPY routes/ ./routes/
COPY lib/ ./lib/
COPY views/ ./views/
COPY public/ ./public/
COPY data/ ./data/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/

RUN node scripts/install-policy-models.js --dir /app/models/policy-retrieval \
 && node scripts/self-test-policy-models.js --dir /app/models/policy-retrieval \
 && chmod -R a-w /app/models/policy-retrieval

RUN set -e; \
    for f in .env .env.local iso27001.db data/master.key; do \
      if [ -e "/app/$f" ]; then echo "SEC-001: $f must not be in the image" >&2; exit 1; fi; \
    done; \
    if find /app -maxdepth 4 \( -name '*.db' -o -name '*.sqlite' -o -name '*.key' -o -name '*.pem' -o -name '*.enc' \) -print | grep -q .; then \
      echo "SEC-001: database/key material found in image" >&2; \
      find /app -maxdepth 4 \( -name '*.db' -o -name '*.sqlite' -o -name '*.key' -o -name '*.pem' -o -name '*.enc' \) -print >&2; exit 1; \
    fi

RUN mkdir -p /app/data/backups /app/uploads \
 && chown -R node:node /app/data /app/uploads \
 && chmod 0700 /app/data /app/data/backups /app/uploads

VOLUME ["/app/data", "/app/uploads"]
ENV ISMS_BACKUP_DIR=/app/data/backups \
    POLICY_MODEL_DIR=/app/models/policy-retrieval \
    POLICY_RETRIEVAL_ENABLED=true \
    PORT=3000

EXPOSE 3000

USER node:node

CMD ["node", "server.js"]
