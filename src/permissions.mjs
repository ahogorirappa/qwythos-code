// 「書き換え」「コマンド実行」の前に人へ確認をとる仕組み。
import { c, line, out } from './ui.mjs';

// シェルが「ここでコマンドが切れる」と読む文字。
//
// **改行が抜けていた。** そのせいで、こういうものが「読み取り専用」と判定されていた。
//
//     ls -la\nrm -rf /tmp/x          → SAFE と判定（実測）
//     echo hi\nchmod 777 ~/.ssh      → SAFE と判定（実測）
//
// 改行はセミコロンと同じ区切り文字なので、1行目だけを見て安全と決めると、
// 2行目に何を書かれても通ってしまう。`\r` と行継続の `\` も同じ理由で足す。
const COMMAND_SEPARATORS = /[;&|><`\n\r\\]|\$\(/;

// 読み取り専用の顔をしているのに、書き込みも実行もできる引数。
//
// `find` は safeCommands に入っているが、実際には -delete / -exec / -fprintf を持つ。
// `-exec ... \;` は `;` のおかげで弾けていたが、**`+` で終わる形は素通り**していた。
//
//     find . -delete                       → SAFE と判定（実測）
//     find . -name '*.mjs' -exec rm {} +   → SAFE と判定（実測）
//     find . -fprintf /tmp/pwned %p        → SAFE と判定（実測）
//
// find を一覧から外すのではなく引数で見るのは、**調べる道具としては要る**から。
// 計画モードで find が使えないと、調べてから提案するという役目が果たせない。
const WRITING_ARGS = /(^|\s)-(delete|exec|execdir|ok|okdir|fprintf|fprint|fls)(\s|$)/;

// 読めてしまうと困る場所。
//
// **「読み取り専用」は「無害」ではない。** `cat ~/.openclaw/.env` は
// 書き込みを一切しないが、Discord・LINE・Tavily・Bluesky の鍵が全部
// モデルの文脈に入る。そして同じエージェントが web_search / web_fetch を
// 持っているので、**読んだものが外に出る道がある**。
// ここに当たったら確認をとる（禁止ではない。本当に読みたい場面はある）。
const SECRET_PATHS =
  /\.env\b|\.ssh\b|\.aws\b|\.gnupg\b|\.netrc\b|\.npmrc\b|id_rsa|id_ecdsa|id_ed25519|\.pem\b|\.p12\b|\bcredentials\b|\bsecrets?\.(json|ya?ml|txt|env)\b/i;

/**
 * 危険な連結が含まれていない、素直な読み取り専用コマンドかを見る。
 *
 * 確認をとるかどうか（PermissionManager）と、
 * 計画モードで実行してよいかどうか（tools.mjs）の両方から使うので、
 * 判断は1箇所にだけ置く。片方だけ緩いと、そこが穴になる。
 *
 * **裏を返すと、ここの穴は2つのドアを同時に開ける。**
 * 計画モードは「調べるだけで、環境は変えない」と約束しているので、
 * ここが緩いとその約束ごと破れる。だから疑わしいものは安全側に倒す
 * （false を返しても禁止ではなく、人に確認をとるだけ）。
 */
export function isSafeCommand(command, config) {
  const cmd = String(command).trim();
  if (COMMAND_SEPARATORS.test(cmd)) return false;
  if (WRITING_ARGS.test(cmd)) return false;
  if (SECRET_PATHS.test(cmd)) return false;
  return (config.safeCommands || []).some((prefix) => {
    if (cmd === prefix) return true;
    return cmd.startsWith(`${prefix} `);
  });
}

export class PermissionManager {
  constructor(config, ask) {
    this.config = config;
    this.ask = ask;                 // (question) => Promise<string>
    this.alwaysAllow = new Set();   // このセッション中ずっと許可するもの
    this.denied = 0;
  }

  get autoApprove() {
    return Boolean(this.config.autoApprove);
  }

  set autoApprove(v) {
    this.config.autoApprove = Boolean(v);
  }

  /**
   * 書き換えだけ黙って通す段階。
   *
   * 全部飛ばす（--yolo）と、毎回聞かれるの間。
   * ふだんの作業でうるさいのは書き換えの確認で、そこは差分が画面に出るので後から追える。
   * コマンド実行とネットは**引き続き聞く**。あれは戻せないものを含むうえ、
   * 画面に出ても「何が起きたか」が事前には分からない。
   */
  get acceptEdits() {
    return Boolean(this.config.acceptEdits);
  }

  set acceptEdits(v) {
    this.config.acceptEdits = Boolean(v);
  }

  /** その道具が、いまの段階で黙って通ってよいか */
  autoAllowed(toolName) {
    if (this.autoApprove) return true;
    return this.acceptEdits && (toolName === 'write_file' || toolName === 'edit_file');
  }

  // 危険な連結が含まれていない、素直な読み取り専用コマンドかを見る
  isSafeCommand(command) {
    return isSafeCommand(command, this.config);
  }

  key(toolName, args) {
    if (toolName === 'run_command') {
      const first = String(args.command || '').trim().split(/\s+/).slice(0, 2).join(' ');
      return `run_command:${first}`;
    }
    return `${toolName}`;
  }

  async request({ toolName, args, title, preview }) {
    if (this.autoAllowed(toolName)) return { granted: true, reason: 'auto' };

    const key = this.key(toolName, args);
    if (this.alwaysAllow.has(key)) return { granted: true, reason: 'remembered' };

    line();
    line(`${c.brightYellow('┌')} ${c.bold('確認')} ${c.gray(title)}`);
    if (preview) {
      for (const l of preview.split('\n')) line(`${c.brightYellow('│')} ${l}`);
    }
    line(`${c.brightYellow('└')} ${c.gray('y = 実行 / n = やめる（既定） / a = 以後このセッションは同種を自動許可')}`);

    for (;;) {
      // 大文字の N が既定。**そのまま Enter を押したら「やめる」にする。**
      //
      // 前はここで空入力を「はい」にしていた。表示は [y/n/a] で、どれが既定かの
      // 印も無かった。コマンドの実行は戻せないものを含むので、**いちばん押されやすい
      // キーが、いちばん戻せない側に倒れている**のは向きが逆になる。
      // 貼り付けたテキストに改行が混ざっていれば、見ないうちに通ってしまう。
      const raw = await this.ask(`${c.brightYellow('  →')} [y/N/a] `);
      if (raw === null || raw === undefined) {
        // 入力が閉じた（Ctrl+D など）ときは「やめる」扱いにする
        this.denied++;
        return { granted: false, reason: 'closed' };
      }
      const answer = String(raw).trim().toLowerCase();
      if (answer === '') {
        out(c.gray('  やめました（実行するなら y を入力してください）。\n'));
        this.denied++;
        return { granted: false, reason: 'default' };
      }
      if (answer === 'y' || answer === 'yes') {
        return { granted: true, reason: 'user' };
      }
      if (answer === 'a' || answer === 'always') {
        this.alwaysAllow.add(key);
        return { granted: true, reason: 'always' };
      }
      if (answer === 'n' || answer === 'no') {
        this.denied++;
        return { granted: false, reason: 'user' };
      }
      out(c.gray('  y / n / a のどれかを入力してください。\n'));
    }
  }
}
