# 🤖 MC Bedrock Pay Bot

Bot Discord điều khiển một **tài khoản Minecraft Bedrock / MCPE** giữ phiên online **24/7** trên server của bạn. Khi có người gõ lệnh `/pay` trên Discord, bot sẽ **tự thực hiện lệnh `/pay` trong game**, **chụp màn hình kết quả** rồi gửi ảnh về **webhook admin**.

**Phiên bản 2.0 — thêm hệ thống SHOP & PANEL** (lấy cơ chế từ dự án auto-buy, chạy trên tài khoản Bedrock — **không dùng mineflayer/acc Java**):
Panel bán tiền trên Discord, thanh toán QR ngân hàng tự động, thẻ cào, số dư cá nhân, webhook Casso, web panel quản trị realtime và chu kỳ AFK.

> ⚠️ **Cảnh báo:** Việc điều khiển tài khoản tự động có thể vi phạm quy định (rules) của một số server. Hãy chỉ dùng trên server của bạn hoặc server cho phép bot/automation.

---

## ✨ Tính năng

| Tính năng | Chi tiết |
|---|---|
| 💸 `/pay <ign> <amount>` | Gửi tiền trong game. IGN **chấp nhận mọi ký tự** (kể cả tiền tố đặc biệt như `.steve`, `~Steve#123`). |
| 💰 `/balance [ign]` | Xem số dư trong game — bỏ trống = số dư của bot, điền `ign` = số dư người chơi bất kỳ. Hiện **phản hồi của server ngay trong embed** + ảnh chụp. Tên lệnh trong game đổi được qua `BALANCE_COMMAND` (hỗ trợ `/money`, `/mymoney`,...). |
| 💬 Chat ra console | In **TOÀN BỘ chat của server** (tin nhắn, vào/ra, hệ thống) ra cửa sổ cmd/console theo thời gian thực — bật/tắt qua `CHAT_CONSOLE`. |
| 🔢 Parser số tiền | `5m` → `5,000,000` • `1.5b` → `1,500,000,000` • `2k` • `1t` • `1,000,000` — tính bằng **BigInt**, không sai số với số lớn (giới hạn 64-bit của Bedrock). |
| 🖥️ Online 24/7 | Giữ phiên Bedrock liên tục, tự **kết nối lại** khi mất mạng/bị kick (backoff 3s → 60s). |
| 📦 Tự dò phiên bản | Ping RakNet tự nhận phiên bản server (hỗ trợ Bedrock **1.16.201 → 1.26.60**). Có thể ghim cứng qua `MC_VERSION`. |
| 🔐 2 chế độ đăng nhập | `AUTH_MODE=offline` (tên người chơi) hoặc `online` (tài khoản Microsoft thật bằng **device code**, token tự cache). |
| 📸 Ảnh chụp kiểu F2 | Render **góc nhìn thứ nhất từ mắt bot** (raycast 3D DDA, FOV 70° như Minecraft) với trời, mây vuông, sương mù, tô sáng từng mặt block + **HUD đầy đủ** (tim, đói, thanh XP, hotbar, tâm ngắm, khung chat bóng chữ) — giống ảnh bấm **F2 trong Minecraft PC**. Nếu chưa đủ dữ liệu chunk thì **tự fallback** sang ảnh khung chat. |
| 🪝 Webhook admin | Ảnh chụp + thông báo vào/kick/mất kết nối/đăng nhập Microsoft gửi thẳng tới webhook admin. |
| 🖥️ `/setipserver` | Admin đổi máy chủ bot đang online **trực tiếp từ Discord** — bot ping thử, báo phiên bản + số người chơi, lưu cấu hình vĩnh viễn. |

### 🛒 Shop & Panel (mới — v2.0)

| Tính năng | Chi tiết |
|---|---|
| 💵 `/panel` | Đăng **bảng bán tiền in-game** kèm nút **💸 Mua Tiền** — bot nhớ vị trí tin nhắn và **tự cập nhật giá/kho/trạng thái** mỗi 2 phút. |
| 🧾 Mua qua QR | Bấm Mua Tiền → modal (số tiền, phương thức, IGN) → sinh **mã QR VietQR** + mã đơn `DHxxxxxx` + nội dung CK bắt buộc. Khách chuyển khoản → **webhook Casso** đối soát → bot **tự `/pay` trong game** → DM người mua + log admin + lời cảm ơn. |
| 💳 `/gachthe` | Nạp **thẻ cào tự động** (API đối tác dạng trumthengon) vào **số dư cá nhân**. Trạng thái pending/thành công/sai mệnh giá/callback đều xử lý. |
| 🏦 `/sodu` | Xem số dư cá nhân + quy đổi sang tiền game. |
| ⚡ Mua bằng số dư | Chọn phương thức `card/thẻ cào` khi mua → trừ số dư và **bot `/pay` NGAY**. `/pay` lỗi thì **tự hoàn tiền**. Chống double-spend bằng lock theo user. |
| 🌐 Web Panel | Giao diện quản trị **http://localhost:3000** (Express + Socket.io): tổng quan trạng thái, sửa giá/kho, **đổi server Bedrock**, kết nối lại, tắt/bật bot mua, **console live toàn bộ log + chat in-game**, gửi lệnh vào game, bảng đơn hàng, quản lý số dư. Có khóa bằng `PANEL_PASSWORD`. |
| 🔁 Chống lỗi | Đơn đã nhận tiền nhưng bot offline/server lag → **hàng chờ tự `/pay` lại** (2–30 phút/lần, tối đa 5 lần rồi báo admin). Giao dịch ngân hàng **chống xử lý trùng tuyệt đối**. Kho trừ bằng BigInt không âm. |
| 💤 Chu kỳ AFK | `AFK_CYCLE=true`: treo online 12h → tự out server nghỉ 1h → tự vào lại. Trong giờ nghỉ, nút Mua bị khóa. |
| ⌨️ Lệnh console CMD | `/stock 500m` `/stock +50m` • `/botoff` `/onbot` • `/panel` • `/afk rest|resume` • `/pay <ign> <số>` • `/balance` • `/naptien <userId> <50k>` • gõ tin nhắn/lệnh thường → gửi thẳng vào game. |
| 📣 Kênh cảm ơn | Sau đơn hàng thành công, bot gửi lời cảm ơn vào `FEEDBACK_CHANNEL_ID` (IGN được ẩn danh: `kurimeee → ku***e`). |
| 🤖 Bot tự đăng Panel | Đặt `SHOP_PANEL_CHANNEL_ID` để bot tự đăng bảng bán tiền khi khởi động (nếu chưa từng dùng `/panel`). |

---

## 📦 Danh sách package cần cài

`npm install` sẽ tự cài hết (tất cả đều có prebuilt binary, **không cần Visual Studio / build-tools**):

| Package | Vai trò |
|---|---|
| `discord.js` ^14.28 | Kết nối Discord, slash command, embed, webhook |
| `bedrock-protocol` ^3.61.0 | Client Minecraft Bedrock (MCPE) — đăng nhập, mã hoá, gửi/nhận packet |
| `@napi-rs/canvas` | Vẽ ảnh chụp màn hình (HUD, khung chat, thế giới voxel) — không cần thư viện hệ thống |
| `prismarine-nbt` | Đọc bảng màu NBT trong dữ liệu chunk Bedrock (cho chế độ 3D) |
| `dotenv` | Đọc cấu hình từ file `.env` |
| `express` + `socket.io` | **Web panel quản trị** realtime + nhận webhook ngân hàng/thẻ cào (v2.0) |

Yêu cầu hệ thống: **Node.js ≥ 24.17** (discord.js 14.28 yêu cầu) — tải tại [nodejs.org](https://nodejs.org).

---

## 🚀 Hướng dẫn cài đặt từng bước

### Bước 1 — Tạo Discord bot

1. Vào [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → đặt tên (vd: `MC Pay Bot`).
2. Mục **Bot** → **Reset Token** → copy token.
3. Mục **OAuth2 → URL Generator**: tích `bot` + `applications.commands`, scopes; quyền `Send Messages`, `Embed Links`, `Attach Files`. Mở URL sinh ra để mời bot vào server Discord của bạn.

### Bước 2 — Tạo webhook admin

1. Trong server Discord, chuột phải kênh nhận ảnh (vd `#pay-logs`) → **Edit Channel → Integrations → Webhooks → New Webhook**.
2. **Copy Webhook URL** — dạng `https://discord.com/api/webhooks/.../...`.

### Bước 3 — Cài project

```bash
# Giải nén file zip (nếu tải về dạng zip)
cd mc-bedrock-pay-bot

# Cài dependencies
npm install

# Tạo file cấu hình từ mẫu
#   Windows (PowerShell):  copy .env.example .env
#   Linux/macOS:           cp .env.example .env
```

Mở `.env` và điền:

```ini
DISCORD_TOKEN=token_bot_ở_bước_1
ADMIN_WEBHOOK_URL=webhook_ở_bước_2

MC_HOST=ip-hoặc-domain-server-bedrock
MC_PORT=19132
MC_USERNAME=PayBot
AUTH_MODE=offline        # hoặc "online" nếu server cần tài khoản Microsoft
```

**Các biến tuỳ chọn khác:**

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `REGISTER_GUILD_ID` | *(rỗng)* | ID server Discord để slash command hiện **ngay**; bỏ trống = đăng ký global (chờ tới 1 giờ) |
| `ADMIN_DISCORD_IDS` | *(rỗng)* | Danh sách ID được dùng `/setipserver` (phân cách bằng `,`); bỏ trống = ai có quyền Administrator cũng được |
| `MC_VERSION` | *(rỗng)* | Ghim phiên bản Bedrock, vd `1.21.50`; bỏ trống = tự dò |
| `MC_RAKNET_BACKEND` | *(rỗng)* | `jsp-raknet` nếu máy không chạy được raknet-native |
| `PAY_CAPTURE_MS` | `3500` | Thời gian (ms) chờ phản hồi lệnh trong game (/pay, /balance) trước khi chụp |
| `BALANCE_COMMAND` | `balance` | Tên lệnh kinh tế trong game mà `/balance` trên Discord sẽ gọi — đổi thành `money` hoặc `mymoney` nếu server dùng plugin khác |
| `CHAT_CONSOLE` | `true` | `false` = không in chat server ra console |
| `SCREENSHOT_WATERMARK` | `false` | `true` = in tên server/phiên bản/thời điểm lên ảnh (mặc định tắt để ảnh giống F2 100%) |
| `VIEW_YAW` / `VIEW_PITCH` | `0` / `-12` | Hướng nhìn của bot khi render ảnh 3D (độ) — chỉnh nếu ảnh bị chằm vào tường/đồi |
| `RENDER_3D` | `true` | `false` = luôn dùng ảnh khung chat |

### Bước 4 — Chạy bot

```bash
npm start        # hoặc: node index.js
```

Bot sẽ: đăng nhập Discord → đăng ký lệnh `/pay`, `/balance` và `/setipserver` → ping server Bedrock (in ra phiên bản) → vào server và giữ online 24/7. Ảnh chụp mẫu có sẵn trong `samples/` nếu bạn muốn xem trước giao diện.

### Bước 5 — Sử dụng

```
/pay .steve 5m          →  gửi 5,000,000 tới ".steve"
/pay .steve 1.5b        →  gửi 1,500,000,000 tới ".steve"
/pay ~Steve#123 2k      →  gửi 2,000 tới "~Steve#123"

/balance                →  xem số dư của chính tài khoản bot
/balance .steve         →  xem số dư của người chơi ".steve"

/setipserver play.example.net           →  đổi server (port mặc định 19132)
/setipserver 123.45.67.89 port:19133    →  đổi cả IP lẫn port
```

Sau mỗi lệnh `/pay` và `/balance`: kênh Discord nhận **embed kết quả + ảnh chụp**, webhook admin nhận **ảnh + caption đầy đủ** (ai gửi, liên quan ai, server nào).

---

## 🛒 Hướng dẫn Shop & Panel (v2.0)

Toàn bộ shop chỉ hoạt động khi `SHOP_ENABLED=true` (mặc định). Đặt `SHOP_ENABLED=false` → bot trở về **đúng bản gốc** (chỉ /pay, /balance, /setipserver).

### 1. Đăng bảng bán tiền (Panel Discord)

- Cách 1: gõ `/panel` trên Discord (cần quyền Administrator) → bot đăng bảng + nút **💸 Mua Tiền** và **tự cập nhật** bảng đó mỗi 2 phút.
- Cách 2: đặt `SHOP_PANEL_CHANNEL_ID` trong `.env` → bot tự đăng khi khởi động.
- Đổi giá/kho bất cứ lúc nào: lệnh `/stock 500m` trong console, sửa ở Web Panel, hoặc sửa trực tiếp `data/shop.json`.

### 2. Nhận tiền chuyển khoản (QR VietQR + Casso)

1. Điền `BANK_BIN`, `BANK_ACCOUNT_NUMBER`, `BANK_ACCOUNT_NAME` trong `.env`
   (BIN ví dụ: Vietcombank `970436`, MB `970422`, Techcombank `970407`).
2. Đăng ký [Casso](https://portal.casso.vn) với tài khoản ngân hàng đó, lấy **API key** điền vào `BANK_API_KEY`.
3. Trong Casso cấu hình **Webhook** trỏ tới:

```
http://IP_MAY_CHAY_BOT:3000/api/webhook/bank?secret=CHUỖI_BI_MẬT
```

(`CHUỖI_BI_MẬT` = giá trị `BANK_WEBHOOK_SECRET` trong `.env` — bắt buộc để không ai giả mạo webhook)

Quy trình tự động: khách bấm Mua Tiền → nhận QR + nội dung CK `muamon DHxxxxxx <ign>` → khách chuyển khoản → Casso đẩy giao dịch về → bot đối soát theo **mã đơn** trong nội dung → tự `/pay` trong game → DM khách + log admin + cảm ơn.

> Bot cũng **tự nhận diện** giao dịch kiểu `muamon <ign> <số tiền>` ngay cả khi khách không tạo đơn trước (vẫn kiểm tra số tiền theo tỷ giá).

### 3. Thẻ cào (tùy chọn)

Điền `CARD_DOMAIN`, `CARD_PARTNER_ID`, `CARD_PARTNER_KEY` (dịch vụ dạng trumthengon/thesieure). Thành viên dùng `/gachthe telco amount code serial` — thẻ 99 (pending) sẽ được cộng số dư tự động qua callback `POST /charge/callback`.

### 4. Web Panel quản trị — Nova Panel v3

Mở `http://localhost:3000` (đổi qua `WEB_PORT`). Panel v3 là giao diện **mới hoàn toàn** phong cách *superconscious* (nền đen + neon cyan, thẻ kính mờ, glow) viết lại từ đầu bằng HTML/CSS/JS thuần — **không cần build, không thêm package nào**, vẫn chạy trên cùng server Express + Socket.io cũ.

| Mục | Chức năng |
|---|---|
| **Tổng quan** | Trạng thái bot/Discord/shop (pill realtime), kho, giá, đơn chờ + uptime, **biểu đồ doanh thu 14 ngày**, console nhanh, nút Kết nối lại / Tắt / Bật bot, bảng đơn gần nhất |
| **Thống kê** ★mới | Doanh thu 14 ngày (biểu đồ vùng có tooltip), đơn theo trạng thái (vành khuyên), phương thức thanh toán (thanh ngang), **top khách hàng** — dữ liệu từ `/api/stats` |
| **Cấu hình** | Sửa giá + kho (tự cập nhật Panel Discord, chip nhập nhanh 1m/10m/1b/+50m/-20m), **đổi server Bedrock** (ping trước khi vào), điều khiển botoff/onbot |
| **Đơn hàng** | 50 đơn gần nhất + **tìm kiếm, lọc trạng thái, sắp xếp, phân trang, xuất CSV** ★mới |
| **Số dư** | Số dư thành viên (+ tổng hợp, tìm kiếm ★mới) + cộng/trừ thủ công + lịch sử biến động |
| **Console** | **Live console toàn bộ log của bot** + chat in-game (lọc "chỉ chat", tự cuộn, đếm dòng), ô nhập gửi lệnh/chat vào game (có **lịch sử lệnh ↑/↓** ★mới) |
| **Cài đặt** ★mới | Đổi ngôn ngữ **VI/EN** tức thì, bật/tắt hiệu ứng glow, quản lý khóa panel, thông tin hệ thống |

Tính năng mới khác: **⌘K / Ctrl+K command palette** (đi trang nhanh, reconnect, botoff/onbot, xuất CSV, đổi ngôn ngữ…), toast thông báo, giao diện responsive (sidebar thành drawer trên điện thoại), chế độ **xem trước không cần bot**: `npm run preview` → `http://localhost:3100` (dữ liệu mẫu; thêm `PANEL_PASSWORD=xxx npm run preview` để thử màn hình khóa). Panel cũ vẫn còn nguyên tại `/legacy/index.html` nếu bạn muốn quay lại giao diện cũ.

Mở ra từ xa: đặt `PANEL_PASSWORD` → mọi API yêu cầu khóa, panel hiện ô nhập mật khẩu khi truy cập lần đầu. **KHÔNG** mở port 3000 ra internet nếu không đặt mật khẩu.

### 5. Các biến môi trường mới

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `SHOP_ENABLED` | `true` | `false` = tắt toàn bộ shop, về bản gốc |
| `WEB_PORT` | `3000` | Cổng web panel; `0` = tắt web |
| `PANEL_PASSWORD` | *(rỗng)* | Khóa truy cập web panel |
| `PRICE_BASE_AMOUNT` / `PRICE_BASE_PRICE` | `1000000` / `10000` | Tỷ giá: 1m tiền game = 10.000đ |
| `PRICE_CURRENCY` | `VND` | Đơn vị tiền hiển thị |
| `SHOP_STOCK` | `1b` | Kho khởi tạo (hỗ trợ `1b`, `500m`, `100k`) |
| `ORDER_TIMEOUT_MINUTES` | `15` | Đơn QR tự hủy nếu không thanh toán (5–120) |
| `BANK_BIN` / `BANK_ACCOUNT_NUMBER` / `BANK_ACCOUNT_NAME` | *(rỗng)* | Tài khoản nhận chuyển khoản (VietQR) |
| `BANK_API_KEY` | *(rỗng)* | Casso API key |
| `BANK_WEBHOOK_SECRET` | *(rỗng)* | Chuỗi bí mật trên URL webhook |
| `CARD_DOMAIN` / `CARD_PARTNER_ID` / `CARD_PARTNER_KEY` | *(rỗng)* | API thẻ cào |
| `FEEDBACK_CHANNEL_ID` | *(rỗng)* | Kênh gửi lời cảm ơn sau đơn hàng |
| `SHOP_PANEL_CHANNEL_ID` | *(rỗng)* | Kênh tự đăng Panel khi khởi động |
| `AFK_CYCLE` | `false` | Bật chu kỳ online/nghỉ |
| `AFK_ONLINE_MINUTES` / `AFK_REST_MINUTES` | `720` / `60` | Thời gian treo / nghỉ (phút) |

---

## 🔐 Chế độ đăng nhập `online` (Microsoft)

Khi `AUTH_MODE=online`, lần đầu chạy bot sẽ in ra console (và gửi webhook) hướng dẫn:

1. Mở trang `https://www.microsoft.com/link`
2. Nhập mã hiện trên màn hình (vd `ABCD-EFGH`)
3. Đăng nhập tài khoản Microsoft sở hữu Minecraft Bedrock

Token được cache trong `data/profiles/` — các lần chạy sau **không cần đăng nhập lại**.

## 📸 Cơ chế chụp màn hình (kiểu F2)

| Chế độ | Khi nào dùng | Cách hoạt động |
|---|---|---|
| **Thế giới 3D góc nhìn thứ nhất** (mặc định) | Bot đã spawn và nhận đủ chunk quanh vị trí | Raycast 3D (DDA) từ mắt bot, FOV 70° — giải mã chunk Bedrock thật → dựng cảnh như bot đang nhìn thấy: trời gradient, mặt trời vuông, mây phẳng, sương mù, tô sáng mặt block đúng tỉ lệ Minecraft |
| **Khung chat** (fallback) | Chưa đủ dữ liệu chunk, hoặc `RENDER_3D=false`, hoặc render lỗi | Vẽ nền gradient tối + HUD đầy đủ; kết quả lệnh **luôn** hiển thị |

Cả hai chế độ đều phủ **HUD chuẩn Minecraft PC**: 10 tim, 10 thanh đói, thanh XP xanh lá, hotbar 9 ô (ô đang chọn viền trắng), tâm ngắm blend difference, khung chat dưới-trái với nền đen mờ từng dòng và bóng chữ — **không watermark** nào trên ảnh (đúng chuẩn ảnh F2). Muốn in tên server lên ảnh thì đặt `SCREENSHOT_WATERMARK=true`.

Nếu ảnh bị chằm vào đồi/tường (bot spawn sát địa hình), chỉnh `VIEW_YAW` (quay ngang) / `VIEW_PITCH` (nhìn lên/xuống) trong `.env`.

## ♻️ Chạy 24/7 trên VPS (pm2)

```bash
npm install -g pm2
pm2 start ecosystem.config.js     # hoặc: pm2 start index.js --name mc-bedrock-bot
pm2 save && pm2 startup           # tự khởi động cùng máy
pm2 logs mc-bedrock-bot           # xem log
```

## 🛠️ Xử lý sự cố

| Hiện tượng | Nguyên nhân & cách xử lý |
|---|---|
| `Read failure for 0x38...` khi vào server | **Sai phiên bản protocol.** Chạy `npm update bedrock-protocol --depth 9999`; nếu vẫn lỗi, đặt `MC_VERSION` đúng phiên bản server. |
| Bot bị kick ngay khi vào (`offline` mode) | Server bật Xbox-auth — chuyển `AUTH_MODE=online` hoặc tắt online-mode trên server. |
| Ảnh không gửi về webhook | Kiểm tra `ADMIN_WEBHOOK_URL`; webhook phải cùng server Discord và chưa bị xoá. |
| Slash command không hiện | Đợi (global mất tới 1 giờ) hoặc điền `REGISTER_GUILD_ID` rồi khởi động lại. |
| `discord.js requires Node.js ...` | Nâng Node.js lên ≥ 24.17. |
| Kết nối UDP bị chặn trên hosting | Nhà cung cấp phải cho phép UDP hai chiều (Bedrock dùng UDP 19132). Có thể thử `MC_RAKNET_BACKEND=jsp-raknet`. |
| Web Panel mở không được | Kiểm tra `WEB_PORT` ≠ 0 và port chưa bị chiếm; truy cập sai mật khẩu → xóa key trong localStorage hoặc nhập lại. |
| Casso không gọi webhook | URL phải là **địa chỉ công khai** của máy chạy bot (nếu bot ở nhà, cần port-forward/tunnel); kiểm tra `?secret=` đúng `BANK_WEBHOOK_SECRET`; test nhanh bằng mở URL bằng trình duyệt (phải trả JSON `{ok:true}`). |
| Khách đã chuyển khoản nhưng chưa được giao | Xem trạng thái đơn ở Web Panel → **Đơn hàng**: `WAITING_RETRY` = bot đang chờ vào server rồi tự giao; `FAILED` = cần admin giao thủ công (xem lý do trong `data/orders.json`). |
| Nút Mua hiện "Tạm Dừng Bán" | Bot chưa online (đang kết nối), đang nghỉ AFK, hoặc đã `botoff` — xem trạng thái chính xác ở Web Panel hoặc console CMD `/afk`. |

## 📁 Cấu trúc thư mục

```
mc-bedrock-pay-bot/
├── index.js                  # Khởi động: Discord + Minecraft + wiring (+ shop v2)
├── src/
│   ├── config.js             # Nạp .env + lưu data/server.json (lệnh /setipserver)
│   ├── amount.js             # Parser "5m"/"1.5b" (BigInt) + sanitize IGN
│   ├── minecraft.js          # Kết nối Bedrock 24/7, auto-version, gửi command_request
│   ├── bedrockWorld.js       # Giải mã chunk Bedrock (subchunk palettized + NBT)
│   ├── commands.js           # Slash command /pay, /balance, /setipserver + embed
│   ├── webhook.js            # Gửi ảnh/thông báo tới webhook admin
│   ├── screenshot/
│   │   ├── index.js          # Điều phối: 3D → fallback chat
│   │   ├── hud.js            # Lớp HUD chung (khung chat, hotbar, crosshair)
│   │   ├── chatRender.js     # Chế độ khung chat
│   │   └── render3d.js       # Chế độ thế giới 3D góc nhìn thứ nhất (raycast)
│   └── shop/                 # ★ v2.0 — Shop & Panel (cơ chế từ auto-buy)
│       ├── index.js          # startShop: tương tác Discord, console CMD, timer
│       ├── store.js          # Cấu hình shop (giá/kho/panel/botOff) — data/shop.json
│       ├── balances.js       # Số dư cá nhân VNĐ (lock, atomic, lịch sử)
│       ├── orders.js         # Đơn hàng DHxxxxxx + chống trùng giao dịch + retry
│       ├── payflow.js        # Thực hiện /pay + hoàn tất đơn + vòng lặp retry
│       ├── panel.js          # /panel /sodu /gachthe + nút Mua + modal + QR VietQR
│       ├── cardService.js    # API gạch thẻ cào (md5 sign)
│       ├── feedback.js       # Lời cảm ơn ẩn danh vào kênh feedback
│       ├── afk.js            # Chu kỳ AFK 12h/1h + khóa mua
│       └── format.js         # formatStock/formatNumber/parseVnd
├── web/                      # ★ v3.0 — Web Panel quản trị (Nova Panel)
│   ├── server.js             # Express + Socket.io + API (+ /api/stats mới) + khóa PANEL_PASSWORD
│   ├── routes/bank.js        # Webhook Casso (tự /pay) + callback thẻ cào
│   └── public/               # Giao diện Nova Panel v3 (index.html, style.css, app.js, i18n.js, charts.js)
│       └── legacy/           # ★ Giao diện panel cũ v2 giữ nguyên (mở tại /legacy/index.html)
├── test/
│   ├── amount.test.js        # 29 test case parser
│   ├── shop.test.js          # 25 test case shop (store/balance/order/webhook/afk)
│   ├── panel-preview.js      # ★ v3 — xem trước panel mới với dữ liệu mẫu (npm run preview)
│   └── sample-screenshot.js  # Tạo ảnh mẫu (npm run sample)
├── samples/                  # Ảnh chụp mẫu đã tạo sẵn (kiểu F2)
├── data/                     # server.json, shop.json, orders.json... (tự sinh khi chạy)
├── .env.example              # Mẫu cấu hình — copy thành .env
├── ecosystem.config.js       # ★ v2.0 — PM2 chạy 24/7
└── package.json
```

## ❓ Câu hỏi nhanh

- **IGN có dấu chấm đầu như `.steve` có hoạt động không?** — Có. Ô `ign` là chuỗi tự do, bot chỉ chặn xuống dòng/tab để chống chèn lệnh.
- **Nhiều người gõ `/pay` cùng lúc thì sao?** — Các lệnh được xếp hàng tuần tự (kể cả `/balance`) để phản hồi không lẫn vào nhau.
- **Server dùng lệnh số dư khác `/balance` (vd `/money`, `/mymoney`)?** — Đặt `BALANCE_COMMAND=money` trong `.env`, lệnh `/balance` trên Discord sẽ tự gọi đúng lệnh trong game.
- **Muốn xem chat server mà không mở VNC?** — Chat đã in sẵn ra console (cmd) theo thời gian thực; tắt bằng `CHAT_CONSOLE=false`.
- **Ảnh bị chằm vào đồi/tường?** — Chỉnh `VIEW_YAW` (quay hướng nhìn) hoặc `VIEW_PITCH` (nhìn lên/xuống) trong `.env` rồi khởi động lại bot.
- **Server chạy phiên bản cũ hơn (vd 1.21.50)?** — Bot tự dò qua ping và dùng đúng protocol; packet `command_request` cũng tự đổi định dạng theo phiên bản (1.21.130 là mốc phân cách).
- **Khách mua bằng QR thì bot biết khi nào nhận được tiền?** — Qua webhook của Casso (hoặc dịch vụ tương tự) gọi vào `/api/webhook/bank`. Không cấu hình webhook thì đơn QR sẽ không được đối soát tự động — nên dùng phương thức số dư thẻ cào thay thế.
- **Khách chuyển nhầm thiếu tiền?** — Bot bỏ qua và ghi log (không tạo đơn). Khách chuyển THỪA tiền? — Bot vẫn giao đúng đơn (kiểm tra `nhận ≥ cần`).
- **Bot tắt giữa chừng có mất đơn đã nhận tiền không?** — Không. Đơn lưu trong `data/orders.json`, khi bot vào lại server sẽ **tự `/pay` bù** (hàng chờ retry, bảo lưu tối đa 5 lần thử).
- **Tắt hoàn toàn shop về bản cũ?** — Đặt `SHOP_ENABLED=false` trong `.env` (hoặc `WEB_PORT=0` để chỉ tắt web panel).
