/** 跨領域 OSCE 專用後端。貼入新的 Apps Script 專案，勿覆蓋單領域後端。 */
const OSCE = Object.freeze({
  competition: 'interdisciplinary-2026-v1',
  spreadsheetName: '115年跨領域OSCE教案甄選評核',
  defaultOrigin: 'https://luyun1224.github.io',
  sessionSeconds: 21600,
  usersSheet: '評審帳號', scoresSheet: '評核資料', metaSheet: '系統設定',
  usersHeader: ['username','name','role','passwordSalt','passwordHash','active'],
  scoreHeader: ['username','caseId','title','c1','c2','c3','c4','c5','c6','c7','c8','c9','c10','bonus','baseScore','totalScore','comment','updatedAt'],
  users: [
    ['admin','管理者','admin'],
    ['reviewer1','柯雅婷 督導','reviewer'],
    ['reviewer2','劉韋呈 醫師','reviewer'],
    ['reviewer3','蔡長志 主任','reviewer']
  ],
  cases: ['復健部-物理治療','臨床病理部','腦中風中心','品管部-01','品管部-02']
});

/** 首次執行：自動建立獨立試算表。重跑保留所有帳號與評分。 */
function setupInterdisciplinary() {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    let id = props.getProperty('SPREADSHEET_ID');
    let ss;
    if (id) { ss = SpreadsheetApp.openById(id); assertCompetition_(ss); }
    else {
      ss = SpreadsheetApp.create(OSCE.spreadsheetName);
      ss.setSpreadsheetTimeZone('Asia/Taipei');
      const meta = ss.getSheets()[0]; meta.setName(OSCE.metaSheet);
      meta.getRange(1,1,1,2).setValues([['competition',OSCE.competition]]);
      props.setProperty('SPREADSHEET_ID',ss.getId());
    }
    if (!props.getProperty('AUTH_PEPPER')) props.setProperty('AUTH_PEPPER',randomToken_());
    if (!props.getProperty('ALLOWED_ORIGINS')) props.setProperty('ALLOWED_ORIGINS',OSCE.defaultOrigin);
    ensureSheet_(ss,OSCE.usersSheet,OSCE.usersHeader);
    ensureSheet_(ss,OSCE.scoresSheet,OSCE.scoreHeader);
    const users = ss.getSheetByName(OSCE.usersSheet);
    if (users.getLastRow() === 1) {
      users.getRange(2,1,OSCE.users.length,6).setValues(OSCE.users.map(u=>[...u,'','',false]));
    }
    console.log('跨領域獨立試算表：'+ss.getUrl());
    return ss.getUrl();
  } finally { lock.releaseLock(); }
}

/** 在專案「指令碼屬性」填 PASSWORD_ADMIN / PASSWORD_REVIEWER1…3，再執行。
 * 密碼不寫入原始碼或試算表；設定成功後刪除暫存密碼屬性。
 * 可只填一位以更新該位密碼；該位所有舊登入立即失效。 */
function setPasswordsFromProperties() {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    const sheet = spreadsheet_().getSheetByName(OSCE.usersSheet);
    const rows = sheet.getDataRange().getValues();
    let count = 0;
    // 先驗證全部輸入，避免設定一半後才發現短密碼。
    for (let i=1;i<rows.length;i++) {
      const key = 'PASSWORD_'+String(rows[i][0]).toUpperCase();
      const password = props.getProperty(key);
      if (password !== null && (password.length<8 || password.length>128)) {
        throw new Error(key+' 須為 8–128 個字元。');
      }
    }
    for (let i=1;i<rows.length;i++) {
      const username=String(rows[i][0]);
      const key='PASSWORD_'+username.toUpperCase(), password=props.getProperty(key);
      if (password === null) continue;
      const salt=randomToken_();
      sheet.getRange(i+1,4,1,3).setValues([[salt,passwordHash_(username,salt,password),true]]);
      props.deleteProperty(key);
      CacheService.getScriptCache().remove('fail:'+username);
      count++;
    }
    console.log('已設定 '+count+' 位帳號的密碼；暫存密碼屬性已移除。');
    return count;
  } finally { lock.releaseLock(); }
}

/** GET 僅為狀態檢查，不接受登入／修改評分。 */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ok:true,service:OSCE.competition,transport:'POST'}))
    .setMimeType(ContentService.MimeType.JSON);
}

/** GitHub Pages 使用隱藏表單 POST；HtmlService 回覆 postMessage，無須停用 CORS。 */
function doPost(e) {
  const params=(e && e.parameter)||{};
  const requestId=String(params.requestId||''), origin=String(params.returnOrigin||'');
  if (!/^osce_[a-f0-9]{48}$/.test(requestId) || !allowedOrigin_(origin)) {
    return HtmlService.createHtmlOutput('不允許的請求來源。');
  }
  let result;
  try {
    const raw=String(params.payload||'');
    if (raw.length>20000) throw new Error('請求內容過長。');
    const payload=JSON.parse(raw);
    result=dispatch_(payload);
  } catch (error) {
    // 不回傳堆疊、試算表 ID、密碼、token 或原始輸入。
    result={ok:false,error:error.publicMessage||'服務無法完成請求，請聯絡管理者確認部署及資料表設定。',code:error.code||'SERVER_ERROR'};
  }
  const data=safeJson_({requestId:requestId,result:result});
  const target=safeJson_(origin);
  return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><script>window.top.postMessage('+data+','+target+');</script>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function dispatch_(payload) {
  if (!payload || typeof payload!=='object' || Array.isArray(payload)) fail_('請求格式不正確。','BAD_REQUEST');
  if (payload.action==='login') return login_(payload);
  const session=session_(payload.token);
  if (payload.action==='logout') {
    CacheService.getScriptCache().remove(sessionKey_(payload.token));
    return {ok:true};
  }
  if (payload.action==='load') return load_(session);
  if (payload.action==='save') return save_(session,payload);
  fail_('不支援的操作。','BAD_REQUEST');
}

function login_(payload) {
  const username=typeof payload.username==='string'?payload.username.trim():'';
  const password=typeof payload.password==='string'?payload.password:'';
  if (!/^[A-Za-z0-9_]{1,40}$/.test(username) || password.length>128) fail_('帳號或密碼錯誤。','AUTH_FAILED');
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const cache=CacheService.getScriptCache();
    const failKey='fail:'+username, failures=Number(cache.get(failKey)||0);
    if (failures>=10) fail_('登入失敗次數過多，請 15 分鐘後重試。','RATE_LIMIT');
    const user=users_().find(u=>u.username===username);
    const valid=user && user.active && user.passwordHash && user.passwordSalt &&
      same_(passwordHash_(username,user.passwordSalt,password),user.passwordHash);
    if (!valid) { cache.put(failKey,String(failures+1),900); fail_('帳號或密碼錯誤。','AUTH_FAILED'); }
    cache.remove(failKey);
    const token=randomToken_();
    cache.put(sessionKey_(token),JSON.stringify({username:user.username,stamp:user.passwordHash,expires:Date.now()+OSCE.sessionSeconds*1000}),OSCE.sessionSeconds);
    return {ok:true,username:user.username,name:user.name,role:user.role,token:token};
  } finally { lock.releaseLock(); }
}

function session_(token) {
  if (typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)) fail_('登入已過期，請登出後重新登入。','SESSION_EXPIRED');
  const raw=CacheService.getScriptCache().get(sessionKey_(token));
  if (!raw) fail_('登入已過期，請登出後重新登入。','SESSION_EXPIRED');
  const session=JSON.parse(raw), user=users_().find(u=>u.username===session.username);
  if (!user || !user.active || user.passwordHash!==session.stamp || session.expires<=Date.now()) {
    fail_('登入已過期，請登出後重新登入。','SESSION_EXPIRED');
  }
  return user;
}

function load_(user) {
  const reviewers=users_().filter(u=>u.role==='reviewer'&&u.active).map(u=>({username:u.username,name:u.name}));
  const rows=spreadsheet_().getSheetByName(OSCE.scoresSheet).getDataRange().getValues().slice(1)
    .filter(r=>r[0] && (user.role==='admin'||String(r[0])===user.username))
    .map(r=>{
      const scores={};for(let i=0;i<10;i++) scores['c'+(i+1)]=Number(r[i+3]);
      const checked=validateScore_({caseId:Number(r[1]),scores:scores,bonus:Number(r[13]),comment:String(r[16]||'')});
      return {username:String(r[0]),caseId:checked.caseId,scores:checked.scores,bonus:checked.bonus,comment:checked.comment,
        baseScore:checked.baseScore,totalScore:checked.totalScore,updatedAt:r[17] instanceof Date?r[17].toISOString():String(r[17]||'')};
    });
  return {ok:true,rows:rows,reviewers:reviewers};
}

function save_(user,payload) {
  if(user.role!=='reviewer') fail_('只有評審可以填寫評分。','FORBIDDEN');
  const checked=validateScore_(payload);
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    const sheet=spreadsheet_().getSheetByName(OSCE.scoresSheet);
    const values=sheet.getDataRange().getValues();
    const matches=[];
    for(let i=1;i<values.length;i++) if(String(values[i][0])===user.username&&Number(values[i][1])===checked.caseId) matches.push(i+1);
    if(matches.length>1) fail_('資料表有重複評分紀錄，請管理者檢查。','DATA_ERROR');
    const updatedAt=new Date().toISOString();
    const row=[user.username,checked.caseId,OSCE.cases[checked.caseId-1],
      ...Array.from({length:10},(_,i)=>checked.scores['c'+(i+1)]),checked.bonus,checked.baseScore,checked.totalScore,sheetText_(checked.comment),updatedAt];
    sheet.getRange(matches[0]||sheet.getLastRow()+1,1,1,row.length).setValues([row]);
    SpreadsheetApp.flush();
    return {ok:true,baseScore:checked.baseScore,totalScore:checked.totalScore,updatedAt:updatedAt};
  } finally {lock.releaseLock();}
}

function validateScore_(payload) {
  if (!Number.isInteger(payload.caseId)||payload.caseId<1||payload.caseId>OSCE.cases.length) fail_('教案組別不正確。','BAD_SCORE');
  const source=payload.scores;
  if(!source||typeof source!=='object'||Array.isArray(source)) fail_('請填完全部十個評分項目。','BAD_SCORE');
  const scores={};let baseScore=0;
  for(let i=1;i<=10;i++) {
    const v=source['c'+i];
    if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>10||!Number.isInteger(v*2)) fail_('每項須為 0–10 分，以 0.5 分為單位。','BAD_SCORE');
    scores['c'+i]=v;baseScore+=v;
  }
  const bonus=payload.bonus;
  if(typeof bonus!=='number'||!Number.isFinite(bonus)||bonus<0||bonus>10||!Number.isInteger(bonus*2)) fail_('加分須為 0–10 分，以 0.5 分為單位。','BAD_SCORE');
  if(typeof payload.comment!=='string'||payload.comment.length>5000) fail_('評審意見須為文字，最多 5000 字。','BAD_SCORE');
  const comment=payload.comment.trim();
  if(bonus>0&&!comment) fail_('加分須填寫特殊優良表現說明。','BAD_SCORE');
  return {caseId:payload.caseId,scores:scores,bonus:bonus,comment:comment,baseScore:baseScore,totalScore:Math.min(100,baseScore+bonus)};
}

function users_() {
  return spreadsheet_().getSheetByName(OSCE.usersSheet).getDataRange().getValues().slice(1)
    .filter(r=>r[0]).map(r=>{
      const role=String(r[2]);
      if(role!=='admin'&&role!=='reviewer') throw new Error('帳號角色設定不正確。');
      return {username:String(r[0]),name:String(r[1]),role:role,passwordSalt:String(r[3]),passwordHash:String(r[4]),active:r[5]===true};
    });
}
function spreadsheet_() {
  const id=PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if(!id) throw new Error('請先執行 setupInterdisciplinary。');
  const ss=SpreadsheetApp.openById(id);assertCompetition_(ss);
  for(const [name,header] of [[OSCE.usersSheet,OSCE.usersHeader],[OSCE.scoresSheet,OSCE.scoreHeader]]) {
    const sheet=ss.getSheetByName(name);
    if(!sheet||JSON.stringify(sheet.getRange(1,1,1,header.length).getValues()[0])!==JSON.stringify(header)) throw new Error('試算表欄位不符合跨領域版本。');
  }
  return ss;
}
function assertCompetition_(ss) {
  const sheet=ss.getSheetByName(OSCE.metaSheet);
  if(!sheet||sheet.getRange(1,2).getValue()!==OSCE.competition) throw new Error('此試算表不是跨領域專用表，已停止操作以保護原有資料。');
}
function ensureSheet_(ss,name,header) {
  let sheet=ss.getSheetByName(name);
  if(!sheet) {sheet=ss.insertSheet(name);sheet.getRange(1,1,1,header.length).setValues([header]);sheet.setFrozenRows(1);}
  else if(JSON.stringify(sheet.getRange(1,1,1,header.length).getValues()[0])!==JSON.stringify(header)) throw new Error('既有工作表欄位不符，未覆蓋資料。');
}
function allowedOrigin_(origin) {
  const configured=PropertiesService.getScriptProperties().getProperty('ALLOWED_ORIGINS')||OSCE.defaultOrigin;
  return origin!=='' && configured.split(',').map(s=>s.trim()).includes(origin);
}
function passwordHash_(username,salt,password) {
  const pepper=PropertiesService.getScriptProperties().getProperty('AUTH_PEPPER');
  if(!pepper) throw new Error('請先初始化後端。');
  return hex_(Utilities.computeHmacSha256Signature(username+'\u0000'+salt+'\u0000'+password,pepper,Utilities.Charset.UTF_8));
}
function randomToken_() {return (Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'').toLowerCase();}
function sessionKey_(token) {return 'session:'+hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,token,Utilities.Charset.UTF_8));}
function hex_(bytes) {return bytes.map(b=>('0'+(b&255).toString(16)).slice(-2)).join('');}
function same_(a,b) {let d=a.length^b.length;for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^(b.charCodeAt(i)||0);return d===0;}
function sheetText_(text) {return /^[\s]*[=+@-]/.test(text)?"'"+text:text;}
function safeJson_(value) {return JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
function fail_(message,code) {const error=new Error(message);error.publicMessage=message;error.code=code;throw error;}
