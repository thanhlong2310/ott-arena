class OTTGame {
  constructor(
    redName = "RED",
    blueName = "BLUE",
    customRedPieces = null,
    customBluePieces = null,
  ) {
    this.redName = redName;
    this.blueName = blueName;
    this.board = Array(9)
      .fill(null)
      .map(() => Array(9).fill(null));
    this.turn = "RED";
    this.ply = 0;
    this.winner = null;
    this.finishReason = null;

    this.winner = null;
    this.finishReason = null;
    this.moves = []; // <-- THÊM

    this.initBoard(customRedPieces, customBluePieces);
    this.initialState = this.getSnapshot();
  }

  // Khởi tạo vị trí quân cờ tuỳ chỉnh của người chơi nếu có
  initBoard(customRed = null, customBlue = null) {
    const defaultRed = ["R", "R", "R", "P", "P", "P", "P", "S", "S", "S"];
    const redPieces =
      customRed && customRed.length === 10 ? customRed : defaultRed;
    let idx = 0;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 5; c++) {
        if (idx < redPieces.length) {
          this.board[r][c] = { t: redPieces[idx++], o: "RED" };
        }
      }
    }

    const defaultBlue = ["R", "R", "R", "P", "P", "P", "P", "S", "S", "S"];
    const bluePieces =
      customBlue && customBlue.length === 10 ? customBlue : defaultBlue;
    idx = 0;
    for (let r = 7; r < 9; r++) {
      for (let c = 4; c < 9; c++) {
        if (idx < bluePieces.length) {
          this.board[r][c] = { t: bluePieces[idx++], o: "BLUE" };
        }
      }
    }
  }

  getSnapshot() {
    return {
      board: JSON.parse(JSON.stringify(this.board)),
      turn: this.turn,
      ply: this.ply,
      winner: this.winner,
      finishReason: this.finishReason,
    };
  }

  getStateForPlayer(side) {
    return {
      side,
      board: JSON.parse(JSON.stringify(this.board)),
      ply: this.ply,
    };
  }

  isValidPos(r, c) {
    return r >= 0 && r < 9 && c >= 0 && c < 9;
  }

  beats(t1, t2) {
    if (t1 === t2) return false;
    if (t1 === "R" && t2 === "S") return true;
    if (t1 === "S" && t2 === "P") return true;
    if (t1 === "P" && t2 === "R") return true;
    return false;
  }

  makeMove(side, move) {
    if (this.winner || side !== this.turn) return false;
    if (!move || !move.from || !move.to) return false;

    const [fr, fc] = move.from;
    const [tr, tc] = move.to;

    if (!this.isValidPos(fr, fc) || !this.isValidPos(tr, tc)) return false;

    const piece = this.board[fr][fc];
    if (!piece || piece.o !== side) return false;

    const dr = Math.abs(tr - fr);
    const dc = Math.abs(tc - fc);
    if (dr > 1 || dc > 1 || (dr === 0 && dc === 0)) return false;

    const destPiece = this.board[tr][tc];

    if (destPiece) {
      if (destPiece.o === side) return false;
      if (this.beats(piece.t, destPiece.t)) {
        this.board[tr][tc] = piece;
        this.board[fr][fc] = null;
      } else {
        return false;
      }
    } else {
      this.board[tr][tc] = piece;
      this.board[fr][fc] = null;
    }

    this.ply++;
    this.moves.push([fr, fc, tr, tc]);

    if (side === "RED" && tr === 8 && tc === 0) {
      this.finishMatch("RED", "Đã đưa quân chạm ô đích a1!");
      return true;
    }
    if (side === "BLUE" && tr === 0 && tc === 8) {
      this.finishMatch("BLUE", "Đã đưa quân chạm ô đích i9!");
      return true;
    }

    this.checkElimination();

    if (!this.winner) {
      this.turn = this.turn === "RED" ? "BLUE" : "RED";
    }

    return true;
  }

  checkElimination() {
    const redCounts = { R: 0, P: 0, S: 0 };
    const blueCounts = { R: 0, P: 0, S: 0 };

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const p = this.board[r][c];
        if (p) {
          if (p.o === "RED") redCounts[p.t]++;
          if (p.o === "BLUE") blueCounts[p.t]++;
        }
      }
    }

    if (redCounts.R === 0 || redCounts.P === 0 || redCounts.S === 0) {
      this.finishMatch("BLUE", "Đã ăn sạch 1 chủng loại quân của phe RED!");
    } else if (blueCounts.R === 0 || blueCounts.P === 0 || blueCounts.S === 0) {
      this.finishMatch("RED", "Đã ăn sạch 1 chủng loại quân của phe BLUE!");
    }
  }

  finishMatch(winner, reason) {
    this.winner = winner;
    this.finishReason = reason;
  }

  isFinished() {
    return this.winner !== null;
  }
}

module.exports = { OTTGame };
