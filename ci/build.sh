#!/usr/bin/env bash
# Chạy bên trong image unityci/editor:<version>-android.
# Mượn một suất license Unity Personal bằng email + mật khẩu, build, rồi luôn trả suất lại.
# Unity 6 không còn dùng được file .ulf cho CI (license gắn với máy tạo ra nó).
set -uo pipefail

LC=/opt/unity/Editor/Data/Resources/Licensing/Client/Unity.Licensing.Client
hide() { grep -viE 'password|token' || true; }

release_seat() {
  echo "::group::Trả suất license Unity"
  "$LC" --deactivate-all --username "$UNITY_EMAIL" --password "$UNITY_PASSWORD" 2>&1 | hide | tail -5
  echo "::endgroup::"
}

if [ -z "${UNITY_EMAIL:-}" ] || [ -z "${UNITY_PASSWORD:-}" ]; then
  echo "::error title=Thiếu tài khoản Unity::Thêm secrets UNITY_EMAIL và UNITY_PASSWORD vào repo build."
  exit 1
fi

echo "::group::Mượn suất license Unity Personal"
out="$("$LC" --activate-all --include-personal --username "$UNITY_EMAIL" --password "$UNITY_PASSWORD" 2>&1)"
status=$?
echo "$out" | hide
echo "::endgroup::"

if [ $status -ne 0 ] || ! grep -q 'Activation processed successfully' <<<"$out"; then
  cause="Unity không cấp license"
  if grep -qiE 'invalid.*credential|unauthorized|401' <<<"$out"; then
    cause="Sai email/mật khẩu Unity. Tài khoản đăng nhập bằng Google phải đặt mật khẩu tại https://login.unity.com"
  elif grep -qiE 'two.factor|2FA|verification code' <<<"$out"; then
    cause="Tài khoản Unity đang bật xác minh 2 bước, máy build không trả lời được"
  elif grep -qiE 'no seat|seat.*unavailable|exhausted' <<<"$out"; then
    cause="Hết suất license. Lần build trước có thể chưa trả suất, đợi một lúc rồi build lại"
  fi
  echo "::error title=Lỗi license Unity::$cause"
  release_seat
  exit 1
fi
trap release_seat EXIT

args=(-batchmode -nographics -quit
  -projectPath "$PROJECT_DIR"
  -buildTarget Android
  -executeMethod CIBuild.BuildAndroid
  -logFile -
  -customBuildPath "$OUTPUT_PATH"
  -androidExportType "$EXPORT_TYPE"
  -ciBuildType "$BUILD_TYPE")

if [ "$BUILD_TYPE" = "release" ]; then
  [ -n "${KS_NAME:-}" ] && args+=(-androidKeystoreName "$KS_NAME")
  args+=(-androidKeystorePass "${KS_PASS:-}" -androidKeyaliasName "${KS_ALIAS:-}" -androidKeyaliasPass "${KS_ALIAS_PASS:-}")
fi

unity-editor "${args[@]}"
code=$?
echo "Unity thoát với mã $code"
exit $code
