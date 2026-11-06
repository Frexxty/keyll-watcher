# No dependencies to install: the watcher only uses Node's standard library.
FROM node:24-alpine
WORKDIR /watcher
COPY package.json ./
COPY bin ./bin
COPY src ./src
# The local ledger for providers whose keys can't carry a marker (Anthropic, OpenAI, OpenRouter, Resend). Mount a volume here.
RUN mkdir -p /var/lib/keyll && chown node:node /var/lib/keyll
USER node
CMD ["node", "bin/keyll-watcher.mjs", "run"]
