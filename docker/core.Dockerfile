FROM node:24-alpine
RUN apk add --no-cache bash git curl python3 make g++ github-cli tzdata
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY src/core-package.json ./package.json
RUN npm install --omit=dev
COPY src/core-server.js src/vault-indexer.js src/vault-cli.js src/registry.js src/graph.js src/graph-export.js src/model-command.cjs src/schema-validator.js src/send-to-user.js src/send-message.js src/send-location.js src/scheduler.js src/routine-cli.js ./
COPY roots /app/roots
# Install deps for any root that has its own package.json (gmail uses googleapis etc.)
RUN for d in /app/roots/*/; do \
      if [ -f "$d/package.json" ]; then \
        (cd "$d" && npm install --omit=dev); \
      fi; \
    done
RUN chmod +x /app/vault-cli.js && ln -s /app/vault-cli.js /usr/local/bin/vault
RUN chmod +x /app/send-to-user.js && ln -s /app/send-to-user.js /usr/local/bin/send-to-user
RUN chmod +x /app/send-message.js && ln -s /app/send-message.js /usr/local/bin/send-message
RUN chmod +x /app/send-location.js && ln -s /app/send-location.js /usr/local/bin/send-location
RUN chmod +x /app/routine-cli.js && ln -s /app/routine-cli.js /usr/local/bin/routine
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude
USER node
CMD ["node", "core-server.js"]
