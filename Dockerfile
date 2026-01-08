FROM denoland/deno:latest
WORKDIR /app

COPY main.ts .
COPY config.ts .
COPY deno.json .
COPY logger.ts .
COPY error-handler.ts .

RUN deno cache main.ts
EXPOSE 10001
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "main.ts"]