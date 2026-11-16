# unity-build-server

Build Android cho các game Unity trên GitHub Actions (miễn phí), không gắn với repo game nào.
Repo game **không cần sửa gì**: workflow tự kéo code game về, chép script build chung vào rồi build.

## Cài một lần

Vào **Settings → Secrets and variables → Actions → New repository secret** của repo này và thêm:

| Secret | Giá trị |
|---|---|
| `UNITY_LICENSE` | Nội dung file `C:\ProgramData\Unity\Unity_lic.ulf` (xem bên dưới) |
| `UNITY_EMAIL` | Email tài khoản Unity |
| `UNITY_PASSWORD` | Mật khẩu tài khoản Unity |
| `GH_PAT` | GitHub **classic** token, quyền `repo`, để đọc các repo game |
| `TELEGRAM_BOT_TOKEN` | (tuỳ chọn) token bot từ @BotFather |

Chỉ cần cho build **release** của từng game (thay `<GAME>` bằng tên game viết hoa, vd `MUKBANG`):
`KEYSTORE_PASS_<GAME>`, `KEYALIAS_NAME_<GAME>`, `KEYALIAS_PASS_<GAME>`.

### Lấy file license Unity Personal
1. Unity Hub → Preferences → Licenses → **Add** → **Get a free personal license**.
2. Kiểm tra file `C:\ProgramData\Unity\Unity_lic.ulf` (thư mục ẩn). Mở bằng Notepad, copy toàn bộ vào secret `UNITY_LICENSE`.
3. Nếu không thấy file: hỏi lại, có cách khác.

### Tạo `GH_PAT`
GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate, tick `repo`.
Dùng classic vì repo game thuộc nhiều tài khoản khác nhau, fine-grained token không đọc được.

## Build
Tab **Actions → Build Android → Run workflow**, điền:
- `game`: tên ngắn, vd `mukbang`
- `repo`: `thanhndsomia/Somia---Mukbang_ASMR`
- `branch`, `build_type` (debug/release), `export` (apk/aab)

File build nằm ở mục **Artifacts** cuối trang run (giữ 3 ngày).

## Script build chung (`unity/CIBuild.cs`)
- Tự build Addressables nếu project có dùng
- `debug`: Development build, ký bằng key debug (không cần mật khẩu keystore)
- `release`: ký bằng keystore có sẵn trong project, mật khẩu lấy từ secrets
- Giữ nguyên scripting backend, version, scene list của project
