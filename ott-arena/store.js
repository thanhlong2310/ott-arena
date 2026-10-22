const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "ott-data.json");

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function initStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    const initialData = {
      players: {},
      history: [],
      accounts: {},
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
  }
}

function readData() {
  initStore();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return { players: {}, history: [], accounts: {} };
  }
}

function saveData(data) {
  initStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const SECRET_ADMIN_CODE = "2026";

function registerUser(username, password, displayName, adminCode) {
  const data = readData();
  const u = username.trim().toLowerCase();

  if (!u || !password) {
    throw new Error("Vui lòng nhập đầy đủ Tên đăng nhập và Mật khẩu");
  }
  if (data.accounts[u]) {
    throw new Error("Tên đăng nhập này đã tồn tại");
  }
  const assignedRole = (adminCode === SECRET_ADMIN_CODE) ? 'admin' : 'player';

  const userObj = {
    id: "u_" + Date.now(),
    username: u,
    displayName: displayName ? displayName.trim() : u,
    passwordHash: hashPassword(password),
    role: assignedRole,
    createdAt: new Date().toISOString(),
  };

  data.accounts[u] = userObj;

  if (!data.players[u]) {
    data.players[u] = {
      username: u,
      displayName: userObj.displayName,
      elo: 1000,
      wins: 0,
      losses: 0,
      draws: 0,
    };
  }

  saveData(data);
  return userObj;
}

function authenticateUser(username, password) {
  const data = readData();
  const u = username.trim().toLowerCase();
  const user = data.accounts[u];
  if (!user) return null;

  if (user.passwordHash === hashPassword(password)) {
    return user;
  }
  return null;
}

function getPlayerStats(username) {
  const data = readData();
  const u = username.trim().toLowerCase();
  return data.players[u] || { elo: 1000, wins: 0, losses: 0, draws: 0 };
}

function getLeaderboard() {
  const data = readData();
  const list = Object.values(data.players || {});
  list.sort((a, b) => b.elo - a.elo);
  return list;
}

function recordMatch(match) {
  const data = readData();

  const redU = match.red.username.toLowerCase();
  const blueU = match.blue.username.toLowerCase();

  if (!data.players[redU])
    data.players[redU] = {
      username: redU,
      displayName: match.red.name,
      elo: 1000,
      wins: 0,
      losses: 0,
      draws: 0,
    };
  if (!data.players[blueU])
    data.players[blueU] = {
      username: blueU,
      displayName: match.blue.name,
      elo: 1000,
      wins: 0,
      losses: 0,
      draws: 0,
    };

  const pRed = data.players[redU];
  const pBlue = data.players[blueU];

  if (match.winner === "RED") {
    pRed.wins++;
    pBlue.losses++;
    pRed.elo += 15;
    pBlue.elo = Math.max(100, pBlue.elo - 15);
  } else if (match.winner === "BLUE") {
    pBlue.wins++;
    pRed.losses++;
    pBlue.elo += 15;
    pRed.elo = Math.max(100, pRed.elo - 15);
  } else {
    pRed.draws++;
    pBlue.draws++;
  }

  // Gán điểm Elo cập nhật vào chi tiết trận đấu
  match.red.elo = pRed.elo;
  match.blue.elo = pBlue.elo;

  data.history.unshift(match);
  if (data.history.length > 500) {
    data.history = data.history.slice(0, 500);
  }

  saveData(data);
}

function getMatchHistory(limit = 20) {
  const data = readData();
  return (data.history || []).slice(0, limit).map((m) => {
    const { moves, initial, ...rest } = m;
    const redU = m.red && m.red.username ? m.red.username.toLowerCase() : "";
    const blueU = m.blue && m.blue.username ? m.blue.username.toLowerCase() : "";
    const redElo = m.red && m.red.elo !== undefined ? m.red.elo : (data.players[redU]?.elo ?? 1000);
    const blueElo = m.blue && m.blue.elo !== undefined ? m.blue.elo : (data.players[blueU]?.elo ?? 1000);
    return {
      ...rest,
      red: { ...m.red, elo: redElo },
      blue: { ...m.blue, elo: blueElo },
      hasReplay: Array.isArray(moves) && Array.isArray(initial),
    };
  });
}

function getMatchById(id) {
  const data = readData();
  return (data.history || []).find((m) => m.id === id) || null;
}

module.exports = {
  registerUser,
  authenticateUser,
  getPlayerStats,
  getLeaderboard,
  recordMatch,
  getMatchHistory,
  getMatchById,
};
