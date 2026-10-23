const { Worker } = require("worker_threads");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { OTTGame } = require("./game");

let hasBwrap = false;
if (process.platform !== "win32") {
  try {
    execSync("bwrap --version", { stdio: "ignore" });
    hasBwrap = true;
  } catch (e) {
    hasBwrap = false;
  }
}

// Hàm đọc mảng xếp cờ getSetup(state) từ Bot
function runBotSetup(botEntry, side) {
  return new Promise((resolve) => {
    const { code, lang } = botEntry;
    const mockState = { side };

    if (lang === "javascript" || !lang) {
      try {
        const script = `
          ${code}
          if (typeof getSetup === "function") return getSetup(${JSON.stringify(mockState)});
          return null;
        `;
        const setup = new Function(script)();
        if (Array.isArray(setup) && setup.length === 10) return resolve(setup);
      } catch (e) {}
      return resolve(null);
    }

    if (lang === "python") {
      const tmpDir = os.tmpdir();
      const id = Date.now() + "_" + Math.random().toString(36).substring(2, 7);
      const pyPath = path.join(tmpDir, `setup_${id}.py`);
      const pyRunner = `
import sys, json
${code}
if __name__ == '__main__':
    try:
        input_state = json.loads(sys.argv[1])
        if 'getSetup' in globals():
            res = getSetup(input_state)
            print(json.dumps(res))
    except Exception as e:
        sys.exit(1)
`;
      fs.writeFileSync(pyPath, pyRunner, "utf8");
      const pythonBin = process.platform === "win32" ? "python" : "python3";
      const proc = spawn(pythonBin, [pyPath, JSON.stringify(mockState)]);
      let out = "";
      proc.stdout.on("data", (d) => (out += d.toString()));
      proc.on("close", () => {
        try { fs.unlinkSync(pyPath); } catch (e) {}
        try {
          const arr = JSON.parse(out.trim());
          resolve(Array.isArray(arr) && arr.length === 10 ? arr : null);
        } catch (e) { resolve(null); }
      });
      return;
    }

    resolve(null);
  });
}

function runBotScript(botEntry, state) {
  return new Promise((resolve) => {
    const { code, lang } = botEntry;

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

        resolve(msg?.move ?? null);
      });
      worker.on("error", () => {
        clearTimeout(timer);
        worker.terminate();
        resolve(null);
      });
      return;
    }

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

      const pythonBin = process.platform === "win32" ? "python" : "python3";
      const proc = hasBwrap
        ? spawn("bwrap", [
            "--dev-bind", "/", "/",
            "--unshare-net",
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
        try { fs.unlinkSync(pyPath); } catch (e) {}
        resolve(null);
      }, 2000);

      proc.on("close", () => {
        clearTimeout(timer);
        try { fs.unlinkSync(pyPath); } catch (e) {}
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

      const compile = spawn("g++", ["-O2", cppPath, "-o", binPath]);
      
      compile.on("error", (err) => {
        console.error("[G++ COMPILE ERROR]", err.message);
        try { fs.unlinkSync(cppPath); } catch (e) {}
        resolve(null);
      });

      compile.on("close", (codeExit) => {
        try { fs.unlinkSync(cppPath); } catch (e) {}
        if (codeExit !== 0) return resolve(null);

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
          try { fs.unlinkSync(binPath); } catch (e) {}
          resolve(null);
        }, 2000);

        proc.on("close", () => {
          clearTimeout(timer);
          try { fs.unlinkSync(binPath); } catch (e) {}
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

async function runMatch(p1, p2, onUpdate, rules = {}) {
  // Đọc thiết lập xếp cờ tự do từ file Bot
  const redSetup = await runBotSetup(p1, "RED");
  const blueSetup = await runBotSetup(p2, "BLUE");

  const game = new OTTGame(
    p1.user.displayName || p1.user.username,
    p2.user.displayName || p2.user.username,
    redSetup,
    blueSetup,
    rules,
  );

  let plies = 0;
  const maxPlies = 200;
  const stepDelay = Math.max(50, Math.min(5000, Number(rules?.stepDelay) || 600));
  
  // Đồng bộ kiểm tra thuộc tính bảo vệ
  const protectBotError = rules?.protectBotError !== false;

  while (!game.isFinished() && plies < maxPlies) {
    const currentTurn = game.turn;
    const currentBot = currentTurn === "RED" ? p1 : p2;
    const state = game.getStateForPlayer(currentTurn);

    let move = await runBotScript(currentBot, state);

    if (!move || !game.makeMove(currentTurn, move)) {
      if (protectBotError) {
        const legalMoves = game.getLegalMoves(currentTurn);
        if (legalMoves.length > 0) {
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
