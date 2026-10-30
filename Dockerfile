# ---- Build zsign (the signing engine) ----
FROM debian:bookworm-slim AS zsign
ARG ZSIGN_COMMIT=9299685bab7ef99827e06e5dfda93af747386590
RUN apt-get update \
 && apt-get install -y --no-install-recommends git g++ make pkg-config libssl-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git init /zsign && cd /zsign \
 && git remote add origin https://github.com/zhlynn/zsign.git \
 && git fetch --depth 1 origin ${ZSIGN_COMMIT} && git checkout FETCH_HEAD \
 && cd build/linux && make clean && make -j"$(nproc)" \
 && test -x /zsign/bin/zsign

# ---- App ----
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl libssl3 ca-certificates zip unzip \
 && rm -rf /var/lib/apt/lists/*
COPY --from=zsign /zsign/bin/zsign /usr/local/bin/zsign
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
