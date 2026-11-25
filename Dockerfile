FROM node:24-bookworm-slim

ARG TARGETARCH
ARG YTDLP_VERSION=2026.11.19.232656
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH:-amd64}" in \
        amd64) asset=yt-dlp_linux ;; \
        arm64) asset=yt-dlp_linux_aarch64 ;; \
        *) exit 1 ;; \
    esac \
    && release="https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/${YTDLP_VERSION}" \
    && curl -fsSL --retry 3 "${release}/SHA2-256SUMS" -o /tmp/yt-dlp-checksums \
    && curl -fsSL --retry 3 "${release}/${asset}" -o "/tmp/${asset}" \
    && cd /tmp \
    && awk -v file="${asset}" '$2 == file { print }' yt-dlp-checksums | sha256sum -c - \
    && install -m 0755 "${asset}" /usr/local/bin/yt-dlp \
    && rm "${asset}" yt-dlp-checksums

WORKDIR /app
COPY media.mjs converter.mjs server.mjs ./
COPY public ./public
RUN node --input-type=module -e "\
    import { readFileSync, writeFileSync } from 'node:fs'; \
    import { gzipSync } from 'node:zlib'; \
    for (const name of ['index.html', 'style.css', 'app.js']) { \
        const path = 'public/' + name; \
        writeFileSync(path + '.gz', gzipSync(readFileSync(path))); \
    }"
USER node
ENV NODE_ENV=production CLIPDECK_HOSTED=1
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
