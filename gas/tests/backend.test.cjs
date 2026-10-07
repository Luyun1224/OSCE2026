// 在 Node.js 模擬 GAS 服務，測試業務邏輯；不宣稱已驗證真實 Google 部署。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fixture() {
  const properties = new Map(), cache = new Map(), books = new Map();
  let now = Date.now();
  class Sheet {
    constructor(name) { this.name = name; this.rows = []; }
    setName(name) { this.name = name; return this; }
    setFrozenRows() {}
    getLastRow() { return this.rows.length; }
    getRange(r, c, h = 1, w = 1) {
      const self = this;
      return {
        getValues() { return Array.from({ length: h }, (_,i) => Array.from({ length: w }, (_,j) => self.rows[r+i-1]?.[c+j-1] ?? '')); },
        getValue() { return this.getValues()[0][0]; },
        setValues(values) {
          for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
            self.rows[r+i-1] ||= [];
            // Sheets 使用 apostrophe 避免公式；讀回時沒有 escape 前綴。
            const v = values[i][j];
            self.rows[r+i-1][c+j-1] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
          }
          return this;
        }
      };
    }
    getDataRange() { return this.getRange(1, 1, this.rows.length, this.rows[0]?.length || 1); }
  }
  class Book {
    constructor(id) { this.id = id; this.sheets = [new Sheet('Sheet1')]; }
    getId() { return this.id; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
    getSheets() { return this.sheets; }
    getSheetByName(name) { return this.sheets.find(s => s.name === name); }
    insertSheet(name) { const s = new Sheet(name); this.sheets.push(s); return s; }
    setSpreadsheetTimeZone() {}
  }
  const scriptProperties = {
    getProperty: key => properties.get(key) ?? null,
    setProperty: (key, value) => properties.set(key, value),
    deleteProperty: key => properties.delete(key)
  };
  const scriptCache = {
    get: key => { const v = cache.get(key); return v && v.expires > now ? v.value : null; },
    put: (key, value, seconds) => cache.set(key, { value, expires: now + seconds*1000 }),
    remove: key => cache.delete(key)
  };
  function output(body) { return { body, setMimeType() { return this; }, setXFrameOptionsMode() { return this; } }; }
  const context = vm.createContext({
    console: { log() {} },
    Utilities: {
      getUuid: () => crypto.randomUUID(), Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, value) => [...crypto.createHash('sha256').update(value).digest()],
      computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', key).update(value).digest()]
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    CacheService: { getScriptCache: () => scriptCache },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: {
      create: () => { const b = new Book('book' + books.size); books.set(b.id, b); return b; },
      openById: id => { if (!books.has(id)) throw new Error('Missing book'); return books.get(id); }, flush() {}
    },
    HtmlService: { createHtmlOutput: output, XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' } },
    ContentService: { createTextOutput: output, MimeType: { JSON: 'JSON' } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), context);
  context.setupInterdisciplinary();
  const ids = ['admin', 'reviewer1', 'reviewer2', 'reviewer3'];
  for (const id of ids) properties.set('PASSWORD_' + id.toUpperCase(), 'test-password-123');
  context.setPasswordsFromProperties();
  const login = username => context.dispatch_({ action: 'login', username, password: 'test-password-123' });
  const book = books.get(properties.get('SPREADSHEET_ID'));
  return { context, properties, book, cache, login, advance: ms => { now += ms; } };
}
function score(overrides = {}) {
  return { action: 'save', caseId: 1, scores: Object.fromEntries(Array.from({ length: 10 }, (_,i) => ['c'+(i+1), 9.5])), bonus: 10, comment: '優良表現', ...overrides };
}
function raisesCode(fn, code) { assert.throws(fn, e => e.code === code); }

test('初始化可重跑，密碼不存為明文，暫存密碼設定會刪除', () => {
  const f = fixture();
  const rows = f.book.getSheetByName('評審帳號').getDataRange().getValues();
  assert.equal(rows.length, 5);
  assert.equal(rows[1][4].length, 64);
  assert.ok(rows.every(r => !r.includes('test-password-123')));
  assert.equal(f.properties.has('PASSWORD_ADMIN'), false);
  f.context.setupInterdisciplinary();
  assert.equal(f.book.getSheetByName('評審帳號').getLastRow(), 5);
  assert.equal(f.login('reviewer1').role, 'reviewer');
});

test('評分封頂、重複儲存更新同一列、伺服器使用正式組別名稱', () => {
  const f = fixture(), token = f.login('reviewer1').token;
  const result = f.context.dispatch_(score({ token, title: 'untrusted title', username: 'reviewer2' }));
  assert.equal(result.baseScore, 95); assert.equal(result.totalScore, 100);
  const table = f.book.getSheetByName('評核資料');
  assert.equal(table.rows[1][0], 'reviewer1');
  assert.equal(table.rows[1][2], '復健部-物理治療');
  f.context.dispatch_(score({ token, bonus: 0, comment: '=SUM(1,2)</script>文字' }));
  assert.equal(table.getLastRow(), 2);
  const read = f.context.dispatch_({ action: 'load', token }).rows[0];
  assert.equal(read.totalScore, 95); assert.equal(read.comment, '=SUM(1,2)</script>文字');
});

test('評審只讀自己的分數，管理者可讀全部且不能代填', () => {
  const f = fixture(), one = f.login('reviewer1').token, two = f.login('reviewer2').token, admin = f.login('admin').token;
  f.context.dispatch_(score({ token: one })); f.context.dispatch_(score({ token: two }));
  const mine = f.context.dispatch_({ action: 'load', token: one, username: 'reviewer2' });
  assert.equal(mine.rows.length, 1); assert.equal(mine.rows[0].username, 'reviewer1');
  assert.equal(mine.reviewers.length, 3);
  assert.equal(f.context.dispatch_({ action: 'load', token: admin }).rows.length, 2);
  raisesCode(() => f.context.dispatch_(score({ token: admin })), 'FORBIDDEN');
});

test('不完整、負分、超額、非数字、錯誤組別、無說明加分均拒絕', () => {
  const f = fixture(), token = f.login('reviewer1').token;
  for (const change of [{ scores: {} }, { bonus: -1 }, { bonus: 11 }, { bonus: '5' }, { caseId: 6 }, { caseId: '1' }, { comment: '' }, { comment: 'a'.repeat(5001) }]) {
    raisesCode(() => f.context.dispatch_(score({ token, ...change })), 'BAD_SCORE');
  }
  for (const v of [-1, 11, 1.25, NaN, Infinity, '8', null]) {
    raisesCode(() => f.context.dispatch_(score({ token, scores: { ...score().scores, c1: v } })), 'BAD_SCORE');
  }
  assert.equal(f.book.getSheetByName('評核資料').getLastRow(), 1);
});

test('錯誤密碼、失敗鎖定、登出、停用及改密碼均正確', () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) raisesCode(() => f.context.dispatch_({ action: 'login', username: 'reviewer1', password: 'wrong' }), 'AUTH_FAILED');
  raisesCode(() => f.login('reviewer1'), 'RATE_LIMIT');
  f.advance(901000);
  const token = f.login('reviewer1').token;
  f.context.dispatch_({ action: 'logout', token });
  raisesCode(() => f.context.dispatch_({ action: 'load', token }), 'SESSION_EXPIRED');
  const next = f.login('reviewer1').token;
  f.properties.set('PASSWORD_REVIEWER1', 'new-test-password-123'); f.context.setPasswordsFromProperties();
  raisesCode(() => f.context.dispatch_({ action: 'load', token: next }), 'SESSION_EXPIRED');
  const two = f.login('reviewer2').token;
  f.book.getSheetByName('評審帳號').rows[3][5] = false;
  raisesCode(() => f.context.dispatch_({ action: 'load', token: two }), 'SESSION_EXPIRED');
});

test('session cache 到期需重登入，不回傳其他帳號資料', () => {
  const f = fixture(), token = f.login('reviewer1').token;
  f.advance(21601000);
  raisesCode(() => f.context.dispatch_({ action: 'load', token }), 'SESSION_EXPIRED');
});

test('POST 校驗來源與 requestId，回覆防止 script 注入；GET 不處理寫入', () => {
  const f = fixture();
  const requestId = 'osce_' + 'a'.repeat(48);
  const bad = f.context.doPost({ parameter: { requestId, returnOrigin: 'https://evil.invalid', payload: '{}' } });
  assert.equal(bad.body, '不允許的請求來源。');
  const malformed = f.context.doPost({ parameter: { requestId: 'bad', returnOrigin: 'https://luyun1224.github.io' } });
  assert.equal(malformed.body, '不允許的請求來源。');
  const reply = f.context.doPost({ parameter: { requestId, returnOrigin: 'https://luyun1224.github.io', payload: JSON.stringify({ action: 'login', username: 'reviewer1', password: 'test-password-123' }) } });
  assert.ok(reply.body.includes('window.top.postMessage('));
  assert.ok(reply.body.includes('"ok":true'));
  assert.ok(!reply.body.includes('test-password-123'));
  assert.ok(!f.context.safeJson_('</script>\u2028').includes('</script>'));
  const health = JSON.parse(f.context.doGet({ parameter: { action: 'save' } }).body);
  assert.equal(health.transport, 'POST');
});

test('錯誤試算表標記及破壞表頭均停止操作', () => {
  const f = fixture();
  f.book.getSheetByName('系統設定').rows[0][1] = 'single-domain';
  assert.throws(() => f.context.setupInterdisciplinary(), /不是跨領域/);
  f.book.getSheetByName('系統設定').rows[0][1] = 'interdisciplinary-2026-v1';
  f.book.getSheetByName('評核資料').rows[0][3] = 'badColumn';
  assert.throws(() => f.login('reviewer1'), /欄位/);
});

function accountSettings(f, changes = {}) {
  const values = { admin: 'test_manager', reviewer1: 'member_alpha', reviewer2: 'member_beta', reviewer3: 'member_gamma', ...changes };
  for (const [alias, value] of Object.entries(values)) f.properties.set('ACCOUNT_' + alias.toUpperCase(), value);
  return values;
}

test('設定帳密相同，遷移既有評分歸屬、保留其餘欄位，舊登入失效', () => {
  const f = fixture(), oldToken = f.login('reviewer1').token;
  f.context.dispatch_(score({ token: oldToken, comment: '=Comment with quotes " and text' }));
  const before = f.book.getSheetByName('評核資料').rows[1].slice(1);
  const values = accountSettings(f);
  assert.equal(f.context.applyAccountCodesFromProperties(), 4);
  assert.equal(f.book.getSheetByName('評核資料').rows[1][0], values.reviewer1);
  assert.deepEqual(f.book.getSheetByName('評核資料').rows[1].slice(1), before);
  assert.equal(f.properties.has('ACCOUNT_REVIEWER1'), false);
  const result = f.context.dispatch_({ action: 'login', username: values.reviewer1, password: values.reviewer1 });
  assert.equal(result.name, '柯雅婷 督導');
  assert.equal(f.context.dispatch_({ action: 'load', token: result.token }).rows.length, 1);
  raisesCode(() => f.context.dispatch_({ action: 'load', token: oldToken }), 'SESSION_EXPIRED');
  for (const alias of ['admin', 'reviewer2', 'reviewer3']) {
    assert.equal(f.context.dispatch_({ action: 'login', username: values[alias], password: values[alias] }).role, alias === 'admin' ? 'admin' : 'reviewer');
  }
  // 再次設定由姓名與角色定位，不能新增重複帳號或遺失評分。
  accountSettings(f); f.context.applyAccountCodesFromProperties();
  assert.equal(f.book.getSheetByName('評審帳號').getLastRow(), 5);
  assert.equal(f.book.getSheetByName('評核資料').getLastRow(), 2);
});

test('支援四字元密碼及四字元帳密相同設定', () => {
  const f = fixture();
  f.properties.set('PASSWORD_ADMIN', 'four'); f.context.setPasswordsFromProperties();
  assert.equal(f.context.dispatch_({ action: 'login', username: 'admin', password: 'four' }).role, 'admin');
  accountSettings(f, { admin: 'root' }); f.context.applyAccountCodesFromProperties();
  assert.equal(f.context.dispatch_({ action: 'login', username: 'root', password: 'root' }).role, 'admin');
});

test('帳號設定缺漏或重複時不改帳號、保留待處理屬性', () => {
  const f = fixture(), sheet = f.book.getSheetByName('評審帳號');
  const before = JSON.stringify(sheet.rows);
  accountSettings(f); f.properties.delete('ACCOUNT_REVIEWER3');
  assert.throws(() => f.context.applyAccountCodesFromProperties(), /ACCOUNT_REVIEWER3/);
  assert.equal(JSON.stringify(sheet.rows), before);
  accountSettings(f, { reviewer3: 'member_alpha' });
  assert.throws(() => f.context.applyAccountCodesFromProperties(), /不可重複/);
  assert.equal(JSON.stringify(sheet.rows), before);
  assert.equal(f.properties.has('ACCOUNT_ADMIN'), true);
});

test('遷移寫入失敗時還原帳號及評分歸屬', () => {
  const f = fixture(), token = f.login('reviewer1').token;
  f.context.dispatch_(score({ token })); accountSettings(f);
  const users = f.book.getSheetByName('評審帳號'), scores = f.book.getSheetByName('評核資料');
  const beforeUsers = JSON.stringify(users.rows), beforeScores = JSON.stringify(scores.rows);
  const getRange = scores.getRange.bind(scores); let failed = false;
  scores.getRange = (...args) => {
    const range = getRange(...args), setValues = range.setValues.bind(range);
    range.setValues = values => {
      if (!failed) { failed = true; throw new Error('Simulated write failure'); }
      return setValues(values);
    };
    return range;
  };
  assert.throws(() => f.context.applyAccountCodesFromProperties(), /已還原/);
  assert.equal(JSON.stringify(users.rows), beforeUsers);
  assert.equal(JSON.stringify(scores.rows), beforeScores);
  assert.equal(f.properties.has('ACCOUNT_ADMIN'), true);
});
