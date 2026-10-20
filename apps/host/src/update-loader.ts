// Host-owned recovery surface. Never bundled with a candidate or dependent on React.
export const updateLoaderHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suri Pi</title></head><body><div id="root"><main aria-live="polite">Loading Suri Pi…</main></div><script src="/update-loader.js"></script></body></html>`;
export const updateLoaderScript = String.raw`
(() => {
  const root=document.getElementById('root');
  let csrf,descriptor,client=sessionStorage.getItem('suri.window')||crypto.randomUUID();
  sessionStorage.setItem('suri.window',client);
  let operation=null,finished=false,ready=false,composing=false,stage='bootstrap';
  const shellContract=window.webkit?Number(new URLSearchParams(location.search).get('shell')||1):null;
  const shellLocation=value=>{const target=new URL(value,location.origin);if(shellContract)target.searchParams.set('shell',String(shellContract));return target.pathname+target.search};
  const appLocation=()=>shellLocation('/app');
  const notifyShell=state=>{try{window.webkit?.messageHandlers?.suri?.postMessage({type:'hostLifecycle',state})}catch{}};
  addEventListener('compositionstart',()=>{composing=true});addEventListener('compositionend',()=>{composing=false});
  function rotateWindow(copyOutbox=true){
    const previous=client;client=crypto.randomUUID();
    const prefix='suri.window.'+previous+'.';
    for(let index=0;index<localStorage.length;index++){const key=localStorage.key(index);if(key?.startsWith(prefix)&&(copyOutbox||!key.slice(prefix.length).startsWith('suri.outbox.')))localStorage.setItem('suri.window.'+client+'.'+key.slice(prefix.length),localStorage.getItem(key))}
    sessionStorage.setItem('suri.window',client);sessionStorage.removeItem('suri.checkpointRevision');
    if(!copyOutbox){const checkpoint=localCheckpoint();if(checkpoint){checkpoint.draft.outboxIds=[];sessionStorage.setItem('suri.checkpoint',JSON.stringify(checkpoint))}}
  }
  const nonce=new URLSearchParams(location.hash.slice(1)).get('nonce');
  history.replaceState(null,'',location.pathname+location.search);
  const failView=code=>{
    finished=true;ready=false;lock(false);notifyShell('recoveryRequired');
    window.suriUpdateFailure={stage,code};
    root.replaceChildren();
    const main=document.createElement('main');main.setAttribute('role','alert');main.style.cssText='font:16px/1.5 system-ui;max-width:640px;margin:32px auto;padding:24px;color:CanvasText;background:Canvas;overflow-wrap:anywhere';
    const title=document.createElement('h1');title.textContent='Suri Pi recovery';
    const message=document.createElement('p');message.textContent=stage+': '+code;
    main.append(title,message);
    const download=document.createElement('button');download.textContent='Download saved window state';download.onclick=()=>void exportSaved();main.append(download);
    for(const [label,target] of (csrf&&code!=='RECONNECT_SECURELY'?[['Restore previous interface','previous'],['Use packaged interface','packaged']]:[])){
      const button=document.createElement('button');button.textContent=label;button.onclick=()=>transition('ui.rollback',{target}).catch(()=>failView('RECOVERY_TRANSITION_FAILED'));main.append(button);
    }
    const hint=document.createElement('p');hint.textContent='If the local connection expired, open Suri through its local launcher. Your draft is retained.';main.append(hint);for(const button of main.querySelectorAll('button'))button.style.cssText='display:block;min-height:44px;padding:8px 12px;margin:12px 0;font:inherit;color:CanvasText;background:Canvas;border:1px solid currentColor;border-radius:6px';root.append(main);
  };
  async function command(type,payload={}) {
    const response=await fetch('/v1/commands',{method:'POST',headers:{'Content-Type':'application/json','X-Suri-Csrf':csrf},body:JSON.stringify({v:1,id:crypto.randomUUID(),createdAt:new Date().toISOString(),type,payload})});
    if(!response.ok)throw Error('CONNECTION_LOST');
    const receipt=await response.json();if(receipt.status!=='completed')throw Error(receipt.error?.code||'UPDATE_COMMAND_FAILED');return receipt.result;
  }
  const blank=()=>({schema:1,selectedProjectId:null,selectedWorkspaceId:null,selectedSessionId:null,draft:{text:'',attachmentIds:[],revision:0,outboxIds:[]},expandedIds:[],anchor:{messageId:null,blockId:null,offset:0,bottomFollow:true},layout:{sidebarOpen:false,detailsOpen:false,focus:'none'}});
  function localCheckpoint(){try{return JSON.parse(sessionStorage.getItem('suri.checkpoint')||'null')}catch{return null}}
  async function exportSaved(){
    const viewBuffers={};for(let index=0;index<localStorage.length;index++){const key=localStorage.key(index);if(key?.startsWith('suri.window.'+client+'.suri.'))viewBuffers[key.slice(('suri.window.'+client+'.').length)]=localStorage.getItem(key)}
    const body={schema:1,checkpoint:localCheckpoint()||window.suriUpdate?.descriptorCheckpoint||await persisted()||blank(),viewBuffers};
    const url=URL.createObjectURL(new Blob([JSON.stringify(body,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='suri-window-state.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  const database=new Promise((resolve,reject)=>{const request=indexedDB.open('suri-update-checkpoints',1);request.onupgradeneeded=()=>request.result.createObjectStore('windows');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('CLIENT_STATE_UNSAVED'))});
  database.catch(()=>{});
  async function persist(checkpoint){
    sessionStorage.setItem('suri.checkpoint',JSON.stringify(checkpoint));
    const db=await database;
    await new Promise((resolve,reject)=>{const tx=db.transaction('windows','readwrite');tx.objectStore('windows').put(checkpoint,client);tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(Error('CLIENT_STATE_UNSAVED'))});
  }
  async function persisted(){try{const db=await database;return await new Promise((resolve,reject)=>{const request=db.transaction('windows').objectStore('windows').get(client);request.onsuccess=()=>resolve(request.result||null);request.onerror=reject})}catch{return null}}
  let barrierView;
  function lock(locked){
    root.inert=locked;document.documentElement.dataset.suriUpdating=String(locked);
    if(!locked){barrierView?.remove();barrierView=null;dispatchEvent(new Event('suri-update-unlocked'));return}
    if(!barrierView){barrierView=document.createElement('aside');barrierView.setAttribute('role','status');barrierView.style.cssText='position:fixed;z-index:1000;right:16px;bottom:16px;max-width:calc(100vw - 32px);padding:16px;background:white;color:#202329;border:1px solid #626b78;font:14px system-ui';barrierView.textContent='Saving window state…';document.body.append(barrierView)}
  }
  async function checkpoint(){
    if(composing||window.suriUploadsPending>0)throw Error('CLIENT_STATE_UNSAVED');
    const saved=window.suriCheckpoint?.()||localCheckpoint()||blank();lock(true);
    try{await Promise.race([window.suriFlush?.()||Promise.resolve(),new Promise((_,reject)=>setTimeout(()=>reject(Error('CLIENT_STATE_UNSAVED')),5000))]);const current=window.suriCheckpoint?.();if(current){saved.draft.revision=current.draft.revision;saved.draft.outboxIds=current.draft.outboxIds}await persist(saved);return saved}catch(error){lock(false);throw error}
  }
  let restartOperation=null,restartBarrier=null,restartBusy=false,browserOpening=false,connectionLostAt=0;
  async function restartPoll(){
    if(restartBusy||!ready||browserOpening)return;restartBusy=true;
    try{
      const status=await command('updates.get');connectionLostAt=0;const approval=status.restart?.approval;
      const request=status.browserOpen?.find(request=>request.clientInstanceId===client);
      if(request&&!operation&&!restartOperation){
        const saved=await checkpoint();browserOpening=true;
        try{const stored=await command('ui.rendezvous',{clientInstanceId:client,requestId:request.requestId,expectedCheckpointRevision:Number(sessionStorage.getItem('suri.checkpointRevision')||0),checkpoint:saved});sessionStorage.setItem('suri.checkpointRevision',String(stored.revision));if(barrierView)barrierView.textContent='Reopening this window. Your draft is saved.'}finally{setTimeout(()=>{browserOpening=false;lock(false)},5000)}
        return;
      }
      if(approval?.phase==='checkpoints'&&restartBarrier!==approval.barrierId){
        const saved=await checkpoint();
        const record=await command('host.restart.checkpoint',{clientInstanceId:client,operationId:approval.operationId,barrierId:approval.barrierId,expectedCheckpointRevision:Number(sessionStorage.getItem('suri.checkpointRevision')||0),checkpoint:saved});
        sessionStorage.setItem('suri.checkpointRevision',String(record.revision));
        const mint=await fetch('/v1/restart-handoff/mint',{method:'POST',headers:{'Content-Type':'application/json','X-Suri-Csrf':csrf},body:JSON.stringify({operationId:approval.operationId,barrierId:approval.barrierId})});if(!mint.ok)throw Error('RESTART_BARRIER_CLOSED');
        restartOperation=approval.operationId;restartBarrier=approval.barrierId;sessionStorage.setItem('suri.restart',JSON.stringify({operationId:restartOperation,targetBuildId:approval.targetBuildId,fromInstanceId:approval.fromInstanceId,profileId:approval.profileId,expiresAt:Date.now()+120000}));
        await command('host.restart.ack',{clientInstanceId:client,operationId:restartOperation,barrierId:restartBarrier,checkpointRevision:record.revision});notifyShell('restartInProgress');
        if(barrierView){barrierView.textContent='Restarting host. Your draft is saved. ';const cancel=document.createElement('button');cancel.textContent='Cancel restart';cancel.onclick=()=>command('host.restart.cancel',{clientInstanceId:client,operationId:restartOperation}).then(()=>{sessionStorage.removeItem('suri.restart');restartOperation=null;restartBarrier=null;lock(false);notifyShell('ready')}).catch(()=>{barrierView.textContent='Restart has already started. Waiting for secure reconnection…'});barrierView.append(cancel)}
      }else if(restartOperation&&['waiting','cancelled','failed','completed'].includes(approval?.phase)){restartOperation=null;restartBarrier=null;sessionStorage.removeItem('suri.restart');lock(false);notifyShell(approval?.phase==='failed'?'recoveryRequired':'ready')}
    }catch(error){
      if(sessionStorage.getItem('suri.restart'))await reconnectRestart();else {
        lock(false);
        if(error?.message==='CONNECTION_LOST'||error instanceof TypeError){connectionLostAt ||= Date.now();if(Date.now()-connectionLostAt>5000){await persist(window.suriCheckpoint?.()||localCheckpoint()||blank()).catch(()=>{});window.suriReconnectRequired=true;stage='connection';failView('RECONNECT_SECURELY')}}
      }
    }finally{restartBusy=false}
  }
  async function reconnectRestart(){
    if(navigator.locks)return navigator.locks.request('suri-host-restart',{ifAvailable:true},lock=>lock?performRestartReconnect():false);
    // Older engines still fail closed through atomic one-consumption-per-group.
    return performRestartReconnect();
  }
  async function performRestartReconnect(){
    let pending;try{pending=JSON.parse(sessionStorage.getItem('suri.restart')||'null')}catch{sessionStorage.removeItem('suri.restart');window.suriReconnectRequired=true;stage='restart-handoff';failView('RECONNECT_SECURELY');return true}if(!pending)return false;
    if(pending.expiresAt<Date.now()){sessionStorage.removeItem('suri.restart');ready=false;window.suriReconnectRequired=true;lock(false);stage='restart-handoff';failView('RECONNECT_SECURELY');return true}
    try{
      let response=await fetch('/v1/client');
      if(!response.ok){
        const handoff=await fetch('/v1/restart-handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        if(!handoff.ok)return false;
        const grant=await handoff.json();response=await fetch('/v1/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:grant.nonce})});
      }
      if(!response.ok)return false;
      const auth=await response.json();csrf=auth.csrf;
      const status=await command('updates.get');
      if(status.runningHost.buildId!==pending.targetBuildId||status.runningHost.instanceId===pending.fromInstanceId||status.profileId!==pending.profileId)return false;
      sessionStorage.removeItem('suri.restart');notifyShell('reconnecting');location.replace(appLocation());return true;
    }catch{return false}
  }
  async function transition(type,payload={}) {
    if(operation||browserOpening)throw Error('UPDATE_CONFLICT');
    operation='flushing';
    try {
      const saved=await checkpoint();
      const status=await command('updates.get');
      const prepared=await command(type,{...payload,clientInstanceId:client,expectedUpdateRevision:status.revision});
      const trial=prepared.trial;operation=trial.operationId;
      const stored=await command('ui.checkpoint',{operationId:operation,clientInstanceId:client,expectedCheckpointRevision:Number(sessionStorage.getItem('suri.checkpointRevision')||0),checkpoint:saved});
      const revision=stored.trial.checkpointRevision;
      sessionStorage.setItem('suri.checkpointRevision',String(revision));
      const next=await command('ui.activate',{operationId:operation,buildId:trial.buildId,clientInstanceId:client,expectedUpdateRevision:stored.revision,checkpointRevision:revision});
      location.assign(shellLocation(next.url));
    }catch(error){operation=null;lock(false);throw error}
  }
  async function failure(code) {
    if(finished||ready)return;finished=true;
    if(!descriptor||new URLSearchParams(location.search).has('fallback')){failView(code);return}
    try {
      const next=await command('ui.failed',{operationId:descriptor.operationId,clientInstanceId:client,buildId:descriptor.buildId,code});
      if(sessionStorage.getItem('suri.uiPin')===descriptor.buildId)sessionStorage.removeItem('suri.uiPin');
      location.replace(shellLocation(next.url));
    }catch{failView(code)}
  }
  async function start(){
    const response=await fetch(nonce?'/v1/bootstrap':'/v1/client',nonce?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce})}:{});
    if(!response.ok){if(sessionStorage.getItem('suri.restart')){const retry=setInterval(()=>{void reconnectRestart().then(ok=>{if(ok)clearInterval(retry)})},500);return}failView('RECONNECT_SECURELY');return}
    const auth=await response.json();csrf=auth.csrf;
    const previousAuth=sessionStorage.getItem('suri.windowAuth');
    if(previousAuth&&previousAuth!==auth.clientId)rotateWindow();
    sessionStorage.setItem('suri.windowAuth',auth.clientId);
    // Duplicated sessionStorage is not authority for a second writable window.
    const collision=new BroadcastChannel('suri-update-windows');
    const ticket=crypto.randomUUID();
    collision.onmessage=event=>{if(event.data?.client!==client||event.data.ticket===ticket)return;if(event.data.type==='probe')collision.postMessage({type:'occupied',client,ticket});else if(event.data.type==='occupied')rotateWindow(false);};
    collision.postMessage({type:'probe',client,ticket});await new Promise(r=>setTimeout(r,100));
    const register=()=>command('updates.client',{clientInstanceId:client,surface:window.webkit?'native':'browser',loadedUiId:descriptor?.buildId||sessionStorage.getItem('suri.uiPin')||null,mode:sessionStorage.getItem('suri.uiPin')?'pinned':'follow',...(shellContract?{shellContract}:{})});
    stage='window-register';await register();
    const canonical=new URL(location.href);canonical.searchParams.set('window',client);history.replaceState(null,'',canonical.pathname+canonical.search);
    setInterval(()=>register().catch(()=>{}),15000);
    addEventListener('focus',()=>register().catch(()=>{}));
    window.suriUpdate={command,client,transition,persist,exportSaved,pin:async()=>{await command('ui.pin',{clientInstanceId:client,buildId:descriptor.buildId});sessionStorage.setItem('suri.uiPin',descriptor.buildId);dispatchEvent(new Event('suri-update-ready'))},follow:async()=>{try{await checkpoint();await command('ui.follow',{clientInstanceId:client});sessionStorage.removeItem('suri.uiPin');location.assign(appLocation())}catch(error){lock(false);throw error}},get descriptor(){return descriptor},get ready(){return ready},reload:async()=>{
      if(sessionStorage.getItem('suri.uiPin')){await checkpoint();location.reload();return}
      const status=await command('updates.get');
      const target=status.ui.activeId!==descriptor?.buildId?status.ui.activeId:status.ui.candidate?.buildId;
      if(!target||target===descriptor?.buildId){await checkpoint();location.reload();return}
      return transition('ui.prepare',{buildId:target});
    }};
    if(location.pathname==='/recover'){failView('Choose a retained interface.');return}
    stage='ui-selection';const selection=await fetch('/v1/ui-selection?client='+encodeURIComponent(client));
    if(!selection.ok)throw Error('UI_SELECTION_FAILED');
    descriptor=await selection.json();
    sessionStorage.setItem('suri.checkpointRevision',String(descriptor.checkpointRevision));
    window.suriUpdate.descriptorCheckpoint=localCheckpoint()||descriptor.checkpoint||await persisted();
    const restore=window.suriUpdate.descriptorCheckpoint;
    if(restore?.selectedSessionId){
      localStorage.setItem('suri.window.'+client+'.suri.selected',restore.selectedSessionId);
      localStorage.setItem('suri.window.'+client+'.suri.draft.'+restore.selectedSessionId,restore.draft.text);
    }
    for(const id of restore?.expandedIds||[])localStorage.setItem('suri.window.'+client+'.suri.disclosure.'+id,'true');
    const stylesReady=Promise.all(descriptor.styles.map(path=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/ui/'+descriptor.buildId+'/'+path;link.onload=resolve;link.onerror=reject;document.head.append(link)})));stylesReady.catch(()=>{});
    stage='ui-mount';lock(true);if(barrierView)barrierView.textContent='Restoring saved window…';let elapsed=0;const started=performance.now();let previous=started;
    const watchdog=setInterval(()=>{const now=performance.now();if(!document.hidden)elapsed+=now-previous;previous=now;if(ready||finished)clearInterval(watchdog);else if(elapsed>10000||now-started>60000)void failure('UI_READY_TIMEOUT')},100);
    addEventListener('error',()=>void failure('UI_MOUNT_FAILED'));
    addEventListener('unhandledrejection',()=>void failure('UI_ASSET_MISSING'));
    addEventListener('vite:preloadError',()=>void failure('UI_ASSET_MISSING'));
    try{await stylesReady}catch{await failure('UI_ASSET_MISSING');return}
    const script=document.createElement('script');script.type='module';script.src='/ui/'+descriptor.buildId+'/'+descriptor.entry;script.onerror=()=>void failure('UI_ASSET_MISSING');document.head.append(script);
    for(let i=0;i<600&&!finished;i++){
      if(window.suriReady&&window.suriRestore){
        stage='checkpoint-restore';await window.suriRestore(window.suriUpdate.descriptorCheckpoint);
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        while(!window.suriReady&&!finished)await new Promise(resolve=>setTimeout(resolve,50));
        if(finished)return;
        const watermark=window.suriWatermarks?.()||{catalogSeq:0};
        stage='ready-commit';await command('ui.ready',{operationId:descriptor.operationId,clientInstanceId:client,buildId:descriptor.buildId,checkpointRevision:descriptor.checkpointRevision,hostInstanceId:descriptor.hostInstanceId,...watermark});
        if(sessionStorage.getItem('suri.uiPin'))sessionStorage.setItem('suri.uiPin',descriptor.buildId);
        ready=true;lock(false);if(restore?.layout.focus==='composer')root.querySelector('[aria-label="Message Pi"]')?.focus();dispatchEvent(new Event('suri-update-ready'));setInterval(()=>void restartPoll(),1000);return;
      }
      await new Promise(r=>setTimeout(r,100));
    }
  }
  start().catch(error=>failView(/^[A-Z_]{1,80}$/.test(error?.message||'')?error.message:'UPDATE_LOADER_FAILED'));
})();`;
