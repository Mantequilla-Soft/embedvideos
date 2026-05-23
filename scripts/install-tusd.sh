#!/bin/bash
set -e

TUSD_VERSION="v2.9.2"
ARCH="linux_amd64"
BINARY_DIR="./bin"
BINARY_PATH="${BINARY_DIR}/tusd"
DOWNLOAD_URL="https://github.com/tus/tusd/releases/download/${TUSD_VERSION}/tusd_${ARCH}.tar.gz"

if [ -f "$BINARY_PATH" ]; then
  echo "tusd already installed at ${BINARY_PATH}"
  "$BINARY_PATH" --version
  exit 0
fi

echo "Downloading tusd ${TUSD_VERSION} for ${ARCH}..."
mkdir -p "$BINARY_DIR"

TMP=$(mktemp -d)
curl -fsSL "$DOWNLOAD_URL" -o "${TMP}/tusd.tar.gz"
tar -xzf "${TMP}/tusd.tar.gz" -C "$TMP"
cp "${TMP}/tusd_${ARCH}/tusd" "$BINARY_PATH"
chmod +x "$BINARY_PATH"
rm -rf "$TMP"

echo "tusd installed at ${BINARY_PATH}"
"$BINARY_PATH" --version
