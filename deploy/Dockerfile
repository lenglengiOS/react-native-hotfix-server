FROM node:22-bookworm-slim

ARG HOTFIX_VERSION=0.1.3

RUN npm install --global "react-native-hotfix-server@${HOTFIX_VERSION}" \
  && npm cache clean --force \
  && groupadd --system hotfix \
  && useradd --system --gid hotfix --home-dir /data --shell /usr/sbin/nologin hotfix \
  && install -d -o hotfix -g hotfix /data

USER hotfix
WORKDIR /data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV HOTFIX_STORAGE_DIR=/data

EXPOSE 3000

CMD ["hotfix-server"]
