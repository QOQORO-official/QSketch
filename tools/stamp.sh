#!/usr/bin/env bash
# Stamp a build version into an assembled site directory:
#   tools/stamp.sh <site-dir> <version>
#
# GitHub Pages caches every file for 10 minutes, each independently, so right
# after a deploy a browser can hold a new index.html with an old app.js (or
# the reverse). Versioned asset URLs keep a page's files matched; the
# version meta tag + APP_VERSION let app.js detect and repair a mismatch; and
# version.json lets an open page notice that a newer build has been deployed.
set -euo pipefail
SITE="$1"
VER="$2"
[[ "$VER" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad version: $VER" >&2; exit 1; }

sed -i \
  -e "s|<meta name=\"qsketch-version\" content=\"dev\" />|<meta name=\"qsketch-version\" content=\"$VER\" />|" \
  -e "s|href=\"styles.css\"|href=\"styles.css?v=$VER\"|" \
  -e "s|src=\"app.js\"|src=\"app.js?v=$VER\"|" \
  "$SITE/index.html"
sed -i "s|^const APP_VERSION = 'dev';|const APP_VERSION = '$VER';|" "$SITE/app.js"
printf '{"version":"%s"}\n' "$VER" > "$SITE/version.json"

# Fail the deploy rather than ship a half-stamped site.
grep -q "content=\"$VER\"" "$SITE/index.html"
grep -q "styles.css?v=$VER" "$SITE/index.html"
grep -q "app.js?v=$VER" "$SITE/index.html"
grep -q "^const APP_VERSION = '$VER';" "$SITE/app.js"
echo ">> stamped $SITE as version $VER"
