#!/bin/sh
# Builds dist/, ready to upload to public_html:
#   dist/        the team site (haaps.co.in)
#   dist/admin/  the admin site (admin.haaps.co.in or haaps.co.in/admin),
#                a copy of the same page with admin/config.js, and an API
#                entrance that reuses ../api (one database, one config.php).
# api/config.php is never included, so uploading can't overwrite it.
set -e
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist/api dist/icons dist/admin/api dist/admin/icons
for d in dist dist/admin; do
  cp index.html styles.css app.js tasks-seed.js favicon.ico .htaccess "$d/"
  cp icons/* "$d/icons/"
done
cp config.js dist/config.js
cp api/index.php api/config.sample.php dist/api/
cp admin/config.js dist/admin/config.js
cp admin/api/index.php dist/admin/api/index.php
echo "Built dist/"
