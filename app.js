/* دفتر حساب - نسخه محلی و قابل نصب روی اندروید */
(() => {
  'use strict';

  const DB_NAME = 'daftar-hesab-db';
  const LEGACY_MIGRATION_KEY = 'dh.legacy-data-migrated';
  const AUTH_CACHE_KEY = 'dh.last-authorized-uid';
  const LOGOUT_SIGNAL_KEY = 'dh.cross-tab-logout';
  const DB_VERSION = 1;
  const STORE_NAME = 'app';
  const DEFAULT_CATEGORIES = [
    {name:'آرایشی و بهداشتی', subs:['محصولات آرایشی','مراقبت پوست','مراقبت مو','محصولات بهداشتی','عطر و ادکلن']},
    {name:'پوشاک', subs:[]}, {name:'لوازم خانگی', subs:[]}, {name:'مواد غذایی', subs:[]},
    {name:'لوازم الکترونیکی', subs:[]}, {name:'سایر کالاها', subs:[]}
  ];
  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const id = () => 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmt = value => new Intl.NumberFormat('fa-IR', {maximumFractionDigits: 2}).format(Number(value || 0));
  const money = (value, ws=activeWs()) => `${fmt(value)} ${escapeHtml(ws?.currency || 'تومان')}`;
  const persianDateParts = value => {
    const d = value instanceof Date ? value : new Date(`${value}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {year:'numeric',month:'numeric',day:'numeric',timeZone:'UTC'}).formatToParts(d);
    const get = type => Number(parts.find(x => x.type === type)?.value || 0);
    return {year:get('year'),month:get('month'),day:get('day')};
  };
  const toPersianDigits = value => String(value).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  const toLatinDigits = value => String(value).replace(/[۰-۹٠-٩]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d) >= 0 ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(d) : '٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const dateFa = value => {
    if (!value) return '—';
    const d = new Date(`${value}T12:00:00`);
    if (Number.isNaN(d.getTime())) return value;
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
  };
  const jalaliInput = iso => {
    if (!iso) return '';
    const p = persianDateParts(iso);
    return p ? toPersianDigits(`${p.year}/${String(p.month).padStart(2,'0')}/${String(p.day).padStart(2,'0')}`) : iso;
  };
  function jalaliToIso(raw) {
    const normalized = toLatinDigits(String(raw || '').trim()).replace(/[.\-]/g,'/');
    const m = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) throw new Error('تاریخ را به شکل سال/ماه/روز شمسی وارد کنید؛ مانند ۱۴۰۵/۰۸/۲۸.');
    const jy=Number(m[1]), jm=Number(m[2]), jd=Number(m[3]);
    if (jy<1200 || jy>1600 || jm<1 || jm>12 || jd<1 || jd>(jm<=6?31:jm<=11?30:30)) throw new Error('تاریخ شمسی معتبر نیست.');
    const gyGuess=jy+621; let start=null;
    for(let day=17;day<=23;day++){
      const candidate=new Date(Date.UTC(gyGuess,2,day,12)); const parts=persianDateParts(candidate);
      if(parts?.year===jy && parts.month===1 && parts.day===1){start=candidate;break;}
    }
    if(!start) throw new Error('تبدیل این تاریخ شمسی ممکن نشد.');
    const offset=(jm<=6?(jm-1)*31:(jm<=11?186+(jm-7)*30:336))+jd-1;
    const result=new Date(start.getTime()+offset*86400000);
    const check=persianDateParts(result);
    if(!check || check.year!==jy || check.month!==jm || check.day!==jd) throw new Error('این روز در تقویم شمسی معتبر نیست.');
    return `${result.getUTCFullYear()}-${String(result.getUTCMonth()+1).padStart(2,'0')}-${String(result.getUTCDate()).padStart(2,'0')}`;
  }
  function currentJalaliMonthStart(){const p=persianDateParts(today());return jalaliToIso(`${p.year}/${p.month}/1`);}
  const num = value => Number(String(value ?? '').replace(/[٬,]/g,'').trim()) || 0;
  const sum = arr => arr.reduce((a,b)=>a + Number(b || 0),0);
  const uid = value => String(value || '');

  let db, data, page='dashboard', selectedCustomerId=null, currentSearch='', reportStart='', reportEnd='', modalMode=null;
  let pageStack=[], calendarState=null, cloudStatus='not-configured', cloudUser=null, cloudSyncReady=false, cloudSyncBusy=false, cloudSyncTimer=null, suppressCloudSync=false;
  let accessGranted=false, accessUid=null, activeDatabaseUid=null, offlineSession=false, authReady=false, manualLoginInProgress=false, accessWatchUnsubscribe=null, authTransitionPromise=null, authTransitionUid=null, reconnectPromise=null, syncEpoch=0;
  let lastSeenLogoutSignal='', logoutChannel=null;

  function openDb(name=DB_NAME){
    return new Promise((resolve,reject)=>{
      const request = indexedDB.open(name, DB_VERSION);
      request.onupgradeneeded = () => { const database=request.result; if(!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME,{keyPath:'key'}); };
      request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
    });
  }
  function dbGet(){ return new Promise((resolve,reject)=>{const tx=db.transaction(STORE_NAME,'readonly');const req=tx.objectStore(STORE_NAME).get('main');req.onsuccess=()=>resolve(req.result?.value || null);req.onerror=()=>reject(req.error);}); }
  function dbSave(options={}){
    if(activeDatabaseUid&&!options.allowSessionSetup&&!sessionAllowedForCurrentTab())return Promise.reject(new Error('نشست کاربر فعال نیست؛ ذخیره متوقف شد.'));
    const touch=options.touch!==false, queue=options.queue!==false; if(touch&&data&&!suppressCloudSync){data._meta={...(data._meta||{}),updatedAt:Date.now()};} return new Promise((resolve,reject)=>{if(!db){reject(new Error('پایگاه داده فعال نیست.'));return;}const tx=db.transaction(STORE_NAME,'readwrite');tx.objectStore(STORE_NAME).put({key:'main',value:data});tx.oncomplete=()=>{resolve();if(queue&&!suppressCloudSync&&cloudSyncReady)scheduleCloudSync();};tx.onerror=()=>reject(tx.error);});
  }
  function safeLocalGet(key){try{return localStorage.getItem(key)||'';}catch(_){return '';}}
  function safeLocalSet(key,value){try{localStorage.setItem(key,String(value));}catch(err){console.warn('Local session cache unavailable:',err);}}
  function safeLocalRemove(key){try{localStorage.removeItem(key);}catch(_){}}
  function parseLogoutSignal(raw){try{return raw?JSON.parse(raw):null;}catch(_){return null;}}
  function processLogoutSignal(raw){
    if(!raw||raw===lastSeenLogoutSignal)return false;
    lastSeenLogoutSignal=raw;
    const signal=parseLogoutSignal(raw);
    if(signal?.type==='logout'&&signal.uid&&signal.uid===accessUid){
      const oldUid=signal.uid;
      clearAuthorizedUid(oldUid);cloudUser=null;
      lockApplication('signed-out',{clearCache:true,clearIdentity:true,uid:oldUid}).catch(err=>console.error('Cross-tab logout:',err));
      return true;
    }
    return false;
  }
  function sessionAllowedForCurrentTab(){
    if(!accessGranted||!accessUid||!data||!db||activeDatabaseUid!==accessUid)return false;
    const raw=safeLocalGet(LOGOUT_SIGNAL_KEY);
    if(raw&&raw!==lastSeenLogoutSignal&&processLogoutSignal(raw))return false;
    if(!raw)lastSeenLogoutSignal='';
    return accessGranted&&!!data&&!!db&&activeDatabaseUid===accessUid;
  }
  function publishCrossTabLogout(uid){
    if(!uid)return;
    const raw=JSON.stringify({type:'logout',uid,at:Date.now(),nonce:id()});
    lastSeenLogoutSignal=raw;safeLocalSet(LOGOUT_SIGNAL_KEY,raw);
    try{logoutChannel?.postMessage(raw);}catch(err){console.warn('BroadcastChannel logout:',err);}
  }
  function initializeCrossTabLogout(){
    lastSeenLogoutSignal=safeLocalGet(LOGOUT_SIGNAL_KEY);
    try{if('BroadcastChannel' in window){logoutChannel=new BroadcastChannel('daftar-hesab-auth');logoutChannel.onmessage=e=>processLogoutSignal(e.data);}}catch(err){console.warn('BroadcastChannel unavailable:',err);}
    window.addEventListener('storage',e=>{if(e.key===LOGOUT_SIGNAL_KEY&&e.newValue)processLogoutSignal(e.newValue);});
  }
  function userDbName(uid){return `${DB_NAME}-${String(uid).replace(/[^a-zA-Z0-9_-]/g,'_')}`;}
  function readMainFrom(database){return new Promise((resolve,reject)=>{const tx=database.transaction(STORE_NAME,'readonly'),req=tx.objectStore(STORE_NAME).get('main');req.onsuccess=()=>resolve(req.result?.value||null);req.onerror=()=>reject(req.error);});}
  async function openUserDatabase(uid){
    const requestEpoch=syncEpoch, databaseName=userDbName(uid);
    if(db){try{db.close();}catch(_){}db=null;}
    activeDatabaseUid=null;
    const targetDb=await openDb(databaseName);
    const stillCurrent=()=>syncEpoch===requestEpoch&&accessUid===uid;
    if(!stillCurrent()){targetDb.close();return false;}
    db=targetDb;
    data=await readMainFrom(targetDb);
    if(!stillCurrent()||db!==targetDb){targetDb.close();if(db===targetDb){db=null;data=null;}return false;}
    let markLegacyMigration=false;
    if(!safeLocalGet(LEGACY_MIGRATION_KEY)){
      if(data&&Array.isArray(data.workspaces)&&data.workspaces.length){
        // اگر این UID از قبل پایگاه داده اختصاصی دارد، داده قدیمی را به حساب بعدی منتقل نکن.
        markLegacyMigration=true;
      }else{
        let legacy=null,oldDb=null;
        try{oldDb=await openDb(DB_NAME);legacy=await readMainFrom(oldDb);}catch(err){console.warn('Legacy database migration check:',err);}finally{try{oldDb?.close();}catch(_){}}
        if(!stillCurrent()||db!==targetDb){targetDb.close();if(db===targetDb){db=null;data=null;}return false;}
        if(legacy&&Array.isArray(legacy.workspaces)&&legacy.workspaces.length){
          if(!hasBusinessData(legacy)||confirm('اطلاعات محلی نسخه قبلی پیدا شد. آیا این اطلاعات به حساب فعلی شما منتقل شود؟ این انتقال فقط یک بار روی این دستگاه انجام می‌شود.'))data=legacy;
        }
        // حتی اگر کاربر انتقال را نپذیرد، این داده‌های قدیمی به UID دیگری منتقل نمی‌شوند.
        markLegacyMigration=true;
      }
    }
    if(!stillCurrent()||db!==targetDb){targetDb.close();if(db===targetDb){db=null;data=null;}return false;}
    if(!data||!Array.isArray(data.workspaces)||!data.workspaces.length){
      const w=newWorkspace();data={activeWorkspaceId:w.id,workspaces:[w],_meta:{updatedAt:Date.now(),lastSyncedCloudUpdatedAt:null}};
    }
    data.workspaces=data.workspaces.map(cleanWorkspace);
    if(!data.workspaces.some(w=>w.id===data.activeWorkspaceId))data.activeWorkspaceId=data.workspaces[0].id;
    data._meta={...(data._meta||{}),updatedAt:Number(data._meta?.updatedAt||Date.now()),lastSyncedCloudUpdatedAt:data._meta?.lastSyncedCloudUpdatedAt||null};
    try{await dbSave({touch:false,queue:false,allowSessionSetup:true});}catch(err){if(!stillCurrent()||db!==targetDb)return false;throw err;}
    if(!stillCurrent()||db!==targetDb)return false;
    activeDatabaseUid=uid;
    if(markLegacyMigration&&!safeLocalGet(LEGACY_MIGRATION_KEY))safeLocalSet(LEGACY_MIGRATION_KEY,uid);
    return true;
  }
  function cachedAuthorizedUid(){return safeLocalGet(AUTH_CACHE_KEY);}
  function cacheAuthorizedUid(uid){safeLocalSet(AUTH_CACHE_KEY,uid);}
  function clearAuthorizedUid(uid=''){if(!uid||cachedAuthorizedUid()===uid)safeLocalRemove(AUTH_CACHE_KEY);}
  function showAccessGate(mode='login',opts={}){
    const gate=$('#access-gate'),content=$('#access-gate-content'),uid=opts.uid||cloudUser?.uid||accessUid||'';
    let title='ورود به دفتر حساب',message='برای استفاده از برنامه، با حساب Google یا GitHub خود وارد شوید. پس از تأیید مدیر برنامه، امکان استفاده از بخش‌های حسابداری و همگام‌سازی فعال می‌شود.';
    if(mode==='not-authorized'){title='دسترسی هنوز فعال نشده';message='ورود حساب موفق بوده، اما مدیر برنامه هنوز دسترسی این شناسه را فعال نکرده است. شناسه زیر را برای مدیر ارسال کنید. پس از فعال‌سازی، «بررسی دوباره» را بزنید.';}
    else if(mode==='revoked'){title='دسترسی برنامه غیرفعال شده';message='این حساب مجوز ورود ندارد . اطلاعات محلی حذف نشده‌اند، اما تا زمان فعال‌سازی دوباره، ورود به محیط برنامه و بازیابی فایل پشتیبان امکان‌پذیر نیست.';}
    else if(mode==='network'){title='اتصال به سرویس ورود برقرار نشد';message=opts.message||'ارتباط با سرویس احراز هویت گوگل/Firebase برقرار نشد. اتصال اینترنت، VPN یا DNS دستگاه را بررسی کنید و دوباره تلاش کنید.';}
    else if(mode==='rules-error'){title='خطا در قوانین دسترسی Firebase';message='درخواست بررسی مجوز به Firestore رسید، اما قوانین امنیتی اجازه خواندن سند access را ندادند. فایل firestore.rules را در بخش Rules منتشر کنید.';}
    else if(mode==='config'){title='تنظیمات فضای ابری ناقص است';message='برای قفل و تأیید کاربران، فایل firebase-config.js باید با تنظیمات پروژه Firebase تکمیل شده باشد.';}
    else if(mode==='signed-out'){title='برای ادامه وارد شوید';message='از حساب قبلی خارج شده‌اید. برای استفاده از اطلاعات محلی همین حساب یا دریافت اطلاعات ابری، دوباره با همان حساب وارد شوید.';}
    if(opts.message)message=opts.message;
    const uidHtml=uid?`<div class="access-gate-uid">UID: ${escapeHtml(uid)}</div><button class="btn outline full" data-action="gate-copy-uid">کپی شناسه کاربری</button>`:'';
    const retry=mode==='not-authorized'||mode==='rules-error'?`<button class="btn full" data-action="gate-retry">بررسی دوباره مجوز</button>`:'';
    const networkTest=mode==='network'?`<button class="btn outline full" data-action="gate-test-network">آزمایش اتصال به سرویس‌های ورود</button><div id="gate-network-results" class="tiny muted" style="text-align:right"></div>`:'';
    const signout=(cloudUser||uid)?`<button class="btn outline full" data-action="gate-signout">خروج و انتخاب حساب دیگر</button>`:'';
    content.innerHTML=`<div class="access-gate-mark">د</div><h1 class="access-gate-title">${title}</h1><p class="access-gate-subtitle">مدیریت فروش، حساب مشتریان و انبار</p><div class="access-gate-message">${escapeHtml(message)}</div>${uidHtml}<div class="access-gate-actions">${retry}${networkTest}<button class="btn full" data-action="gate-login-google">ورود با Google</button><button class="btn secondary full" data-action="gate-login-github">ورود با GitHub</button>${signout}</div><div class="access-gate-contact">توسعه‌دهنده: سعید · پشتیبانی: <a href="https://t.me/SS73_z" target="_blank" rel="noopener">@SS73_z</a></div>`;
    $('#app').hidden=true;gate.hidden=false;
  }
  function showAuthorizedApp(){if(!accessUid||activeDatabaseUid!==accessUid||!data||!db)return;accessGranted=true;$('#access-gate').hidden=true;$('#app').hidden=false;render();}
  function isNetworkError(err){const code=String(err?.code||'');const msg=String(err?.message||'').toLowerCase();return !navigator.onLine||['auth/network-request-failed','unavailable','deadline-exceeded','network-request-failed'].includes(code)||msg.includes('failed to fetch')||msg.includes('networkerror')||msg.includes('load failed');}
  function authErrorMessage(err){
    const code=String(err?.code||'');
    if(code==='auth/network-request-failed'||isNetworkError(err)){const authHost=window.DH_FIREBASE_CONFIG?.authDomain||'دامنه Auth پروژه';return `درخواست ورود به سرویس‌های Google/Firebase نرسید یا در مسیر قطع شد. علاوه بر سرویس‌های identitytoolkit.googleapis.com، securetoken.googleapis.com، accounts.google.com و www.gstatic.com، دامنه ${authHost} و مسیر /__/auth/handler نیز باید از شبکه قابل دسترسی باشند. این خطا با افزودن DNS داخل کد حل نمی‌شود؛ VPN یا مسیر اینترنت را بررسی کنید و در صورت مسدود بودن authDomain، راهنمای تغییر دامنه ورود را ببینید.`;}
    if(code==='auth/unauthorized-domain')return 'دامنه فعلی برنامه در Firebase Authentication مجاز نشده است. دامنه میزبان را در Authentication ← Settings ← Authorized domains اضافه کنید.';
    if(code==='auth/popup-blocked'||code==='auth/popup-closed-by-user')return 'پنجره ورود گوگل بسته یا مسدود شد. اجازه بازشدن پنجره‌های ورود را در مرورگر فعال کنید و دوباره تلاش کنید.';
    return err?.message||'خطای نامشخص در ورود رخ داد.';
  }
  async function stopAccessWatch(){if(accessWatchUnsubscribe){try{accessWatchUnsubscribe();}catch(_){}accessWatchUnsubscribe=null;}}
  function startAccessWatch(uid){
    if(!window.DHCloud?.watchAccess||!uid)return;
    stopAccessWatch();
    accessWatchUnsubscribe=window.DHCloud.watchAccess(allowed=>{
      if(allowed){if(!accessGranted&&cloudUser?.uid===uid)authorizeCurrentUser(cloudUser,{fromWatcher:true}).catch(console.error);}
      else if(accessGranted&&accessUid===uid)lockApplication('revoked',{clearCache:true,uid}).then(()=>startAccessWatch(uid));
    },err=>{console.warn('Access watch error:',err);if(err?.code==='permission-denied'&&accessGranted)lockApplication('rules-error',{clearCache:false,uid});});
  }
  async function lockApplication(mode='login',opts={}){
    accessGranted=false;offlineSession=false;cloudSyncReady=false;cloudSyncBusy=false;syncEpoch++;clearTimeout(cloudSyncTimer);await stopAccessWatch();
    if(opts.clearCache)clearAuthorizedUid(opts.uid||accessUid||cloudUser?.uid||'');
    // مودال‌ها بیرون از #app هستند؛ هنگام لغو مجوز باید آن‌ها هم فوراً بسته شوند.
    $('#modal-root').innerHTML='';$('#toast-root').innerHTML='';closeJalaliCalendar();
    if(db){try{db.close();}catch(_){}}db=null;activeDatabaseUid=null;data=null;page='dashboard';pageStack=[];
    if(opts.clearIdentity)accessUid=null;else if(opts.uid)accessUid=opts.uid;
    showAccessGate(mode,{uid:opts.clearIdentity?'':(opts.uid||cloudUser?.uid||accessUid||''),message:opts.message});
  }
  async function authorizeCurrentUser(user,opts={}){
    if(!user?.uid)return false;
    if(authTransitionPromise){
      if(authTransitionUid===user.uid)return authTransitionPromise;
      try{await authTransitionPromise;}catch(_){}
    }
    const attemptEpoch=syncEpoch, logoutMarkerAtStart=safeLocalGet(LOGOUT_SIGNAL_KEY);
    const operation=(async()=>{
      cloudUser=user;accessUid=user.uid;
      try{
        const allowed=await window.DHCloud.checkAccess();
        if(attemptEpoch!==syncEpoch||accessUid!==user.uid||window.DHCloud.currentUser()?.uid!==user.uid)return false;
        if(safeLocalGet(LOGOUT_SIGNAL_KEY)!==logoutMarkerAtStart){await lockApplication('signed-out',{clearCache:true,clearIdentity:true,uid:user.uid});return false;}
        if(!allowed){await stopAccessWatch();await lockApplication('not-authorized',{clearCache:true,uid:user.uid});cloudUser=user;accessUid=user.uid;startAccessWatch(user.uid);return false;}
        lastSeenLogoutSignal=safeLocalGet(LOGOUT_SIGNAL_KEY);
        cacheAuthorizedUid(user.uid);
        const opened=await openUserDatabase(user.uid);
        if(!opened||attemptEpoch!==syncEpoch||accessUid!==user.uid)return false;
        offlineSession=false;cloudStatus='checking';showAuthorizedApp();
        startAccessWatch(user.uid);
        await syncWithCloud({startup:true,firstLogin:!!opts.firstLogin});
        return accessGranted&&accessUid===user.uid;
      }catch(err){
        if(attemptEpoch!==syncEpoch||accessUid!==user.uid)return false;
        console.error('Authorization check failed:',err);
        if(isNetworkError(err)&&cachedAuthorizedUid()===user.uid){
          const opened=await openUserDatabase(user.uid);if(!opened||attemptEpoch!==syncEpoch||accessUid!==user.uid)return false;
          offlineSession=true;cloudSyncReady=false;cloudStatus='offline';showAuthorizedApp();startAccessWatch(user.uid);return true;
        }
        const mode=String(err?.code||'')==='permission-denied'?'rules-error':(isNetworkError(err)?'network':'rules-error');
        await lockApplication(mode,{clearCache:false,uid:user.uid,message:authErrorMessage(err)});cloudUser=user;accessUid=user.uid;startAccessWatch(user.uid);return false;
      }
    })();
    authTransitionPromise=operation;authTransitionUid=user.uid;
    try{return await operation;}finally{if(authTransitionPromise===operation){authTransitionPromise=null;authTransitionUid=null;}}
  }
  async function unlockOffline(uid){
    if(!uid)return false;
    accessUid=uid;cloudUser=window.DHCloud?.currentUser?.()||{uid,email:''};
    const opened=await openUserDatabase(uid);if(!opened||accessUid!==uid)return false;
    offlineSession=true;cloudSyncReady=false;cloudStatus='offline';showAuthorizedApp();return true;
  }
  async function reconnectAndRevalidate(){
    if(!navigator.onLine)return;
    if(reconnectPromise)return reconnectPromise;
    const operation=(async()=>{
      try{
        if(!window.DHCloud?.isConfigured())return;
        const state=await window.DHCloud.initialize();authReady=true;
        if(!state.user){
          if(state.authError&&isNetworkError(state.authError)&&cachedAuthorizedUid()){
            await unlockOffline(cachedAuthorizedUid());
            return;
          }
          await lockApplication('signed-out',{clearCache:true,uid:accessUid});cloudUser=null;return;
        }
        cloudUser=state.user;
        if(!accessUid||state.user.uid!==accessUid){
          if(accessUid&&state.user.uid!==accessUid){clearAuthorizedUid(accessUid);await lockApplication('login',{clearIdentity:true,uid:accessUid});}
          await authorizeCurrentUser(state.user,{startup:true});
          return;
        }
        const allowed=await window.DHCloud.checkAccess();
        if(!allowed){await lockApplication('revoked',{clearCache:true,uid:state.user.uid});cloudUser=state.user;startAccessWatch(state.user.uid);return;}
        cacheAuthorizedUid(state.user.uid);
        if(!accessGranted){const opened=await openUserDatabase(state.user.uid);if(!opened||accessUid!==state.user.uid)return;}
        offlineSession=false;showAuthorizedApp();startAccessWatch(state.user.uid);
        await syncWithCloud({startup:true});
      }catch(err){
        console.warn('Reconnect validation failed:',err);
        if(!accessGranted&&cachedAuthorizedUid()&&isNetworkError(err))await unlockOffline(cachedAuthorizedUid());
        else if(accessGranted&&isNetworkError(err)){offlineSession=true;cloudStatus='offline';if(page==='backup')render();}
        else if(accessGranted&&String(err?.code||'')==='permission-denied')await lockApplication('rules-error',{clearCache:false,uid:accessUid});
      }
    })();
    reconnectPromise=operation;
    try{return await operation;}finally{if(reconnectPromise===operation)reconnectPromise=null;}
  }
  function newWorkspace(name='کسب‌وکار من'){
    return {id:id(),name,currency:'تومان',createdAt:today(),categories:structuredClone(DEFAULT_CATEGORIES),customers:[],products:[],invoices:[],payments:[],expenses:[],adjustments:[],stockMovements:[],allowNegativeStock:false,inventorySort:'high',nextInvoiceNumber:1};
  }
  function activeWs(){ return data?.workspaces?.find(w=>w.id===data.activeWorkspaceId) || data?.workspaces?.[0] || null; }
  function cleanWorkspace(ws){
    const result={...newWorkspace(ws.name || 'کسب‌وکار من'),...ws};
    for(const k of ['categories','customers','products','invoices','payments','expenses','adjustments','stockMovements']) if(!Array.isArray(result[k])) result[k]=[];
    if(typeof result.allowNegativeStock!=='boolean') result.allowNegativeStock=false;
    if(!['high','low','name'].includes(result.inventorySort))result.inventorySort='high';
    result.products=result.products.map(p=>({...p,baseUnit:p.baseUnit||p.unit||'عدد',units:Array.isArray(p.units)&&p.units.length?p.units:[{name:p.unit||'عدد',factor:1}]}));
    if(!result.currency) result.currency='تومان';
    if(!result.nextInvoiceNumber) result.nextInvoiceNumber=result.invoices.length+1;
    return result;
  }
  function saveAndRender(){ if(!sessionAllowedForCurrentTab()){toast('نشست فعال نیست؛ برای ادامه دوباره وارد شوید.');return;}const epoch=syncEpoch;dbSave().then(()=>{if(epoch===syncEpoch&&sessionAllowedForCurrentTab())render();}).catch(err=>{console.error(err);if(accessGranted)toast('ذخیره اطلاعات با خطا روبه‌رو شد. از اطلاعات پشتیبان بگیرید.');}); }
  function toast(message){ const root=$('#toast-root');root.innerHTML=`<div class="toast">${escapeHtml(message)}</div>`;setTimeout(()=>root.innerHTML='',2600); }
  function setPage(next,opts={}){ if(!sessionAllowedForCurrentTab())return; if(next!==page&&!opts.fromPop){pageStack.push({page,selectedCustomerId});try{history.pushState({dhPage:true},'',`#${next}`);}catch(_){}} page=next;currentSearch='';render();window.scrollTo({top:0,behavior:'smooth'}); }
  function goBack(){ if(calendarState){closeJalaliCalendar();return;} if($('#modal-root').innerHTML.trim()){closeModal();return;} if(pageStack.length&&history.state?.dhPage){history.back();return;} if(pageStack.length){const prev=pageStack.pop();page=prev.page;selectedCustomerId=prev.selectedCustomerId;render();return;} if(page!=='dashboard'){page='dashboard';selectedCustomerId=null;render();return;} toast('در صفحه اصلی هستید.'); }
  window.addEventListener('popstate',()=>{if($('#modal-root').innerHTML.trim()){closeModal();return;}if(pageStack.length){const prev=pageStack.pop();page=prev.page;selectedCustomerId=prev.selectedCustomerId;}else{page='dashboard';selectedCustomerId=null;}render();});
  function customerById(customerId){return activeWs().customers.find(c=>c.id===customerId);}
  function productById(productId){return activeWs().products.find(p=>p.id===productId);}
  function productUnits(product){
    if(!product) return [];
    const base=product.baseUnit||product.unit||'عدد';
    const all=[{name:base,factor:1},...(Array.isArray(product.units)?product.units:[])];
    const map=new Map();
    all.forEach(u=>{const name=String(u.name||'').trim(),factor=Number(u.factor||1);if(name&&factor>0&&!map.has(name))map.set(name,{name,factor:name===base?1:factor});});
    return [...map.values()];
  }
  function productStock(ws,productId,excludeInvoiceId=''){
    let total=0;
    for(const m of ws.stockMovements||[]) if(m.productId===productId) total+=(m.type==='in'?1:-1)*Number(m.baseQty||0);
    for(const inv of ws.invoices||[]){
      if(!inv.stockApplied||inv.id===excludeInvoiceId)continue;
      for(const item of inv.items||[]) if(item.productId===productId) total-=Number(item.baseQty??(Number(item.qty||0)*Number(item.unitFactor||1)));
    }
    return total;
  }
  function stockBreakdown(product,total){
    if(Math.abs(total)<0.000001)return '۰';
    if(total<0)return `${fmt(total)} ${escapeHtml(product.baseUnit||product.unit||'عدد')} (کسری)`;
    let remaining=total;const parts=[];
    const units=productUnits(product).sort((a,b)=>b.factor-a.factor);
    for(const unit of units){if(unit.factor<=1)continue;const count=Math.floor((remaining+1e-8)/unit.factor);if(count>0){parts.push(`${fmt(count)} ${escapeHtml(unit.name)}`);remaining-=count*unit.factor;}}
    if(remaining>0.000001)parts.push(`${fmt(remaining)} ${escapeHtml(product.baseUnit||product.unit||'عدد')}`);
    return parts.join(' و ')||`۰ ${escapeHtml(product.baseUnit||product.unit||'عدد')}`;
  }
  function invoiceById(invoiceId){return activeWs().invoices.find(i=>i.id===invoiceId);}
  function customerBalance(c){
    const ws=activeWs();
    const opening=(c.openingType==='credit'?-1:1)*Number(c.openingBalance||0);
    const sales=sum(ws.invoices.filter(i=>i.customerId===c.id).map(i=>i.total));
    const receipts=sum(ws.payments.filter(p=>p.customerId===c.id).map(p=>p.amount));
    const adjust=sum(ws.adjustments.filter(a=>a.customerId===c.id).map(a=>(a.type==='credit'?-1:1)*Number(a.amount||0)));
    return opening+sales-receipts+adjust;
  }
  function invoiceAllocated(invoiceId){
    return sum(activeWs().payments.flatMap(p=>(p.allocations||[]).filter(a=>a.invoiceId===invoiceId).map(a=>a.amount)));
  }
  function invoiceRemaining(invoice){return Math.max(0,Number(invoice.total||0)-invoiceAllocated(invoice.id));}
  function invoiceStatus(invoice){const paid=invoiceAllocated(invoice.id);if(paid<=0)return 'پرداخت نشده';if(paid+0.001>=invoice.total)return 'تسویه شده';return 'بخشی پرداخت شده';}
  function badge(text,type=''){return `<span class="pill ${type}">${escapeHtml(text)}</span>`;}
  function pageHead(title,sub='',action=''){return `<div class="page-head"><div><h1>${title}</h1>${sub?`<p>${sub}</p>`:''}</div>${action}</div>`;}
  function emptyBox(icon,title,sub=''){return `<div class="empty"><div class="empty-icon">${icon}</div><b>${title}</b>${sub?`<div class="small" style="margin-top:4px">${sub}</div>`:''}</div>`;}
  function button(label,action,extra=''){return `<button class="btn ${extra}" data-action="${action}">${label}</button>`;}
  function stat(label,value,note='',cls=''){return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value ${cls}">${value}</div>${note?`<div class="stat-note">${note}</div>`:''}</div>`;}

  function renderDashboard(){
    const ws=activeWs(), sales=sum(ws.invoices.map(i=>i.total)), receipts=sum(ws.payments.map(p=>p.amount)), expenses=sum(ws.expenses.map(e=>e.amount));
    const receivables=sum(ws.customers.map(c=>Math.max(0,customerBalance(c)))), payables=sum(ws.customers.map(c=>Math.max(0,-customerBalance(c))));
    const recent=[...ws.invoices.map(i=>({type:'invoice',date:i.date,amount:i.total,title:`فاکتور ${i.number}`,sub:customerById(i.customerId)?.name||'مشتری حذف‌شده',id:i.id})),...ws.payments.map(p=>({type:'payment',date:p.date,amount:p.amount,title:'دریافت وجه',sub:customerById(p.customerId)?.name||'مشتری حذف‌شده',id:p.id}))].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6);
    return `${pageHead('نمای کلی',`خلاصه وضعیت ${escapeHtml(ws.name)}`,`<button class="btn small-btn" data-action="switch-workspace">تغییر کسب‌وکار</button>`)}
      <div class="stats-grid">
        ${stat('مجموع فروش',money(sales,ws),'از ابتدای ثبت اطلاعات')}
        ${stat('مجموع دریافتی',money(receipts,ws),'تمام پرداخت‌های ثبت‌شده','green')}
        ${stat('طلب از مشتریان',money(receivables,ws),'مانده مثبت حساب‌ها','orange')}
        ${stat('بدهی به مشتریان',money(payables,ws),'مانده منفی حساب‌ها','red')}
      </div>
      <div class="card"><h3 class="card-title">ثبت سریع</h3><div class="quick-grid">
        <button class="quick-tile" data-action="add-invoice"><span class="quick-icon">＋</span><span><b>فاکتور فروش</b><small>ثبت فروش جدید</small></span></button>
        <button class="quick-tile" data-action="add-payment"><span class="quick-icon">↙</span><span><b>دریافت وجه</b><small>ثبت پرداخت مشتری</small></span></button>
        <button class="quick-tile" data-action="add-customer"><span class="quick-icon">♙</span><span><b>مشتری جدید</b><small>ساخت پرونده مشتری</small></span></button>
        <button class="quick-tile" data-action="add-expense"><span class="quick-icon">−</span><span><b>ثبت هزینه</b><small>هزینه‌های کسب‌وکار</small></span></button>
        <button class="quick-tile" data-action="go-inventory"><span class="quick-icon">▤</span><span><b>موجودی انبار</b><small>ورود و خروج کالا</small></span></button>
      </div></div>
      <div class="card"><div class="page-head" style="margin:0 0 5px"><h3 class="card-title" style="margin:0">آخرین فعالیت‌ها</h3><button class="text-link" data-action="go-invoices">مشاهده فاکتورها</button></div>
      ${recent.length?`<div class="list">${recent.map(x=>`<div class="list-row"><div class="row-main"><div class="row-title">${escapeHtml(x.title)}</div><div class="row-sub">${escapeHtml(x.sub)} · ${dateFa(x.date)}</div></div><div class="row-end"><div class="amount">${money(x.amount,ws)}</div>${badge(x.type==='invoice'?'فروش':'دریافت',x.type==='invoice'?'orange-pill':'green-pill')}</div></div>`).join('')}</div>`:emptyBox('▤','هنوز فعالیتی ثبت نشده','برای شروع، یک مشتری و سپس فاکتور فروش ثبت کنید.')}</div>
      <div class="card"><h3 class="card-title">یادآوری</h3><div class="notice">اطلاعات ابتدا در حافظه محلی همین مرورگر ذخیره می‌شود و در صورت فعال بودن مجوز ابری، با Firebase همگام خواهد شد. برای اطمینان، از بخش «بیشتر ← پشتیبان و خروجی» نیز مرتباً فایل پشتیبان تهیه کنید.</div></div>`;
  }

  function renderCustomers(){
    const ws=activeWs(), q=currentSearch.trim().toLowerCase();
    const rows=ws.customers.filter(c=>`${c.name} ${c.phone||''} ${c.kind||''}`.toLowerCase().includes(q));
    return `${pageHead('مشتریان','پرونده اشخاص و فروشگاه‌ها',button('＋ مشتری جدید','add-customer'))}
      <div class="toolbar"><div class="search"><input data-search placeholder="جست‌وجوی نام یا شماره تماس..." value="${escapeHtml(currentSearch)}"></div><span class="pill">${fmt(rows.length)} مشتری</span></div>
      <div class="card">${rows.length?`<div class="list">${rows.map(c=>{const bal=customerBalance(c);return `<div class="list-row"><div class="row-main"><button class="text-link" style="padding:0;text-align:right" data-action="view-customer" data-id="${c.id}"><span class="row-title">${escapeHtml(c.name)}</span></button><div class="row-sub">${c.kind==='store'?'فروشگاه':'شخص'}${c.phone?' · '+escapeHtml(c.phone):''}</div></div><div class="row-end"><div class="amount ${bal>0?'orange':bal<0?'green':''}">${money(Math.abs(bal),ws)}</div>${badge(bal>0?'بدهکار':bal<0?'بستانکار':'تسویه',bal>0?'orange-pill':bal<0?'green-pill':'')}</div><button class="text-link" data-action="view-customer" data-id="${c.id}">›</button></div>`;}).join('')}</div>`:emptyBox('♙','مشتری‌ای پیدا نشد','با دکمه مشتری جدید، اولین پرونده را بسازید.')}</div>`;
  }

  function renderCustomerDetail(){
    const ws=activeWs(), c=customerById(selectedCustomerId); if(!c){page='customers';return renderCustomers();}
    const bal=customerBalance(c);
    const customerSales=sum(ws.invoices.filter(i=>i.customerId===c.id).map(i=>i.total));
    const customerReceipts=sum(ws.payments.filter(p=>p.customerId===c.id).map(p=>p.amount));
    const tx=[];
    tx.push({date:c.createdAt||today(),type:'opening',title:'مانده اول دوره',amount:(c.openingType==='credit'?-1:1)*Number(c.openingBalance||0)});
    ws.invoices.filter(i=>i.customerId===c.id).forEach(i=>tx.push({date:i.date,type:'invoice',title:`فاکتور ${i.number}`,amount:i.total,id:i.id}));
    ws.payments.filter(p=>p.customerId===c.id).forEach(p=>tx.push({date:p.date,type:'payment',title:'دریافت وجه',amount:-p.amount,id:p.id}));
    ws.adjustments.filter(a=>a.customerId===c.id).forEach(a=>tx.push({date:a.date,type:'adjustment',title:a.reason||'اصلاح حساب',amount:(a.type==='credit'?-1:1)*a.amount,id:a.id}));
    tx.sort((a,b)=>a.date.localeCompare(b.date)); let running=0; tx.forEach(t=>{running+=t.amount;t.balance=running;});
    return `${pageHead('پرونده مشتری',`گردش حساب ${escapeHtml(c.name)}`,`<button class="btn small-btn secondary" data-action="edit-customer" data-id="${c.id}">ویرایش</button>`)}
      <div class="card"><div class="row-title">${escapeHtml(c.name)} ${badge(c.kind==='store'?'فروشگاه':'شخص')}</div><div class="row-sub">${escapeHtml(c.phone||'بدون شماره تماس')}${c.address?' · '+escapeHtml(c.address):''}</div>
      <div class="stats-grid" style="margin-top:12px">${stat('مجموع فروش',money(customerSales,ws))}${stat('مجموع دریافتی',money(customerReceipts,ws),'','green')}</div>
      <div class="balance-box"><span class="small muted">مانده فعلی حساب</span><strong class="${bal>0?'orange':bal<0?'green':''}">${money(Math.abs(bal),ws)}</strong></div><div class="row-sub">${bal>0?'این مشتری به ما بدهکار است':bal<0?'ما به این مشتری بدهکار هستیم':'حساب تسویه است'}</div>
      <div class="actions" style="margin-top:12px"><button class="btn small-btn" data-action="add-payment" data-customer="${c.id}">＋ ثبت دریافت</button><button class="btn small-btn secondary" data-action="add-invoice" data-customer="${c.id}">＋ فاکتور فروش</button><button class="btn small-btn outline" data-action="add-adjustment" data-customer="${c.id}">اصلاح حساب</button></div></div>
      <div class="card"><h3 class="card-title">گردش حساب به ترتیب تاریخ</h3>${tx.length?`<div class="table-wrap"><table><thead><tr><th>تاریخ</th><th>شرح</th><th>بدهکار/بستانکار</th><th>مانده</th></tr></thead><tbody>${tx.map(t=>`<tr><td>${dateFa(t.date)}</td><td>${escapeHtml(t.title)}</td><td class="${t.amount>0?'orange':t.amount<0?'green':''}">${t.amount>0?'+':'−'} ${money(Math.abs(t.amount),ws)}</td><td>${money(Math.abs(t.balance),ws)} ${t.balance>0?'بدهکار':t.balance<0?'بستانکار':'—'}</td></tr>`).join('')}</tbody></table></div>`:emptyBox('↔','گردش حسابی وجود ندارد')}</div>
      <div class="actions"><button class="btn outline" data-action="back-customers">بازگشت به مشتریان</button><button class="btn danger" data-action="delete-customer" data-id="${c.id}">حذف مشتری</button></div>`;
  }

  function renderProducts(){
    const ws=activeWs(), q=currentSearch.trim().toLowerCase();
    const rows=ws.products.filter(p=>`${p.name} ${p.sku||''} ${p.category||''} ${p.subcategory||''}`.toLowerCase().includes(q));
    return `${pageHead('کالاها و خدمات','تعریف کالا، واحد پایه و واحدهای تبدیل',button('＋ کالای جدید','add-product'))}
      <div class="toolbar"><div class="search"><input data-search placeholder="جست‌وجوی نام، کد یا دسته..." value="${escapeHtml(currentSearch)}"></div><span class="pill">${fmt(rows.length)} کالا</span><button class="btn secondary small-btn" data-action="go-inventory">موجودی انبار</button></div>
      <div class="card">${rows.length?`<div class="list">${rows.map(p=>{const stock=productStock(ws,p.id);return `<div class="list-row"><div class="row-main"><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.category||'بدون دسته')}${p.subcategory?' / '+escapeHtml(p.subcategory):''}${p.sku?' · کد '+escapeHtml(p.sku):''}</div><div class="row-sub">موجودی: <b>${stockBreakdown(p,stock)}</b> <span class="muted">(${fmt(stock)} ${escapeHtml(p.baseUnit||p.unit||'عدد')})</span></div></div><div class="row-end"><div class="amount">${money(p.price,ws)}</div><div class="row-sub">قیمت هر ${escapeHtml(p.baseUnit||p.unit||'واحد پایه')}</div></div><div><button class="text-link" data-action="add-stock" data-id="${p.id}">ورود/خروج</button><button class="text-link" data-action="edit-product" data-id="${p.id}">ویرایش</button></div></div>`}).join('')}</div>`:emptyBox('▦','هنوز کالایی ثبت نشده','برای شروع، کالای جدید تعریف کنید.')}</div>`;
  }

  function renderInventory(){
    const ws=activeWs();
    const sortMode=ws.inventorySort||'high';
    const rows=[...ws.products].sort((a,b)=>{if(sortMode==='name')return a.name.localeCompare(b.name,'fa');const delta=productStock(ws,a.id)-productStock(ws,b.id);return sortMode==='low'?(delta||a.name.localeCompare(b.name,'fa')):(-delta||a.name.localeCompare(b.name,'fa'));});
    const moves=[...(ws.stockMovements||[])].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,25);
    const totalProducts=rows.length, zero=rows.filter(p=>productStock(ws,p.id)<=0).length;
    return `${pageHead('موجودی انبار','موجودی بر اساس واحد پایه و تبدیل خودکار واحدها',button('＋ ثبت ورود یا خروج','add-stock'))}
      <div class="stats-grid">${stat('تعداد کالاها',fmt(totalProducts))}${stat('کالاهای بدون موجودی',fmt(zero),'موجودی صفر یا منفی','orange')}</div>
      <div class="card"><div class="setting-row"><h3 class="card-title" style="margin:0">موجودی فعلی کالاها</h3><select id="inventory-sort" aria-label="ترتیب نمایش کالاها"><option value="high" ${sortMode==='high'?'selected':''}>تعداد بیشتر به کمتر</option><option value="low" ${sortMode==='low'?'selected':''}>تعداد کمتر به بیشتر</option><option value="name" ${sortMode==='name'?'selected':''}>ترتیب الفبایی</option></select></div>${rows.length?`<div class="list">${rows.map(p=>{const stock=productStock(ws,p.id);return `<div class="list-row"><div class="row-main"><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.category||'بدون دسته')}</div><div class="row-sub">${stockBreakdown(p,stock)}</div></div><div class="row-end"><b class="amount ${stock<=0?'red':'green'}">${fmt(stock)} ${escapeHtml(p.baseUnit||p.unit||'عدد')}</b><button class="text-link" data-action="add-stock" data-id="${p.id}">ثبت گردش</button></div></div>`}).join('')}</div>`:emptyBox('▦','ابتدا کالا تعریف کنید')}</div>
      <div class="card"><h3 class="card-title">آخرین گردش‌های انبار</h3>${moves.length?`<div class="list">${moves.map(m=>{const p=ws.products.find(x=>x.id===m.productId);return `<div class="list-row"><div class="row-main"><b>${escapeHtml(p?.name||'کالای حذف‌شده')}</b><div class="row-sub">${dateFa(m.date)} · ${escapeHtml(m.note||'بدون توضیح')}</div></div><div class="row-end"><b class="amount ${m.type==='in'?'green':'red'}">${m.type==='in'?'+':'−'} ${fmt(m.qty)} ${escapeHtml(m.unit||'')}</b></div><button class="text-link danger-link" data-action="delete-stock-move" data-id="${m.id}">حذف</button></div>`}).join('')}</div>`:emptyBox('↔','گردشی ثبت نشده','ورود اولیه کالاها یا خروج‌های دستی را ثبت کنید.')}</div>
      <div class="notice">فروش‌های جدید از موجودی کم می‌شوند. فاکتورهای قدیمی که قبل از فعال شدن انبار ثبت شده‌اند، برای جلوگیری از تغییر ناخواسته موجودی به‌صورت خودکار کسر نشده‌اند.</div>`;
  }

  function renderInvoices(){
    const ws=activeWs(), q=currentSearch.trim().toLowerCase();
    const rows=[...ws.invoices].sort((a,b)=>b.date.localeCompare(a.date)).filter(i=>`${i.number} ${customerById(i.customerId)?.name||''}`.toLowerCase().includes(q));
    return `${pageHead('فاکتورهای فروش','ثبت و پیگیری فروش‌ها',button('＋ فاکتور جدید','add-invoice'))}
      <div class="toolbar"><div class="search"><input data-search placeholder="جست‌وجوی شماره فاکتور یا مشتری..." value="${escapeHtml(currentSearch)}"></div><span class="pill">${fmt(rows.length)} فاکتور</span></div>
      <div class="card">${rows.length?`<div class="list">${rows.map(i=>`<div class="list-row"><div class="row-main"><button class="text-link" style="padding:0;text-align:right" data-action="view-invoice" data-id="${i.id}"><span class="row-title">فاکتور ${escapeHtml(i.number)}</span></button><div class="row-sub">${escapeHtml(customerById(i.customerId)?.name||'مشتری حذف‌شده')} · ${dateFa(i.date)}</div></div><div class="row-end"><div class="amount">${money(i.total,ws)}</div>${badge(invoiceStatus(i),invoiceRemaining(i)<=0?'green-pill':invoiceAllocated(i)>0?'orange-pill':'red-pill')}</div><button class="text-link" data-action="view-invoice" data-id="${i.id}">›</button></div>`).join('')}</div>`:emptyBox('▤','فاکتوری ثبت نشده','برای ثبت فروش، فاکتور جدید را انتخاب کنید.')}</div>`;
  }

  function renderPayments(){
    const ws=activeWs(), q=currentSearch.trim().toLowerCase();
    const rows=[...ws.payments].sort((a,b)=>b.date.localeCompare(a.date)).filter(p=>`${customerById(p.customerId)?.name||''} ${p.reference||''} ${p.note||''}`.toLowerCase().includes(q));
    return `${pageHead('دریافت وجه','ثبت تمام پرداخت‌های مشتریان',button('＋ دریافت جدید','add-payment'))}
      <div class="toolbar"><div class="search"><input data-search placeholder="جست‌وجوی مشتری یا شرح پرداخت..." value="${escapeHtml(currentSearch)}"></div><span class="pill">${fmt(rows.length)} پرداخت</span></div>
      <div class="card">${rows.length?`<div class="list">${rows.map(p=>`<div class="list-row"><div class="row-main"><div class="row-title">${escapeHtml(customerById(p.customerId)?.name||'مشتری حذف‌شده')}</div><div class="row-sub">${dateFa(p.date)} · ${escapeHtml(p.method||'روش نامشخص')}${p.reference?' · '+escapeHtml(p.reference):''}</div></div><div class="row-end"><div class="amount green">${money(p.amount,ws)}</div><div class="row-sub">${p.allocations?.length?'دارای تخصیص به فاکتور':'ثبت در حساب مشتری'}</div></div><div><button class="text-link" data-action="edit-payment" data-id="${p.id}">ویرایش</button><button class="text-link danger-link" data-action="delete-payment" data-id="${p.id}">حذف</button></div></div>`).join('')}</div>`:emptyBox('↙','دریافتی ثبت نشده','پرداخت‌های نقدی، کارت‌به‌کارت یا بانکی را اینجا ثبت کنید.')}</div>`;
  }

  function renderExpenses(){
    const ws=activeWs(), q=currentSearch.trim().toLowerCase();
    const rows=[...ws.expenses].sort((a,b)=>b.date.localeCompare(a.date)).filter(e=>`${e.title} ${e.category||''} ${e.note||''}`.toLowerCase().includes(q));
    return `${pageHead('هزینه‌ها','ثبت هزینه‌های جاری کسب‌وکار',button('＋ هزینه جدید','add-expense'))}
      <div class="toolbar"><div class="search"><input data-search placeholder="جست‌وجوی شرح یا دسته هزینه..." value="${escapeHtml(currentSearch)}"></div><span class="pill">${fmt(rows.length)} مورد</span></div>
      <div class="card">${rows.length?`<div class="list">${rows.map(e=>`<div class="list-row"><div class="row-main"><div class="row-title">${escapeHtml(e.title)}</div><div class="row-sub">${dateFa(e.date)} · ${escapeHtml(e.category||'بدون دسته')}</div></div><div class="row-end"><div class="amount red">${money(e.amount,ws)}</div></div><div><button class="text-link" data-action="edit-expense" data-id="${e.id}">ویرایش</button><button class="text-link danger-link" data-action="delete-expense" data-id="${e.id}">حذف</button></div></div>`).join('')}</div>`:emptyBox('−','هزینه‌ای ثبت نشده','هزینه‌هایی مثل اجاره، حمل‌ونقل و سایر مخارج را ثبت کنید.')}</div>`;
  }

  function renderReports(){
    const ws=activeWs(), start=reportStart||currentJalaliMonthStart(), end=reportEnd||today();
    const within=x=>x>=start&&x<=end;
    const inv=ws.invoices.filter(i=>within(i.date)), pay=ws.payments.filter(p=>within(p.date)), exp=ws.expenses.filter(e=>within(e.date));
    const sales=sum(inv.map(i=>i.total)), receipts=sum(pay.map(p=>p.amount)), costs=sum(exp.map(e=>e.amount));
    const byCat={}; inv.forEach(i=>i.items.forEach(item=>{const key=item.category||'بدون دسته';byCat[key]=(byCat[key]||0)+Number(item.lineTotal||item.qty*item.price||0);}));
    const byCustomer={}; inv.forEach(i=>{const n=customerById(i.customerId)?.name||'مشتری حذف‌شده';byCustomer[n]=(byCustomer[n]||0)+i.total;});
    const debtors=ws.customers.map(c=>({c,b:customerBalance(c)})).filter(x=>x.b>0).sort((a,b)=>b.b-a.b);
    const creditors=ws.customers.map(c=>({c,b:-customerBalance(c)})).filter(x=>x.b>0).sort((a,b)=>b.b-a.b);
    const allCostsKnown=inv.length>0 && inv.every(i=>i.items.every(it=>Number(it.costPrice||0)>0));
    const estimatedGross=allCostsKnown?inv.reduce((acc,i)=>acc+i.items.reduce((s,it)=>s+(Number(it.price||0)-Number(it.costPrice||0))*Number(it.qty||0),0)-Number(i.discount||0),0):null;
    return `${pageHead('گزارش‌ها','گزارش فروش و دریافت در بازه دلخواه',`<button class="btn small-btn secondary" data-action="print-report">چاپ گزارش</button>`)}
      <div class="card"><h3 class="card-title">فیلتر زمانی</h3><div class="form-grid"><div class="field"><label>از تاریخ</label><div class="date-input-wrap"><input id="report-start" type="text" inputmode="none" autocomplete="off" data-jalali-date readonly placeholder="انتخاب تاریخ" value="${escapeHtml(jalaliInput(start))}"><button class="date-picker-btn" type="button" data-action="open-calendar" data-date-id="report-start">▦ تقویم</button></div></div><div class="field"><label>تا تاریخ</label><div class="date-input-wrap"><input id="report-end" type="text" inputmode="none" autocomplete="off" data-jalali-date readonly placeholder="انتخاب تاریخ" value="${escapeHtml(jalaliInput(end))}"><button class="date-picker-btn" type="button" data-action="open-calendar" data-date-id="report-end">▦ تقویم</button></div></div></div><button class="btn full" data-action="apply-report">اعمال بازه</button></div>
      <div class="stats-grid">${stat('فروش در بازه',money(sales,ws))}${stat('دریافت در بازه',money(receipts,ws),'','green')}${stat('هزینه در بازه',money(costs,ws),'','red')}${stat('مانده خالص فروش و هزینه',money(sales-costs,ws),'فروش منهای هزینه ثبت‌شده',sales-costs>=0?'green':'red')}</div>
      <div class="card"><h3 class="card-title">فروش به تفکیک دسته کالا</h3>${Object.keys(byCat).length?Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([name,value])=>`<div style="margin-bottom:12px"><div class="list-row" style="padding:3px 0 7px;border:0"><span>${escapeHtml(name)}</span><b>${money(value,ws)}</b></div><div class="progress"><i style="width:${Math.max(2,sales?Math.min(100,value/sales*100):0)}%"></i></div></div>`).join(''):emptyBox('▥','فروشی در این بازه ثبت نشده')}</div>
      <div class="card"><h3 class="card-title">بدهکاران فعلی</h3>${debtors.length?debtors.slice(0,10).map(x=>`<div class="list-row"><div class="row-main"><div class="row-title">${escapeHtml(x.c.name)}</div></div><b class="amount orange">${money(x.b,ws)}</b><button class="text-link" data-action="view-customer" data-id="${x.c.id}">پرونده</button></div>`).join(''):emptyBox('✓','مشتری بدهکاری وجود ندارد')}</div>
      <div class="card"><h3 class="card-title">بستانکاران فعلی</h3>${creditors.length?creditors.slice(0,10).map(x=>`<div class="list-row"><div class="row-main"><div class="row-title">${escapeHtml(x.c.name)}</div></div><b class="amount green">${money(x.b,ws)}</b><button class="text-link" data-action="view-customer" data-id="${x.c.id}">پرونده</button></div>`).join(''):emptyBox('✓','مشتری بستانکاری وجود ندارد')}</div>
      <div class="card"><h3 class="card-title">فروش به تفکیک مشتری</h3>${Object.keys(byCustomer).length?Object.entries(byCustomer).sort((a,b)=>b[1]-a[1]).map(([name,value])=>`<div class="list-row"><span>${escapeHtml(name)}</span><b class="amount">${money(value,ws)}</b></div>`).join(''):emptyBox('▤','اطلاعاتی برای گزارش وجود ندارد')}</div>
      <div class="card"><h3 class="card-title">برآورد سود ناخالص کالاها</h3><div class="amount ${estimatedGross===null?'muted':estimatedGross>=0?'green':'red'}" style="font-size:20px">${estimatedGross===null?'برای محاسبه، قیمت خرید همه کالاهای فروخته‌شده را ثبت کنید':money(estimatedGross,ws)}</div><div class="small muted">این برآورد از اختلاف قیمت فروش و خرید کالاها پس از تخفیف به دست می‌آید؛ هزینه‌های جاری در آن کسر نشده‌اند.</div></div>
      <div class="footer-note">بازه گزارش: ${dateFa(start)} تا ${dateFa(end)}</div>`;
  }

  function renderMore(){return `${pageHead('بخش‌های دیگر','مدیریت ابزارها و تنظیمات')}<div class="quick-grid">
    <button class="quick-tile" data-action="go-products"><span class="quick-icon">▦</span><span><b>کالاها و خدمات</b><small>تعریف کالا و دسته‌بندی</small></span></button>
    <button class="quick-tile" data-action="go-inventory"><span class="quick-icon">▤</span><span><b>موجودی انبار</b><small>ورود، خروج و موجودی قابل تبدیل</small></span></button>
    <button class="quick-tile" data-action="go-expenses"><span class="quick-icon">−</span><span><b>هزینه‌ها</b><small>ثبت مخارج</small></span></button>
    <button class="quick-tile" data-action="go-reports"><span class="quick-icon">▥</span><span><b>گزارش‌ها</b><small>فروش، طلب و هزینه</small></span></button>
    <button class="quick-tile" data-action="go-settings"><span class="quick-icon">⚙</span><span><b>تنظیمات</b><small>کسب‌وکار و واحد پول</small></span></button>
    <button class="quick-tile" data-action="go-backup"><span class="quick-icon">⇧</span><span><b>پشتیبان و خروجی</b><small>Excel و فایل بازیابی</small></span></button>
    </div><div class="card logout-card"><h3 class="card-title">حساب کاربری</h3><p class="small muted">برای پایان دادن به نشست این حساب در این مرورگر، از دکمه زیر استفاده کنید.</p><button class="btn danger full logout-large" data-action="cloud-signout"><span aria-hidden="true">↪</span> خروج از حساب</button></div><div class="card" style="margin-top:13px"><h3 class="card-title">درباره برنامه</h3><p class="small">این برنامه با هدف ساده‌تر کردن حسابداری برای کسب‌وکارهای کوچک و متوسط طراحی و توسعه داده شده است. من سعید ، توسعه‌دهنده مستقل، تلاش کرده‌ام تجربه‌ای ساده، سریع و کاربردی بسازم. نظرات و پیشنهادهای شما به بهبود برنامه کمک می‌کند.</p><div class="small"><b>📩 برای ارتباط و ارسال بازخورد:</b><br>آیدی تلگرام: <a href="https://t.me/SS73_z" target="_blank" rel="noopener">SS73_z</a></div></div>`;}

  function renderSettings(){const ws=activeWs();return `${pageHead('تنظیمات','اطلاعات پایه کسب‌وکار')}<div class="card"><h3 class="card-title">کسب‌وکار فعال</h3><div class="field"><label>نام کسب‌وکار</label><input id="ws-name" value="${escapeHtml(ws.name)}"></div><div class="field"><label>واحد پول</label><select id="ws-currency">${['تومان','ریال','افغانی','دلار','یورو','لیر','منات','سایر'].map(x=>`<option ${ws.currency===x?'selected':''}>${x}</option>`).join('')}</select></div><button class="btn full" data-action="save-settings">ذخیره تنظیمات</button></div>
      <div class="card"><div class="setting-row"><div><b>دسته‌بندی کالاها</b><div class="row-sub">افزودن شاخه و زیرشاخه دلخواه</div></div><button class="btn secondary small-btn" data-action="manage-categories">مدیریت</button></div><div class="setting-row"><div><b>کسب‌وکارهای من</b><div class="row-sub">هر کسب‌وکار اطلاعات مستقل دارد</div></div><button class="btn secondary small-btn" data-action="switch-workspace">مشاهده</button></div><div class="setting-row"><div><b>ساخت کسب‌وکار جدید</b><div class="row-sub">برای فعالیت یا فروشگاه دیگر</div></div><button class="btn small-btn" data-action="add-workspace">＋ افزودن</button></div><div class="setting-row"><div><b>اجازه فروش با موجودی منفی</b><div class="row-sub">در حالت خاموش، فروش بیشتر از موجودی ثبت نمی‌شود.</div></div><input id="allow-negative-stock" type="checkbox" ${ws.allowNegativeStock?'checked':''}></div></div>
      <div class="card"><h3 class="card-title">داده‌ها و امنیت</h3><div class="notice">پاک کردن داده‌های مرورگر، حذف برنامه یا خرابی گوشی ممکن است اطلاعات محلی را از بین ببرد. مرتباً پشتیبان کامل بگیرید و فایل آن را در جای امن دیگری نگه دارید.</div><button class="btn secondary full" data-action="go-backup">پشتیبان‌گیری و خروجی گرفتن</button></div>`;}

  function renderBackup(){return `${pageHead('پشتیبان و خروجی','ذخیره اطلاعات یا انتقال به دستگاه دیگر')}<div class="card"><h3 class="card-title">فایل پشتیبان کامل</h3><p class="small muted">این فایل شامل همه کسب‌وکارها، مشتریان، کالاها، فاکتورها، دریافت‌ها، هزینه‌ها، گردش‌های انبار، واحدهای تبدیل و تنظیمات است و برای بازیابی در همین برنامه استفاده می‌شود.</p><button class="btn full" data-action="backup">⇩ دریافت فایل پشتیبان JSON</button><hr class="section-sep"><button class="btn outline full" data-action="restore">انتخاب فایل و بازیابی پشتیبان</button><p class="tiny muted">بازیابی، اطلاعات فعلی برنامه را با اطلاعات داخل فایل جایگزین می‌کند. قبل از بازیابی، از اطلاعات فعلی هم پشتیبان بگیرید.</p></div>
    <div class="card"><h3 class="card-title">همگام‌سازی و پشتیبان‌گیری ابری</h3><p class="small muted">پس از تنظیم Firebase و ورود با حساب کاربری، هنگام باز شدن برنامه اطلاعات با فضای ابری مقایسه و همگام می‌شود. تغییرات جدید نیز هنگام باز بودن برنامه پس از ذخیره به فضای ابری ارسال می‌شوند. اجرای برنامه در پس‌زمینه یا وقتی بسته است لازم نیست.</p><div class="notice" id="cloud-status">${offlineSession?'جلسه آفلاین: دسترسی قبلاً تأیید شده و اطلاعات فقط روی این دستگاه ذخیره می‌شود.':cloudStatusText()}</div>${cloudUser?`<div class="actions" style="margin-top:9px"><button class="btn secondary" data-action="cloud-sync-now">همگام‌سازی اکنون</button><button class="btn outline" data-action="cloud-signout">خروج از حساب کاربری</button></div><div class="tiny muted" style="margin-top:8px">حساب فعال: ${escapeHtml(cloudUser.email||cloudUser.displayName||cloudUser.uid)}</div><div class="tiny muted" style="margin-top:5px;direction:ltr;text-align:left;overflow-wrap:anywhere">UID: ${escapeHtml(cloudUser.uid)} <button class="text-link" data-action="copy-cloud-uid">کپی شناسه</button></div>`:''}<p class="tiny muted" style="margin-top:10px">مجوز فعال این حساب برای ورود به کل برنامه لازم است. اگر اتصال اینترنت موقتاً قطع شود، پس از یک بار تأیید مجوز، می‌توانید از اطلاعات همین دستگاه به‌صورت آفلاین استفاده کنید. با اتصال دوباره، مجوز بررسی و در صورت فعال بودن همگام‌سازی انجام می‌شود.</p></div><div class="card"><h3 class="card-title">خروجی Excel</h3><p class="small muted">یک فایل Excel با برگه‌های جداگانه برای مشتریان، کالاها، فاکتورها، ریز اقلام، دریافت‌ها، هزینه‌ها، موجودی فعلی، گردش انبار و اصلاح حساب تولید می‌شود.</p><button class="btn full" data-action="excel">ساخت فایل Excel</button></div>
    <div class="card"><h3 class="card-title">چاپ یا PDF فاکتور</h3><p class="small muted">در فهرست فاکتورها یک فاکتور را باز کنید و گزینه چاپ را بزنید. در پنجره چاپ گوشی می‌توانید گزینه ذخیره به‌صورت PDF را انتخاب کنید.</p><button class="btn outline full" data-action="go-invoices">رفتن به فاکتورها</button></div>
    <div class="card"><h3 class="card-title">انتقال به گوشی دیگر</h3><ol class="small muted" style="padding-right:20px;margin-bottom:0"><li>در گوشی فعلی فایل پشتیبان را دریافت کنید.</li><li>فایل را به گوشی جدید منتقل کنید.</li><li>برنامه را در گوشی جدید باز کنید و «بازیابی پشتیبان» را بزنید.</li></ol></div>`;}

  function render(){
    if(!sessionAllowedForCurrentTab()){ $('#app').hidden=true; return; }
    const ws=activeWs(); $('#workspace-caption').textContent=ws?.name||'مدیریت فروش و حساب مشتریان';
    $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===page||(page==='customer-detail'&&b.dataset.page==='customers')||(['products','inventory','expenses','reports','settings','backup'].includes(page)&&b.dataset.page==='more')));
    if(page==='backup'){$('#main').innerHTML=renderBackup();return;}
    const pages={dashboard:renderDashboard,customers:renderCustomers,'customer-detail':renderCustomerDetail,products:renderProducts,inventory:renderInventory,invoices:renderInvoices,payments:renderPayments,expenses:renderExpenses,reports:renderReports,settings:renderSettings,more:renderMore};
    $('#main').innerHTML=(pages[page]||renderDashboard)();
  }

  function modal(title,body,submitLabel='ذخیره'){
    $('#modal-root').innerHTML=`<div class="modal-backdrop" data-backdrop><section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>${title}</h2><button class="close-btn" data-action="close-modal" aria-label="بستن">×</button></div>${body}</section></div>`;
  }
  function closeModal(){ $('#modal-root').innerHTML='';modalMode=null;closeJalaliCalendar(); }
  function field(name,label,value='',type='text',opts={}){
    const idAttr=opts.id||name;const req=opts.required?'required':'';const placeholder=opts.placeholder?`placeholder="${escapeHtml(opts.placeholder)}"`:'';
    if(type==='date') return `<div class="field ${opts.span?'span-2':''}"><label for="${idAttr}">${label}${opts.required?' *':''}</label><div class="date-input-wrap"><input id="${idAttr}" name="${name}" type="text" inputmode="none" autocomplete="off" data-jalali-date readonly value="${escapeHtml(jalaliInput(value))}" placeholder="انتخاب تاریخ شمسی" ${req}><button class="date-picker-btn" type="button" data-action="open-calendar" data-date-id="${idAttr}" aria-label="انتخاب تاریخ">▦ تقویم</button></div></div>`;
    const numeric=type==='number';
    return `<div class="field ${opts.span?'span-2':''}"><label for="${idAttr}">${label}${opts.required?' *':''}</label><input id="${idAttr}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${req} ${placeholder} ${numeric?'step="any" inputmode="numeric" data-integer-input':''} ${opts.min!==undefined?`min="${opts.min}"`:''} ${opts.readonly?'readonly':''}></div>`;
  }
  function selectField(name,label,options,value='',span=false){return `<div class="field ${span?'span-2':''}"><label>${label}</label><select name="${name}">${options.map(o=>`<option value="${escapeHtml(o.value)}" ${String(o.value)===String(value)?'selected':''}>${escapeHtml(o.label)}</option>`).join('')}</select></div>`;}

  function openCustomerForm(customer=null){
    modalMode={kind:'customer',id:customer?.id};
    const c=customer||{};
    const body=`<form id="customer-form"><div class="form-grid">${field('name','نام شخص یا فروشگاه',c.name||'','text',{required:true,span:true})}
      ${selectField('kind','نوع مشتری',[{value:'person',label:'شخص'},{value:'store',label:'فروشگاه'}],c.kind||'person')}
      ${field('phone','شماره تماس',c.phone||'','tel')}${field('address','آدرس',c.address||'','text',{span:true})}
      ${field('openingBalance','مانده اول دوره',c.openingBalance||0,'number',{min:0})}
      ${selectField('openingType','ماهیت مانده',[{value:'debit',label:'مشتری به ما بدهکار است'},{value:'credit',label:'ما به مشتری بدهکاریم'}],c.openingType||'debit')}
      <div class="field span-2"><label>توضیحات</label><textarea name="notes">${escapeHtml(c.notes||'')}</textarea></div></div>
      <div class="modal-actions"><button class="btn" type="submit">${customer?'ذخیره تغییرات':'ثبت مشتری'}</button><button class="btn outline" type="button" data-action="close-modal">انصراف</button></div></form>`;
    modal(customer?'ویرایش مشتری':'مشتری جدید',body);
  }

  function unitRowHtml(unit={}){return `<div class="unit-row"><input data-unit-name value="${escapeHtml(unit.name||'')}" placeholder="نام واحد؛ مثلاً بسته"><input data-unit-factor data-integer-input inputmode="numeric" type="number" min="1" step="any" value="${escapeHtml(unit.factor??1)}" placeholder="معادل واحد پایه"><button class="btn danger small-btn" type="button" data-action="remove-unit-row">×</button></div>`;}
  function openProductForm(product=null){
    const ws=activeWs(),p=product||{};modalMode={kind:'product',id:product?.id};
    const cats=ws.categories.map(c=>({value:c.name,label:c.name}));if(p.category&&!cats.some(c=>c.value===p.category))cats.push({value:p.category,label:p.category});
    const baseUnit=p.baseUnit||p.unit||'عدد';const baseLocked=!!product&&(ws.stockMovements||[]).some(m=>m.productId===product.id)||!!product&&ws.invoices.some(i=>i.stockApplied&&i.items.some(it=>it.productId===product.id));const extras=(Array.isArray(p.units)?p.units:[]).filter(u=>u.name&&u.name!==baseUnit);
    const unitRows=extras.length?extras.map(unitRowHtml).join(''):'';
    const body=`<form id="product-form"><div class="form-grid">${field('name','نام کالا یا خدمت',p.name||'','text',{required:true,span:true})}${field('sku','کد کالا (اختیاری)',p.sku||'')}
      ${selectField('category','شاخه اصلی',[...cats,{value:'__new__',label:'＋ شاخه جدید'}],p.category||'آرایشی و بهداشتی')}
      ${field('subcategory','زیرشاخه',p.subcategory||'')}
      ${field('baseUnit','واحد پایه (کوچک‌ترین واحد)',baseUnit,'text',{required:true,readonly:baseLocked})}
      <div class="field span-2"><label>واحدهای دیگر و نسبت تبدیل</label><div class="small muted" style="margin-bottom:8px">مثلاً اگر هر بسته ۶ عدد دارد، نام واحد «بسته» و ضریب آن ۶ است. موجودی همیشه بر اساس واحد پایه محاسبه می‌شود.</div><div id="product-alt-units">${unitRows}</div><button class="btn secondary small-btn" type="button" data-action="add-unit-row">＋ افزودن واحد دیگر</button></div>
      ${field('price','قیمت فروش هر واحد پایه',p.price||0,'number',{required:true,min:0})}${field('costPrice','قیمت خرید هر واحد پایه (اختیاری)',p.costPrice||0,'number',{min:0,span:true})}
      <div class="field span-2"><label>توضیحات</label><textarea name="notes">${escapeHtml(p.notes||'')}</textarea></div></div>
      <div class="notice">${baseLocked?'به دلیل ثبت گردش انبار یا فروش، تغییر نام واحد پایه قفل شده است تا معنای موجودی قبلی عوض نشود. ':''}قیمت‌ها بر اساس واحد پایه ثبت می‌شوند. در فاکتور، با انتخاب بسته یا واحد دیگر، مقدار و قیمت متناسب با ضریب تبدیل محاسبه می‌شود.</div>
      <div class="modal-actions"><button class="btn" type="submit">${product?'ذخیره تغییرات':'ثبت کالا'}</button><button class="btn outline" type="button" data-action="close-modal">انصراف</button></div></form>`;
    modal(product?'ویرایش کالا':'کالای جدید',body);
  }

  function invoiceLinesHtml(items=[]){
    const ws=activeWs();const selected=items.length?items:[{productId:ws.products[0]?.id||'',qty:1,price:ws.products[0]?.price||0}];
    return selected.map((it,idx)=>{const product=productById(it.productId),units=productUnits(product),selectedUnit=it.unit||product?.baseUnit||product?.unit||'';const selectedFactor=units.find(u=>u.name===selectedUnit)?.factor||Number(it.unitFactor||1);const opts=units.map(u=>`<option value="${escapeHtml(u.name)}" data-factor="${u.factor}" ${u.name===selectedUnit?'selected':''}>${escapeHtml(u.name)}${u.factor>1?` (هر واحد ${fmt(u.factor)} ${escapeHtml(product.baseUnit||'')})`:''}</option>`).join('');
      const price=it.price??(product?Number(product.price||0)*selectedFactor:0);
      return `<div class="invoice-line" data-line><div class="line-top"><div class="field" style="margin:0"><label>کالا</label><select class="line-product"><option value="">انتخاب کالا...</option>${ws.products.map(p=>`<option value="${p.id}" ${it.productId===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select></div><div class="field" style="margin:0"><label>تعداد</label><input class="line-qty" data-integer-input inputmode="numeric" type="number" min="1" step="any" value="${escapeHtml(it.qty??1)}"></div></div><div class="line-bottom"><div class="field"><label>واحد</label><select class="line-unit">${opts}</select></div><div class="field"><label>قیمت واحد انتخاب‌شده</label><input class="line-price" data-integer-input inputmode="numeric" type="number" min="0" step="any" value="${escapeHtml(price)}"></div><div class="line-total">جمع: <b data-line-total>${money(Number(it.qty||0)*Number(price||0),ws)}</b></div><button class="btn danger small-btn" type="button" data-action="remove-line">×</button></div></div>`;
    }).join('');
  }

  function openInvoiceForm(invoice=null,presetCustomer=''){
    const ws=activeWs(),i=invoice||{};modalMode={kind:'invoice',id:invoice?.id};
    const customerId=i.customerId||presetCustomer||ws.customers[0]?.id||'';
    const number=i.number||`F-${String(ws.nextInvoiceNumber).padStart(4,'0')}`;
    const body=`<form id="invoice-form"><div class="form-grid">${selectField('customerId','مشتری',[{value:'',label:'انتخاب مشتری...'},...ws.customers.map(c=>({value:c.id,label:c.name}))],customerId,true)}
      ${field('number','شماره فاکتور',number,'text',{required:true})}${field('date','تاریخ فاکتور',i.date||today(),'date',{required:true})}<div class="field"><label>تخفیف کل فاکتور</label><input name="discount" class="invoice-discount" data-integer-input inputmode="numeric" type="number" min="0" step="any" value="${i.discount||0}"></div></div>
      <div class="row" style="justify-content:space-between;align-items:center;margin:8px 0"><b>اقلام فاکتور</b><button class="btn secondary small-btn" type="button" data-action="add-line">＋ افزودن کالا</button></div>
      <div id="invoice-lines">${invoiceLinesHtml(i.items||[])}</div><div class="balance-box"><span class="small muted">مبلغ نهایی فاکتور</span><strong id="invoice-total">${money(i.total||0,ws)}</strong></div>
      <div class="field"><label>توضیحات</label><textarea name="notes">${escapeHtml(i.notes||'')}</textarea></div>
      <div class="modal-actions"><button class="btn" type="submit">${invoice?'ذخیره فاکتور':'ثبت فاکتور'}</button><button class="btn outline" type="button" data-action="close-modal">انصراف</button></div></form>`;
    modal(invoice?'ویرایش فاکتور':'فاکتور فروش جدید',body);recalcInvoiceModal();
  }
  function recalcInvoiceModal(){
    const root=$('#invoice-lines');if(!root)return;const ws=activeWs();let subtotal=0;
    $$('[data-line]',root).forEach(line=>{const qty=num($('.line-qty',line).value),price=num($('.line-price',line).value),total=qty*price;subtotal+=total;const target=$('[data-line-total]',line);if(target)target.textContent=money(total,ws);});
    const discount=num($('.invoice-discount')?.value);$('#invoice-total').textContent=money(Math.max(0,subtotal-discount),ws);
  }

  function openPaymentForm(payment=null,presetCustomer=''){
    const ws=activeWs(),p=payment||{};modalMode={kind:'payment',id:payment?.id};const customerId=p.customerId||presetCustomer||ws.customers[0]?.id||'';
    const customerInvoices=ws.invoices.filter(i=>i.customerId===customerId && invoiceRemaining(i)>0 && i.id!==p.allocations?.[0]?.invoiceId);
    let allocInvoice=p.allocations?.[0]?.invoiceId||'';let allocAmt=p.allocations?.[0]?.amount||'';
    if(allocInvoice){const found=invoiceById(allocInvoice);if(found&&!customerInvoices.some(x=>x.id===found.id))customerInvoices.unshift(found);}
    const body=`<form id="payment-form"><div class="form-grid">${selectField('customerId','دریافت از مشتری',[{value:'',label:'انتخاب مشتری...'},...ws.customers.map(c=>({value:c.id,label:c.name}))],customerId,true)}
      ${field('date','تاریخ دریافت',p.date||today(),'date',{required:true})}${field('amount','مبلغ دریافتی',p.amount||'','number',{required:true,min:'1'})}
      ${selectField('method','روش دریافت',[{value:'نقدی',label:'نقدی'},{value:'کارت‌به‌کارت',label:'کارت‌به‌کارت'},{value:'واریز بانکی',label:'واریز بانکی'},{value:'چک',label:'چک'},{value:'سایر',label:'سایر'}],p.method||'واریز بانکی')}
      ${field('reference','شماره پیگیری (اختیاری)',p.reference||'')}
      ${selectField('invoiceId','اختصاص به فاکتور (اختیاری)',[{value:'',label:'بدون تخصیص؛ ثبت در حساب کلی مشتری'},...customerInvoices.map(i=>({value:i.id,label:`${i.number} · مانده ${fmt(invoiceRemaining(i))}`}))],allocInvoice,true)}
      ${field('allocatedAmount','مبلغ تخصیص به فاکتور',allocAmt,'number',{min:0,span:true})}
      <div class="field span-2"><label>توضیحات</label><textarea name="note">${escapeHtml(p.note||'')}</textarea></div></div>
      <div class="notice">اگر فاکتوری انتخاب نکنید، کل مبلغ فقط از مانده کلی مشتری کم می‌شود و به فاکتور خاصی تخصیص نمی‌یابد. این دریافت همچنان در گردش حساب مشتری ثبت خواهد شد.</div>
      <div class="modal-actions"><button class="btn" type="submit">${payment?'ذخیره تغییرات':'ثبت دریافت'}</button><button class="btn outline" type="button" data-action="close-modal">انصراف</button></div></form>`;
    modal(payment?'ویرایش دریافت':'ثبت دریافت وجه',body);
  }

  function openStockForm(productId=''){
    const ws=activeWs();if(!ws.products.length){toast('ابتدا یک کالا تعریف کنید.');setPage('products');return;}
    const selected=productId||ws.products[0].id;const options=[{value:'',label:'انتخاب کالا...'},...ws.products.map(p=>({value:p.id,label:p.name}))];
    const body=`<form id="stock-form"><div class="form-grid">${selectField('productId','کالا',options,selected,true)}${selectField('type','نوع گردش',[{value:'in',label:'ورود به انبار'},{value:'out',label:'خروج از انبار'}],'in')}${field('date','تاریخ',today(),'date',{required:true})}${field('qty','تعداد',1,'number',{required:true,min:'1'})}<div class="field"><label>واحد</label><select name="unit" id="stock-unit"></select></div><div class="field span-2"><label>توضیحات</label><textarea name="note" placeholder="مثلاً خرید اولیه، برگشت از فروش یا ضایعات"></textarea></div></div><div class="notice" id="stock-current"></div><div class="modal-actions"><button class="btn" type="submit">ثبت گردش انبار</button><button class="btn outline" type="button" data-action="close-modal">انصراف</button></div></form>`;
    modal('ثبت ورود یا خروج کالا',body);modalMode={kind:'stock'};updateStockUnitOptions();
  }
  function updateStockUnitOptions(){const form=$('#stock-form');if(!form)return;const product=productById($('select[name="productId"]',form).value),unitSelect=$('#stock-unit');if(!product)return;unitSelect.innerHTML=productUnits(product).map(u=>`<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)} (هر واحد ${fmt(u.factor)} ${escapeHtml(product.baseUnit||'')})</option>`).join('');const current=productStock(activeWs(),product.id);$('#stock-current').textContent=`موجودی فعلی: ${stockBreakdown(product,current)} (${fmt(current)} ${product.baseUnit||'واحد پایه'})`;}

  function openExpenseForm(expense=null){const e=expense||{};modalMode={kind:'expense',id:expense?.id};const body=`<form id="expense-form"><div class="form-grid">${field('title','شرح هزینه',e.title||'','text',{required:true,span:true})}${field('date','تاریخ',e.date||today(),'date',{required:true})}${field('amount','مبلغ',e.amount||'','number',{required:true,min:'1'})}${field('category','دسته هزینه',e.category||'عمومی')}${selectField('method','روش پرداخت',[{value:'نقدی',label:'نقدی'},{value:'کارت یا بانک',label:'کارت یا بانک'},{value:'چک',label:'چک'},{value:'سایر',label:'سایر'}],e.method||'نقدی')}<div class="field span-2"><label>توضیحات</label><textarea name="note">${escapeHtml(e.note||'')}</textarea></div></div><div class="modal-actions"><button class="btn" type="submit">${expense?'ذخیره تغییرات':'ثبت هزینه'}</button><button class="btn outline" type="button" data-action="close-modal">انصراف</button></div></form>`;modal(expense?'ویرایش هزینه':'ثبت هزینه جدید',body);}
  function openAdjustmentForm(customerId,adjustment=null){const a=adjustment||{};modalMode={kind:'adjustment',id:adjustment?.id};const body=`<form id="adjustment-form"><div class="form-grid">${selectField('customerId','مشتری',[{value:'',label:'انتخاب مشتری...'},...activeWs().customers.map(c=>({value:c.id,label:c.name}))],a.customerId||customerId||'',true)}${field('date','تاریخ',a.date||today(),'date',{required:true})}${selectField('type','نوع اصلاح',[{value:'debit',label:'افزایش بدهی مشتری به ما'},{value:'credit',label:'افزایش بستانکاری مشتری'}],a.type||'credit')}${field('amount','مبلغ',a.amount||'','number',{required:true,min:'1'})}${field('reason','شرح اصلاح',a.reason||'اصلاح حساب','text',{span:true,required:true})}<div class="field span-2"><label>توضیحات</label><textarea name="note">${escapeHtml(a.note||'')}</textarea></div></div><div class="notice">برای ثبت برگشت از فروش، تخفیف پس از فاکتور یا اصلاح مانده حساب می‌توانید از این بخش استفاده کنید.</div><div class="modal-actions"><button class="btn" type="submit">ثبت اصلاح</button><button class="btn outline" type="button" data-action="close-modal">انصراف</button></div></form>`;modal('اصلاح گردش حساب مشتری',body);}
  function openWorkspaceForm(){modalMode={kind:'workspace'};modal('ساخت کسب‌وکار جدید',`<form id="workspace-form"><div class="field"><label>نام کسب‌وکار</label><input name="name" required placeholder="مثلاً فروشگاه لوازم آرایشی"></div><div class="field"><label>واحد پول</label><select name="currency">${['تومان','ریال','افغانی','دلار','یورو','لیر','منات','سایر'].map(x=>`<option>${x}</option>`).join('')}</select></div><div class="modal-actions"><button class="btn" type="submit">ایجاد کسب‌وکار</button><button class="btn outline" type="button" data-action="close-modal">انصراف</button></div></form>`);}
  function openCategories(){const ws=activeWs();modalMode={kind:'categories'};modal('مدیریت دسته‌بندی کالاها',`<div class="list">${ws.categories.map(c=>`<div class="list-row"><div class="row-main"><b>${escapeHtml(c.name)}</b><div class="row-sub">${(c.subs||[]).map(escapeHtml).join('، ')||'بدون زیرشاخه'}</div></div><button class="text-link" data-action="edit-category" data-id="${escapeHtml(c.name)}">ویرایش</button><button class="text-link danger-link" data-action="delete-category" data-id="${escapeHtml(c.name)}">حذف</button></div>`).join('')}</div><hr class="section-sep"><button class="btn full" data-action="add-category">＋ افزودن شاخه</button>`);}
  function openCategoryEdit(name=''){const found=activeWs().categories.find(c=>c.name===name)||{name:'',subs:[]};modalMode={kind:'category',oldName:name};modal(name?'ویرایش شاخه':'شاخه جدید',`<form id="category-form"><div class="field"><label>نام شاخه</label><input name="name" value="${escapeHtml(found.name)}" required></div><div class="field"><label>زیرشاخه‌ها (با ویرگول جدا کنید)</label><input name="subs" value="${escapeHtml((found.subs||[]).join('، '))}" placeholder="مثلاً مراقبت پوست، مراقبت مو"></div><div class="modal-actions"><button class="btn" type="submit">ذخیره</button><button class="btn outline" type="button" data-action="manage-categories">بازگشت</button></div></form>`);}

  function viewInvoice(invoiceId){
    const ws=activeWs(),i=invoiceById(invoiceId);if(!i)return;const c=customerById(i.customerId),paid=invoiceAllocated(i.id);
    modal(`فاکتور ${escapeHtml(i.number)}`,`<div id="print-invoice" class="print-sheet"><div style="text-align:center;margin-bottom:15px"><h2 style="margin:0">${escapeHtml(ws.name)}</h2><div class="small">فاکتور فروش</div></div><div class="row" style="justify-content:space-between"><span>شماره: ${escapeHtml(i.number)}</span><span>تاریخ: ${dateFa(i.date)}</span></div><hr class="section-sep"><div><b>خریدار:</b> ${escapeHtml(c?.name||'مشتری حذف‌شده')}</div><div class="table-wrap" style="margin-top:12px"><table style="min-width:0"><thead><tr><th>ردیف</th><th>شرح کالا</th><th>تعداد</th><th>قیمت واحد</th><th>جمع</th></tr></thead><tbody>${i.items.map((it,n)=>`<tr><td>${fmt(n+1)}</td><td>${escapeHtml(it.name)}</td><td>${fmt(it.qty)} ${escapeHtml(it.unit||'')}</td><td>${money(it.price,ws)}</td><td>${money(it.lineTotal,ws)}</td></tr>`).join('')}</tbody></table></div><div style="margin-top:14px;max-width:280px;margin-right:auto"><div class="list-row"><span>جمع اقلام</span><b>${money(i.subtotal,ws)}</b></div><div class="list-row"><span>تخفیف</span><b>${money(i.discount,ws)}</b></div><div class="list-row"><b>مبلغ نهایی</b><b>${money(i.total,ws)}</b></div><div class="list-row"><span>پرداخت تخصیص‌یافته</span><b>${money(paid,ws)}</b></div><div class="list-row"><b>مانده تخصیص‌نیافته فاکتور</b><b>${money(invoiceRemaining(i),ws)}</b></div></div>${i.notes?`<p class="small">توضیحات: ${escapeHtml(i.notes)}</p>`:''}</div><div class="modal-actions no-print"><button class="btn" data-action="print-invoice">چاپ / ذخیره PDF</button><button class="btn secondary" data-action="edit-invoice" data-id="${i.id}">ویرایش</button><button class="btn outline" data-action="close-modal">بستن</button></div><div class="actions no-print" style="margin-top:9px"><button class="btn danger small-btn" data-action="delete-invoice" data-id="${i.id}">حذف فاکتور</button></div>`);
  }

  function printInvoice(){const el=$('#print-invoice');if(!el)return;const w=window.open('','_blank','width=800,height=900');if(!w){toast('اجازه بازشدن پنجره چاپ داده نشد.');return;}w.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>چاپ فاکتور</title><style>body{font-family:Tahoma,Arial;padding:25px;color:#172521;line-height:1.8}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #ddd;padding:8px;text-align:right}h2{font-size:20px}.list-row{display:flex;justify-content:space-between;border-bottom:1px solid #ddd;padding:5px 0}.small{font-size:11px}</style></head><body>${el.innerHTML}</body></html>`);w.document.close();w.focus();setTimeout(()=>w.print(),300);}

  function fileDownload(filename,blob){const a=document.createElement('a');const url=URL.createObjectURL(blob);a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
  function downloadBackup(){if(!sessionAllowedForCurrentTab()){toast('برای تهیه پشتیبان باید دسترسی برنامه فعال باشد.');return;}const payload={app:'daftar-hesab',version:3,ownerUid:accessUid,exportedAt:new Date().toISOString(),data};fileDownload(`daftar-hesab-backup-${today()}.json`,new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}));toast('فایل پشتیبان آماده شد.');}
  async function restoreBackup(file){try{if(!sessionAllowedForCurrentTab()){toast('برای بازیابی پشتیبان باید دسترسی برنامه فعال باشد.');return;}const ownerAtStart=accessUid,text=await file.text(),parsed=JSON.parse(text);if(!sessionAllowedForCurrentTab()||accessUid!==ownerAtStart){toast('دسترسی برنامه تغییر کرده است؛ بازیابی انجام نشد.');return;}if(parsed.ownerUid&&parsed.ownerUid!==accessUid){toast('این فایل پشتیبان متعلق به حساب کاربری دیگری است و در این حساب بازیابی نمی‌شود.');return;}const incoming=parsed.data||parsed;if(!Array.isArray(incoming.workspaces)||!incoming.workspaces.length)throw new Error('ساختار فایل معتبر نیست');if(!confirm('اطلاعات فعلی با محتوای فایل پشتیبان جایگزین شود؟'))return;if(!sessionAllowedForCurrentTab()||accessUid!==ownerAtStart||!db){toast('دسترسی برنامه تغییر کرده است؛ بازیابی انجام نشد.');return;}data={activeWorkspaceId:incoming.activeWorkspaceId,workspaces:incoming.workspaces.map(cleanWorkspace)};if(!data.workspaces.some(w=>w.id===data.activeWorkspaceId))data.activeWorkspaceId=data.workspaces[0].id;await dbSave();if(!sessionAllowedForCurrentTab()||accessUid!==ownerAtStart||!data)return;page='dashboard';render();toast('بازیابی اطلاعات با موفقیت انجام شد.');}catch(err){console.error(err);toast('فایل پشتیبان معتبر نیست یا قابل خواندن نیست.');}}

  function xlsxEscape(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');}
  function colName(n){let s='';while(n>0){let r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}return s;}
  function sheetXml(rows){let maxCols=Math.max(1,...rows.map(r=>r.length));let xmlRows=rows.map((row,ri)=>`<row r="${ri+1}">${row.map((v,ci)=>{const ref=colName(ci+1)+(ri+1);if(typeof v==='number'&&Number.isFinite(v))return `<c r="${ref}" t="n"><v>${v}</v></c>`;return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xlsxEscape(v)}</t></is></c>`;}).join('')}</row>`).join('');return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`;}
  const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=CRC_TABLE[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
  function le16(v){return [v&255,(v>>>8)&255];}function le32(v){return [v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];}
  function makeZip(files){const enc=new TextEncoder();let locals=[],centrals=[],offset=0;for(const f of files){const name=enc.encode(f.name),content=enc.encode(f.content),crc=crc32(content);const local=new Uint8Array([...le32(0x04034b50),...le16(20),...le16(0),...le16(0),...le16(0),...le16(0),...le32(crc),...le32(content.length),...le32(content.length),...le16(name.length),...le16(0),...name,...content]);locals.push(local);const central=new Uint8Array([...le32(0x02014b50),...le16(20),...le16(20),...le16(0),...le16(0),...le16(0),...le16(0),...le32(crc),...le32(content.length),...le32(content.length),...le16(name.length),...le16(0),...le16(0),...le16(0),...le16(0),...le32(0),...le32(offset),...name]);centrals.push(central);offset+=local.length;}const centralSize=centrals.reduce((s,x)=>s+x.length,0);const end=new Uint8Array([...le32(0x06054b50),...le16(0),...le16(0),...le16(files.length),...le16(files.length),...le32(centralSize),...le32(offset),...le16(0)]);return new Blob([...locals,...centrals,end],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});}
  function buildExcel(){
    if(!accessGranted||!data||!db){toast('برای خروجی گرفتن باید دسترسی برنامه فعال باشد.');return;}
    const ws=activeWs();const sheets=[];
    sheets.push({name:'مشتریان',rows:[['نام','نوع','شماره تماس','آدرس','مانده اول دوره','ماهیت مانده','توضیحات'],...ws.customers.map(c=>[c.name,c.kind==='store'?'فروشگاه':'شخص',c.phone||'',c.address||'',Number(c.openingBalance||0),c.openingType==='credit'?'بستانکار':'بدهکار',c.notes||''])]});
    sheets.push({name:'کالاها',rows:[['نام کالا','کد','شاخه','زیرشاخه','واحد پایه','واحدهای تبدیل','قیمت فروش پایه','قیمت خرید پایه','موجودی فعلی به واحد پایه','توضیحات'],...ws.products.map(p=>[p.name,p.sku||'',p.category||'',p.subcategory||'',p.baseUnit||p.unit||'',productUnits(p).map(u=>`${u.name} = ${u.factor} ${p.baseUnit||p.unit||''}`).join('؛ '),Number(p.price||0),Number(p.costPrice||0),productStock(ws,p.id),p.notes||''])]});
    sheets.push({name:'فاکتورها',rows:[['شماره فاکتور','تاریخ','مشتری','جمع اقلام','تخفیف','مبلغ نهایی','پرداخت تخصیص‌یافته','مانده فاکتور','توضیحات'],...ws.invoices.map(i=>[i.number,dateFa(i.date),customerById(i.customerId)?.name||'مشتری حذف‌شده',Number(i.subtotal||0),Number(i.discount||0),Number(i.total||0),invoiceAllocated(i.id),invoiceRemaining(i),i.notes||''])]});
    sheets.push({name:'ریز اقلام',rows:[['شماره فاکتور','تاریخ','مشتری','نام کالا','شاخه','تعداد','واحد','قیمت واحد','جمع'],...ws.invoices.flatMap(i=>i.items.map(it=>[i.number,dateFa(i.date),customerById(i.customerId)?.name||'',it.name,it.category||'',Number(it.qty||0),it.unit||'',Number(it.price||0),Number(it.lineTotal||0)]))]});
    sheets.push({name:'دریافت‌ها',rows:[['تاریخ','مشتری','مبلغ','روش','شماره پیگیری','فاکتور تخصیص‌یافته','مبلغ تخصیص','توضیحات'],...ws.payments.flatMap(p=>{const alloc=p.allocations||[];return alloc.length?alloc.map(a=>[dateFa(p.date),customerById(p.customerId)?.name||'',Number(p.amount||0),p.method||'',p.reference||'',invoiceById(a.invoiceId)?.number||'',Number(a.amount||0),p.note||'']):[[dateFa(p.date),customerById(p.customerId)?.name||'',Number(p.amount||0),p.method||'',p.reference||'','',0,p.note||'']];})]});
    sheets.push({name:'هزینه‌ها',rows:[['تاریخ','شرح','دسته','مبلغ','روش پرداخت','توضیحات'],...ws.expenses.map(e=>[dateFa(e.date),e.title,e.category||'',Number(e.amount||0),e.method||'',e.note||''])]});
    sheets.push({name:'موجودی فعلی',rows:[['نام کالا','موجودی قابل نمایش','تعداد کل به واحد پایه','واحد پایه'],...ws.products.map(p=>[p.name,stockBreakdown(p,productStock(ws,p.id)),productStock(ws,p.id),p.baseUnit||p.unit||''])]});
    sheets.push({name:'گردش انبار',rows:[['تاریخ','کالا','نوع','تعداد وارد/خارج','واحد ثبت','ضریب تبدیل','مقدار به واحد پایه','توضیحات'],...(ws.stockMovements||[]).map(m=>[dateFa(m.date),productById(m.productId)?.name||'کالای حذف‌شده',m.type==='in'?'ورود':'خروج',Number(m.qty||0),m.unit||'',Number(m.unitFactor||1),Number(m.baseQty||0),m.note||''])]});
    sheets.push({name:'اصلاح حساب',rows:[['تاریخ','مشتری','نوع','مبلغ','شرح','توضیحات'],...ws.adjustments.map(a=>[dateFa(a.date),customerById(a.customerId)?.name||'',a.type==='credit'?'افزایش بستانکاری':'افزایش بدهی',Number(a.amount||0),a.reason||'',a.note||''])]});
    const files=[];files.push({name:'[Content_Types].xml',content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`});
    files.push({name:'_rels/.rels',content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`});
    files.push({name:'xl/workbook.xml',content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${xlsxEscape(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`});
    files.push({name:'xl/_rels/workbook.xml.rels',content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}</Relationships>`});
    sheets.forEach((s,i)=>files.push({name:`xl/worksheets/sheet${i+1}.xml`,content:sheetXml(s.rows)}));
    fileDownload(`daftar-hesab-${today()}.xlsx`,makeZip(files));toast('فایل Excel ساخته شد.');
  }

  function handleAction(action,el){
    const ws=activeWs(),targetId=el?.dataset.id;
    switch(action){
      case 'go-back':goBack();break;
      case 'open-calendar':openJalaliCalendar(el.dataset.dateId);break;
      case 'calendar-prev':{const n=shiftJalaliMonth(calendarState.year,calendarState.month,-1);calendarState={...calendarState,...n};renderJalaliCalendar();break;}
      case 'calendar-next':{const n=shiftJalaliMonth(calendarState.year,calendarState.month,1);calendarState={...calendarState,...n};renderJalaliCalendar();break;}
      case 'calendar-select':chooseCalendarDate(el.dataset.iso);break;
      case 'calendar-today':chooseCalendarDate(today());break;
      case 'calendar-close':closeJalaliCalendar();break;
      case 'gate-login-google':case 'cloud-login-google':cloudLogin('google');break;
      case 'gate-login-github':case 'cloud-login-github':cloudLogin('github');break;
      case 'gate-retry':retryAuthorization();break;
      case 'gate-test-network':testAuthNetwork();break;
      case 'gate-signout':cloudLogout();break;
      case 'gate-copy-uid':{const copyUid=cloudUser?.uid||accessUid;if(copyUid)navigator.clipboard?.writeText(copyUid).then(()=>toast('شناسه کاربری کپی شد.')).catch(()=>toast('کپی شناسه انجام نشد.'));break;}
      case 'cloud-sync-now':syncWithCloud({startup:true});break;
      case 'cloud-signout':cloudLogout();break;
      case 'copy-cloud-uid':if(cloudUser?.uid)navigator.clipboard?.writeText(cloudUser.uid).then(()=>toast('شناسه کاربری کپی شد.')).catch(()=>toast('کپی شناسه انجام نشد.'));break;
      case 'close-modal':closeModal();break;
      case 'add-customer':openCustomerForm();break;
      case 'edit-customer':openCustomerForm(customerById(targetId));break;
      case 'view-customer':selectedCustomerId=targetId;closeModal();setPage('customer-detail');break;
      case 'back-customers':setPage('customers');break;
      case 'delete-customer':{const hasHistory=ws.invoices.some(i=>i.customerId===targetId)||ws.payments.some(p=>p.customerId===targetId)||ws.adjustments.some(a=>a.customerId===targetId);if(hasHistory){toast('این مشتری سابقه مالی دارد و برای حفظ صحت گزارش‌ها حذف نمی‌شود. نام و مشخصاتش را ویرایش کنید.');break;}if(confirm('این مشتری حذف شود؟')){ws.customers=ws.customers.filter(c=>c.id!==targetId);saveAndRender();toast('مشتری حذف شد.');}break;}
      case 'add-product':openProductForm();break;
      case 'add-stock':openStockForm(targetId||'');break;
      case 'go-inventory':setPage('inventory');break;
      case 'delete-stock-move':if(confirm('این گردش انبار حذف شود؟')){ws.stockMovements=ws.stockMovements.filter(m=>m.id!==targetId);saveAndRender();}break;
      case 'edit-product':openProductForm(productById(targetId));break;
      case 'add-invoice':openInvoiceForm(null,el?.dataset.customer||'');break;
      case 'edit-invoice':{const i=invoiceById(targetId);closeModal();openInvoiceForm(i);break;}
      case 'view-invoice':viewInvoice(targetId);break;
      case 'delete-invoice':if(confirm('این فاکتور حذف شود؟ پرداخت‌های مرتبط باقی می‌مانند اما تخصیص آن‌ها به این فاکتور حذف می‌شود.')){ws.invoices=ws.invoices.filter(i=>i.id!==targetId);ws.payments.forEach(p=>p.allocations=(p.allocations||[]).filter(a=>a.invoiceId!==targetId));saveAndRender();closeModal();toast('فاکتور حذف شد.');}break;
      case 'print-invoice':printInvoice();break;
      case 'add-payment':openPaymentForm(null,el?.dataset.customer||'');break;
      case 'edit-payment':openPaymentForm(ws.payments.find(p=>p.id===targetId));break;
      case 'delete-payment':if(confirm('این دریافت حذف شود؟')){ws.payments=ws.payments.filter(p=>p.id!==targetId);saveAndRender();toast('دریافت حذف شد.');}break;
      case 'add-expense':openExpenseForm();break;
      case 'edit-expense':openExpenseForm(ws.expenses.find(e=>e.id===targetId));break;
      case 'delete-expense':if(confirm('این هزینه حذف شود؟')){ws.expenses=ws.expenses.filter(e=>e.id!==targetId);saveAndRender();toast('هزینه حذف شد.');}break;
      case 'add-adjustment':openAdjustmentForm(el?.dataset.customer||'');break;
      case 'add-workspace':openWorkspaceForm();break;
      case 'switch-workspace':openWorkspaceSwitcher();break;
      case 'go-invoices':setPage('invoices');break;case 'go-products':setPage('products');break;case 'go-expenses':setPage('expenses');break;case 'go-reports':setPage('reports');break;case 'go-settings':setPage('settings');break;case 'go-backup':setPage('backup');break;
      case 'save-settings':{const name=$('#ws-name').value.trim();if(!name){toast('نام کسب‌وکار را وارد کنید.');break;}ws.name=name;ws.currency=$('#ws-currency').value;ws.allowNegativeStock=$('#allow-negative-stock').checked;saveAndRender();toast('تنظیمات ذخیره شد.');break;}
      case 'manage-categories':openCategories();break;case 'add-category':openCategoryEdit();break;case 'edit-category':openCategoryEdit(targetId);break;
      case 'delete-category':if(confirm('این شاخه حذف شود؟ نام دسته در کالاهای قبلی باقی می‌ماند.')){ws.categories=ws.categories.filter(c=>c.name!==targetId);openCategories();dbSave();}break;
      case 'apply-report':try{reportStart=jalaliToIso($('#report-start').value);reportEnd=jalaliToIso($('#report-end').value);}catch(err){toast(err.message);break;}if(reportStart&&reportEnd&&reportStart>reportEnd){toast('تاریخ شروع نباید بعد از تاریخ پایان باشد.');break;}render();break;
      case 'print-report':window.print();break;
      case 'backup':downloadBackup();break;
      case 'restore':$('#restore-file').click();break;
      case 'excel':buildExcel();break;
      case 'add-line':{$('#invoice-lines').insertAdjacentHTML('beforeend',invoiceLinesHtml([{}]));recalcInvoiceModal();break;}
      case 'add-unit-row':$('#product-alt-units').insertAdjacentHTML('beforeend',unitRowHtml({name:'',factor:1}));break;
      case 'remove-unit-row':el.closest('.unit-row')?.remove();break;
      case 'remove-line':{if($$('[data-line]').length<=1){toast('فاکتور باید حداقل یک قلم داشته باشد.');break;}el.closest('[data-line]').remove();recalcInvoiceModal();break;}
      default:break;
    }
  }
  function openWorkspaceSwitcher(){modal('انتخاب کسب‌وکار',`<div class="list">${data.workspaces.map(w=>`<div class="list-row"><div class="row-main"><b>${escapeHtml(w.name)}</b><div class="row-sub">${fmt(w.customers.length)} مشتری · ${fmt(w.invoices.length)} فاکتور</div></div>${w.id===data.activeWorkspaceId?badge('فعال','green-pill'):`<button class="btn secondary small-btn" data-action="activate-workspace" data-id="${w.id}">انتخاب</button>`}</div>`).join('')}</div><hr class="section-sep"><button class="btn full" data-action="add-workspace">＋ ساخت کسب‌وکار جدید</button>`);}

  async function testAuthNetwork(){
    const box=$('#gate-network-results');if(!box)return;box.textContent='در حال بررسی مسیرهای شبکه…';
    const authHost=window.DH_FIREBASE_CONFIG?.authDomain;
    const targets=[
      ['Firebase Authentication','https://identitytoolkit.googleapis.com/'],
      ['Firebase Token','https://securetoken.googleapis.com/'],
      ['Google Accounts','https://accounts.google.com/'],
      ['Google OAuth','https://oauth2.googleapis.com/'],
      ['Google APIs','https://www.googleapis.com/'],
      ['Firebase SDK','https://www.gstatic.com/'],
      ['Cloud Firestore','https://firestore.googleapis.com/'],
      ...(authHost? [
        ['Firebase Auth Domain',`https://${authHost}/`],
        ['Firebase Auth helper (iframe)',`https://${authHost}/__/auth/iframe`],
        ['Firebase OAuth handler',`https://${authHost}/__/auth/handler`]
      ]:[]),
      ...(window.DH_FIREBASE_CONFIG?.projectId?[
        ['Firebase Hosting جایگزین (web.app)',`https://${window.DH_FIREBASE_CONFIG.projectId}.web.app/`],
        ['Auth helper جایگزین (web.app)',`https://${window.DH_FIREBASE_CONFIG.projectId}.web.app/__/auth/iframe`]
      ]:[])
    ];
    const results=await Promise.all(targets.map(async([name,url])=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6500);
      try{await fetch(url,{method:'GET',mode:'no-cors',cache:'no-store',signal:controller.signal});return {name,ok:true};}
      catch(_){return {name,ok:false};}finally{clearTimeout(timer);}
    }));
    if(!$('#gate-network-results'))return;
    box.innerHTML=results.map(r=>`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #edf1ee"><span>${escapeHtml(r.name)}</span><b style="color:${r.ok?'#16834c':'#b84141'}">${r.ok?'قابل دسترسی':'عدم دسترسی'}</b></div>`).join('')+'<p>اگر دامنه Auth فعلی در دسترس نیست اما دامنه web.app قابل دسترسی است، می‌توان برنامه را روی Firebase Hosting منتشر کرد و پس از تنظیم دامنه و OAuth، authDomain را به web.app تغییر داد. این تغییر به‌تنهایی و بدون تنظیمات Firebase Console کافی نیست.</p><p>این آزمون فقط دسترسی شبکه را بررسی می‌کند و جایگزین تأیید ورود Firebase نیست.</p>';
  }
  function cloudStatusText(){
    if(cloudStatus==='not-configured')return 'فضای ابری هنوز تنظیم نشده است. فایل تنظیمات Firebase باید تکمیل شود.';
    if(cloudStatus==='signed-out')return 'برای فعال شدن برنامه، با حساب گوگل یا GitHub وارد شوید.';
    if(cloudStatus==='checking')return 'در حال بررسی اطلاعات فضای ابری…';
    if(cloudStatus==='syncing')return 'در حال همگام‌سازی اطلاعات…';
    if(cloudStatus==='synced')return 'اطلاعات با فضای ابری همگام است.';
    if(cloudStatus==='not-authorized')return 'این UID هنوز مجوز استفاده از برنامه را ندارد. در Firestore و مجموعه access باید سندی با شناسه دقیق UID و فیلد enabled از نوع Boolean با مقدار true وجود داشته باشد.';
    if(cloudStatus==='rules-error')return 'حساب شناسایی شد، اما قوانین امنیتی Firestore اجازه بررسی یا دسترسی به اطلاعات را نمی‌دهند. بخش Rules را با فایل firebase.rules تطبیق دهید.';
    if(cloudStatus==='offline')return 'اتصال اینترنت در دسترس نیست؛ اطلاعات فعلاً روی همین دستگاه ذخیره می‌شود.';
    if(cloudStatus==='error')return 'همگام‌سازی انجام نشد. اطلاعات محلی دست‌نخورده باقی مانده است.';
    return 'وضعیت اتصال فضای ابری نامشخص است.';
  }
  function hasBusinessData(source){return (source?.workspaces||[]).some(w=>['customers','products','invoices','payments','expenses','adjustments','stockMovements'].some(k=>(w[k]||[]).length));}
  async function applyCloudData(snapshot){
    const epoch=syncEpoch,uidAtStart=accessUid;
    suppressCloudSync=true;
    try{data=snapshot.data;data.workspaces=(data.workspaces||[]).map(cleanWorkspace);if(!data.workspaces.length)throw new Error('اطلاعات ابری ساختار معتبری ندارد.');if(!data.workspaces.some(w=>w.id===data.activeWorkspaceId))data.activeWorkspaceId=data.workspaces[0].id;data._meta={...(data._meta||{}),updatedAt:snapshot.updatedAt,lastSyncedCloudUpdatedAt:snapshot.updatedAt};await dbSave({touch:false,queue:false});}
    finally{suppressCloudSync=false;}
    if(epoch!==syncEpoch||!accessGranted||accessUid!==uidAtStart)return;
    render();
  }
  async function uploadCloudData(){
    const timestamp=Date.now(),uidAtStart=accessUid,epochAtStart=syncEpoch;cloudStatus='syncing';if(page==='backup')render();
    await window.DHCloud.saveSnapshot(data,timestamp);
    if(epochAtStart!==syncEpoch||!accessGranted||accessUid!==uidAtStart)return;
    suppressCloudSync=true;try{data._meta={...(data._meta||{}),updatedAt:timestamp,lastSyncedCloudUpdatedAt:timestamp};await dbSave({touch:false,queue:false});}finally{suppressCloudSync=false;}
    cloudStatus='synced';if(page==='backup')render();
  }
  async function syncWithCloud(options={}){
    if(!window.DHCloud||!window.DHCloud.isConfigured()){cloudStatus='not-configured';return;}
    if(!navigator.onLine){cloudStatus='offline';return;}
    if(!cloudUser){cloudStatus='signed-out';return;}
    if(cloudSyncBusy)return;cloudSyncBusy=true;const syncUid=cloudUser.uid, mySyncEpoch=syncEpoch;cloudStatus='checking';if(page==='backup')render();
    try{
      const allowed=await window.DHCloud.checkAccess();
      if(!allowed){cloudStatus='not-authorized';cloudSyncReady=false;await lockApplication('revoked',{clearCache:true,uid:syncUid}).then(()=>startAccessWatch(syncUid));return;}
      if(mySyncEpoch!==syncEpoch||!accessGranted||accessUid!==syncUid)return;
      const remote=await window.DHCloud.loadSnapshot();
      if(mySyncEpoch!==syncEpoch||!accessGranted||accessUid!==syncUid)return;
      if(!remote){await uploadCloudData();if(mySyncEpoch===syncEpoch&&accessGranted&&accessUid===syncUid)cloudSyncReady=true;return;}
      const localMeta=data._meta||{},localUpdated=Number(localMeta.updatedAt||0),base=Number(localMeta.lastSyncedCloudUpdatedAt||0),remoteUpdated=Number(remote.updatedAt||0);
      if(!hasBusinessData(data)&&hasBusinessData(remote.data)){await applyCloudData(remote);cloudStatus='synced';cloudSyncReady=true;return;}
      if(!base){
        if(!hasBusinessData(data)){await applyCloudData(remote);}
        else if(options.firstLogin||options.startup){const takeCloud=confirm('اطلاعاتی در فضای ابری پیدا شد. برای دریافت اطلاعات ابری و جایگزینی اطلاعات این گوشی، «تأیید» را بزنید. برای بارگذاری اطلاعات همین گوشی روی فضای ابری، «لغو» را بزنید.');if(takeCloud)await applyCloudData(remote);else await uploadCloudData();}
        else await uploadCloudData();
      } else {
        const localChanged=localUpdated>base,cloudChanged=remoteUpdated>base;
        if(localChanged&&cloudChanged){const takeCloud=confirm('اطلاعات هم در این گوشی و هم در فضای ابری از آخرین همگام‌سازی تغییر کرده است. برای جلوگیری از ادغام نادرست حساب‌ها، یکی را انتخاب کنید. تأیید = دریافت نسخه ابری؛ لغو = بارگذاری نسخه همین گوشی. پیش از انتخاب، در صورت نیاز فایل پشتیبان دستی بگیرید.');if(takeCloud)await applyCloudData(remote);else await uploadCloudData();}
        else if(cloudChanged&&!localChanged)await applyCloudData(remote);
        else if(localChanged&&!cloudChanged)await uploadCloudData();
        else {suppressCloudSync=true;try{data._meta={...(data._meta||{}),lastSyncedCloudUpdatedAt:remoteUpdated};await dbSave({touch:false,queue:false});}finally{suppressCloudSync=false;}cloudStatus='synced';}
      }
      if(mySyncEpoch===syncEpoch&&accessGranted&&accessUid===syncUid)cloudSyncReady=true;
    }catch(err){
      if(mySyncEpoch!==syncEpoch)return;
      console.error('Cloud sync error:',err);
      const code=String(err?.code||'');
      if(code==='permission-denied')cloudStatus='rules-error';
      else if(code==='access-denied'){cloudStatus='not-authorized';cloudSyncReady=false;await lockApplication('revoked',{clearCache:true,uid:syncUid}).then(()=>startAccessWatch(syncUid));}
      else if(!navigator.onLine||['unavailable','deadline-exceeded','network-request-failed'].includes(code))cloudStatus='offline';
      else cloudStatus='error';
      if(page==='backup')render();
    }
    finally{if(mySyncEpoch===syncEpoch){cloudSyncBusy=false;if(page==='backup'&&accessGranted)render();}}
  }
  function scheduleCloudSync(){if(!cloudSyncReady||!cloudUser||suppressCloudSync)return;clearTimeout(cloudSyncTimer);cloudSyncTimer=setTimeout(()=>syncWithCloud({automatic:true}),1200);}
  async function initializeCloudSync(){
    const cachedUid=cachedAuthorizedUid();
    if(!window.DHCloud||!window.DHCloud.isConfigured()){
      if(cachedUid){await unlockOffline(cachedUid);return;}
      cloudStatus='not-configured';showAccessGate('config');return;
    }
    try{
      const state=await window.DHCloud.initialize();authReady=true;cloudUser=state.user||null;
      if(!cloudUser){
        if(state.authError&&isNetworkError(state.authError)&&cachedUid){await unlockOffline(cachedUid);return;}
        clearAuthorizedUid();showAccessGate(state.authError?'network':'login',{message:state.authError?authErrorMessage(state.authError):undefined});return;
      }
      await authorizeCurrentUser(cloudUser,{startup:true});
    }catch(err){
      console.error('Firebase initialization failed:',err);
      if(cachedUid){await unlockOffline(cachedUid);return;}
      showAccessGate('network',{message:authErrorMessage(err)});
    }
  }
  async function cloudLogin(provider){
    if(!window.DHCloud||!window.DHCloud.isConfigured()){showAccessGate('config');return;}
    manualLoginInProgress=true;
    try{
      await window.DHCloud.signIn(provider);
      authReady=true;
      const signedUser=window.DHCloud.currentUser();
      if(signedUser&&accessUid&&signedUser.uid!==accessUid){const oldUid=accessUid;clearAuthorizedUid(oldUid);await lockApplication('login',{clearIdentity:true,uid:oldUid});}
      cloudUser=signedUser;
      if(cloudUser)await authorizeCurrentUser(cloudUser,{firstLogin:true});
      // در حالت redirect، مرورگر به همین صفحه برمی‌گردد و ادامه کار در init انجام می‌شود.
    }catch(err){console.error(err);showAccessGate('network',{uid:cloudUser?.uid,message:authErrorMessage(err)});}
    finally{manualLoginInProgress=false;}
  }
  async function retryAuthorization(){
    try{const state=await window.DHCloud.initialize();authReady=true;cloudUser=state.user||null;if(!cloudUser){showAccessGate('login');return;}await authorizeCurrentUser(cloudUser,{startup:true});}
    catch(err){showAccessGate('network',{uid:accessUid,message:authErrorMessage(err)});}
  }
  async function cloudLogout(){
    const oldUid=accessUid||cloudUser?.uid||cachedAuthorizedUid();
    try{await window.DHCloud.signOut();}catch(err){if(!isNetworkError(err)){toast('خروج از حساب انجام نشد.');return;}console.warn('Firebase sign-out deferred while offline:',err);}
    publishCrossTabLogout(oldUid);
    clearAuthorizedUid(oldUid);cloudUser=null;await lockApplication('signed-out',{clearCache:true,clearIdentity:true,uid:oldUid});toast('از حساب خارج شدید. داده‌های محلی حذف نشده‌اند.');
  }

  function parseDateOrNotify(value){try{return jalaliToIso(value);}catch(err){toast(err.message);return null;}}
  const JALALI_MONTHS=['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
  function jalaliMonthLength(year,month){if(month<=6)return 31;if(month<=11)return 30;try{jalaliToIso(`${year}/12/30`);return 30;}catch(_){return 29;}}
  function shiftJalaliMonth(year,month,delta){let index=year*12+(month-1)+delta;return {year:Math.floor(index/12),month:(index%12+12)%12+1};}
  function renderJalaliCalendar(){
    if(!calendarState)return;
    const {targetId,year,month}=calendarState, target=document.getElementById(targetId);
    let selected='';try{selected=target?.value?jalaliToIso(target.value):'';}catch(_){}
    const firstIso=jalaliToIso(`${year}/${month}/1`), firstDay=new Date(`${firstIso}T12:00:00Z`).getUTCDay(), offset=(firstDay+1)%7;
    const count=jalaliMonthLength(year,month), cells=[];
    for(let i=0;i<offset;i++)cells.push('<span class="calendar-empty"></span>');
    for(let day=1;day<=count;day++){const iso=jalaliToIso(`${year}/${month}/${day}`);cells.push(`<button type="button" class="calendar-day ${iso===selected?'selected':''} ${iso===today()?'today':''}" data-action="calendar-select" data-iso="${iso}">${toPersianDigits(day)}</button>`);}
    while(cells.length%7)cells.push('<span class="calendar-empty"></span>');
    let overlay=$('#jalali-calendar');if(!overlay){overlay=document.createElement('div');overlay.id='jalali-calendar';overlay.className='calendar-overlay';document.body.appendChild(overlay);}
    overlay.innerHTML=`<section class="calendar-card" role="dialog" aria-modal="true" aria-label="انتخاب تاریخ شمسی"><div class="calendar-head"><button type="button" data-action="calendar-prev" aria-label="ماه قبل">‹</button><b>${JALALI_MONTHS[month-1]} ${toPersianDigits(year)}</b><button type="button" data-action="calendar-next" aria-label="ماه بعد">›</button></div><div class="calendar-weekdays">${['ش','ی','د','س','چ','پ','ج'].map(x=>`<span>${x}</span>`).join('')}</div><div class="calendar-grid">${cells.join('')}</div><div class="calendar-footer"><button type="button" class="btn secondary" data-action="calendar-today">امروز</button><button type="button" class="btn outline" data-action="calendar-close">انصراف</button></div></section>`;
  }
  function openJalaliCalendar(targetId){const target=document.getElementById(targetId);if(!target)return;let parts=persianDateParts(today());try{if(target.value)parts=(()=>{const iso=jalaliToIso(target.value);return persianDateParts(iso);})();}catch(_){}calendarState={targetId,year:parts.year,month:parts.month};renderJalaliCalendar();}
  function closeJalaliCalendar(){calendarState=null;$('#jalali-calendar')?.remove();}
  function chooseCalendarDate(iso){const target=calendarState&&document.getElementById(calendarState.targetId);if(target){target.value=jalaliInput(iso);target.dispatchEvent(new Event('change',{bubbles:true}));}closeJalaliCalendar();}


  async function submitForm(form){
    if(!sessionAllowedForCurrentTab()){toast('دسترسی برنامه فعال نیست؛ اطلاعات ذخیره نشد.');return;}
    const submitEpoch=syncEpoch,ws=activeWs(),fd=new FormData(form),v=Object.fromEntries(fd.entries());
    if(form.id==='customer-form'){
      const obj={id:modalMode.id||id(),name:v.name.trim(),kind:v.kind,phone:v.phone.trim(),address:v.address.trim(),openingBalance:num(v.openingBalance),openingType:v.openingType,notes:v.notes.trim(),createdAt:modalMode.id?(customerById(modalMode.id)?.createdAt||today()):today()};
      if(modalMode.id)ws.customers=ws.customers.map(c=>c.id===obj.id?obj:c);else ws.customers.push(obj);closeModal();saveAndRender();toast('اطلاعات مشتری ذخیره شد.');
    } else if(form.id==='product-form'){
      if(v.category==='__new__'){const name=prompt('نام شاخه جدید را وارد کنید:');if(!name?.trim())return;v.category=name.trim();if(!ws.categories.some(c=>c.name===v.category))ws.categories.push({name:v.category,subs:[]});}
      const baseUnit=(v.baseUnit||'').trim();if(!baseUnit){toast('واحد پایه را مشخص کنید.');return;}
      const units=[{name:baseUnit,factor:1}];for(const row of $$('.unit-row',form)){const name=$('[data-unit-name]',row).value.trim(),factor=num($('[data-unit-factor]',row).value);if(!name)continue;if(name===baseUnit||units.some(u=>u.name===name)){toast('نام واحدها باید یکتا و متفاوت از واحد پایه باشد.');return;}if(factor<=0){toast('ضریب تبدیل هر واحد باید بیشتر از صفر باشد.');return;}units.push({name,factor});}
      const obj={id:modalMode.id||id(),name:v.name.trim(),sku:v.sku.trim(),category:v.category,subcategory:v.subcategory.trim(),unit:baseUnit,baseUnit,units,price:num(v.price),costPrice:num(v.costPrice),notes:v.notes.trim()};
      if(modalMode.id)ws.products=ws.products.map(p=>p.id===obj.id?obj:p);else ws.products.push(obj);closeModal();saveAndRender();toast('کالا ذخیره شد.');
    } else if(form.id==='invoice-form'){
      const invoiceDate=parseDateOrNotify(v.date);if(!invoiceDate)return;v.date=invoiceDate;
      if(!v.customerId){toast('مشتری را انتخاب کنید.');return;}
      const lines=$$('[data-line]',$('#invoice-lines')).map(line=>{const product=productById($('.line-product',line).value);if(!product)return null;const qty=num($('.line-qty',line).value),price=num($('.line-price',line).value),unit=$('.line-unit',line).value||product.baseUnit||product.unit||'عدد',unitFactor=productUnits(product).find(u=>u.name===unit)?.factor||1;return {productId:product.id,name:product.name,category:product.category||'',subcategory:product.subcategory||'',qty,unit,unitFactor,baseQty:qty*unitFactor,price,costPrice:num(product.costPrice)*unitFactor,lineTotal:qty*price};}).filter(x=>x&&x.qty>0);
      if(!lines.length){toast('حداقل یک کالای معتبر با تعداد بیشتر از صفر اضافه کنید.');return;}
      const oldInvoice=modalMode.id?invoiceById(modalMode.id):null;const applyStock=!oldInvoice||oldInvoice.stockApplied===true;
      if(applyStock&&!ws.allowNegativeStock){const totals={};lines.forEach(x=>totals[x.productId]=(totals[x.productId]||0)+x.baseQty);for(const [pid,needed] of Object.entries(totals)){const available=productStock(ws,pid,oldInvoice?.id||'');if(available+0.000001<needed){const product=productById(pid);toast(`موجودی «${product?.name||'کالا'}» کافی نیست. موجودی: ${fmt(available)} ${product?.baseUnit||'واحد'}؛ نیاز فاکتور: ${fmt(needed)}.`);return;}}}
      const subtotal=sum(lines.map(x=>x.lineTotal)),discount=num(v.discount);if(discount>subtotal){toast('تخفیف نمی‌تواند از جمع اقلام بیشتر باشد.');return;}
      const duplicate=ws.invoices.some(i=>i.number===v.number.trim()&&i.id!==modalMode.id);if(duplicate){toast('این شماره فاکتور قبلاً استفاده شده است.');return;}
      const obj={id:modalMode.id||id(),number:v.number.trim(),customerId:v.customerId,date:v.date,items:lines,stockApplied:applyStock,subtotal,discount,total:subtotal-discount,notes:v.notes.trim(),createdAt:modalMode.id?(invoiceById(modalMode.id)?.createdAt||today()):new Date().toISOString()};
      if(modalMode.id)ws.invoices=ws.invoices.map(i=>i.id===obj.id?obj:i);else{ws.invoices.push(obj);ws.nextInvoiceNumber=Math.max(ws.nextInvoiceNumber||1,Number(String(obj.number).match(/(\d+)$/)?.[1]||0)+1);}
      closeModal();saveAndRender();toast('فاکتور ذخیره شد.');
    } else if(form.id==='payment-form'){
      const paymentDate=parseDateOrNotify(v.date);if(!paymentDate)return;v.date=paymentDate;
      if(!v.customerId){toast('مشتری را انتخاب کنید.');return;}const amount=num(v.amount);if(amount<=0){toast('مبلغ باید بیشتر از صفر باشد.');return;}
      let allocations=[];if(v.invoiceId){const inv=invoiceById(v.invoiceId);if(!inv||inv.customerId!==v.customerId){toast('فاکتور انتخاب‌شده متعلق به این مشتری نیست.');return;}const oldAllocation=modalMode.id?num(ws.payments.find(p=>p.id===modalMode.id)?.allocations?.find(a=>a.invoiceId===inv.id)?.amount):0;const maxAlloc=invoiceRemaining(inv)+oldAllocation;const allocated=num(v.allocatedAmount)||Math.min(amount,maxAlloc);if(allocated>amount||allocated>maxAlloc||allocated<0){toast('مبلغ تخصیص نمی‌تواند از مبلغ دریافتی یا مانده فاکتور بیشتر باشد.');return;}allocations=[{invoiceId:inv.id,amount:allocated}];}
      const obj={id:modalMode.id||id(),customerId:v.customerId,date:v.date,amount,method:v.method,reference:v.reference.trim(),note:v.note.trim(),allocations};
      if(modalMode.id)ws.payments=ws.payments.map(p=>p.id===obj.id?obj:p);else ws.payments.push(obj);closeModal();saveAndRender();toast('دریافت وجه ثبت شد.');
    } else if(form.id==='stock-form'){
      const stockDate=parseDateOrNotify(v.date);if(!stockDate)return;const product=productById(v.productId);if(!product){toast('کالا را انتخاب کنید.');return;}const qty=num(v.qty);if(qty<=0){toast('تعداد باید بیشتر از صفر باشد.');return;}const unit=productUnits(product).find(u=>u.name===v.unit)||productUnits(product)[0],baseQty=qty*unit.factor;
      if(v.type==='out'&&!ws.allowNegativeStock&&productStock(ws,product.id)+0.000001<baseQty){toast(`موجودی کافی نیست. موجودی فعلی: ${fmt(productStock(ws,product.id))} ${product.baseUnit||'واحد'}.`);return;}
      ws.stockMovements.push({id:id(),productId:product.id,date:stockDate,type:v.type,qty,unit:unit.name,unitFactor:unit.factor,baseQty,note:v.note.trim(),createdAt:new Date().toISOString()});closeModal();saveAndRender();toast('گردش انبار ثبت شد.');
    } else if(form.id==='expense-form'){
      const expenseDate=parseDateOrNotify(v.date);if(!expenseDate)return;v.date=expenseDate;
      const obj={id:modalMode.id||id(),title:v.title.trim(),date:v.date,amount:num(v.amount),category:v.category.trim(),method:v.method,note:v.note.trim()};if(modalMode.id)ws.expenses=ws.expenses.map(e=>e.id===obj.id?obj:e);else ws.expenses.push(obj);closeModal();saveAndRender();toast('هزینه ذخیره شد.');
    } else if(form.id==='adjustment-form'){
      const adjustmentDate=parseDateOrNotify(v.date);if(!adjustmentDate)return;v.date=adjustmentDate;
      if(!v.customerId){toast('مشتری را انتخاب کنید.');return;}const obj={id:modalMode.id||id(),customerId:v.customerId,date:v.date,type:v.type,amount:num(v.amount),reason:v.reason.trim(),note:v.note.trim()};ws.adjustments.push(obj);closeModal();saveAndRender();toast('اصلاح حساب ثبت شد.');
    } else if(form.id==='workspace-form'){
      const nw=newWorkspace(v.name.trim());nw.currency=v.currency;data.workspaces.push(nw);data.activeWorkspaceId=nw.id;page='dashboard';closeModal();await dbSave();if(submitEpoch!==syncEpoch||!accessGranted||!data)return;render();toast('کسب‌وکار جدید ساخته شد.');
    } else if(form.id==='category-form'){
      const name=v.name.trim();if(!name){toast('نام شاخه را وارد کنید.');return;}if(ws.categories.some(c=>c.name===name&&name!==modalMode.oldName)){toast('این شاخه از قبل وجود دارد.');return;}const obj={name,subs:v.subs.split(/[،,]/).map(x=>x.trim()).filter(Boolean)};if(modalMode.oldName){ws.categories=ws.categories.filter(c=>c.name!==modalMode.oldName);ws.products.forEach(p=>{if(p.category===modalMode.oldName)p.category=name;});}ws.categories.push(obj);await dbSave();if(submitEpoch!==syncEpoch||!accessGranted||!data)return;openCategories();toast('دسته‌بندی ذخیره شد.');
    }
  }

  function handleClick(event){
    const actionEl=event.target.closest('[data-action]');
    const actionName=actionEl?.dataset.action||'';
    const gateActions=['gate-login-google','gate-login-github','gate-retry','gate-test-network','gate-signout','gate-copy-uid'];
    const insideProtectedUi=!!(event.target.closest('#app')||event.target.closest('#modal-root'));
    if(insideProtectedUi&&!gateActions.includes(actionName)&&!sessionAllowedForCurrentTab()){event.preventDefault();event.stopImmediatePropagation();return;}
    if(actionEl){const action=actionName;if(action==='activate-workspace'){data.activeWorkspaceId=actionEl.dataset.id;page='dashboard';closeModal();saveAndRender();return;}if(action==='edit-category'||action==='delete-category'){handleAction(action,actionEl);return;}handleAction(action,actionEl);return;}
    if(event.target.matches('[data-backdrop]'))closeModal();
    if(event.target.id==='jalali-calendar')closeJalaliCalendar();
  }
  function handleInput(event){
    if(event.target.matches('[data-integer-input]')){const raw=toLatinDigits(event.target.value);const match=raw.match(/^-?\d+/);const normalized=match?match[0]:'';if(normalized!==event.target.value)event.target.value=normalized;}
    if(event.target.id==='inventory-sort'){activeWs().inventorySort=event.target.value;saveAndRender();return;}
    if(event.target.matches('[data-search]')){const pos=event.target.selectionStart;currentSearch=event.target.value;const y=window.scrollY;render();const input=$('[data-search]');if(input){input.focus();input.setSelectionRange(pos,pos);}window.scrollTo(0,y);}
    if(event.target.matches('.line-qty,.line-price,.invoice-discount'))recalcInvoiceModal();
    if(event.target.matches('.line-product')){const product=productById(event.target.value);const line=event.target.closest('[data-line]');if(line){const unit=$('.line-unit',line);unit.innerHTML=product?productUnits(product).map(u=>`<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}${u.factor>1?` (هر واحد ${fmt(u.factor)} ${escapeHtml(product.baseUnit||'')})`:''}</option>`).join(''):'';$('.line-price',line).value=product?product.price:0;}recalcInvoiceModal();}
    if(event.target.matches('.line-unit')){const line=event.target.closest('[data-line]'),product=productById($('.line-product',line).value),unit=productUnits(product).find(u=>u.name===event.target.value);if(product&&unit)$('.line-price',line).value=Number(product.price||0)*unit.factor;recalcInvoiceModal();}
    if(event.target.matches('select[name="productId"]')&&event.target.closest('#stock-form'))updateStockUnitOptions();
    if(event.target.name==='customerId'&&event.target.closest('#payment-form')){const form=$('#payment-form');const select=$('select[name="invoiceId"]',form);if(select){const p=wsAvailableInvoices(event.target.value);select.innerHTML=`<option value="">بدون تخصیص؛ ثبت در حساب کلی مشتری</option>${p.map(i=>`<option value="${i.id}">${escapeHtml(i.number)} · مانده ${fmt(invoiceRemaining(i))}</option>`).join('')}`;}}
  }
  function wsAvailableInvoices(customerId){return activeWs().invoices.filter(i=>i.customerId===customerId&&invoiceRemaining(i)>0);}

  document.addEventListener('click',handleClick);
  document.addEventListener('submit',event=>{const f=event.target;if(f.matches('form')&&['customer-form','product-form','invoice-form','payment-form','expense-form','adjustment-form','workspace-form','category-form','stock-form'].includes(f.id)){event.preventDefault();if(!sessionAllowedForCurrentTab()){toast('نشست این حساب پایان یافته است؛ عملیات ذخیره نشد.');return;}submitForm(f).catch(err=>{console.error(err);toast('ذخیره اطلاعات با خطا روبه‌رو شد.');});}});
  document.addEventListener('input',event=>{if((event.target.closest('#app')||event.target.closest('#modal-root'))&&!sessionAllowedForCurrentTab())return;handleInput(event);});
  document.addEventListener('change',event=>{if((event.target.closest('#app')||event.target.closest('#modal-root'))&&!sessionAllowedForCurrentTab())return;handleInput(event);});
  $('#back-page').addEventListener('click',()=>{if(sessionAllowedForCurrentTab())goBack();});
  window.addEventListener('online',()=>{reconnectAndRevalidate();});
  window.addEventListener('focus',()=>{if(navigator.onLine&&accessUid)reconnectAndRevalidate();});
  window.addEventListener('pageshow',()=>{if(navigator.onLine&&accessUid)reconnectAndRevalidate();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&navigator.onLine&&accessUid)reconnectAndRevalidate();});
  window.addEventListener('dh-cloud-auth',event=>{
    if(!authReady)return;
    const next=event.detail?.user||null;
    if(!next){if(accessGranted||accessUid){const oldUid=accessUid;cloudUser=null;lockApplication('signed-out',{clearCache:true,clearIdentity:true,uid:oldUid}).catch(console.error);}return;}
    if(!accessUid&&!accessGranted&&!manualLoginInProgress){cloudUser=next;authorizeCurrentUser(next,{startup:true}).catch(console.error);return;}
    if(accessUid&&next.uid!==accessUid&&!manualLoginInProgress){
      const oldUid=accessUid;clearAuthorizedUid(oldUid);cloudUser=next;
      lockApplication('login',{clearIdentity:true,uid:oldUid}).then(()=>{
        if(navigator.onLine)reconnectAndRevalidate();
        else showAccessGate('login');
      }).catch(console.error);
    }
  });
  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>{if(sessionAllowedForCurrentTab())setPage(b.dataset.page);}));
  $('#quick-add').addEventListener('click',()=>{if(!sessionAllowedForCurrentTab())return;modal('ثبت سریع',`<div class="quick-grid"><button class="quick-tile" data-action="add-invoice"><span class="quick-icon">＋</span><b>فاکتور فروش</b></button><button class="quick-tile" data-action="add-payment"><span class="quick-icon">↙</span><b>دریافت وجه</b></button><button class="quick-tile" data-action="add-customer"><span class="quick-icon">♙</span><b>مشتری جدید</b></button><button class="quick-tile" data-action="add-expense"><span class="quick-icon">−</span><b>ثبت هزینه</b></button></div>`);});
  $('#restore-file').addEventListener('change',e=>{const f=e.target.files?.[0];if(f&&sessionAllowedForCurrentTab())restoreBackup(f);e.target.value='';});

  initializeCrossTabLogout();
  async function init(){
    try{showAccessGate('login');await initializeCloudSync();}
    catch(err){console.error(err);showAccessGate('network',{message:'راه‌اندازی برنامه با خطا روبه‌رو شد. مرورگر را به‌روز کنید و دوباره تلاش کنید.'});}
  }
  init();
})();
