#!/bin/bash
# VideoHub setup - double-click to install (see README.md)
cd "$(dirname "$0")" && ./setup.sh "$@"
echo; read -n 1 -s -r -p "Press any key to close..."
