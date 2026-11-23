#!/usr/bin/env bash
# The signed RELEASE APK, built on the machine that holds the signing key (it never goes to CI). Bash; on Windows, Git Bash.
#   bash tools/android-release.sh
# Steps: web build into dist-android (dist/ may be a web build that is being served, and is left alone) -> copy into the Android
# project -> Gradle assembleRelease signed with the release key -> verify the signature and who it names ->
# scan the finished APK for anything that names this machine or its user -> copy to out/android/.
# Environment:
#   LUMP_KEYSTORE            keystore file, kept OUTSIDE the repository (required)
#   LUMP_KEYSTORE_PASS_FILE  file with its password   (default keystore-pass.txt next to the keystore)
#   EXPECT_SIGNER            the certificate name the finished APK must carry (required, e.g. "CN=My Wallet")
#   LUMP_VERSION_CODE        must grow with every APK handed out (default: minutes since 1970, always growing)
#   LUMP_PRIVACY_NEEDLES     more patterns (grep -E) the finished APK must not contain, e.g. local folder names
#   JAVA_HOME / ANDROID_HOME a JDK 21 and an Android SDK with build-tools (required)
set -euo pipefail
cd "$(dirname "$0")/.."

: "${LUMP_KEYSTORE:?set LUMP_KEYSTORE to the release keystore (kept outside the repository)}"
: "${EXPECT_SIGNER:?set EXPECT_SIGNER to the certificate name of the release key, e.g. CN=My Wallet}"
: "${JAVA_HOME:?set JAVA_HOME to a JDK 21}"
: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"
PASS_FILE="${LUMP_KEYSTORE_PASS_FILE:-$(dirname "$LUMP_KEYSTORE")/keystore-pass.txt}"
[ -f "$LUMP_KEYSTORE" ] || { echo "no keystore at $LUMP_KEYSTORE"; exit 1; }
[ -f "$PASS_FILE" ] || { echo "no password file at $PASS_FILE"; exit 1; }
export LUMP_KEYSTORE
LUMP_KEYSTORE_PASS="$(cat "$PASS_FILE")"; export LUMP_KEYSTORE_PASS
export LUMP_VERSION_CODE="${LUMP_VERSION_CODE:-$(( $(date +%s) / 60 ))}"
export JAVA_HOME ANDROID_HOME
VERSION="$(node -p "require('./package.json').version")"

echo "== web build"
npx tsc -b
npx vite build --outDir dist-android >/dev/null
CAP_WEB_DIR=dist-android npx cap sync android >/dev/null

echo "== gradle assembleRelease (version $VERSION, code $LUMP_VERSION_CODE)"
(cd android && ./gradlew assembleRelease --no-daemon --max-workers=3 -Dorg.gradle.priority=low --console=plain -q)
APK=android/app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || { echo "no signed APK was produced (is the keystore readable?)"; ls android/app/build/outputs/apk/release/ || true; exit 1; }

echo "== signature"
APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)apksigner"
[ -f "$APKSIGNER" ] || APKSIGNER="$APKSIGNER.bat"
CERTS="$("$APKSIGNER" verify --print-certs "$APK")"
echo "$CERTS" | grep -E "certificate DN|SHA-256 digest" | sed 's/^/   /'
echo "$CERTS" | grep -q "certificate DN: $EXPECT_SIGNER\$" || { echo "the APK is not signed as \"$EXPECT_SIGNER\""; exit 1; }

echo "== privacy scan (machine user name, home folders, local paths)"
SCAN="$(mktemp -d)"
unzip -q -o "$APK" -d "$SCAN"
NEEDLES="${USERNAME:-${USER:-nobody}}|[/\\\\]Users[/\\\\]|/home/|AppData|[A-Za-z]:[/\\\\]Program Files${LUMP_PRIVACY_NEEDLES:+|$LUMP_PRIVACY_NEEDLES}"
HITS="$(grep -r -a -l -i -E "$NEEDLES" "$SCAN" || true)"
if [ -n "$HITS" ]; then
  echo "found in:"; echo "$HITS" | sed "s#$SCAN/#   #"
  rm -rf "$SCAN"; exit 1
fi
FILES="$(find "$SCAN" -type f | wc -l)"
rm -rf "$SCAN"
echo "   clean: $FILES files inside the APK, none names this machine or its user"

mkdir -p out/android
OUT="out/android/LumpWallet-$VERSION-$LUMP_VERSION_CODE.apk"
cp "$APK" "$OUT"
echo "== done"
echo "   $OUT  ($(du -h "$OUT" | cut -f1))"
echo "   sha256 $(sha256sum "$OUT" | cut -d' ' -f1)"
