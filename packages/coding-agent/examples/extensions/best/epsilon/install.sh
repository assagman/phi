#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_NAME="epsilon"
TARGET_DIR="${HOME}/.phi/agent/extensions/${EXTENSION_NAME}"

echo -e "${YELLOW}Installing ${EXTENSION_NAME}...${NC}"

# Install dependencies
echo -e "${YELLOW}→ Installing dependencies...${NC}"
cd "${SCRIPT_DIR}"
bun install

# Build extension
echo -e "${YELLOW}→ Building extension...${NC}"
bun run build

# Create extensions directory if needed
mkdir -p "$(dirname "${TARGET_DIR}")"

# Remove existing symlink if present
if [ -L "${TARGET_DIR}" ]; then
    echo -e "${YELLOW}→ Removing existing symlink...${NC}"
    rm "${TARGET_DIR}"
fi

# Create symlink to dist folder
echo -e "${YELLOW}→ Linking to phi extensions...${NC}"
ln -s "${SCRIPT_DIR}/dist" "${TARGET_DIR}"

echo -e "${GREEN}✓ ${EXTENSION_NAME} installed successfully!${NC}"
echo -e "  Location: ${TARGET_DIR}"
echo -e "  Source:   ${SCRIPT_DIR}"
