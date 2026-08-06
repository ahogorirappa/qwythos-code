// 設定の読み書き。~/.qwythos-code/config.json があればそれを既定値に上書きする。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME_DIR = path.join(os.homedir(), '.qwythos-code');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
export const SESSION_DIR = path.join(HOME_DIR, 'sessions');

export const DEFAULT_CONFIG = {
  // 接続先
  host: 'http://localhost:11434',
  // 既定は 9B。実測でこれが一番ちょうどよかった。
  // 14B は同じ作業に20倍かかり（5手の修正で 30秒 → 10分超）、
  // 大きいほど自律的に動けるわけでもない（README「モデルの癖への対処」）。
  model: 'qwythos:latest',

  // 生成パラメータ（qwythos の Modelfile に合わせた値）
  numCtx: 32768,
  temperature: 0.3,
  topP: 0.95,
  topK: 20,
  repeatPenalty: 1.05,
  keepAlive: '30m',
  think: true,

  // モデルの返事をどれだけ待つか。
  //
  // モデルの読み込みや文脈枠の取り直しが挟まると、最初の1文字までが分単位になる。
  // Node の fetch はここを300秒で必ず打ち切るので、この2か所だけ node:http で投げている。
  // 出はじめる前は長く待ち、出はじめたあとで途切れたら短く見切る。
  firstTokenMs: 15 * 60 * 1000,
  stallMs: 3 * 60 * 1000,

  showThinking: 'compact', // compact（1行だけ流す）/ full（全部出す）/ off（出さない）

  // エージェントの動作
  maxSteps: 40,           // 1回のお願いで許すツール実行の往復上限
  maxToolChars: 12000,    // ツールの出力をこれ以上は切り詰める
  maxFileBytes: 400000,   // これより大きいファイルは丸ごと読まない
  commandTimeoutMs: 120000,
  compactAtRatio: 0.7,    // 文脈がこの割合を超えたら自動で要約圧縮
  duplicateLimit: 3,      // 同じツール呼び出しが続いたら止める回数
  maxNudges: 5,           // 「やります」と言うだけで動かないときに促す回数の上限
  todoHintAfter: 6,       // これだけ道具を使ってもリストが無ければ、1度だけ促す

  // ネット接続（web_search / web_fetch）
  //
  // 手元のファイルを触るのとは性質が違う。検索の言葉と URL が外へ出るので、
  // 既定では毎回確認する（y/n/a）。丸ごと切りたいときは net: false。
  net: true,
  netTimeoutMs: 20000,
  maxFetchBytes: 2000000,  // 1ページで受け取る上限。文脈を食いつぶさないため

  // ログイン済みブラウザ（browse）。Playwright が入っているときだけ有効になる。
  // 判定は起動時に1回だけ行い、browserReady に入れる（毎回試すと遅い）。
  browserReady: false,
  browseTimeoutMs: 30000,

  // 言語サーバー（find_symbol）が使えるか。起動時に1回だけ調べて入れる。
  lspReady: false,

  // 計画モード。true のあいだは書き換える道具を渡さない。
  // 保存はしない（次回まで持ち越すものではないため）。
  planMode: false,

  // 安全まわり
  autoApprove: false,      // true で確認なし（--yolo と同じ）
  allowOutsideRoot: false, // 作業フォルダの外を触れるか
  safeCommands: [
    'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'which', 'echo', 'date',
    'file', 'stat', 'find', 'grep', 'rg', 'fd', 'tree', 'du', 'df',
    'node -v', 'node --version', 'npm ls', 'python3 -V', 'python3 --version',
    'git status', 'git diff', 'git log', 'git branch', 'git show', 'git remote'
  ]
};

function ensureHomeDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

export function loadConfig() {
  ensureHomeDir();
  let fromFile = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      process.stderr.write(`設定ファイルが読めませんでした (${CONFIG_PATH}): ${err.message}\n`);
    }
  }
  const env = {};
  if (process.env.OLLAMA_HOST) {
    const h = process.env.OLLAMA_HOST;
    env.host = h.startsWith('http') ? h : `http://${h}`;
  }
  if (process.env.QWC_MODEL) env.model = process.env.QWC_MODEL;
  return { ...DEFAULT_CONFIG, ...fromFile, ...env };
}

export function saveConfig(patch) {
  ensureHomeDir();
  let current = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      current = {};
    }
  }
  const next = { ...current, ...patch };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
