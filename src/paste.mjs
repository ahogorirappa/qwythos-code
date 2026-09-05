// 貼り付けた文を、1つの依頼としてまとめる。
//
// ■ なにが困るか
//   複数行を貼ると、端末は改行のたびに1行ずつ送ってくる。readline はそれを
//   「本人がエンターを押した」と受け取るので、10行のエラーログを貼ると
//   **エンターを押していないのに依頼が飛ぶ**。しかも飛ぶのは1行目だけで、
//   残りは順番待ちに積まれる。
//
// ■ 直し方は2段構え
//   1. 貼り付けの印（bracketed paste）… 端末に「ここから貼り付け・ここまで」の
//      印を出させ、その間の改行を**行の確定として扱わない**。貼った中身は
//      入力欄に入るだけで、送るのは本人がエンターを押したとき。
//      いまどきの端末（Terminal.app / iTerm2 / VS Code / tmux）はこれに対応している。
//   2. 時間で見分ける（createPasteBuffer）… 印を出せない端末むけの保険。
//      すでに確定してしまった行を、続けざまに届いたかどうかで1つにまとめ直す。
//      送信そのものは止められないので、あくまで次善の策。
//
// ■ まとめてよい場面かどうか
//   まとめるのは端末のときだけ。パイプで流し込まれた入力（`printf ... | qwc`）は
//   全行が同じ瞬間に届くので、ここでまとめると台本が丸ごと1つの依頼に化ける。
//   だから `enabled` を外から渡す（この判断はここではできない）。

// ── 1. 貼り付けの印（bracketed paste） ──────────────────────

/** 端末に貼り付けの印を出させる／やめさせる合図。 */
export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';

/** 一度に受け取る貼り付けの上限。これを超えたぶんは切る。 */
export const MAX_PASTE_CHARS = 100_000;

/** 入力欄に残す札の数の上限（古いものから捨てる）。 */
const MAX_STASH = 50;

// 印は端末によって名前が付く場合と付かない場合があるので、両方で見る。
// Node 26 は paste-start / paste-end という名前を付けてくれるが、
// 古い Node では名前が無く、コードだけが届く。
const isPasteStart = (key) => key?.name === 'paste-start' || key?.code === '[200~';
const isPasteEnd = (key) => key?.name === 'paste-end' || key?.code === '[201~';

/** 札の書き方。数字と行数だけの、打ち間違えようのない形にしておく。 */
const MARK_HEAD = '[貼り付け';
const markFor = (no, rows) => `${MARK_HEAD}${no}: ${rows}行]`;

/**
 * readline に、貼り付けの印を見分けさせる。
 *
 * 印と印のあいだに届いた文字は readline に渡さず、こちらで溜める。
 * 溜め終わったら:
 *   - 1行だけなら … そのまま入力欄に入れる（送らない）
 *   - 複数行なら  … `[貼り付け1: 12行]` という札を入力欄に入れ、中身は控えておく。
 *                   本人がエンターを押したあと `expand()` で中身に戻す。
 *
 * @param {import('node:readline').Interface} rl
 * @param {{ output?: NodeJS.WriteStream, onNote?: (msg: string) => void }} options
 */
export function attachBracketedPaste(rl, { output = null, onNote = null } = {}) {
  const dest = output || rl.output || null;
  /** 札 → 実際に貼られた中身 */
  const stash = new Map();
  const original = rl._ttyWrite.bind(rl);

  let collecting = false;
  let parts = [];
  let size = 0;
  let cut = false;
  let count = 0;

  const write = (seq) => {
    try {
      if (dest && typeof dest.write === 'function') dest.write(seq);
    } catch {
      // 画面に書けなくても入力は受け付けられる。ここで止めない
    }
  };

  const finish = () => {
    collecting = false;
    const raw = parts.join('');
    const truncated = cut;
    parts = [];
    size = 0;
    cut = false;

    const text = raw
      // 端末によって改行は \r\n / \r / \n のどれかで届く。1つに揃える
      .replace(/\r\n?/g, '\n')
      // 色や制御の文字が混じっても、依頼の文としては読めないので落とす
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      // 末尾の改行は「送れ」の合図ではない。行を丸ごとコピーすると必ず付いてくる
      .replace(/\n+$/, '');

    if (!text) return;

    if (!text.includes('\n')) {
      // 1行だけなら、打ったのと同じ扱いでよい。札にすると、かえって読みにくい
      rl._insertString(text);
    } else {
      const rows = text.split('\n').length;
      const mark = markFor(++count, rows);
      stash.set(mark, text);
      // 古い札から捨てる。↑ で古い行を呼び戻したときに困らない程度には残す
      while (stash.size > MAX_STASH) stash.delete(stash.keys().next().value);
      rl._insertString(mark);
    }

    if (truncated && onNote) {
      onNote(`貼り付けが長いので、${MAX_PASTE_CHARS.toLocaleString()}文字で切りました。`);
    }
  };

  rl._ttyWrite = (s, key) => {
    if (isPasteStart(key)) {
      collecting = true;
      parts = [];
      size = 0;
      cut = false;
      return undefined;
    }
    if (isPasteEnd(key)) {
      if (collecting) finish();
      return undefined;
    }
    // 貼り付けの最中でなければ、readline の普段どおりの処理に返す
    if (!collecting) return original(s, key);

    if (typeof s !== 'string' || s === '') return undefined;
    if (size >= MAX_PASTE_CHARS) {
      cut = true;
      return undefined;
    }
    const room = MAX_PASTE_CHARS - size;
    if (s.length > room) {
      parts.push(s.slice(0, room));
      size = MAX_PASTE_CHARS;
      cut = true;
    } else {
      parts.push(s);
      size += s.length;
    }
    return undefined;
  };

  return {
    /** 端末に印を出させる。子プロセスが消してしまうので、そのつどかけ直す */
    enable: () => write(PASTE_ON),
    disable: () => write(PASTE_OFF),
    /** 入力欄の札を、貼られた中身に戻す */
    expand: (text) => {
      if (typeof text !== 'string' || stash.size === 0) return text;
      if (!text.includes(MARK_HEAD)) return text;
      let filled = text;
      for (const [mark, body] of stash) {
        if (filled.includes(mark)) filled = filled.split(mark).join(body);
      }
      return filled;
    },
    /** 控えている貼り付けの数（検証用） */
    stashed: () => stash.size,
    /** 元の readline に戻す */
    detach: () => {
      rl._ttyWrite = original;
      write(PASTE_OFF);
    }
  };
}

// ── 2. 時間で見分ける（印を出せない端末むけの保険） ─────────
//
// 貼り付けは一瞬で届き、人が打つ改行は最短でも100ミリ秒は空く。
// 印が使えるなら行はここまで来ない（改行が確定にならないため）ので、
// 実際に働くのは印に対応していない端末だけ。

/** 続けざまに届いた行を、同じ貼り付けとみなす幅（ミリ秒）。 */
export const PASTE_WINDOW_MS = 15;

/**
 * 行を受け取って、まとまったところで `onFlush` に渡す入れ物を作る。
 *
 * @param {(text: string) => void} onFlush まとめた文字列の受け取り先
 * @param {{ enabled?: boolean, windowMs?: number }} options
 * @returns {{ push: (line: string) => void, flush: () => void, pending: () => number }}
 */
export function createPasteBuffer(onFlush, { enabled = true, windowMs = PASTE_WINDOW_MS } = {}) {
  let parts = [];
  let timer = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!parts.length) return;
    const text = parts.join('\n');
    parts = [];
    onFlush(text);
  };

  const push = (text) => {
    // まとめない場でも、この入れ物を通せるようにしておく。
    // 呼ぶ側に「まとめるときだけこちらを使う」という分岐を作ると、
    // 片方だけ直したときに、行の届き方が2通りに割れる。
    if (!enabled) return onFlush(text);
    parts.push(text);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, windowMs);
  };

  return { push, flush, pending: () => parts.length };
}
