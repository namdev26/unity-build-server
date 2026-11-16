# unity-build-server

Build Android cho các game Unity trên GitHub Actions (miễn phí), không gắn với repo game nào.
Repo game **không cần sửa gì**: workflow tự kéo code game về, chép script build chung vào rồi build.

## Cài một lần

Vào **Settings → Secrets and variables → Actions → New repository secret** của repo này và thêm:

| Secret | Giá trị |
|---|---|
| `UNITY_EMAIL` | Email tài khoản Unity |
| `UNITY_PASSWORD` | Mật khẩu tài khoản Unity |
| `GH_PAT` | GitHub **classic** token, quyền `repo`, để đọc các repo game |
| `TELEGRAM_BOT_TOKEN` | (tuỳ chọn) token bot từ @BotFather |

Chỉ cần cho build **release** của từng game (thay `<GAME>` bằng tên game viết hoa, vd `MUKBANG`):
`KEYSTORE_PASS_<GAME>`, `KEYALIAS_NAME_<GAME>`, `KEYALIAS_PASS_<GAME>`.

### License Unity
Không cần file `.ulf` (Unity 6 không còn dùng được cho CI). Mỗi lần build, máy build đăng nhập bằng
`UNITY_EMAIL` + `UNITY_PASSWORD` để mượn một suất license Personal, build xong thì trả lại.
- Tài khoản phải **tắt xác minh 2 bước**, vì máy build không nhập mã được. Nên dùng một tài khoản Unity riêng cho build.
- Tài khoản đăng nhập bằng Google thì phải đặt mật khẩu tại https://login.unity.com.
- Các build chạy lần lượt từng cái để không chiếm nhiều suất cùng lúc.

### Tạo `GH_PAT`
GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate, tick `repo`.
Dùng classic vì repo game thuộc nhiều tài khoản khác nhau, fine-grained token không đọc được.

## Bot Telegram (`bot/worker.js`)
Chạy miễn phí trên Cloudflare Workers, không cần cài gì trên máy.

1. Telegram: nhắn **@BotFather** → `/newbot` → lấy token. Thêm token này vào secret `TELEGRAM_BOT_TOKEN` của repo này.
2. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
   chỉ chọn repo `unity-build-server`, quyền **Actions: Read and write**. Đây là `GH_TOKEN` cho bot.
3. [dash.cloudflare.com](https://dash.cloudflare.com) (tài khoản miễn phí):
   - **Workers & Pages → Create → Start with Hello World** → đặt tên, vd `unity-build-bot` → Deploy
   - **Edit code** → xoá hết, dán nội dung `bot/worker.js` → Deploy
   - **Storage & Databases → KV → Create** một namespace, vd `unity-build-bot`
   - Quay lại Worker → **Settings → Bindings → Add → KV namespace**: tên biến `DB`, chọn namespace vừa tạo
   - **Settings → Variables and Secrets → Add**:
     - `TELEGRAM_BOT_TOKEN` (Secret): token bot
     - `GH_TOKEN` (Secret): token ở bước 2
     - `GH_REPO` (Text): `namdev26/unity-build-server`
     - `WEBHOOK_SECRET` (Secret): chuỗi ngẫu nhiên bất kỳ (chữ, số, `_`, `-`)
4. Mở `https://unity-build-bot.<tài-khoản>.workers.dev/setup` một lần.
5. Telegram: gửi `/start` cho bot. **Người gửi đầu tiên thành chủ bot.**

Dùng:
```
/addgame onepunch thanhndsomia/Somia---Ragdoll_One_Punch main
/build              (chọn bằng nút)
/build onepunch Nam-Dev debug
/status
/allow <chat_id>    (cho người/nhóm khác dùng, họ lấy id bằng /myid)
```

## Build bằng tay (không qua bot)
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
