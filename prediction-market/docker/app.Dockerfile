FROM node:22-alpine AS build
RUN npm install -g pnpm@12.18.0
WORKDIR /app
COPY app/package.json app/pnpm-lock.yaml app/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY app ./
# The browser talks to the backend through the host's published port.
ARG VITE_API_URL=http://localhost:8080
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm exec vite build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
