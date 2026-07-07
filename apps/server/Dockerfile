# ---- 构建阶段 ----
FROM node:22-slim AS builder

WORKDIR /app

# 原生模块编译工具（better-sqlite3）
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# ① 先只复制 package.json / package-lock.json，利用 Docker 层缓存
#    只要依赖声明没变，npm ci 这一层就会命中缓存，不需要重新安装
COPY package.json package-lock.json ./

COPY packages/package.json                   ./packages/package.json
COPY packages/config/package.json            ./packages/config/package.json
COPY packages/logger/package.json            ./packages/logger/package.json
COPY packages/module-runtime/package.json    ./packages/module-runtime/package.json
COPY packages/plugin-runtime/package.json    ./packages/plugin-runtime/package.json
COPY packages/sdk/package.json               ./packages/sdk/package.json
COPY packages/shared/package.json            ./packages/shared/package.json
COPY packages/storage/package.json           ./packages/storage/package.json
COPY apps/server/package.json                ./apps/server/package.json

# ② 安装依赖（此层可被缓存，改代码不影响）
RUN npm ci

# ③ 复制源码
COPY packages  ./packages
COPY apps/server ./apps/server

# ④ 编译（单层减少镜像层数）
RUN npm run build -w packages && npm run build -w apps/server

# ---- 运行阶段 ----
FROM node:22-slim AS runtime

WORKDIR /app

ENV TZ=Asia/Shanghai

# Chrome/Puppeteer 运行时依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tzdata fonts-liberation fonts-noto-cjk fonts-wqy-zenhei \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 \
    libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxkbcommon0 libxrandr2 wget xdg-utils unzip \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

# 直接从 builder 复制已编译的 node_modules（含原生二进制），无需重装编译工具
COPY --from=builder /app/package.json        ./
COPY --from=builder /app/node_modules        ./node_modules
# 只复制编译产物和 package.json，不复制源码
COPY --from=builder /app/packages/package.json                ./packages/package.json
COPY --from=builder /app/packages/config/package.json         ./packages/config/package.json
COPY --from=builder /app/packages/config/dist                 ./packages/config/dist
COPY --from=builder /app/packages/logger/package.json         ./packages/logger/package.json
COPY --from=builder /app/packages/logger/dist                 ./packages/logger/dist
COPY --from=builder /app/packages/module-runtime/package.json ./packages/module-runtime/package.json
COPY --from=builder /app/packages/module-runtime/dist         ./packages/module-runtime/dist
COPY --from=builder /app/packages/plugin-runtime/package.json ./packages/plugin-runtime/package.json
COPY --from=builder /app/packages/plugin-runtime/dist         ./packages/plugin-runtime/dist
COPY --from=builder /app/packages/sdk/package.json            ./packages/sdk/package.json
COPY --from=builder /app/packages/sdk/dist                    ./packages/sdk/dist
COPY --from=builder /app/packages/shared/package.json         ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist                 ./packages/shared/dist
COPY --from=builder /app/packages/storage/package.json        ./packages/storage/package.json
COPY --from=builder /app/packages/storage/dist                ./packages/storage/dist
COPY --from=builder /app/apps/server/dist    ./apps/server/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json

# 运行时目录（通过 volume 挂载）
RUN mkdir -p config plugins data

# 复制默认配置文件
COPY config/bot.yaml.example /app/config.default/bot.yaml
COPY config/settings.yaml.example /app/config.default/settings.yaml

# 创建启动脚本
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'if [ ! -f /app/config/bot.yaml ]; then' >> /app/start.sh && \
    echo '  cp /app/config.default/bot.yaml /app/config/bot.yaml' >> /app/start.sh && \
    echo '  echo "Created default bot.yaml"' >> /app/start.sh && \
    echo 'fi' >> /app/start.sh && \
    echo 'if [ ! -f /app/config/settings.yaml ]; then' >> /app/start.sh && \
    echo '  cp /app/config.default/settings.yaml /app/config/settings.yaml' >> /app/start.sh && \
    echo '  echo "Created default settings.yaml"' >> /app/start.sh && \
    echo 'fi' >> /app/start.sh && \
    echo 'exec node apps/server/dist/main.js' >> /app/start.sh && \
    chmod +x /app/start.sh

EXPOSE 3000

CMD ["/app/start.sh"]
