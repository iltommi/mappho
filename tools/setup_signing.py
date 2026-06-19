#!/usr/bin/env python3
"""
Generate a Mappho signing keystore and upload all required GitHub secrets.

Usage:
    python3 tools/setup_signing.py "Tommaso Vinci" IT mypassword
"""

import base64
import subprocess
import sys
import tempfile
from pathlib import Path

KEYSTORE = Path(__file__).parent.parent / "mappho.keystore"
ALIAS    = "mappho"


def run(cmd, **kwargs):
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        sys.exit(result.returncode)
    return result


def main():
    if len(sys.argv) != 4:
        print("Usage: setup_signing.py \"Full Name\" CC password")
        print("  Full Name : your name (e.g. \"Tommaso Vinci\")")
        print("  CC        : two-letter country code (e.g. IT)")
        print("  password  : keystore/key password")
        sys.exit(1)

    name, country, password = sys.argv[1], sys.argv[2], sys.argv[3]
    dn = f"CN={name}, C={country}"

    # ── 1. Generate keystore ────────────────────────────────────────────────
    if KEYSTORE.exists():
        print(f"Keystore already exists at {KEYSTORE} — skipping keytool.")
    else:
        print(f"Generating keystore at {KEYSTORE} …")
        run([
            "keytool", "-genkeypair",
            "-keystore", str(KEYSTORE),
            "-alias",    ALIAS,
            "-keyalg",   "RSA",
            "-keysize",  "2048",
            "-validity", "10000",
            "-storepass", password,
            "-keypass",   password,
            "-dname",     dn,
        ])
        print("Keystore created.")

    # ── 2. Encode keystore ──────────────────────────────────────────────────
    keystore_b64 = base64.b64encode(KEYSTORE.read_bytes()).decode()

    # ── 3. Upload GitHub secrets ────────────────────────────────────────────
    secrets = {
        "KEYSTORE_BASE64":    keystore_b64,
        "KEYSTORE_PASSWORD":  password,
        "KEY_ALIAS":          ALIAS,
        "KEY_PASSWORD":       password,
    }

    print("Uploading secrets via gh …")
    for name_s, value in secrets.items():
        run(["gh", "secret", "set", name_s, "--body", value])
        print(f"  ✓ {name_s}")

    print("\nDone. Push to main to trigger the APK build.")


if __name__ == "__main__":
    main()
