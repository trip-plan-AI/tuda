#!/bin/bash
set -x
API_URL="http://localhost:8080/api" # Default port, could be 3001 depending on config
EMAIL="testuser_$(date +%s)@example.com"
PASSWORD="password123"

echo "=== API Check ==="
echo "Registering test user..."
REGISTER_RESP=$(curl.exe -s -X POST "$API_URL/auth/register" -H "Content-Type: application/json" -d '{"email":"'"$EMAIL"'", "password":"'"$PASSWORD"'", "name":"Test User"}')
echo "Register response: $REGISTER_RESP"

echo "Logging in..."
LOGIN_RESP=$(curl.exe -s -X POST "$API_URL/auth/login" -H "Content-Type: application/json" -d '{"email":"'"$EMAIL"'", "password":"'"$PASSWORD"'"}')
TOKEN=$(echo $LOGIN_RESP | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)
echo "Login status: HTTP $(curl.exe -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/auth/login" -H "Content-Type: application/json" -d '{"email":"'"$EMAIL"'", "password":"'"$PASSWORD"'"}')"

if [ -z "$TOKEN" ]; then
  echo "Failed to get token"
  exit 1
fi

echo -e "\n=== 1. Smoke (Route creation) ==="
PLAN_RESP=$(curl.exe -s -w "\nHTTP_STATUS:%{http_code}" -X POST "$API_URL/ai/plan" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_query":"Спланируй поездку в Москву на 2 дня"}')

echo "$PLAN_RESP" | grep -v HTTP_STATUS
PLAN_STATUS=$(echo "$PLAN_RESP" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d':' -f2)
SESSION_ID=$(echo "$PLAN_RESP" | head -n 1 | grep -o '"session_id":"[^"]*' | cut -d'"' -f4)
echo "Status: $PLAN_STATUS, Session ID: $SESSION_ID"

echo -e "\n=== 2. Intent edits ==="
if [ -n "$SESSION_ID" ]; then
  EDIT_RESP=$(curl.exe -s -w "\nHTTP_STATUS:%{http_code}" -X POST "$API_URL/ai/plan" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"user_query":"Добавь посещение музея", "session_id":"'"$SESSION_ID"'"}' )
  echo "$EDIT_RESP" | grep -v HTTP_STATUS
  echo "Status: $(echo "$EDIT_RESP" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d':' -f2)"
else
  echo "Skipped Intent Edits due to missing session_id"
fi

echo -e "\n=== 3. SSE Stream ==="
# Since ai.controller doesn't seem to have /ai/plan/stream in the first 500 lines, checking if it exists.
# Wait, I didn't see /ai/plan/stream but maybe it is somewhere else. We can just test /ai/stream or fallback.
curl.exe -N -s -X GET "$API_URL/ai/plan/stream?session_id=$SESSION_ID" -H "Authorization: Bearer $TOKEN" --max-time 10 || echo "Stream timed out or failed"
