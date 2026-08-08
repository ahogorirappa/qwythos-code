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
  // 既定は gemma4:26b（2026-08-07 に qwythos:latest から変更）。
  //
  // 26B だが MoE で実効3.8Bなので、9B より速い。実測では速さと正しさの両方で上回った：
  // 同じ課題（既存の関数を使い回して新しい関数を足す）で
  //   9B      = 46.5秒・引数を取り違えた壊れたコード。存在しないパスも3手試した
  //   gemma4  = 36秒（18GBの読み込み込み）・正しいコード。自分からやることリストも作った
  // 14B は論外（同じ作業に20倍かかる。5手の修正で 30秒 → 10分超）。
  //
  // 必要なのは 18GB。GPU枠に載らない環境では `-m qwythos:latest`（7.4GB）に落とす。
  model: 'gemma4:26b',

  // 既定のモデルが GPU に載りきらなかったときの逃げ先（7.4GB）。
  //
  // 載りきらないと、はみ出した分が CPU 側で動いて極端に遅くなる。
  // そうなるくらいなら、遅いが GPU に収まるほうを使う。
  // 切り替えるのは載らなかったときだけで、作業の内容では切り替えない
  // （実測では 26B のほうが 9B より速く、正しい。落とす理由が容量以外に無い）。
  lightModel: 'qwythos:latest',
  autoDowngrade: true,

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

  // 書き換えだけ確認なしで進めるか（`--accept-edits` / `/accept`）。
  //
  // 全部飛ばす（`--yolo`）と、毎回聞かれるの間。
  // ふだんうるさいのは書き換えの確認で、そこは差分が画面に出るので後から追える。
  // コマンド実行とネットは引き続き聞く（戻せないものを含み、事前には何が起きるか分からない）。
  acceptEdits: false,

  // 書き換えた中身を画面に出すか。
  //
  // 「1 か所を置き換え」だけでは、何がどうなったのか分からない。
  // 確認を出さない設定（--yolo）では、ここが唯一の手がかりになる。
  // 確認欄で既に見せたときは重ねて出さない。
  showDiff: true,

  // エージェントの動作
  maxSteps: 40,           // 1回のお願いで許すツール実行の往復上限
  maxToolChars: 12000,    // ツールの出力をこれ以上は切り詰める
  maxFileBytes: 400000,   // これより大きいファイルは丸ごと読まない
  commandTimeoutMs: 120000,
  compactAtRatio: 0.7,    // 文脈がこの割合を超えたら自動で要約圧縮
  duplicateLimit: 3,      // 同じツール呼び出しが続いたら止める回数
  maxNudges: 5,           // 「やります」と言うだけで動かないときに促す回数の上限
  todoHintAfter: 6,       // これだけ道具を使ってもリストが無ければ、1度だけ促す
  // これだけ道具を使っても何も変わっていなければ、1度だけ区切りを促す。
  // 「どこを直すか書いていない依頼」で延々と読み続けるのを止めるため
  // （実測: 28ファイルの案件で7分ぶん読み続け、同じファイルを3回読み直して何も変えなかった）。
  exploreLimit: 10,

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
