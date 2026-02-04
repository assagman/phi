#!/usr/bin/env bash
#
# Install phi_delta and phi_epsilon CLI tools
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${1:-$HOME/.local/bin}"

echo "Installing phi CLI tools..."
echo "  Source: $SCRIPT_DIR"
echo "  Target: $INSTALL_DIR"
echo ""

mkdir -p "$INSTALL_DIR"

# Install phi_delta
cp "$SCRIPT_DIR/delta/phi_delta" "$INSTALL_DIR/phi_delta"
chmod +x "$INSTALL_DIR/phi_delta"
echo "✓ phi_delta"

# Install phi_epsilon  
cp "$SCRIPT_DIR/epsilon/phi_epsilon" "$INSTALL_DIR/phi_epsilon"
chmod +x "$INSTALL_DIR/phi_epsilon"
echo "✓ phi_epsilon"

echo ""

# Check PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo "⚠ $INSTALL_DIR not in PATH. Add to shell profile:"
    echo ""
    echo "  export PATH=\"\$PATH:$INSTALL_DIR\""
    echo ""
fi

echo "Done. Run:"
echo "  phi_delta help"
echo "  phi_epsilon help"
