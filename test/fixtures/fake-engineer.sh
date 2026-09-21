#!/bin/sh
# Stands in for `claude` in tests: reads the pasted prompt, then writes a report using
# the credentials it was given through its environment, without ever echoing the password.
read -r first_line
mkdir -p "$RUN_DIR/screenshots"
# a valid 1x1 PNG
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' | base64 -d > "$RUN_DIR/screenshots/01-home.png"
if [ -n "$TARGET_ADMIN_PASSWORD" ] && [ "$TARGET_ADMIN_USERNAME" = "alice" ]; then V=PASS; else V=FAIL; fi
cat > "$RUN_DIR/report.md" <<REPORT
# Fake scenario — admin — $V

## Verdict

Engineer saw base url $TARGET_BASE_URL as user $TARGET_ADMIN_USERNAME.
REPORT
sleep 60
