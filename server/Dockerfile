# The private archive server (server/serve.mjs): nightly corpus build into a mounted folder, served to the app with a key.
#   docker compose -f server/docker-compose.yml up -d        (see server/README.md)
FROM node:22-alpine
RUN apk add --no-cache git
# This checkout, .git included: the build reads the state data files from it and pulls before each run.
COPY . /app
WORKDIR /app
ENV CORPUS_DIR=/corpus PORT=8787 TZ=America/Los_Angeles
EXPOSE 8787
VOLUME ["/corpus"]
CMD ["node", "server/serve.mjs"]
