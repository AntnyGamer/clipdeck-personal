# Clipdeck

Clipdeck is a password-protected YouTube converter that works in a phone or desktop browser. It converts supported video, Shorts, and replay links to MP4 or MP3. For a supported active livestream, it starts at the live edge and exports the recorded portion when you select **Stop & save**.

## Deploy on Render

1. Put these files at the root of a GitHub repository. A private repository keeps the source private.
2. In Render, create a **Blueprint** linked to the repository. `render.yaml` selects a **Free** Docker web service and generates `CLIPDECK_PASSWORD`. It uses temporary files and requires no database.
3. Open the service’s HTTPS URL on your phone. Sign in with username `clipdeck` and the password shown under **Environment → CLIPDECK_PASSWORD** in the Render dashboard.

Render wakes the app after an idle period. Keep the converter open while recording live, and download the result when it’s ready. Instance restarts clear temporary files. Your workspace shares free build time, bandwidth, and instance hours across services. With no payment method, Render enforces the limits by pausing builds or services. See [Render’s free plan limits](https://render.com/docs/free).

## Run locally for development

Put Node.js 22 or later, `yt-dlp`, `ffmpeg`, and `ffprobe` on your `PATH`. The official yt-dlp executable includes the YouTube JavaScript component. Run `node server.mjs` and open `http://127.0.0.1:4174`.

For another Docker host, set `PORT`, `CLIPDECK_ORIGIN` to the site’s HTTPS origin without a trailing slash, and `CLIPDECK_PASSWORD` to a random password of at least 16 characters. Render supplies its own origin automatically. `/healthz` checks whether the app has the required media tools.

## Supported sources and quality

- MP4 uses H.264 with AAC audio where the source has an audio track. Choose a resolution ceiling from 480p to 2160p. Portrait clips retain their orientation.
- MP3 supports 96, 128, 192, 256, and 320 kbps. The original audio sets the quality ceiling.
- Live capture requires YouTube to provide a compatible live feed. After YouTube publishes a replay, use the same link to convert it as a regular video.
- YouTube may restrict access from cloud hosting IPs. Clipdeck reports these failures. Use it for media you have permission to download under [YouTube’s terms](https://www.youtube.com/t/terms).
