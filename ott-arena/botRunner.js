const { Worker } = require("worker_threads");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { OTTGame } = require("./game");

// Kiểm tra xem hệ thống có hỗ trợ công cụ sandbox bwrap (Linux) hay không
let hasBwrap = false;
if (process.platform !== "win32") {
  try {
    execSync("bwrap --version", { stdio: "ignore" });
    hasBwrap = true;
  } catch (e) {
    hasBwrap = false;
  }
}

// Hàm thực thi Code Bot hỗ trợ JS, Python và C++
function runBotScript(botEntry, state) {
  return new Promise((resolve) => {
    const { code, lang } = botEntry;

    // 1. CHẠY JAVASCRIPT
    if (lang === "javascript" || !lang) {
      const script = `
        const { parentPort, workerData } = require('worker_threads');
        try {
          const botFn = new Function('state', workerData.code + '\\n return typeof getMove === "function" ? getMove(state) : null;');
          const move = botFn(workerData.state);
          parentPort.postMessage({ move });
        } catch (e) {
          parentPort.postMessage({ error: e.message });
        }
      `;
      const worker = new Worker(script, {
        eval: true,
        workerData: { code, state },
      });
      const timer = setTimeout(() => {
        worker.terminate();
        resolve(null);
      }, 1500);

      worker.on("message", (msg) => {
        clearTimeout(timer);
        worker.terminate();

        if (msg?.error) {
          console.error("[BOT JS ERROR]", msg.error);
          resolve(null);
          return;
        }

        //console.log("[BOT JS MOVE]", JSON.stringify(msg?.move));
        resolve(msg?.move ?? null);
      });
      worker.on("error", () => {
        clearTimeout(timer);
        worker.terminate();
        resolve(null);
      });
      return;
    }

    // 2. CHẠY PYTHON & C++ QUA FILE TẠM
    const tmpDir = os.tmpdir();
    const id = Date.now() + "_" + Math.random().toString(36).substring(2, 7);

    if (lang === "python") {
      const pyPath = path.join(tmpDir, `bot_${id}.py`);
      const pyRunner = `
import sys, json

${code}

if __name__ == '__main__':
    try:
        input_data = json.loads(sys.argv[1])
        if 'getMove' in globals():
            res = getMove(input_data)
            print(json.dumps(res))
    except Exception as e:
    import traceback
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
`;
      fs.writeFileSync(pyPath, pyRunner, "utf8");

      // Chạy Python (Ưu tiên dùng bwrap sandbox trên Linux, fallback trực tiếp nếu không có)
      const pythonBin = process.platform === "win32" ? "python" : "python3";
      const proc = hasBwrap
        ? spawn("bwrap", [
            "--dev-bind", "/", "/",    // Ánh xạ toàn bộ ổ đĩa hiện tại vào sandbox để Python không bị lỗi thiếu thư viện
            "--unshare-net",           // Cắt toàn bộ kết nối mạng (Network Isolation)
            "python3", 
            pyPath, 
            JSON.stringify(state)
          ])
        : spawn(pythonBin, [pyPath, JSON.stringify(state)]);

      let out = "";
      proc.stdout.on("data", (d) => (out += d.toString()));

      let timer = null;
      proc.on("error", (err) => {
        console.error("[BOT PYTHON ERROR]", err.message);
        if (timer) clearTimeout(timer);
        try { fs.unlinkSync(pyPath); } catch (e) {}
        resolve(null);
      });

      timer = setTimeout(() => {
        proc.kill();
        try {
          fs.unlinkSync(pyPath);
        } catch (e) {}
        resolve(null);
      }, 2000);

      proc.on("close", () => {
        clearTimeout(timer);
        try {
          fs.unlinkSync(pyPath);
        } catch (e) {}
        try {
          resolve(JSON.parse(out.trim()));
        } catch (e) {
          resolve(null);
        }
      });
      return;
    }

    if (lang === "cpp") {
      const cppPath = path.join(tmpDir, `bot_${id}.cpp`);
      const binPath = path.join(tmpDir, `bot_${id}.out`);

      fs.writeFileSync(cppPath, code, "utf8");

      // Biên dịch C++ bằng g++
      const compile = spawn("g++", ["-O2", cppPath, "-o", binPath]);
      
      compile.on("error", (err) => {
        console.error("[G++ COMPILE ERROR]", err.message);
        try { fs.unlinkSync(cppPath); } catch (e) {}
        resolve(null);
      });

      compile.on("close", (codeExit) => {
        try {
          fs.unlinkSync(cppPath);
        } catch (e) {}
        if (codeExit !== 0) return resolve(null);

        // Chạy tệp nhị phân C++ (Ưu tiên dùng bwrap sandbox trên Linux, fallback trực tiếp nếu không có)
        const proc = hasBwrap
          ? spawn("bwrap", [
              "--dev-bind", "/", "/",
              "--unshare-net",
              binPath, 
              JSON.stringify(state)
            ])
          : spawn(binPath, [JSON.stringify(state)]);

        let out = "";
        proc.stdout.on("data", (d) => (out += d.toString()));

        let timer = null;
        proc.on("error", (err) => {
          console.error("[BOT CPP RUN ERROR]", err.message);
          if (timer) clearTimeout(timer);
          try { fs.unlinkSync(binPath); } catch (e) {}
          resolve(null);
        });

        timer = setTimeout(() => {
          proc.kill();
          try {
            fs.unlinkSync(binPath);
          } catch (e) {}
          resolve(null);
        }, 2000);

        proc.on("close", () => {
          clearTimeout(timer);
          try {
            fs.unlinkSync(binPath);
          } catch (e) {}
          try {
            resolve(JSON.parse(out.trim()));
          } catch (e) {
            resolve(null);
          }
        });
      });
      return;
    }

    resolve(null);
  });
}

// Chạy trận đấu tự động giữa 2 Bot với Cấu hình luật tuỳ chỉnh
async function runMatch(p1, p2, onUpdate, rules = {}) {
  const game = new OTTGame(
    p1.user.displayName || p1.user.username,
    p2.user.displayName || p2.user.username,
    null,
    null,
    rules,
  );

  let plies = 0;
  const maxPlies = 200;
  const stepDelay = Math.max(50, Math.min(5000, Number(rules?.stepDelay) || 600));
  const protectBotError = rules?.protectBotError !== false;

  while (!game.isFinished() && plies < maxPlies) {
    const currentTurn = game.turn;
    const currentBot = currentTurn === "RED" ? p1 : p2;
    const state = game.getStateForPlayer(currentTurn);

    let move = await runBotScript(currentBot, state);

    if (!move || !game.makeMove(currentTurn, move)) {
      if (protectBotError) {
        // Tự động chọn nước đi ngẫu nhiên từ danh sách nước đi hợp lệ khi Bot lỗi/phạm quy
        const legalMoves = game.getLegalMoves(currentTurn);
        if (legalMoves.length > 0) {
          // Ưu tiên nước đi chạm ô đích để thắng nếu có
          const winMove = legalMoves.find((m) =>
            currentTurn === "RED" ? (m.to[0] === 8 && m.to[1] === 0) : (m.to[0] === 0 && m.to[1] === 8)
          );
          const chosenMove = winMove || legalMoves[Math.floor(Math.random() * legalMoves.length)];
          game.makeMove(currentTurn, chosenMove);
          move = chosenMove;
        } else {
          const winner = currentTurn === "RED" ? "BLUE" : "RED";
          game.finishMatch(
            winner,
            `Phe ${currentTurn} đã hết nước đi hợp lệ trên bàn cờ!`,
          );
          if (onUpdate) onUpdate({ state: game.getSnapshot(), move: null });
          break;
        }
      } else {
        const winner = currentTurn === "RED" ? "BLUE" : "RED";
        game.finishMatch(
          winner,
          `Phe ${currentTurn} đưa ra nước đi không hợp lệ hoặc phạm quy!`,
        );
        if (onUpdate) onUpdate({ state: game.getSnapshot(), move: null });
        break;
      }
    }

    plies++;
    if (onUpdate) onUpdate({ state: game.getSnapshot(), move });
    await new Promise((r) => setTimeout(r, stepDelay));
  }

  if (!game.isFinished() && plies >= maxPlies) {
    game.finishMatch("DRAW", "Trận đấu hòa do vượt quá giới hạn 200 nước đi!");
    if (onUpdate) onUpdate({ state: game.getSnapshot(), move: null });
  }

  return {
    id: "m_" + Date.now(),
    red: {
      username: p1.user.username,
      name: p1.user.displayName || p1.user.username,
    },
    blue: {
      username: p2.user.username,
      name: p2.user.displayName || p2.user.username,
    },
    winner: game.winner,
    reason: game.finishReason,
    plies,
    finishedAt: new Date().toISOString(),
    initial: game.initialState.board,
    moves: game.moves,
  };
}

module.exports = { runMatch, runBotScript };
