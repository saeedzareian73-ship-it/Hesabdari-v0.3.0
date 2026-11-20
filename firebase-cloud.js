/* Firebase bridge for Daftar Hesab. Loaded lazily only when firebase-config.js is complete. */
(() => {
  'use strict';
  const SDK_VERSION = '13.4.0';
  let modules = null, auth = null, db = null, app = null, current = null, initPromise = null, lastAuthError = null;
  const cfg = () => window.DH_FIREBASE_CONFIG || {};
  function isConfigured(){const c=cfg();return !!(c.apiKey&&c.authDomain&&c.projectId&&c.appId);}
  async function loadModules(){
    if(modules)return modules;
    const root=`https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
    const [appMod,authMod,fsMod]=await Promise.all([
      import(root+'firebase-app.js'),import(root+'firebase-auth.js'),import(root+'firebase-firestore.js')
    ]);
    modules={...appMod,...authMod,...fsMod};return modules;
  }
  function userInfo(){return current?{uid:current.uid,email:current.email,displayName:current.displayName}:null;}
  async function initialize(){
    if(!isConfigured())return {configured:false,user:null};
    if(!initPromise){initPromise=(async()=>{
      lastAuthError=null;
      const m=await loadModules();app=m.getApps().length?m.getApp():m.initializeApp(cfg());
      auth=m.getAuth(app);db=m.getFirestore(app);
      try{await m.setPersistence(auth,m.browserLocalPersistence);}catch(e){console.warn('Firebase persistence fallback',e);}
      try{await m.getRedirectResult(auth);}catch(e){lastAuthError=e;console.warn('OAuth redirect result:',e);}
      current=await new Promise((resolve,reject)=>{let unsub=()=>{};unsub=m.onAuthStateChanged(auth,u=>{current=u;unsub();resolve(u);},reject);});
      m.onAuthStateChanged(auth,u=>{current=u;window.dispatchEvent(new CustomEvent('dh-cloud-auth',{detail:{user:userInfo()}}));});
    })().catch(err=>{initPromise=null;throw err;});}
    await initPromise;
    // initPromise فقط راه‌اندازی SDK را نگه می‌دارد؛ وضعیت کاربر باید در هر فراخوانی تازه خوانده شود.
    return {configured:true,user:userInfo(),authError:lastAuthError?{code:lastAuthError.code,message:lastAuthError.message}:null};
  }
  async function signIn(){
    await initialize();if(!auth)throw new Error('تنظیمات Firebase کامل نشده است.');
    const m=modules;const provider=new m.GoogleAuthProvider();
    // برای میزبانی خارج از Firebase، Popup از مشکلات دسترسی third-party storage در redirect جلوگیری می‌کند.
    // اگر مرورگر popup را مسدود کند، redirect به‌عنوان مسیر جایگزین استفاده می‌شود.
    try{const result=await m.signInWithPopup(auth,provider);current=result.user;lastAuthError=null;return result;}
    catch(e){if(['auth/popup-blocked','auth/popup-closed-by-user','auth/web-storage-unsupported'].includes(e.code))return m.signInWithRedirect(auth,provider);throw e;}
  }
  async function signOut(){await initialize();if(auth)await modules.signOut(auth);current=null;}
  function currentUser(){return userInfo();}
  async function checkAccess(){
    await initialize();if(!current||!db)return false;
    const ref=modules.doc(db,'access',current.uid),snap=await modules.getDoc(ref);
    return snap.exists()&&snap.data().enabled===true;
  }
  function watchAccess(onChange,onError){
    if(!current||!db||!modules)return ()=>{};
    const ref=modules.doc(db,'access',current.uid);
    return modules.onSnapshot(ref,snap=>onChange(!!(snap.exists()&&snap.data().enabled===true)),err=>{if(onError)onError(err);});
  }
  function bytesToBase64(bytes){let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary);}
  function base64ToBytes(text){const binary=atob(text);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;}
  async function encodePayload(data){
    const raw=new TextEncoder().encode(JSON.stringify(data));
    if('CompressionStream' in window){const stream=new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));const zipped=new Uint8Array(await new Response(stream).arrayBuffer());return {encoding:'gzip',base64:bytesToBase64(zipped)};}
    return {encoding:'plain',base64:bytesToBase64(raw)};
  }
  async function decodePayload(base64,encoding){
    const bytes=base64ToBytes(base64);let raw=bytes;
    if(encoding==='gzip'){if(!('DecompressionStream' in window))throw new Error('مرورگر این دستگاه امکان باز کردن فایل فشرده ابری را ندارد.');const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));raw=new Uint8Array(await new Response(stream).arrayBuffer());}
    return JSON.parse(new TextDecoder().decode(raw));
  }
  function refs(uid){return {meta:modules.doc(db,'users',uid,'cloudState','main'),part:i=>modules.doc(db,'users',uid,'cloudParts',`part_${i}`)};}
  async function loadSnapshot(){
    await initialize();if(!current||!db)throw new Error('ابتدا وارد حساب ابری شوید.');
    const ok=await checkAccess();if(!ok){const e=new Error('این حساب توسط مدیر برنامه فعال نشده است.');e.code='access-denied';throw e;}
    const r=refs(current.uid),metaSnap=await modules.getDoc(r.meta);if(!metaSnap.exists())return null;
    const meta=metaSnap.data(),parts=[];
    for(let i=0;i<Number(meta.parts||0);i++){const snap=await modules.getDoc(r.part(i));if(!snap.exists())throw new Error('یکی از بخش‌های فایل پشتیبان ابری پیدا نشد.');parts.push(snap.data().content||'');}
    return {data:await decodePayload(parts.join(''),meta.encoding||'plain'),updatedAt:Number(meta.updatedAt||meta.savedAt||0)};
  }
  async function saveSnapshot(data,updatedAt){
    await initialize();if(!current||!db)throw new Error('ابتدا وارد حساب ابری شوید.');
    const ok=await checkAccess();if(!ok){const e=new Error('این حساب توسط مدیر برنامه فعال نشده است.');e.code='access-denied';throw e;}
    const r=refs(current.uid),old=await modules.getDoc(r.meta),oldParts=old.exists()?Number(old.data().parts||0):0;
    const payload=await encodePayload(data),CHUNK=600000,parts=[];
    for(let i=0;i<payload.base64.length;i+=CHUNK)parts.push(payload.base64.slice(i,i+CHUNK));
    if(!parts.length)parts.push('');
    for(let start=0;start<parts.length;start+=400){const batch=modules.writeBatch(db);parts.slice(start,start+400).forEach((content,offset)=>batch.set(r.part(start+offset),{content,index:start+offset,updatedAt:Number(updatedAt)}));await batch.commit();}
    await modules.setDoc(r.meta,{schema:1,parts:parts.length,encoding:payload.encoding,updatedAt:Number(updatedAt),savedAt:Date.now()});
    if(oldParts>parts.length){for(let start=parts.length;start<oldParts;start+=400){const batch=modules.writeBatch(db);for(let i=start;i<Math.min(oldParts,start+400);i++)batch.delete(r.part(i));await batch.commit();}}
  }
  window.DHCloud={isConfigured,initialize,signIn,signOut,currentUser,checkAccess,watchAccess,loadSnapshot,saveSnapshot};
})();
