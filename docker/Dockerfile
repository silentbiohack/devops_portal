FROM nginx:alpine

COPY app/index.html /usr/share/nginx/html/index.html

EXPOSE 80

CMD sed -i "s/CONTAINER_HOSTNAME/$(hostname)/" /usr/share/nginx/html/index.html && exec nginx -g 'daemon off;'
