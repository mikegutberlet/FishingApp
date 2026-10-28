# The private archive server (server/serve.mjs): nightly corpus build into a mounted folder, served to the app with a key.
# Built by Compose straight from this repo (server/docker-compose.yml); run per server/README.md.
FROM node:22-alpine
RUN apk add --no-cache git poppler-utils tesseract-ocr tesseract-ocr-data-eng
# This checkout, .git included: the build reads the state data files from it and pulls before each run.
# Owned by uid 3000, the home lab's single app user, so the container can run as it and still git pull.
COPY --chown=3000:3000 . /app
WORKDIR /app
ENV CORPUS_DIR=/corpus PORT=8787 HOME=/tmp TZ=America/Los_Angeles
EXPOSE 8787
VOLUME ["/corpus"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "server/serve.mjs"]
