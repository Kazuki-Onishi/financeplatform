import json
from pathlib import Path
from firebase_admin import auth, credentials, initialize_app
import sys

if len(sys.argv) != 2:
    print("Usage: python scripts/check-custom-claims.py <uid>")
    sys.exit(1)

uid = sys.argv[1]
key_path = Path("c:/Users/onish/Downloads/finance-platform-362a5-c7cfbacbfa0a.json")
if not key_path.exists():
    print(f"Service account key not found: {key_path}")
    sys.exit(1)

service_account = json.loads(key_path.read_text(encoding="utf-8"))
cred = credentials.Certificate(service_account)
initialize_app(cred)

try:
    user = auth.get_user(uid)
    print("Custom claims:", json.dumps(user.custom_claims or {}, indent=2, ensure_ascii=False))
except Exception as err:
    print("Failed to fetch user:", err)
    sys.exit(1)
