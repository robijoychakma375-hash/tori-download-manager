import sqlite3
import json
import sys
import os
import secrets
from datetime import datetime, timezone

db_path = os.path.abspath(sys.argv[1])
downloads_dir = os.path.abspath(sys.argv[2])
qa_root = os.path.dirname(os.path.dirname(db_path))

# Generate a cryptographically secure random, unpredictable test-only token
random_token = "tori_" + secrets.token_hex(16)

os.makedirs(os.path.dirname(db_path), exist_ok=True)
conn = sqlite3.connect(db_path)
c = conn.cursor()

c.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

settings = {
    "port": 19600,
    "dir": downloads_dir,
    "maxActive": 3,
    "con": 8,
    "theme": "dark"
}

c.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES ('app_settings', ?)", (json.dumps(settings),))
c.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES ('browser_integration_token', ?)", (random_token,))

conn.commit()
conn.close()

# Store session details in isolated qa_manual_env/qa_session.json (git-ignored)
session_file = os.path.join(qa_root, "qa_session.json")
session_data = {
    "port": 19600,
    "token": random_token,
    "downloadsDir": downloads_dir,
    "dataDir": os.path.dirname(db_path),
    "generatedAt": datetime.now(timezone.utc).isoformat()
}
with open(session_file, "w", encoding="utf-8") as f:
    json.dump(session_data, f, indent=2)

print(f"Successfully seeded QA database at: {db_path}")
print(f"Secure test-only token stored in: {session_file}")
