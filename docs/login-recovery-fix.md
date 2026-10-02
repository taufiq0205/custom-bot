# Repeated registration and login recovery

Validated 2026-10-03 MYT against local Docker, PostgreSQL and captured SMTP, plus actual Chromium journeys. Runtime/dependency versions match [slice 1 validation](validation-13.md).

## Cause and fix

Better Auth intentionally returns a generic successful signup response for an existing email and retains its original password. The old UI implied every signup created a new account. A controlled public-API reproduction registered password A, repeated signup with B, verified the latest emailed code, observed `Invalid email or password` with B, and successfully signed in with A.

Signup guidance now explains that existing accounts retain their original password. Failed-login guidance offers Recover access. Recovery uses the latest `forget-password` code and a new password; it does not use the earlier verification code. Authentication and its enumeration protection remain maintained-library behavior.

## Verification

`node --test tests/duplicate-signup.test.mjs` passed with the final assertion: the actual failed-login recovery message appears, the original password still works, and browser recovery permits sign-in with the new password. The regression first failed on the old signup guidance. An early harness incorrectly retained a superseded verification code; reading the latest code after repeated registration fixed it. Review also tightened a wait to the unique failed-login message so stale signup text cannot satisfy it.

The final complete suite ran in isolated project `custom-bot-login-regression` with app port 3101 and mail port 8026, preserving the user's running app on 3100/8025. Create a temporary ports override:

```yaml
services:
  app:
    ports: !override [127.0.0.1:3101:3000]
  mail:
    ports: !override [127.0.0.1:8026:8025]
```

Save it as `/tmp/custom-bot-login-test-ports.yaml`, then reproduce:

```sh
npm run typecheck
APP_URL=http://localhost:3101 docker compose -p custom-bot-login-regression -f compose.yaml -f compose.test.yaml -f /tmp/custom-bot-login-test-ports.yaml up --build -d --wait
APP_URL=http://localhost:3101 MAIL_URL=http://localhost:8026 COMPOSE_PROJECT_NAME=custom-bot-login-regression npm test
```

Final result: **5 scenario groups passed, 0 failed/cancelled/skipped; 117.196 seconds**. Typecheck passed. The earlier full-suite run passed 4/5 because its loaded regression still held the superseded verification code; the corrected final run passed all groups.

## Standards

No remaining findings; no credential disclosure, account-enumeration check or authentication bypass added.

## Spec

No remaining findings after making the failed-login assertion wait for unique response text.

Review totals: Standards 0 remaining; Spec 0 remaining.

## Final result excerpt

```text
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 117196.014625
```
