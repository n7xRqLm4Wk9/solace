/**
 * src/core/position.js
 *
 * Board state, legal move generation, make/unmake, FEN and Zobrist handling.
 *
 * Representation (chosen after benchmarking the alternatives, see README):
 *   - a 64-entry board array holding board codes,
 *   - piece bitboards per colour and type (12 pairs of 32-bit words),
 *   - derived colour bitboards and a total occupancy bitboard,
 *   - incremental Zobrist key, castling rights, en-passant square,
 *     halfmove clock and fullmove number.
 *
 * makeMove() stores everything needed to undo the move, including the previous
 * Zobrist key, so unmakeMove() restores the position *exactly*.  A helper
 * (computeKey) recomputes the key from scratch; the test-suite checks the
 * incremental key against it after every move of long random games.
 */

import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  EMPTY, makePiece, pieceIndex,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ, CASTLE_ALL,
  CASTLE_ROOK_FROM, CASTLE_ROOK_TO,
  rankOf, fileOf, squareName, parseSquare,
} from './types.js';
import {
  ATK_LO, ATK_HI, KNIGHT_ATK_LO, KNIGHT_ATK_HI, KING_ATK_LO, KING_ATK_HI,
  PAWN_ATK_LO, PAWN_ATK_HI,
  knightAttacks, kingAttacks, bishopAttacks, rookAttacks, queenAttacks,
} from './bitboards.js';
import {
  PIECE_LO, PIECE_HI, SIDE_LO, SIDE_HI, CASTLING_LO, CASTLING_HI, EP_FILE_LO, EP_FILE_HI,
} from './zobrist.js';
import {
  MoveList, encodeMove, moveFrom, moveTo, moveFlag, promotionType,
  FLAG_QUIET, FLAG_CAPTURE, FLAG_DOUBLE_PUSH, FLAG_EN_PASSANT,
  FLAG_CASTLE_KING, FLAG_CASTLE_QUEEN, FLAG_PROMO_Q, FLAG_PROMO_CAP_Q,
  promotionFlag, CHAR_TO_PIECE,
} from './moves.js';

const MAX_HISTORY = 2048;
const UNDO_STRIDE = 8;

/** Castling rights that survive a piece leaving/arriving on each square. */
const CASTLING_MASK = new Int8Array(64).fill(CASTLE_ALL);
CASTLING_MASK[4] = CASTLE_ALL & ~(CASTLE_WK | CASTLE_WQ); // e1
CASTLING_MASK[7] = CASTLE_ALL & ~CASTLE_WK;               // h1
CASTLING_MASK[0] = CASTLE_ALL & ~CASTLE_WQ;               // a1
CASTLING_MASK[60] = CASTLE_ALL & ~(CASTLE_BK | CASTLE_BQ); // e8
CASTLING_MASK[63] = CASTLE_ALL & ~CASTLE_BK;              // h8
CASTLING_MASK[56] = CASTLE_ALL & ~CASTLE_BQ;              // a8

const PROMOTION_TYPES = [QUEEN, ROOK, BISHOP, KNIGHT];

export class Position {
  constructor() {
    this.board = new Int8Array(64);      // board code at each square (0 = empty)
    this.piecesLo = new Int32Array(12);  // [colour * 6 + type - 1]
    this.piecesHi = new Int32Array(12);
    this.colourLo = new Int32Array(2);
    this.colourHi = new Int32Array(2);
    this.occLo = 0;
    this.occHi = 0;
    /** Total number of pieces on the board (both colours, kings included). */
    this.pieceTotal = 0;
    this.counts = new Int32Array(15);    // number of pieces per board code
    this.kingSq = new Int32Array(2);     // king square per colour
    this.side = WHITE;
    this.castling = 0;
    this.epSquare = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.keyLo = 0;
    this.keyHi = 0;
    this.epKeyIncluded = false;

    // Undo stack, one record of UNDO_STRIDE words per move.
    this.undo = new Int32Array(MAX_HISTORY * UNDO_STRIDE);
    this.undoPly = 0;

    // Zobrist key history for repetition detection.
    this.histLo = new Int32Array(MAX_HISTORY);
    this.histHi = new Int32Array(MAX_HISTORY);
    this.histCount = 0;

    this.clear();
  }

  /** Reset to an empty board (no kings) - used by FEN parsing. */
  clear() {
    this.board.fill(0);
    this.piecesLo.fill(0);
    this.piecesHi.fill(0);
    this.colourLo.fill(0);
    this.colourHi.fill(0);
    this.occLo = 0;
    this.occHi = 0;
    /** Total number of pieces on the board (both colours, kings included). */
    this.pieceTotal = 0;
    this.counts.fill(0);
    this.kingSq[WHITE] = -1;
    this.kingSq[BLACK] = -1;
    this.side = WHITE;
    this.castling = 0;
    this.epSquare = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.keyLo = 0;
    this.keyHi = 0;
    this.epKeyIncluded = false;
    this.undoPly = 0;
    this.histCount = 0;
  }

  // -------------------------------------------------------------------------
  // Low-level board edits (each maintains every derived structure)
  // -------------------------------------------------------------------------
  addPiece(code, sq) {
    const colour = code >> 3;
    const idx = colour * 6 + (code & 7) - 1;
    const lo = sq < 32 ? 1 << sq : 0;
    const hi = sq < 32 ? 0 : 1 << (sq - 32);
    this.board[sq] = code;
    this.piecesLo[idx] |= lo;
    this.piecesHi[idx] |= hi;
    this.colourLo[colour] |= lo;
    this.colourHi[colour] |= hi;
    this.occLo |= lo;
    this.occHi |= hi;
    this.counts[code]++;
    this.pieceTotal++;
    this.keyLo ^= PIECE_LO[code * 64 + sq];
    this.keyHi ^= PIECE_HI[code * 64 + sq];
  }

  removePiece(code, sq) {
    const colour = code >> 3;
    const idx = colour * 6 + (code & 7) - 1;
    const lo = sq < 32 ? 1 << sq : 0;
    const hi = sq < 32 ? 0 : 1 << (sq - 32);
    this.board[sq] = EMPTY;
    this.piecesLo[idx] &= ~lo;
    this.piecesHi[idx] &= ~hi;
    this.colourLo[colour] &= ~lo;
    this.colourHi[colour] &= ~hi;
    this.occLo &= ~lo;
    this.occHi &= ~hi;
    this.counts[code]--;
    this.pieceTotal--;
    this.keyLo ^= PIECE_LO[code * 64 + sq];
    this.keyHi ^= PIECE_HI[code * 64 + sq];
  }

  movePiece(code, from, to) {
    this.removePiece(code, from);
    this.addPiece(code, to);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------
  pieceOn(sq) {
    return this.board[sq];
  }

  pieceCount(colour, type) {
    return this.counts[makePiece(colour, type)];
  }

  /** True when the given square is attacked by any piece of colour ``by``. */
  isAttacked(sq, by) {
    // Pawns: squares from which a pawn of colour `by` attacks `sq` are the
    // squares a pawn of the opposite colour would attack from `sq`.
    const pawnIdx = by * 6;
    const pawnLo = PAWN_ATK_LO[by ^ 1][sq];
    const pawnHi = PAWN_ATK_HI[by ^ 1][sq];
    if ((pawnLo & this.piecesLo[pawnIdx]) !== 0 || (pawnHi & this.piecesHi[pawnIdx]) !== 0) return true;

    // Knights
    if ((KNIGHT_ATK_LO[sq] & this.piecesLo[pawnIdx + 1]) !== 0
      || (KNIGHT_ATK_HI[sq] & this.piecesHi[pawnIdx + 1]) !== 0) return true;

    // King
    if ((KING_ATK_LO[sq] & this.piecesLo[pawnIdx + 5]) !== 0
      || (KING_ATK_HI[sq] & this.piecesHi[pawnIdx + 5]) !== 0) return true;

    // Diagonal sliders (bishops and queens)
    bishopAttacks(sq, this.occLo, this.occHi);
    const diagLo = this.piecesLo[pawnIdx + 2] | this.piecesLo[pawnIdx + 4];
    const diagHi = this.piecesHi[pawnIdx + 2] | this.piecesHi[pawnIdx + 4];
    if ((ATK_LO & diagLo) !== 0 || (ATK_HI & diagHi) !== 0) return true;

    // Straight sliders (rooks and queens)
    rookAttacks(sq, this.occLo, this.occHi);
    const lineLo = this.piecesLo[pawnIdx + 3] | this.piecesLo[pawnIdx + 4];
    const lineHi = this.piecesHi[pawnIdx + 3] | this.piecesHi[pawnIdx + 4];
    if ((ATK_LO & lineLo) !== 0 || (ATK_HI & lineHi) !== 0) return true;

    return false;
  }

  /** Does the colour have any piece other than pawns and the king? */
  hasNonPawnMaterial(colour) {
    const base = colour * 6;
    return this.piecesLo[base + 1] !== 0 || this.piecesHi[base + 1] !== 0
      || this.piecesLo[base + 2] !== 0 || this.piecesHi[base + 2] !== 0
      || this.piecesLo[base + 3] !== 0 || this.piecesHi[base + 3] !== 0
      || this.piecesLo[base + 4] !== 0 || this.piecesHi[base + 4] !== 0;
  }

  /** Is ``colour``'s king currently attacked? */
  isKingInCheck(colour) {
    const sq = this.kingSq[colour];
    return sq >= 0 && this.isAttacked(sq, colour ^ 1);
  }

  inCheck() {
    return this.isKingInCheck(this.side);
  }

  // -------------------------------------------------------------------------
  // Zobrist helpers
  // -------------------------------------------------------------------------
  /** Recompute the Zobrist key from the full position state (verification). */
  computeKey() {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < 64; sq++) {
      const code = this.board[sq];
      if (code !== EMPTY) {
        lo ^= PIECE_LO[code * 64 + sq];
        hi ^= PIECE_HI[code * 64 + sq];
      }
    }
    if (this.side === BLACK) {
      lo ^= SIDE_LO;
      hi ^= SIDE_HI;
    }
    lo ^= CASTLING_LO[this.castling];
    hi ^= CASTLING_HI[this.castling];
    if (this.epSquare >= 0 && this.epKeyIncluded) {
      const f = fileOf(this.epSquare);
      lo ^= EP_FILE_LO[f];
      hi ^= EP_FILE_HI[f];
    }
    return { lo, hi };
  }

  /** Would the side to move have a pawn able to capture on ``epSquare``? */
  hasEpCaptureBy(colour, epSquare) {
    if (epSquare < 0) return false;
    const file = fileOf(epSquare);
    const rank = rankOf(epSquare);
    const fromRank = colour === WHITE ? rank - 1 : rank + 1;
    if (fromRank < 0 || fromRank > 7) return false;
    for (const df of [-1, 1]) {
      const f = file + df;
      if (f < 0 || f > 7) continue;
      const sq = fromRank * 8 + f;
      if (this.board[sq] === makePiece(colour, PAWN)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Move generation
  // -------------------------------------------------------------------------
  /**
   * Generate pseudo-legal moves for the side to move.  Castling is only
   * generated when it is fully legal; every other move may still leave the
   * king in check and must be validated by the caller (after makeMove).
   *
   * @param {MoveList} list receives the moves
   * @param {boolean} capturesOnly generate only captures, promotions and
   *        en-passant moves (used by quiescence search)
   */
  generateMoves(list, capturesOnly = false) {
    list.clear();
    this.generatePawnMoves(list, capturesOnly);
    this.generateKnightMoves(list, capturesOnly);
    this.generateSliderMoves(list, capturesOnly, BISHOP);
    this.generateSliderMoves(list, capturesOnly, ROOK);
    this.generateSliderMoves(list, capturesOnly, QUEEN);
    this.generateKingMoves(list, capturesOnly);
  }

  generatePawnMoves(list, capturesOnly) {
    const us = this.side;
    const up = us === WHITE ? 8 : -8;
    const startRank = us === WHITE ? 1 : 6;
    const promoRank = us === WHITE ? 7 : 0;
    const pawnCode = makePiece(us, PAWN);
    const idx = us * 6;
    const atkLo = PAWN_ATK_LO[us];
    const atkHi = PAWN_ATK_HI[us];
    const enemyLo = this.colourLo[us ^ 1];
    const enemyHi = this.colourHi[us ^ 1];

    for (let word = 0; word < 2; word++) {
      let bits = word === 0 ? this.piecesLo[idx] : this.piecesHi[idx];
      const base = word === 0 ? 0 : 32;
      while (bits !== 0) {
        const sq = base + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;

        const to = sq + up;
        if (to >= 0 && to < 64 && this.board[to] === EMPTY) {
          if (rankOf(to) === promoRank) {
            for (const pt of PROMOTION_TYPES) {
              list.add(encodeMove(sq, to, promotionFlag(pt, false), PAWN, 0));
            }
          } else if (!capturesOnly) {
            list.add(encodeMove(sq, to, FLAG_QUIET, PAWN, 0));
            if (rankOf(sq) === startRank && this.board[to + up] === EMPTY) {
              list.add(encodeMove(sq, to + up, FLAG_DOUBLE_PUSH, PAWN, 0));
            }
          }
        }

        // Pawn captures (also covers promotions by capture and en passant).
        const targetsLo = atkLo[sq];
        const targetsHi = atkHi[sq];
        for (let w = 0; w < 2; w++) {
          let t = w === 0 ? targetsLo : targetsHi;
          const tBase = w === 0 ? 0 : 32;
          const enemyWord = w === 0 ? enemyLo : enemyHi;
          while (t !== 0) {
            const target = tBase + 31 - Math.clz32(t & -t);
            t &= t - 1;
            const onEnemy = (enemyWord & (1 << (target - tBase))) !== 0;
            if (onEnemy) {
              const victim = this.board[target] & 7;
              if (rankOf(target) === promoRank) {
                for (const pt of PROMOTION_TYPES) {
                  list.add(encodeMove(sq, target, promotionFlag(pt, true), PAWN, victim));
                }
              } else {
                list.add(encodeMove(sq, target, FLAG_CAPTURE, PAWN, victim));
              }
            } else if (target === this.epSquare && this.board[target] === EMPTY) {
              // En passant: the captured pawn must really be there.
              const victimSq = target - up;
              if (this.board[victimSq] === makePiece(us ^ 1, PAWN)) {
                list.add(encodeMove(sq, target, FLAG_EN_PASSANT, PAWN, PAWN));
              }
            }
          }
        }
      }
    }
  }

  generateKnightMoves(list, capturesOnly) {
    const us = this.side;
    const idx = us * 6 + 1;
    const ownLo = this.colourLo[us];
    const ownHi = this.colourHi[us];
    for (let word = 0; word < 2; word++) {
      let bits = word === 0 ? this.piecesLo[idx] : this.piecesHi[idx];
      const base = word === 0 ? 0 : 32;
      while (bits !== 0) {
        const sq = base + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        let tLo = KNIGHT_ATK_LO[sq] & ~ownLo;
        let tHi = KNIGHT_ATK_HI[sq] & ~ownHi;
        this.emitTargets(list, sq, tLo, tHi, KNIGHT, capturesOnly);
      }
    }
  }

  generateSliderMoves(list, capturesOnly, type) {
    const us = this.side;
    const idx = us * 6 + (type - 1);
    const ownLo = this.colourLo[us];
    const ownHi = this.colourHi[us];
    for (let word = 0; word < 2; word++) {
      let bits = word === 0 ? this.piecesLo[idx] : this.piecesHi[idx];
      const base = word === 0 ? 0 : 32;
      while (bits !== 0) {
        const sq = base + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        if (type === BISHOP) bishopAttacks(sq, this.occLo, this.occHi);
        else if (type === ROOK) rookAttacks(sq, this.occLo, this.occHi);
        else queenAttacks(sq, this.occLo, this.occHi);
        this.emitTargets(list, sq, ATK_LO & ~ownLo, ATK_HI & ~ownHi, type, capturesOnly);
      }
    }
  }

  /** Append one move per set bit of the target masks. */
  emitTargets(list, from, targetLo, targetHi, type, capturesOnly) {
    for (let word = 0; word < 2; word++) {
      let bits = word === 0 ? targetLo : targetHi;
      const base = word === 0 ? 0 : 32;
      while (bits !== 0) {
        const to = base + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        const victim = this.board[to];
        if (victim !== EMPTY) {
          list.add(encodeMove(from, to, FLAG_CAPTURE, type, victim & 7));
        } else if (!capturesOnly) {
          list.add(encodeMove(from, to, FLAG_QUIET, type, 0));
        }
      }
    }
  }

  generateKingMoves(list, capturesOnly) {
    const us = this.side;
    const idx = us * 6 + 5;
    const sq = this.kingSq[us];
    if (sq < 0) return;
    kingAttacks(sq);
    this.emitTargets(list, sq, ATK_LO & ~this.colourLo[us], ATK_HI & ~this.colourHi[us], KING, capturesOnly);
    if (capturesOnly) return;

    // Castling: rights present, rook and king on their home squares, squares
    // between them empty and the king's whole path free of attack.
    const them = us ^ 1;
    if (us === WHITE) {
      if ((this.castling & CASTLE_WK) !== 0 && sq === 4
        && this.board[7] === makePiece(WHITE, ROOK)
        && this.board[5] === EMPTY && this.board[6] === EMPTY
        && !this.isAttacked(4, them) && !this.isAttacked(5, them) && !this.isAttacked(6, them)) {
        list.add(encodeMove(4, 6, FLAG_CASTLE_KING, KING, 0));
      }
      if ((this.castling & CASTLE_WQ) !== 0 && sq === 4
        && this.board[0] === makePiece(WHITE, ROOK)
        && this.board[1] === EMPTY && this.board[2] === EMPTY && this.board[3] === EMPTY
        && !this.isAttacked(4, them) && !this.isAttacked(3, them) && !this.isAttacked(2, them)) {
        list.add(encodeMove(4, 2, FLAG_CASTLE_QUEEN, KING, 0));
      }
    } else {
      if ((this.castling & CASTLE_BK) !== 0 && sq === 60
        && this.board[63] === makePiece(BLACK, ROOK)
        && this.board[61] === EMPTY && this.board[62] === EMPTY
        && !this.isAttacked(60, them) && !this.isAttacked(61, them) && !this.isAttacked(62, them)) {
        list.add(encodeMove(60, 62, FLAG_CASTLE_KING, KING, 0));
      }
      if ((this.castling & CASTLE_BQ) !== 0 && sq === 60
        && this.board[56] === makePiece(BLACK, ROOK)
        && this.board[57] === EMPTY && this.board[58] === EMPTY && this.board[59] === EMPTY
        && !this.isAttacked(60, them) && !this.isAttacked(59, them) && !this.isAttacked(58, them)) {
        list.add(encodeMove(60, 58, FLAG_CASTLE_QUEEN, KING, 0));
      }
    }
  }

  /**
   * Generate the legal moves (pseudo-legal moves filtered by leaving the king
   * safe).  The temporary make/unmake leaves the position untouched.
   */
  generateLegalMoves(list, capturesOnly = false) {
    const pseudo = new MoveList(256);
    this.generateMoves(pseudo, capturesOnly);
    list.clear();
    const us = this.side;
    for (let i = 0; i < pseudo.count; i++) {
      const m = pseudo.moves[i];
      this.makeMove(m);
      if (!this.isKingInCheck(us)) list.add(m);
      this.unmakeMove(m);
    }
    return list;
  }

  /** True when the position has no legal moves (checkmate or stalemate). */
  hasLegalMoves() {
    const pseudo = new MoveList(256);
    this.generateMoves(pseudo);
    const us = this.side;
    for (let i = 0; i < pseudo.count; i++) {
      const m = pseudo.moves[i];
      this.makeMove(m);
      const legal = !this.isKingInCheck(us);
      this.unmakeMove(m);
      if (legal) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // make / unmake
  // -------------------------------------------------------------------------
  makeMove(move) {
    const from = moveFrom(move);
    const to = moveTo(move);
    const flag = moveFlag(move);
    const us = this.side;
    const them = us ^ 1;
    const movedCode = this.board[from];
    if (movedCode === EMPTY || (movedCode >> 3) !== us) {
      throw new Error(`illegal move in makeMove: no ${us === WHITE ? 'white' : 'black'} piece on ${squareName(from)}`);
    }
    const movedType = movedCode & 7;

    if (this.undoPly >= MAX_HISTORY - 1 || this.histCount >= MAX_HISTORY - 1) {
      throw new Error('move history overflow (too many plies without reset)');
    }

    // --- record undo information ------------------------------------------
    const base = this.undoPly * UNDO_STRIDE;
    this.undo[base] = this.castling;
    this.undo[base + 1] = this.epSquare;
    this.undo[base + 2] = this.halfmove;
    this.undo[base + 3] = this.keyLo;
    this.undo[base + 4] = this.keyHi;
    this.undo[base + 6] = this.epKeyIncluded ? 1 : 0;
    let capturedCode = EMPTY;
    if (flag === FLAG_EN_PASSANT) {
      capturedCode = this.board[to + (us === WHITE ? -8 : 8)];
    } else if (flag === FLAG_CAPTURE || flag >= FLAG_PROMO_CAP_Q) {
      capturedCode = this.board[to];
    }
    this.undo[base + 5] = capturedCode;
    this.undo[base + 7] = this.kingSq[us];
    this.undoPly++;

    // --- zobrist: remove castling, ep and side-to-move contribution --------
    this.keyLo ^= CASTLING_LO[this.castling];
    this.keyHi ^= CASTLING_HI[this.castling];
    if (this.epKeyIncluded && this.epSquare >= 0) {
      const f = fileOf(this.epSquare);
      this.keyLo ^= EP_FILE_LO[f];
      this.keyHi ^= EP_FILE_HI[f];
    }
    this.keyLo ^= SIDE_LO;
    this.keyHi ^= SIDE_HI;

    // --- board edits -------------------------------------------------------
    let nextEp = -1;
    switch (flag) {
      case FLAG_EN_PASSANT: {
        const victimSq = to + (us === WHITE ? -8 : 8);
        this.removePiece(makePiece(them, PAWN), victimSq);
        this.movePiece(movedCode, from, to);
        break;
      }
      case FLAG_CASTLE_KING: {
        const right = us === WHITE ? CASTLE_WK : CASTLE_BK;
        this.movePiece(movedCode, from, to);
        this.movePiece(makePiece(us, ROOK), CASTLE_ROOK_FROM[right], CASTLE_ROOK_TO[right]);
        break;
      }
      case FLAG_CASTLE_QUEEN: {
        const right = us === WHITE ? CASTLE_WQ : CASTLE_BQ;
        this.movePiece(movedCode, from, to);
        this.movePiece(makePiece(us, ROOK), CASTLE_ROOK_FROM[right], CASTLE_ROOK_TO[right]);
        break;
      }
      default: {
        if (capturedCode !== EMPTY) this.removePiece(capturedCode, to);
        if (flag >= FLAG_PROMO_Q) {
          // Pawn disappears, promoted piece appears.
          this.removePiece(movedCode, from);
          const promoType = promotionType(move);
          if (promoType === 0) throw new Error('invalid promotion flag');
          this.addPiece(makePiece(us, promoType), to);
        } else if (flag === FLAG_DOUBLE_PUSH) {
          this.movePiece(movedCode, from, to);
          nextEp = (from + to) >> 1;
        } else {
          this.movePiece(movedCode, from, to);
        }
        break;
      }
    }

    if (movedType === KING) this.kingSq[us] = to;

    // --- clocks, rights, side to move -------------------------------------
    this.castling &= CASTLING_MASK[from] & CASTLING_MASK[to];
    if (movedType === PAWN || capturedCode !== EMPTY) this.halfmove = 0;
    else this.halfmove++;
    this.epSquare = nextEp;
    this.side = them;
    if (this.side === WHITE) this.fullmove++;

    // --- zobrist: add new castling, ep and side contribution --------------
    this.keyLo ^= CASTLING_LO[this.castling];
    this.keyHi ^= CASTLING_HI[this.castling];
    this.epKeyIncluded = nextEp >= 0 && this.hasEpCaptureBy(them, nextEp);
    if (this.epKeyIncluded) {
      const f = fileOf(nextEp);
      this.keyLo ^= EP_FILE_LO[f];
      this.keyHi ^= EP_FILE_HI[f];
    }

    // --- repetition history ------------------------------------------------
    this.histLo[this.histCount] = this.keyLo;
    this.histHi[this.histCount] = this.keyHi;
    this.histCount++;
    return true;
  }

  unmakeMove(move) {
    if (this.undoPly === 0) throw new Error('unmakeMove without a matching makeMove');
    this.undoPly--;
    const base = this.undoPly * UNDO_STRIDE;
    const flag = moveFlag(move);
    const from = moveFrom(move);
    const to = moveTo(move);

    if (this.side === WHITE) this.fullmove--;
    this.side ^= 1;
    const us = this.side;

    // Root out any history records belonging to this move.
    this.histCount--;

    // Restore the board by reversing the edits made in makeMove.
    switch (flag) {
      case FLAG_EN_PASSANT: {
        const victimSq = to + (us === WHITE ? -8 : 8);
        const pawnCode = makePiece(us, PAWN);
        this.movePiece(pawnCode, to, from);
        this.addPiece(makePiece(us ^ 1, PAWN), victimSq);
        break;
      }
      case FLAG_CASTLE_KING: {
        const right = us === WHITE ? CASTLE_WK : CASTLE_BK;
        this.movePiece(makePiece(us, KING), to, from);
        this.movePiece(makePiece(us, ROOK), CASTLE_ROOK_TO[right], CASTLE_ROOK_FROM[right]);
        break;
      }
      case FLAG_CASTLE_QUEEN: {
        const right = us === WHITE ? CASTLE_WQ : CASTLE_BQ;
        this.movePiece(makePiece(us, KING), to, from);
        this.movePiece(makePiece(us, ROOK), CASTLE_ROOK_TO[right], CASTLE_ROOK_FROM[right]);
        break;
      }
      default: {
        if (flag >= FLAG_PROMO_Q) {
          const promoType = promotionType(move);
          this.removePiece(makePiece(us, promoType), to);
          this.addPiece(makePiece(us, PAWN), from);
        } else {
          const movedCode = this.board[to];
          this.movePiece(movedCode, to, from);
        }
        const capturedCode = this.undo[base + 5];
        if (capturedCode !== EMPTY) this.addPiece(capturedCode, to);
        break;
      }
    }

    this.kingSq[us] = this.undo[base + 7];
    this.castling = this.undo[base];
    this.epSquare = this.undo[base + 1];
    this.halfmove = this.undo[base + 2];
    this.keyLo = this.undo[base + 3];
    this.keyHi = this.undo[base + 4];
    this.epKeyIncluded = this.undo[base + 6] === 1;
    return true;
  }

  /**
   * Null move: pass the turn.  Used only by the internal move-verifier and by
   * null-move pruning in the search.
   */
  makeNullMove() {
    if (this.undoPly >= MAX_HISTORY - 1 || this.histCount >= MAX_HISTORY - 1) {
      throw new Error('move history overflow');
    }
    const base = this.undoPly * UNDO_STRIDE;
    this.undo[base] = this.castling;
    this.undo[base + 1] = this.epSquare;
    this.undo[base + 2] = this.halfmove;
    this.undo[base + 3] = this.keyLo;
    this.undo[base + 4] = this.keyHi;
    this.undo[base + 5] = EMPTY;
    this.undo[base + 6] = this.epKeyIncluded ? 1 : 0;
    this.undo[base + 7] = this.kingSq[this.side];
    this.undoPly++;

    if (this.epKeyIncluded && this.epSquare >= 0) {
      const f = fileOf(this.epSquare);
      this.keyLo ^= EP_FILE_LO[f];
      this.keyHi ^= EP_FILE_HI[f];
    }
    this.keyLo ^= SIDE_LO;
    this.keyHi ^= SIDE_HI;
    // Castling rights are unchanged by a null move, so their key is unchanged.

    this.epSquare = -1;
    this.epKeyIncluded = false;
    this.halfmove++;
    this.side ^= 1;
    if (this.side === WHITE) this.fullmove++;

    this.histLo[this.histCount] = this.keyLo;
    this.histHi[this.histCount] = this.keyHi;
    this.histCount++;
    return true;
  }

  unmakeNullMove() {
    if (this.undoPly === 0) throw new Error('unmakeNullMove without a matching makeNullMove');
    this.undoPly--;
    const base = this.undoPly * UNDO_STRIDE;
    if (this.side === WHITE) this.fullmove--;
    this.side ^= 1;
    this.histCount--;
    this.castling = this.undo[base];
    this.epSquare = this.undo[base + 1];
    this.halfmove = this.undo[base + 2];
    this.keyLo = this.undo[base + 3];
    this.keyHi = this.undo[base + 4];
    this.epKeyIncluded = this.undo[base + 6] === 1;
    return true;
  }

  // -------------------------------------------------------------------------
  // Repetition and draw detection
  // -------------------------------------------------------------------------
  /**
   * How many earlier positions in this line share the current key?
   * Only positions since the last irreversible move (pawn move or capture) can
   * repeat, which is exactly the halfmove clock window.
   */
  repetitionCount() {
    const keyLo = this.keyLo;
    const keyHi = this.keyHi;
    const window = Math.min(this.halfmove, this.histCount - 1);
    let count = 0;
    for (let i = 1; i <= window; i++) {
      const idx = this.histCount - 1 - i;
      if (idx < 0) break;
      if (this.histLo[idx] === keyLo && this.histHi[idx] === keyHi) count++;
    }
    return count;
  }

  /** True when the side to move has insufficient mating material. */
  hasInsufficientMaterial() {
    for (let colour = 0; colour < 2; colour++) {
      if (this.pieceCount(colour, PAWN) || this.pieceCount(colour, ROOK)
        || this.pieceCount(colour, QUEEN)) return false;
    }
    const wN = this.pieceCount(WHITE, KNIGHT);
    const wB = this.pieceCount(WHITE, BISHOP);
    const bN = this.pieceCount(BLACK, KNIGHT);
    const bB = this.pieceCount(BLACK, BISHOP);
    const minorCount = wN + wB + bN + bB;
    if (minorCount === 0) return true;               // K vs K
    if (minorCount === 1) return true;               // K+minor vs K
    if (wN === 0 && bN === 0 && wB === 1 && bB === 1) {
      // One bishop each.  Mate needs the defending bishop to block a flight
      // square of its own king, which is only possible when the bishops run on
      // the same squares; two bishops on one colour is a dead position.
      const wSq = this.firstBishopSquare(WHITE);
      const bSq = this.firstBishopSquare(BLACK);
      if (wSq >= 0 && bSq >= 0) {
        const wColour = (fileOf(wSq) + rankOf(wSq)) & 1;
        const bColour = (fileOf(bSq) + rankOf(bSq)) & 1;
        return wColour === bColour;
      }
    }
    // K+2B vs K and K+N+N vs K are not dead positions: mate is possible there
    // (K+2B forces it, K+N+N needs help), so neither counts as insufficient.
    return false;
  }

  firstBishopSquare(colour) {
    const idx = colour * 6 + (BISHOP - 1);
    for (let w = 0; w < 2; w++) {
      const bits = w === 0 ? this.piecesLo[idx] : this.piecesHi[idx];
      if (bits !== 0) return (w === 0 ? 0 : 32) + 31 - Math.clz32(bits & -bits);
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // FEN
  // -------------------------------------------------------------------------
  /**
   * Load a position from FEN.  Throws an Error with a human-readable message
   * for malformed or illegal input.
   */
  setFen(fen) {
    if (typeof fen !== 'string') throw new Error('FEN must be a string');
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) {
      throw new Error(`FEN needs at least 4 fields (board, side, castling, en passant), got ${parts.length}`);
    }
    const [boardPart, sidePart, castlePart, epPart] = parts;
    const halfmovePart = parts.length > 4 ? parts[4] : '0';
    const fullmovePart = parts.length > 5 ? parts[5] : '1';

    this.clear();

    const ranks = boardPart.split('/');
    if (ranks.length !== 8) throw new Error(`FEN board must have 8 ranks, got ${ranks.length}`);
    const pieceCodes = {
      P: makePiece(WHITE, PAWN), N: makePiece(WHITE, KNIGHT), B: makePiece(WHITE, BISHOP),
      R: makePiece(WHITE, ROOK), Q: makePiece(WHITE, QUEEN), K: makePiece(WHITE, KING),
      p: makePiece(BLACK, PAWN), n: makePiece(BLACK, KNIGHT), b: makePiece(BLACK, BISHOP),
      r: makePiece(BLACK, ROOK), q: makePiece(BLACK, QUEEN), k: makePiece(BLACK, KING),
    };
    for (let r = 0; r < 8; r++) {
      const rank = 7 - r; // FEN starts at rank 8
      let file = 0;
      for (const ch of ranks[r]) {
        if (ch >= '1' && ch <= '8') {
          file += Number(ch);
        } else if (pieceCodes[ch] !== undefined) {
          if (file > 7) throw new Error(`FEN rank ${8 - r} has too many squares`);
          const sq = rank * 8 + file;
          const code = pieceCodes[ch];
          if ((code & 7) === PAWN && (rank === 0 || rank === 7)) {
            throw new Error(`FEN has a pawn on rank ${rank + 1}`);
          }
          this.addPiece(code, sq);
          if ((code & 7) === KING) {
            const colour = code >> 3;
            if (this.kingSq[colour] >= 0) throw new Error('FEN has more than one king of one colour');
            this.kingSq[colour] = sq;
          }
          file++;
        } else {
          throw new Error(`FEN contains invalid board character "${ch}"`);
        }
      }
      if (file !== 8) throw new Error(`FEN rank ${8 - r} does not contain 8 squares (got ${file})`);
    }
    if (this.kingSq[WHITE] < 0) throw new Error('FEN is missing the white king');
    if (this.kingSq[BLACK] < 0) throw new Error('FEN is missing the black king');

    if (sidePart === 'w') this.side = WHITE;
    else if (sidePart === 'b') this.side = BLACK;
    else throw new Error(`FEN side to move must be "w" or "b", got "${sidePart}"`);

    let castling = 0;
    if (castlePart !== '-') {
      for (const ch of castlePart) {
        switch (ch) {
          case 'K': castling |= CASTLE_WK; break;
          case 'Q': castling |= CASTLE_WQ; break;
          case 'k': castling |= CASTLE_BK; break;
          case 'q': castling |= CASTLE_BQ; break;
          case '-': break;
          default: throw new Error(`FEN castling field contains invalid character "${ch}"`);
        }
      }
    }
    // Drop rights that the position cannot support (tolerates sloppy FENs).
    if (this.kingSq[WHITE] !== 4 || this.board[7] !== makePiece(WHITE, ROOK)) castling &= ~CASTLE_WK;
    if (this.kingSq[WHITE] !== 4 || this.board[0] !== makePiece(WHITE, ROOK)) castling &= ~CASTLE_WQ;
    if (this.kingSq[BLACK] !== 60 || this.board[63] !== makePiece(BLACK, ROOK)) castling &= ~CASTLE_BK;
    if (this.kingSq[BLACK] !== 60 || this.board[56] !== makePiece(BLACK, ROOK)) castling &= ~CASTLE_BQ;
    this.castling = castling;

    if (epPart !== '-') {
      const sq = parseSquare(epPart);
      if (sq < 0) throw new Error(`FEN en-passant square "${epPart}" is invalid`);
      const rank = rankOf(sq);
      const expectRank = this.side === WHITE ? 5 : 2;
      if (rank !== expectRank) {
        throw new Error(`FEN en-passant square ${epPart} must be on rank ${expectRank + 1} for ${this.side === WHITE ? 'white' : 'black'} to move`);
      }
      this.epSquare = sq;
    } else {
      this.epSquare = -1;
    }

    if (!/^\d+$/.test(halfmovePart)) throw new Error(`FEN halfmove clock must be a non-negative integer, got "${halfmovePart}"`);
    if (!/^\d+$/.test(fullmovePart)) throw new Error(`FEN fullmove number must be a positive integer, got "${fullmovePart}"`);
    this.halfmove = Number(halfmovePart);
    this.fullmove = Math.max(1, Number(fullmovePart));

    // The side that just moved must not be left in check.
    if (this.isKingInCheck(this.side ^ 1)) {
      throw new Error('FEN describes an illegal position: the side not to move is in check');
    }

    // Recompute the key from scratch so that FEN loading cannot drift.
    this.keyLo = 0;
    this.keyHi = 0;
    for (let sq = 0; sq < 64; sq++) {
      const code = this.board[sq];
      if (code !== EMPTY) {
        this.keyLo ^= PIECE_LO[code * 64 + sq];
        this.keyHi ^= PIECE_HI[code * 64 + sq];
      }
    }
    if (this.side === BLACK) {
      this.keyLo ^= SIDE_LO;
      this.keyHi ^= SIDE_HI;
    }
    this.keyLo ^= CASTLING_LO[this.castling];
    this.keyHi ^= CASTLING_HI[this.castling];
    this.epKeyIncluded = this.epSquare >= 0 && this.hasEpCaptureBy(this.side, this.epSquare);
    if (this.epKeyIncluded) {
      const f = fileOf(this.epSquare);
      this.keyLo ^= EP_FILE_LO[f];
      this.keyHi ^= EP_FILE_HI[f];
    }

    this.undoPly = 0;
    this.histCount = 0;
    this.histLo[0] = this.keyLo;
    this.histHi[0] = this.keyHi;
    this.histCount = 1;
    return this;
  }

  /** Serialise the position to FEN (always six fields). */
  toFen() {
    let boardPart = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const code = this.board[rank * 8 + file];
        if (code === EMPTY) {
          empty++;
          continue;
        }
        if (empty > 0) {
          boardPart += empty;
          empty = 0;
        }
        const letters = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
        const letter = letters[code & 7];
        boardPart += (code >> 3) === WHITE ? letter : letter.toLowerCase();
      }
      if (empty > 0) boardPart += empty;
      if (rank > 0) boardPart += '/';
    }

    let castlePart = '';
    if (this.castling & CASTLE_WK) castlePart += 'K';
    if (this.castling & CASTLE_WQ) castlePart += 'Q';
    if (this.castling & CASTLE_BK) castlePart += 'k';
    if (this.castling & CASTLE_BQ) castlePart += 'q';
    if (castlePart === '') castlePart = '-';

    const epPart = this.epSquare >= 0 ? squareName(this.epSquare) : '-';
    return `${boardPart} ${this.side === WHITE ? 'w' : 'b'} ${castlePart} ${epPart} ${this.halfmove} ${this.fullmove}`;
  }

  /** Load the standard starting position. */
  setStartPosition() {
    return this.setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  }

  /** Deep copy (used by tests and by GUIs that keep positions). */
  clone() {
    const copy = new Position();
    copy.board.set(this.board);
    copy.piecesLo.set(this.piecesLo);
    copy.piecesHi.set(this.piecesHi);
    copy.colourLo.set(this.colourLo);
    copy.colourHi.set(this.colourHi);
    copy.occLo = this.occLo;
    copy.occHi = this.occHi;
    copy.pieceTotal = this.pieceTotal;
    copy.counts.set(this.counts);
    copy.kingSq.set(this.kingSq);
    copy.side = this.side;
    copy.castling = this.castling;
    copy.epSquare = this.epSquare;
    copy.halfmove = this.halfmove;
    copy.fullmove = this.fullmove;
    copy.keyLo = this.keyLo;
    copy.keyHi = this.keyHi;
    copy.epKeyIncluded = this.epKeyIncluded;
    copy.undo.set(this.undo.subarray(0, this.undoPly * UNDO_STRIDE));
    copy.undoPly = this.undoPly;
    copy.histLo.set(this.histLo.subarray(0, this.histCount));
    copy.histHi.set(this.histHi.subarray(0, this.histCount));
    copy.histCount = this.histCount;
    return copy;
  }

  // -------------------------------------------------------------------------
  // Move parsing / formatting
  // -------------------------------------------------------------------------
  /**
   * Convert a UCI move string ("e2e4", "e7e8q") into an encoded move.
   * Returns 0 when the text does not describe a legal move in this position.
   */
  parseMove(text) {
    if (typeof text !== 'string' || text.length < 4) return 0;
    const from = parseSquare(text.slice(0, 2));
    const to = parseSquare(text.slice(2, 4));
    if (from < 0 || to < 0) return 0;
    const promoChar = text.length > 4 ? text[4].toLowerCase() : '';
    const promoTypeWanted = promoChar ? CHAR_TO_PIECE[promoChar] : 0;
    if (promoChar && !promoTypeWanted) return 0;

    const legal = this.generateLegalMoves(new MoveList(256));
    for (let i = 0; i < legal.count; i++) {
      const m = legal.moves[i];
      if (moveFrom(m) !== from || moveTo(m) !== to) continue;
      const promo = promotionType(m);
      if (promoTypeWanted === 0 && promo !== 0) continue;
      if (promoTypeWanted !== 0 && promo !== promoTypeWanted) continue;
      return m;
    }
    return 0;
  }
}

/** Convenience constructor used throughout the code. */
export function createPosition(fen) {
  const pos = new Position();
  if (fen) pos.setFen(fen);
  else pos.setStartPosition();
  return pos;
}
