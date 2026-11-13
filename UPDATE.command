#!/bin/bash
# VideoHub update - copies this folder's code over the VideoHub installed on this Mac (settings and notes stay)
cd "$(dirname "$0")" && ./update.sh "$@"
echo; read -n 1 -s -r -p "Press any key to close..."
