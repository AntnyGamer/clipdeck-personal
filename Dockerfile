FROM node:24-bookworm-slim

ARG TARGETARCH
ARG YTDLP_VERSION=2026.10.26
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH:-amd64}" in \
        amd64) asset=yt-dlp_linux ;; \
        arm64) asset=yt-dlp_linux_aarch64 ;; \
        *) exit 1 ;; \
    esac \
    && release="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}" \
    && curl -fsSL --retry 3 "${release}/SHA2-256SUMS" -o /tmp/yt-dlp-checksums \
    && curl -fsSL --retry 3 "${release}/${asset}" -o "/tmp/${asset}" \
    && cd /tmp \
    && awk -v file="${asset}" '$2 == file { print }' yt-dlp-checksums | sha256sum -c - \
    && install -m 0755 "${asset}" /usr/local/bin/yt-dlp \
    && rm "${asset}" yt-dlp-checksums

WORKDIR /app
COPY media.mjs server.mjs ./
COPY public ./public
USER node
ENV NODE_ENV=production CLIPDECK_HOSTED=1
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
