# Autopia: MCP server (HTTP) + worker in one image. The process is chosen by the command:
#   default              -> MCP server over HTTP on $PORT (Fly sets PORT=8080)
#   npm run run-all      -> one pass of the worker over every target (use as a scheduled job)
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# tsx is a devDependency but runs the app, so dev deps are installed explicitly (NODE_ENV=production would skip them).
RUN npm ci --ignore-scripts --include=dev
COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
COPY targets ./targets
EXPOSE 8080
CMD ["sh", "-c", "npx tsx src/server/mcp.ts --http ${PORT:-8080}"]
