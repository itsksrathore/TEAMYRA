const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { MediaBrowserController } = require('../src/media/media-browser-controller');
const { FlowReferenceController, mediaId } = require('../src/media/flow-reference-controller');
const { GoogleFlowAutomationAdapter } = require('../src/media/google-flow-automation-adapter');
const CAR = '7edb6cbd-6555-4fa0-a82a-1f2126efa59d';
const OTHER = '6c7af45a-8003-4f5a-a7c2-a2f471ecf3e4';

async function main() {
  const clicks = [];
  const ctl = new FlowReferenceController({ executePageScript: async script => {
    if (script.includes('flow-image-tile')) return 'https://flow.google.com/asb/car=s1600-rw';
    if (script.includes('el.click()')) { clicks.push(script); return true; }
    throw Error('Unexpected fixture operation');
  }});
  ctl.candidates = async () => [
    {marker:'wrong',title:'car',type:'image',source:'https://flow.google.com/asb/unrelated=s1600-rw'},
    {marker:'correct',title:'car',type:'image',source:'https://flow.google.com/asb/car=s1600-rw'}
  ];
  ctl.preview = async () => ({title:'car',source:'https://flow.google.com/asb/car=s2048-rw'});
  assert.equal(await ctl.selectExisting({provider_asset_id:CAR}), CAR);
  assert.equal(clicks.length,1);
  assert.ok(clicks[0].includes('correct'), 'duplicate titles cannot choose another provider image');
  ctl.candidates = async () => [];
  assert.equal(await ctl.selectExisting({provider_asset_id:CAR}),null,'empty libraries allow upload fallback');

  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(),'teamyra-fixture-'));
  const original = path.join(sourceDir,'car.png');
  fs.writeFileSync(original,'fixture car bytes');
  let uploadPath;
  let uploadTitle;
  const uploader = new FlowReferenceController({executePageScript:async()=>true,browser:{uploadFiles:async(activate,files)=>{
    assert.equal(await activate(),true);
    uploadPath=files[0];uploadTitle=path.basename(uploadPath,path.extname(uploadPath));
    assert.equal(fs.readFileSync(uploadPath,'utf8'),'fixture car bytes');
    assert.notEqual(uploadPath,original);
  }}});
  uploader.clickButton=async()=>true;
  uploader.candidates=async()=>[
    {marker:'old',title:'car',source:'wrong'},
    {marker:'new',title:uploadTitle,source:'https://flow.google.com/asb/upload'}
  ];
  uploader.preview=async()=>({title:uploadTitle,source:'https://flow.google.com/asb/upload'});
  const uploaded=await uploader.uploadFile({path:original});
  assert.match(uploaded.uploaded_name,/^teamyra-[0-9a-f-]+$/);
  assert.equal(fs.existsSync(uploadPath),false,'only the temporary copy is cleaned');
  assert.equal(fs.readFileSync(original,'utf8'),'fixture car bytes');
  fs.unlinkSync(original);fs.rmdirSync(sourceDir);

  let current=[{source:`https://flow-content.google/image/${CAR}?token=rotates`,busy:false}];
  ctl.attachments=async()=>current;
  assert.equal(await ctl.matches([{provider_asset_id:CAR}]),true);
  current=[{source:`https://flow-content.google/image/${OTHER}`,busy:false}];
  assert.equal(await ctl.matches([{provider_asset_id:CAR}]),false,'a different image aborts before Generate');
  current.push({source:`https://flow-content.google/image/${CAR}`,busy:false});
  assert.equal(await ctl.matches([{provider_asset_id:CAR}]),false,'unexpected ingredients also abort');
  assert.equal(mediaId(`https://flow-content.google/image/${CAR}?x=1`),CAR);

  // Detached native inputs are identified by the chooser event, not a DOM selector.
  const debuggerApi=new EventEmitter();
  const commands=[];
  debuggerApi.isAttached=()=>true;
  debuggerApi.sendCommand=async(name,args)=>{commands.push({name,args});return {};};
  const browserController=new MediaBrowserController({debugger:debuggerApi});
  await browserController.uploadFiles(async()=>{
    debuggerApi.emit('message',null,'Page.fileChooserOpened',{backendNodeId:987});
    return true;
  },['car.png']);
  assert.deepEqual(commands.find(x=>x.name==='DOM.setFileInputFiles').args,{backendNodeId:987,files:['car.png']});
  assert.deepEqual(commands.filter(x=>x.name==='Page.setInterceptFileChooserDialog').map(x=>x.args.enabled),[true,false]);
  assert.equal(debuggerApi.listenerCount('message'),0);
  await assert.rejects(browserController.uploadFiles(async()=>false,['car.png']),/control unavailable/);
  assert.equal(debuggerApi.listenerCount('message'),0,'failed activation restores chooser state too');

  const chips = new FlowReferenceController({});
  let chipRead=0;
  chips.attachments=async()=>++chipRead===1?[{source:`https://flow-content.google/image/${CAR}?old`,busy:false}]:[
    {source:`https://flow-content.google/image/${CAR}?refreshed`,busy:false},
    {source:`https://flow-content.google/image/${OTHER}`,busy:false}
  ];
  chips.openPicker=async()=>{};chips.selectExisting=async()=>null;
  chips.uploadFile=async()=>({preparation:{optimized:false}});chips.clickButton=async()=>true;
  const attached=await chips.attach({path:'new.png'});
  assert.equal(attached.provider_asset_id,OTHER,'refreshed old thumbnail URLs never identify the new ingredient');

  // Reference preparation must keep ownership until all upload operations end.
  // A job cannot finish and permit a second job while an old upload mutates UI.
  const adapter=new GoogleFlowAutomationAdapter({});
  let finish;
  let done=false;
  const pending=new Promise(resolve=>{finish=resolve;});
  const running=adapter.stage('references',async()=>{await pending;throw Error('upload timeout');},null)
    .catch(error=>{assert.match(error.message,/references: upload timeout/);done=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(done,false);
  finish();await running;
  assert.equal(done,true);

  // Fake clock verifies unload protection without slow sleeps or a live account.
  const file=path.join(__dirname,'../src/media/google-media-engine.js');
  const requireActual=createRequire(file);
  let now=1000;
  let timer;
  class FakeProvider {
    constructor(){this.visible=false;this.destroyed=0;}
    ensureView(){}
    ensureLoaded(){return Promise.resolve();}
    destroy(){this.destroyed++;}
  }
  class FakeConsumer { constructor(options){this.options=options;this.busy=false;} start(){} stop(){} }
  class FakeSession {initialize(){} }
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,console,Date:{now:()=>now},
    setTimeout:(fn,ms)=>{timer={fn,ms,unref(){}};return timer;},clearTimeout:()=>{timer=null;},
    require:name=>name==='../core-api'?{callCore:async()=>({})}:
      name==='./google-media-session-manager'?{GoogleMediaSessionManager:FakeSession,safeProfileId:x=>x}:
      name==='./media-download-manager'?{MediaDownloadManager:class{}}:
      name==='./google-flow-provider'?{GoogleFlowProvider:FakeProvider}:
      name==='./google-flow-music-provider'?{GoogleFlowMusicProvider:FakeProvider}:
      name==='./media-job-consumer'?{MediaJobConsumer:FakeConsumer}:requireActual(name)});
  const runtime=new module.exports.GoogleMediaProfileRuntime({window:{},profileId:'google'});
  runtime.touch();assert.equal(timer.ms,45000);
  now+=45001;runtime.visualConsumer.busy=true;timer.fn();
  assert.equal(runtime.visual.destroyed,0,'active downloads retain the hidden browser');
  runtime.visualConsumer.busy=false;runtime.wakingCount=1;timer.fn();
  assert.equal(runtime.visual.destroyed,0,'pending browser startup retains its view');
  runtime.wakingCount=0;runtime.visual.visible=true;timer.fn();
  assert.equal(runtime.visual.destroyed,0,'visible app views stay loaded');
  runtime.visual.visible=false;runtime.scheduleUnload();timer.fn();
  assert.equal(runtime.visual.destroyed,1);assert.equal(runtime.music.destroyed,1);
  console.log('Omni reference identity, upload isolation and browser idle workflow tests passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
