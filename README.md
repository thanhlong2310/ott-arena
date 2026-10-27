# 🏆 OTTV2 TACTICS - Đấu Trường Bot Cờ 9x9 (OTT Arena)

OTTV2 TACTICS là một nền tảng thi đấu lập trình (Programming Arena) thời gian thực. Thí sinh sẽ đóng vai trò là các "Huấn luyện viên", viết mã nguồn (Bot) bằng **JavaScript, Python hoặc C++** để điều khiển các quân cờ Búa - Kéo - Bao trên bàn cờ 9x9 đối đầu với các thuật toán của người chơi khác.

Hệ thống được thiết kế tối ưu cho cả hai hình thức: **Thi đấu Online** và **Tổ chức giải đấu LAN (Offline)** với các cơ chế chống gian lận (Anti-Cheat) mạnh mẽ.

---

## ✨ Tính Năng Nổi Bật

*   **Đa ngôn ngữ:** Hỗ trợ bot viết bằng JavaScript, Python 3 và C++.
*   **Anti-Cheat & Bảo Mật:**
    *   **Sandboxing:** Sử dụng `bwrap` (Bubblewrap) trên Linux để cô lập tiến trình và ngắt mạng (unshare-net) của bot Python/C++.
    *   **IP Binding & Fingerprinting:** Chống Session Hijacking, phát hiện ăn cắp cookie qua Subnet và User-Agent.
    *   **Rate Limiting đa tầng:** Chống DDoS và spam nộp bài làm nghẽn máy chủ.
*   **Chế độ LAN (LAN-Only Mode):** Tự động chặn các IP từ bên ngoài Internet, chỉ cho phép các máy tính trong cùng mạng nội bộ truy cập (phù hợp cho các kỳ thi tập trung).
*   **Truyền phát trực tiếp (SSE):** Xem trực tiếp (Spectate) các trận đấu thời gian thực với độ trễ cực thấp qua Server-Sent Events.
*   **Hệ thống Giải Đấu & Xếp Hạng (Elo):** Quản trị viên (Admin) có thể tạo phòng giải đấu độc lập, tự động ghép cặp theo hệ số Elo.
*   **Xem lại trận đấu (Replay):** Lưu trữ lịch sử tọa độ từng nước đi để người chơi phân tích thuật toán sau trận.

---

## ⚙️ Yêu Cầu Hệ Thống

Để chạy được máy chủ OTT Arena, máy tính/VPS của bạn cần cài đặt:
*   **Node.js:** Phiên bản 18.0 trở lên.
*   **Python 3:** Để biên dịch và chạy bot Python.
*   **GCC / G++:** Để biên dịch bot C++ (chỉ cần nếu cho phép nộp code C++).
*   **Bubblewrap (`bwrap`):** (Bắt buộc trên Linux) Để tạo môi trường cô lập bảo mật mạng cho bot.
    *   *Cài đặt trên Ubuntu/Debian:* `sudo apt install bubblewrap`

---

## 🚀 Hướng Dẫn Cài Đặt & Khởi Chạy

**Bước 1: Clone dự án và cài đặt thư viện**
```bash
git clone <url-repo-cua-ban>
cd ott-arena
npm install
```

**Bước 2: Cấu hình biến môi trường (Tạo file `.env`)**
Tại thư mục gốc, tạo một tệp `.env` với các nội dung sau:
```env
PORT=3000
SESSION_SECRET=chuoi-bao-mat-cookie-cua-ban
MAX_CONCURRENT_MATCHES=3

# Bật chế độ thi đấu nội bộ LAN (Bảo mật phòng thi)
# Để 'false' nếu muốn host lên Internet cho mọi người chơi.
ENABLE_LAN_ONLY=true
```

**Bước 3: Khởi chạy máy chủ**
```bash
npm start
```
Máy chủ sẽ lắng nghe tại `http://localhost:3000` (Hoặc IP LAN của máy chủ như `http://192.168.1.17:3000`).

---

## 🛠 Hướng Dẫn Dành Cho Quản Trị Viên (Admin)

1.  Đăng ký một tài khoản mới và nhập **Mã cấp quyền Admin** (Mặc định trong mã nguồn là `2026`).
2.  Sau khi đăng nhập thành công, giao diện sẽ xuất hiện thêm bảng **"Quản Lý Giải Đấu & Cấu Hình Luật"**.
3.  Tại đây, bạn có thể:
    *   Điều chỉnh tốc độ hiển thị nước đi (ms).
    *   Bật/Tắt tính năng cứu Bot lỗi (Tự động đi random nếu code thí sinh bị lỗi).
    *   Khởi tạo phòng đấu riêng biệt (Giải đấu) và chủ động bấm nút ghép cặp theo hệ số Elo sau khi các thí sinh đã nộp bài xong.

---

## 🤖 Hướng Dẫn Viết Bot (Dành cho Thí sinh)

Mỗi đoạn code Bot cần định nghĩa một hàm chính có tên là `getMove(state)`. Hàm này sẽ nhận vào trạng thái bàn cờ hiện tại và phải trả về một nước đi hợp lệ dưới dạng `{ from: [r, c], to: [r, c] }`.

*Thời gian thực thi tối đa cho 1 lượt là 1.5s (với JS) và 2.0s (với Python/C++).*

### Cấu trúc dữ liệu `state`
```json
{
  "turn": "RED",
  "board": [
    [ null, null, {"o":"RED","t":"R"}, ... ],
    ...
  ],
  "legalMoves": [
    { "from": [0, 2], "to": [1, 2], "capture": false }
  ]
}
```
*   `o`: Chủ sở hữu (`"RED"` hoặc `"BLUE"`).
*   `t`: Loại quân (`"R"`: Búa, `"S"`: Kéo, `"P"`: Bao).

### Code Mẫu JavaScript (JS)
```javascript
function getMove(state) {
  const moves = state.legalMoves || [];
  if (moves.length === 0) return null;

  // Chiến thuật cơ bản: Ưu tiên nước đi ăn được quân đối phương
  const captures = moves.filter(m => m.capture === true);
  if (captures.length > 0) {
    return captures[Math.floor(Math.random() * captures.length)];
  }

  // Nếu không ăn được quân, đi ngẫu nhiên
  return moves[Math.floor(Math.random() * moves.length)];
}
```

### Code Mẫu Python
```python
import random

def getMove(state):
    moves = state.get('legalMoves', [])
    if not moves:
        return None

    # Tìm nước đi ăn quân
    captures = [m for m in moves if m.get('capture') == True]
    if captures:
        return random.choice(captures)

    return random.choice(moves)
```

---

## 🔒 Cơ Chế Vận Hành LAN & Thi Đấu Trực Tiếp

Nếu bạn sử dụng hệ thống này cho mục đích tổ chức giải đấu nội bộ (Offline tại hội trường, lớp học):
1. Đảm bảo biến `ENABLE_LAN_ONLY=true` trong file `.env`.
2. Sử dụng 1 Router Wi-Fi riêng biệt, **không cắm dây Internet (WAN)** để ngăn thí sinh sử dụng mạng bên ngoài/ChatGPT.
3. Đọc kỹ mục **Hướng dẫn LAN** trực tiếp trên thanh điều hướng (Taskbar) của giao diện web bằng tài khoản Admin để xem hướng dẫn mở cổng Tường lửa (Firewall) và chuyển tiếp WSL.

---
*Phát triển bởi đội ngũ quản trị OTT Arena.*
