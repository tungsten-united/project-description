# The built web app on nginx, listening on 8080 for Cloud Run.
# Build the app first (npm run build), then, from the repository root:
#   docker build -f deploy/web/Dockerfile -t orient-web .
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/dist /usr/share/nginx/html
EXPOSE 8080
