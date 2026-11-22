# Clipdeck

Clipdeck is a password-protected YouTube converter, video compressor, and media file converter that works in a phone or desktop browser. It converts supported video, Shorts, and replay links to MP4 or MP3. For a supported active livestream, it starts at the live edge and exports the recorded portion when you select **Stop & save**.

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

## Compress videos from your device

Open **Compress a video**, select a local video up to **200 MB**, and choose a size goal: automatic, a 1–95% reduction, or a target of 0.1–200 MB (decimal MB). Choose a quality preference:

- **Strictly lossless** preserves audio and video without re-encoding. It keeps the original file if it already meets your target or remuxing cannot make it smaller; otherwise it saves an MKV. It can fail an unattainable smaller-size goal rather than silently lowering quality.
- **Prefer lossless** (default) preserves the original file when it already meets the size goal, tries lossless remuxing first for smaller goals, and re-encodes to MP4 only if the goal requires it. With automatic compression, it never increases the size or re-encodes an already compressed file just to make it smaller.
- **Balanced** creates H.264/AAC MP4, limiting resolution to 1080p.
- **Prioritize file size** creates H.264/AAC MP4, limiting resolution to 720p.

When a size goal is selected, Clipdeck uses two-pass FFmpeg video encoding where needed. Exact size is not guaranteed; it shows the actual final size, savings percentage, and whether the file was re-encoded. The original file on your device remains untouched. Videos are uploaded to the Clipdeck server for processing, and temporary server files expire after 12 hours. Very large or lengthy conversions may exceed free hosting limits.

Compression requires only `ffmpeg` and `ffprobe`; YouTube conversion also requires `yt-dlp`. If only the YouTube downloader is missing, local-file compression remains available.

## Convert file formats

Open **Convert file**, select a file up to **200 MB**, search by output format (for example, `MP4`, `WAV`, or `PNG`), and choose a compatible option from the grouped dropdown. Clipdeck shows output choices based on the selected input file. It uses FFmpeg without additional conversion dependencies.

- **Video:** MP4, MOV, M4V, MKV, WEBM, AVI, WMV, MPEG, MPG, FLV, and TS inputs. Convert to MP4, MKV, WEBM, MOV, AVI, or GIF. If the video has audio, you can also export MP3, WAV, M4A, FLAC, OGG, or OPUS.
- **Audio:** MP3, WAV, M4A, AAC, FLAC, OGG, OPUS, WMA, AIFF, and AIF inputs. Convert to MP3, WAV, M4A, FLAC, OGG, or OPUS.
- **Images:** PNG, JPG/JPEG, WEBP, BMP, and TIFF/TIF inputs. Convert to PNG, JPG, WEBP, BMP, or TIFF.

Conversions are restricted to compatible types: changing an extension alone is not a valid conversion. For example, Clipdeck cannot convert a PDF to MP4, a DOCX to PDF, or an image to an audio file. **Document, archive, and arbitrary binary conversions are not supported.** Images are converted as individual still images, video-to-audio drops the video, and GIF output has no audio and uses a reduced frame rate and size. Re-encoding can change quality and file size. The original remains untouched; converted files use a `- converted` filename suffix. Output files expire from temporary server storage after 12 hours.
