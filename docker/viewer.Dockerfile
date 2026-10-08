FROM node:24-alpine
WORKDIR /app
# Stdlib-only server: no npm install, nothing else in the image.
COPY viewer/package.json viewer/server.js viewer/auth.js ./
COPY viewer/public ./public
USER node
EXPOSE 3003
CMD ["node", "server.js"]
