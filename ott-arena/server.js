const express = require("express");
const session = require("express-session");
const path = require("path");
const store = require("./store");
const { runMatch } = require("./botRunner");
const { Worker } = require("worker_threads");
const rateLimit = require("express-rate-limit");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Hàm ghi log ra tệp văn bản
function auditLog(req, action, details = "") {
  // Lấy IP và làm sạch tiền tố IPv6 nếu có
  const clientIp = req.socket.remoteAddress ? req.socket.remoteAddress.replace(/^::ffff:/, '') : 'unknown';
  // Lấy tên user nếu đã đăng nhập, ngược lại là guest
  const username = req.session && req.session.user ? req.session.user.username : 'guest';
  // Lấy thời gian chuẩn ISO
  const timestamp = new Date().toISOString();
  
  // Định dạng dòng log
  const logEntry = `[${timestamp}] IP: ${clientIp} | User: ${username} | Action: ${action} | Details: ${details}\n`;
  
  // Ghi nối tiếp vào file audit.log ở thư mục gốc của dự án
  fs.appendFile(path.join(__dirname, 'audit.log'), logEntry, (err) => {
    if (err) console.error("Lỗi ghi file log:", err);
  });
}

// Cho phép tin tưởng Reverse Proxy (Render / Cloudflare / Nginx) để nhận diện đúng IP client
app.set('trust proxy', 1);

// Middleware Giới hạn mạng truy cập (Chỉ cho phép IP LAN & Localhost khi bật ENABLE_LAN_ONLY=true)
function lanAccessFilter(req, res, next) {
  // Nếu không bật chế độ chỉ cho phép LAN, cho phép mọi IP Internet đi qua
  if (process.env.ENABLE_LAN_ONLY !== 'true') {
    return next();
  }

  let clientIp = req.socket.remoteAddress || '';
  
  // Xử lý IPv6 mapping của IPv4 (vd: ::ffff:192.168.1.10)
  if (clientIp.startsWith('::ffff:')) {
    clientIp = clientIp.replace('::ffff:', '');
  }

  // Danh sách các dải IP được cấp phép (Private IPv4 theo chuẩn RFC 1918 và Localhost)
  const isLocal = clientIp === '127.0.0.1' || clientIp === '::1';
  const isClassC = clientIp.startsWith('192.168.'); // Dải mạng gia đình/cơ quan phổ biến
  const isClassA = clientIp.startsWith('10.');      // Dải mạng doanh nghiệp/VPN
  const isClassB = clientIp.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./); // Dải 172.16.x.x -> 172.31.x.x

  if (!isLocal && !isClassC && !isClassA && !isClassB) {
    console.warn(`[SECURITY] Đã chặn truy cập từ IP ngoài LAN: ${clientIp}`);
    auditLog(req, "BLOCKED_EXT_IP", `Chặn truy cập từ ngoài LAN (IP: ${clientIp})`);
    return res.status(403).json({ 
      error: "Access Denied: Hệ thống OTT Arena hiện chỉ cho phép truy cập nội bộ (LAN)." 
    });
  }
  
  next();
}

// Áp dụng lớp rào chắn IP cho toàn bộ ứng dụng
app.use(lanAccessFilter);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: "ott-arena-secret-key-2026", // Đừng quên đưa secret này vào biến môi trường (.env) khi đưa lên server thật
  name: "ott_session", // Đổi tên cookie mặc định (connect.sid) để tránh bị nhận diện dễ dàng
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,  // Ngăn chặn mã độc JavaScript (XSS) đọc trộm cookie
    secure: process.env.NODE_ENV === 'production', // Chuyển thành true nếu chạy qua HTTPS/Nginx
    sameSite: 'lax'  // Chống tấn công lừa đảo CSRF
  },
});

app.use(sessionMiddleware);

// Hàm tiện ích cắt lấy dải Subnet của IPv4 (Lấy 3 octet đầu)
function getSubnet(ip) {
  if (!ip) return null;
  if (ip.includes(':')) return ip; // Trả về nguyên bản nếu là IPv6
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}` : ip;
}

// Hàm mã hóa nhẹ Fingerprint (Tránh lưu plain-text)
const crypto = require('crypto');
function createDeviceHash(subnet, userAgent) {
  return crypto.createHash('sha256').update(`${subnet}|${userAgent}`).digest('hex');
}

// Middleware rào chắn an ninh (Chống Session Hijacking)
app.use((req, res, next) => {
  // Chỉ kiểm tra khi người dùng đã đăng nhập (có dữ liệu user trong session)
  if (req.session && req.session.user) {
    const rawIp = req.ip || req.socket.remoteAddress;
    const currentSubnet = getSubnet(rawIp);
    const currentUserAgent = req.headers['user-agent'] || 'unknown';
    
    // Nếu bật chế độ LAN thì đối chiếu cả Subnet; nếu ở chế độ Online thì chỉ kiểm tra User-Agent
    // để tránh làm người dùng mạng di động (4G/5G) bị văng session liên tục khi đổi trạm phát sóng.
    const fingerprintBasis = (process.env.ENABLE_LAN_ONLY === 'true')
      ? `${currentSubnet}|${currentUserAgent}`
      : `${currentUserAgent}`;

    const currentDeviceHash = crypto.createHash('sha256').update(fingerprintBasis).digest('hex');

    // Nếu đây là request đầu tiên ngay sau khi login thành công
    if (!req.session.deviceHash) {
      req.session.deviceHash = currentDeviceHash;
    } 
    // Các request tiếp theo: So sánh Fingerprint
    else if (req.session.deviceHash !== currentDeviceHash) {
      auditLog(req, "SESSION_HIJACK_ATTEMPT", `Môi trường thay đổi. User-Agent bất thường.`);
      // Fingerprint không khớp -> Dấu hiệu Cookie bị đánh cắp mang sang máy khác
      req.session.destroy((err) => {
        if (err) console.error("Lỗi hủy session:", err);
      });
      
      return res.status(403).json({ 
        error: "Phiên đăng nhập không hợp lệ hoặc môi trường mạng thay đổi bất thường. Vui lòng đăng nhập lại để đảm bảo an toàn." 
      });
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));
// 1. Giới hạn chung cho toàn bộ website (Bảo vệ tài nguyên cơ bản)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // Khung thời gian: 1 phút (60,000 mili-giây)
  max: 150, // Tối đa 150 request / 1 phút / 1 IP
  message: { error: "Bạn đã vượt quá giới hạn truy cập. Vui lòng thử lại sau 1 phút." },
  standardHeaders: true, // Trả về thông tin giới hạn trong header của HTTP response
  legacyHeaders: false,
});

// 2. Giới hạn khắt khe cho Đăng nhập / Đăng ký (Chống Brute Force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // Khung thời gian: 15 phút
  max: 10, // Tối đa 10 lần thử / 15 phút / 1 IP
  message: { error: "Thao tác đăng nhập/đăng ký quá nhiều lần. Vui lòng đợi 15 phút." },
  standardHeaders: true,
  legacyHeaders: false,
});

// 3. Giới hạn nộp code Bot (Chống Spam làm nghẽn hàng đợi)
const queueLimiter = rateLimit({
  windowMs: 60 * 1000, // Khung thời gian: 1 phút
  max: 15, // Tối đa 15 lần nộp code / 1 phút / 1 IP
  message: { error: "Bạn nộp code quá nhanh. Vui lòng đợi 1 phút." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Áp dụng giới hạn chung (globalLimiter) cho TẤT CẢ các route từ dòng này trở xuống
app.use(globalLimiter);

const activeRooms = new Map();
const roomReadyCode = new Map();
const activeMatches = new Map();
const sseClients = new Set();
const onlineUsers = new Map();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
      if (typeof client.res.flush === "function") client.res.flush();
    } catch (e) {}
  }
}

function broadcastOnlineCount() {
  broadcastSSE("onlineCount", { onlinePlayers: onlineUsers.size });
}

function broadcastLiveMatches() {
  const list = Array.from(activeMatches.values()).map((m) => ({
    id: m.id,
    red: m.red,
    blue: m.blue,
    redUser: m.redUser,
    blueUser: m.blueUser,
    room: m.room,
    state: m.state,
  }));
  broadcastSSE("liveMatches", list);
}

// API VÀO PHÒNG
app.post("/api/room/join", (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Chưa đăng nhập" });
  const { room } = req.body;
  if (!room) return res.json({ playerCount: 0 });

  const roomKey = room.trim().toLowerCase();
  if (!activeRooms.has(roomKey)) {
    activeRooms.set(roomKey, new Set());
  }
  activeRooms.get(roomKey).add(req.session.user.username);

  const count = activeRooms.get(roomKey).size;
  broadcastSSE("roomUpdate", { room: roomKey, playerCount: count });

  res.json({ room: roomKey, playerCount: count });
});

// API RỜI PHÒNG
app.post("/api/room/leave", (req, res) => {
  if (!req.session.user) return res.json({ success: true });
  const { room } = req.body;
  if (room) {
    const roomKey = room.trim().toLowerCase();
    if (activeRooms.has(roomKey)) {
      activeRooms.get(roomKey).delete(req.session.user.username);
      if (activeRooms.get(roomKey).size === 0) {
        activeRooms.delete(roomKey);
      }
      const count = activeRooms.has(roomKey)
        ? activeRooms.get(roomKey).size
        : 0;
      broadcastSSE("roomUpdate", { room: roomKey, playerCount: count });
    }
    if (roomReadyCode.has(roomKey)) {
      roomReadyCode.get(roomKey).delete(req.session.user.username);
      if (roomReadyCode.get(roomKey).size === 0) roomReadyCode.delete(roomKey);
    }
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
      if (waitingQueue[i].user.username === req.session.user.username && waitingQueue[i].room === roomKey) {
        waitingQueue.splice(i, 1);
      }
    }
  }
  res.json({ success: true });
});

// API ĐĂNG KÝ (Đã tích hợp ghi log IP LAN nếu cần theo dõi)
app.post("/api/register", authLimiter, (req, res) => {
  const clientIp = req.socket.remoteAddress.replace(/^::ffff:/, '');
  const { username, password, displayName, adminCode } = req.body;
  
  try {
    const user = store.registerUser(username, password, displayName, adminCode);
    req.session.user = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role
    };
    auditLog(req, "REGISTER_SUCCESS", `Tạo tài khoản mới: ${username}`);
    res.json({ success: true, user: req.session.user });
  } catch (err) {
    auditLog(req, "REGISTER_FAILED", `Lỗi: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// API ĐĂNG NHẬP (Đã tích hợp ghi log IP LAN)
app.post("/api/login", authLimiter, (req, res) => {
  const clientIp = req.socket.remoteAddress.replace(/^::ffff:/, '');
  const { username, password } = req.body;
  
  const user = store.authenticateUser(username, password);
  if (!user) {
    auditLog(req, "LOGIN_FAILED", `Sai thông tin cho tài khoản: ${username}`);
    return res.status(400).json({ error: "Tài khoản hoặc mật khẩu không đúng" });
  }
      
  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role
  };
  
  auditLog(req, "LOGIN_SUCCESS", `Đăng nhập thành công`);
  res.json({ success: true, user: req.session.user });
});

app.get("/api/logout", (req, res) => {
  if (req.session.user) {
    onlineUsers.delete(req.session.user.username);
    broadcastOnlineCount();
  }
  req.session.destroy();
  res.json({ success: true });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  const stats = store.getPlayerStats(req.session.user.username);
  res.json({
    authenticated: true,
    name: req.session.user.displayName,
    username: req.session.user.username,
    role: req.session.user.role,
    stats,
    onlinePlayers: onlineUsers.size,
  });
});

app.get("/api/leaderboard", (req, res) => {
  const players = store.getLeaderboard();
  const currentUsername = req.session.user ? req.session.user.username : null;
  const formatted = players.map((p, idx) => ({
    rank: idx + 1,
    name: p.displayName || p.username,
    username: p.username,
    elo: p.elo,
    wins: p.wins,
    losses: p.losses,
    mine: p.username === currentUsername,
  }));
  res.json({ players: formatted, onlinePlayers: onlineUsers.size });
});

app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const matches = store.getMatchHistory(limit);
  res.json({ matches });
});

app.get("/api/history/:id", (req, res) => {
  const match = store.getMatchById(req.params.id);
  if (!match) return res.status(404).json({ error: "Không tìm thấy trận đấu" });
  if (!Array.isArray(match.moves) || !Array.isArray(match.initial)) {
    return res.status(404).json({ error: "Trận này không có dữ liệu xem lại" });
  }
  res.json(match);
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const client = { id: Date.now(), res };
  sseClients.add(client);

  const currentUser = req.session.user ? req.session.user.username : null;
  if (currentUser) {
    onlineUsers.set(currentUser, (onlineUsers.get(currentUser) || 0) + 1);
    broadcastOnlineCount();
  } else {
    broadcastOnlineCount();
  }

  broadcastLiveMatches();
  client.res.write(`event: tournamentsUpdate\ndata: ${JSON.stringify(Array.from(tournamentRooms))}\n\n`);

  req.on("close", () => {
    sseClients.delete(client);
    if (currentUser) {
      const count = (onlineUsers.get(currentUser) || 1) - 1;
      if (count <= 0) {
        onlineUsers.delete(currentUser);
      } else {
        onlineUsers.set(currentUser, count);
      }
      broadcastOnlineCount();
    }
  });
});

const waitingQueue = [];

app.post("/api/queue", queueLimiter, async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Chưa đăng nhập" });
  const { code, lang, room, fileName } = req.body;
  if (!code) return res.status(400).json({ error: "Thiếu file code" });

  const roomKey = room ? room.trim().toLowerCase() : "";

  auditLog(req, "CODE_SUBMITTED", `Nộp file: ${fileName || 'N/A'}, Ngôn ngữ: ${lang || 'javascript'}, Phòng: ${roomKey || 'Đấu ngẫu nhiên'}`);

  const entry = {
    user: req.session.user,
    code,
    lang: lang || "javascript",
    room: roomKey,
  };

  // Làm sạch entry cũ của user trong hàng đợi nếu đã từng nộp trong phòng này
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (waitingQueue[i].user.username === req.session.user.username && waitingQueue[i].room === roomKey) {
      waitingQueue.splice(i, 1);
    }
  }

  waitingQueue.push(entry);

  if (roomKey) {
    if (!roomReadyCode.has(roomKey)) roomReadyCode.set(roomKey, new Set());
    roomReadyCode.get(roomKey).add(req.session.user.username);

    const isTournament = tournamentRooms.has(roomKey);
    const submittedCount = roomReadyCode.get(roomKey).size;

    // Nếu phòng này thuộc danh sách Giải Đấu: Không tự kích hoạt đếm ngược mà chờ Admin
    if (isTournament) {
      broadcastSSE("codeSubmitted", {
        room: roomKey,
        username: req.session.user.username,
        readyCount: submittedCount,
        isTournament: true,
      });
      return res.json({
        success: true,
        waitingOpponent: true,
        isTournament: true,
        message: `Đã nộp code thành công vào phòng Giải đấu #${roomKey}! Vui lòng chờ Quản trị viên (Admin) phát lệnh ghép cặp.`,
      });
    }

    if (submittedCount === 1) {
      broadcastSSE("codeSubmitted", {
        room: roomKey,
        username: req.session.user.username,
        readyCount: 1,
      });
      return res.json({
        success: true,
        waitingOpponent: true,
        message: "Code hợp lệ! Đã nhận code của bạn, đang chờ đối thủ...",
      });
    }
  }

  res.json({
    success: true,
    waitingOpponent: false,
    message: "Code hợp lệ! Đang chuẩn bị trận đấu…",
  });
  checkAndMatch();
});

// Lưu trạng thái các phòng đang được đánh dấu là Giải đấu (Sẽ bị khóa tự động ghép cặp)
const tournamentRooms = new Set();
function broadcastTournaments() {
  broadcastSSE("tournamentsUpdate", Array.from(tournamentRooms));
}

// ----------------------------------------------------
// 1. API ADMIN: KHỞI TẠO PHÒNG GIẢI ĐẤU
// ----------------------------------------------------
app.post("/api/tournament/create", (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') 
    return res.status(403).json({error: "Chỉ Admin mới có quyền tạo giải đấu."});
  
  const roomKey = req.body.room.trim().toLowerCase();
  if (!roomKey) return res.status(400).json({error: "Vui lòng nhập tên phòng."});
  
  tournamentRooms.add(roomKey);
  broadcastTournaments();
  res.json({success: true, message: `✅ Đã tạo Giải đấu tại phòng #${roomKey}. Thí sinh nộp code sẽ vào hàng đợi (Không tự động ghép) cho đến khi bạn phát lệnh.`});
});

// ----------------------------------------------------
// 2. API ADMIN: GHÉP CẶP THEO ĐIỂM ELO
// ----------------------------------------------------
app.post("/api/tournament/match", (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') 
    return res.status(403).json({error: "Chỉ Admin mới có quyền ghép cặp."});
  
  const roomKey = req.body.room ? req.body.room.trim().toLowerCase() : "";
  if (!roomKey) return res.status(400).json({error: "Vui lòng nhập tên phòng giải đấu."});
  
  // Lọc lấy bản ghi code mới nhất của từng thí sinh duy nhất trong phòng này
  const uniqueMap = new Map();
  for (const entry of waitingQueue) {
    if (entry.room === roomKey) {
      uniqueMap.set(entry.user.username.toLowerCase(), entry);
    }
  }

  const playersInRoom = Array.from(uniqueMap.values());
  if (playersInRoom.length < 2) 
    return res.status(400).json({error: "Cần ít nhất 2 thí sinh KHÁC NHAU nộp code để bắt đầu ghép cặp."});

  // Lấy điểm Elo từ Store và Sắp xếp giảm dần (Người điểm cao đấu với điểm cao)
  playersInRoom.forEach(p => {
    p.elo = store.getPlayerStats(p.user.username).elo;
  });
  playersInRoom.sort((a, b) => b.elo - a.elo);

  let matchCount = 0;
  broadcastTournaments();

  // Ghép từng cặp 2 người từ trên xuống dưới
  while (playersInRoom.length >= 2) {
     const p1 = playersInRoom.shift(); // Top 1 hiện tại
     const p2 = playersInRoom.shift(); // Top 2 hiện tại

     if (p1.user.username === p2.user.username) continue;

     // Xóa toàn bộ lượt nộp của 2 người này khỏi hàng chờ chung
     for (let i = waitingQueue.length - 1; i >= 0; i--) {
       if (waitingQueue[i].room === roomKey && 
           (waitingQueue[i].user.username === p1.user.username || waitingQueue[i].user.username === p2.user.username)) {
         waitingQueue.splice(i, 1);
       }
     }
     if (roomKey && roomReadyCode.has(roomKey)) {
       roomReadyCode.get(roomKey).delete(p1.user.username);
       roomReadyCode.get(roomKey).delete(p2.user.username);
     }

     // Khởi động trận đấu
     startMatchCore(p1, p2, roomKey);
     matchCount++;
  }

  if (matchCount === 0) {
    return res.status(400).json({error: "Không tìm thấy 2 thí sinh hợp lệ khác nhau để ghép cặp."});
  }
  
  res.json({success: true, message: `🏆 Đã ghép thành công ${matchCount} cặp đấu dựa theo hệ số Elo!`});
});

// ----------------------------------------------------
// 2.1 API ADMIN: HỦY / XÓA PHÒNG GIẢI ĐẤU
// ----------------------------------------------------
app.post("/api/tournament/delete", (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') 
    return res.status(403).json({error: "Chỉ Admin mới có quyền xóa giải đấu."});
  
  const roomKey = req.body.room ? req.body.room.trim().toLowerCase() : "";
  if (!roomKey) return res.status(400).json({error: "Vui lòng nhập tên phòng."});
  
  tournamentRooms.delete(roomKey);
  broadcastTournaments();
  res.json({success: true, message: `✅ Đã xóa Giải đấu tại phòng #${roomKey}. Phòng này hiện có thể tự do ghép cặp.`});
});

// ----------------------------------------------------
// 2.2 API ADMIN: QUẢN LÝ CẤU HÌNH LUẬT THI ĐẤU
// ----------------------------------------------------
app.get("/api/rules", (req, res) => {
  res.json({ rules: store.getRules() });
});

app.post("/api/rules", (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: "Chỉ Admin mới có quyền thay đổi cấu hình luật thi đấu." });
  }
  const { protectBotError, enforceRPS, stepDelay } = req.body;
  const updated = store.updateRules({ protectBotError, enforceRPS, stepDelay });
  auditLog(req, "UPDATE_RULES", `Bảo vệ Bot: ${updated.protectBotError}, Luật Búa-Kéo-Bao: ${updated.enforceRPS}, Delay: ${updated.stepDelay}ms`);
  res.json({ success: true, rules: updated, message: "✅ Đã lưu cấu hình luật thi đấu thành công!" });
});

// ----------------------------------------------------
// 3. HÀM LÕI CHẠY TRẬN ĐẤU (DÙNG CHUNG)
// ----------------------------------------------------
function startMatchCore(p1, p2, roomKey) {
  const matchId = "m_" + Date.now() + Math.floor(Math.random() * 1000);
  const redName = p1.user.displayName || p1.user.username;
  const blueName = p2.user.displayName || p2.user.username;
  const currentRules = store.getRules();

  activeMatches.set(matchId, {
    id: matchId, red: redName, blue: blueName,
    redUser: p1.user.username, blueUser: p2.user.username,
    room: roomKey, state: { ply: 0 }
  });
  broadcastLiveMatches();

  // Phát tín hiệu đếm ngược bắt đầu trận đấu chính thức tới đúng phòng
  if (roomKey) {
    broadcastSSE("startCountdown", {
      room: roomKey,
      matchId,
      red: redName,
      blue: blueName,
      redUser: p1.user.username,
      blueUser: p2.user.username,
    });
  }

  setTimeout(async () => {
    const matchPromise = runMatch(p1, p2, (update) => {
      if (activeMatches.has(matchId)) {
        activeMatches.get(matchId).state = update.state;
        broadcastLiveMatches();
      }
      broadcastSSE("matchUpdate", {
        matchId, update, room: roomKey, redName, blueName,
        redUser: p1.user.username, blueUser: p2.user.username,
      });
    }, currentRules);

    const result = await matchPromise;
    activeMatches.delete(matchId);

    if (roomKey) {
      activeRooms.delete(roomKey);
      roomReadyCode.delete(roomKey);
      broadcastSSE("roomUpdate", { room: roomKey, playerCount: 0 });
    }

    broadcastLiveMatches();
    store.recordMatch(result);
    broadcastSSE("refresh", {});

    // Kiểm tra hàng đợi để kích hoạt trận tiếp theo
    checkAndMatch();
  }, 3200);
}

// ----------------------------------------------------
// 4. KIỂM TRA HÀNG ĐỢI TỰ DO (DÀNH CHO PHÒNG THƯỜNG)
// ----------------------------------------------------
async function checkAndMatch() {
  if (waitingQueue.length < 2) return;

  // KIỂM TRA CHỊU TẢI: Giới hạn số trận đấu chạy đồng thời để bảo vệ CPU/RAM
  const MAX_ACTIVE_MATCHES = parseInt(process.env.MAX_CONCURRENT_MATCHES) || 3;
  if (activeMatches.size >= MAX_ACTIVE_MATCHES) {
    return; // Đã đạt giới hạn số trận cùng lúc, các cặp khác tiếp tục xếp hàng chờ
  }

  for (let i = 0; i < waitingQueue.length; i++) {
    for (let j = i + 1; j < waitingQueue.length; j++) {
      const p1 = waitingQueue[i];
      const p2 = waitingQueue[j];

      if (p1.user.username === p2.user.username) continue;

      if ((!p1.room && !p2.room) || (p1.room && p2.room && p1.room === p2.room)) {
        const roomKey = p1.room;

        // BẢO VỆ CHÍNH: Nếu phòng này là Giải Đấu -> KHÔNG tự động ghép
        if (roomKey && tournamentRooms.has(roomKey)) continue;

        waitingQueue.splice(j, 1);
        waitingQueue.splice(i, 1);
        if (roomKey) roomReadyCode.delete(roomKey);

        startMatchCore(p1, p2, roomKey);
        return checkAndMatch();
      }
    }
  }
}

// Lắng nghe trên cổng đã cấu hình (mặc định 3000 hoặc PORT từ Render/Hosting)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[OTT ARENA] Server đang chạy trên cổng ${PORT}`);
  if (process.env.ENABLE_LAN_ONLY === 'true') {
    console.log(`[CHẾ ĐỘ LAN] Chỉ cho phép truy cập từ mạng nội bộ.`);
  } else {
    console.log(`[CHẾ ĐỘ ONLINE] Chấp nhận kết nối từ mọi IP / Internet.`);
  }
});
