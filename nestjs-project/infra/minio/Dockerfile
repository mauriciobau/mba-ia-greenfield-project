FROM golang:1.24.2-alpine AS minio-build

ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z

RUN apk add --no-cache git
RUN go install github.com/minio/minio@${MINIO_VERSION} \
    && go install github.com/minio/mc@${MC_VERSION}

FROM alpine:3.22

RUN apk add --no-cache ca-certificates curl
COPY --from=minio-build /go/bin/minio /usr/local/bin/minio
COPY --from=minio-build /go/bin/mc /usr/local/bin/mc

EXPOSE 9000 9001
ENTRYPOINT ["minio"]
