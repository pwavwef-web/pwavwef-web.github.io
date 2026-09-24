# AZ Studio renderer — Cloud Run job. Debian FFmpeg is built with libx264, AAC, libass and fontconfig.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core fonts-noto-core fonts-inter fonts-ebgaramond ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f \
 && echo "Installed font families:" && fc-list : family | sort -u | grep -Ei "inter|garamond|dejavu sans$|noto sans$" \
 && ffmpeg -hide_banner -filters | grep -E " (subtitles|zoompan|loudnorm|tpad|xfade|sidechaincompress) " \
 && mkdir -p /app/fonts

WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY dist ./dist

USER node
CMD ["node", "dist/main.js"]
