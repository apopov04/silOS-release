FROM node:24-alpine

# Install ffmpeg for audio conversion and build tools for whisper.cpp
RUN apk add --no-cache ffmpeg git make g++ cmake

# Build whisper.cpp from source
RUN git clone https://github.com/ggerganov/whisper.cpp /opt/whisper \
    && cd /opt/whisper \
    && cmake -B build \
    && cmake --build build -j$(nproc) \
    && ln -s /opt/whisper/build/bin/whisper-cli /usr/local/bin/whisper

# Download tiny model (~75MB)
RUN mkdir -p /opt/whisper/models \
    && wget -O /opt/whisper/models/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin

WORKDIR /app
COPY src/bot-package.json ./package.json
RUN npm install --omit=dev
COPY src/bot.js src/model-command.cjs ./
USER node
CMD ["node", "bot.js"]
