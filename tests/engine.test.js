// Engine regression tests: node tests/engine.test.js (after tools/build.sh).
// Exercises StreamLine/smoothing, pressure min-size, deferred tessellation,
// and .qsketch save/load (QSK2 round-trip, corrupt input, legacy QSK1).
const fs=require("fs");
function boot(){const m=new WebAssembly.Module(fs.readFileSync(require("path").join(__dirname,"..","web","qsketch.wasm")));
  const e=new WebAssembly.Instance(m,{env:{}}).exports; e.qs_init(); return e;}
const f32=(e,p,n)=>new Float32Array(e.memory.buffer,p,n);
let ok=true; const check=(name,cond,info="")=>{console.log((cond?"PASS":"FAIL")+"  "+name+(info?"  ("+info+")":"")); ok=ok&&cond;};

// jittery zig-zag input along y=100 at 240Hz, x 0..300
function jitter(e, streamline, smoothing){
  e.qs_begin_stroke(0xff, 4, 0.2, smoothing, streamline);
  let t=0;
  for(let i=0;i<=300;i+=2){ e.qs_add_point(i, 100+((i/2)%2?6:-6), 0.6, t); t+=4.17; }
  const id=e.qs_commit_stroke();
  // measure centerline wobble: mean |y-100| of outline midpoints is awkward; use outline bbox height
  const a=f32(e,e.qs_stroke_outline_ptr(id),e.qs_stroke_outline_count(id));
  let miny=1e9,maxy=-1e9,maxx=-1e9; for(let i=0;i<a.length;i+=2){maxx=Math.max(maxx,a[i]); if(a[i]<60||a[i]>240) continue; miny=Math.min(miny,a[i+1]);maxy=Math.max(maxy,a[i+1]);}
  return {h:maxy-miny, maxx};
}
let e=boot();
const raw=jitter(e,0,0), sm=jitter(e,0,0.8), sl=jitter(e,0.6,0), both=jitter(e,0.6,0.8);
console.log("mid-stroke band height  raw:",raw.h.toFixed(2)," smoothing:",sm.h.toFixed(2)," streamline:",sl.h.toFixed(2)," both:",both.h.toFixed(2));
check("smoothing reduces jitter", sm.h < raw.h*0.7);
check("streamline reduces jitter", sl.h < raw.h*0.7);
check("combined is as clean as either alone", both.h <= Math.min(sm.h, sl.h)+0.5 && both.h < raw.h*0.3, "wobble≈"+(both.h-2.72).toFixed(2));
check("streamline catches up to pen-lift x=300", both.maxx > 299, "maxx="+both.maxx.toFixed(2));

// rate independence: same path at 60Hz vs 240Hz should end up similarly smooth
function rate(hz){ const e=boot(); e.qs_begin_stroke(0xff,4,0.2,0,0.6); let t=0;const dt=1000/hz;
  for(let k=0;k<=hz/2;k++){const x=k*(600/hz); e.qs_add_point(x,100+((k%2)?6:-6),0.6,t); t+=dt;}
  e.qs_commit_stroke(); const a=f32(e,e.qs_stroke_outline_ptr(0),e.qs_stroke_outline_count(0));
  let miny=1e9,maxy=-1e9; for(let i=0;i<a.length;i+=2){miny=Math.min(miny,a[i+1]);maxy=Math.max(maxy,a[i+1]);} return maxy-miny;}
const r60=rate(60), r240=rate(240);
check("streamline is time-based (60Hz vs 240Hz similar)", Math.abs(r60-r240) < 4, `60Hz h=${r60.toFixed(2)} 240Hz h=${r240.toFixed(2)}`);

// min size: pressure 0 stroke thinner with minRatio 0.1 than 0.9
function width(minR){ const e=boot(); e.qs_begin_stroke(0xff,20,minR,0,0); for(let i=0;i<=50;i++) e.qs_add_point(i*4,0,0,i*8); e.qs_commit_stroke();
  const a=f32(e,e.qs_stroke_outline_ptr(0),e.qs_stroke_outline_count(0)); let mn=1e9,mx=-1e9; for(let i=1;i<a.length;i+=2){mn=Math.min(mn,a[i]);mx=Math.max(mx,a[i]);} return mx-mn;}
const w1=width(0.1), w9=width(0.9);
check("min size controls zero-pressure width", w1 < w9*0.3, `min10%=${w1.toFixed(2)} min90%=${w9.toFixed(2)}`);

// live update is deferred
e=boot(); e.qs_begin_stroke(0xff,4,0.3,0.3,0.3);
for(let i=0;i<20;i++) e.qs_add_point(i*5,0,0.5,i*8);
check("add_point doesn't tessellate", e.qs_live_outline_count()===0);
e.qs_live_update(); check("live_update tessellates", e.qs_live_outline_count()>0);
e.qs_cancel_stroke(); check("cancel clears live outline", e.qs_live_outline_count()===0);
check("cancelled stroke not committed", e.qs_commit_stroke()===-1 && e.qs_stroke_count()===0);

// QSK2 round-trip preserves look
e=boot(); e.qs_begin_stroke(0x336699ff>>>0,8,0.15,0.7,0.4); for(let i=0;i<40;i++) e.qs_add_point(i*7,Math.sin(i/4)*30,i/40,i*6); e.qs_commit_stroke();
const before=Array.from(f32(e,e.qs_stroke_outline_ptr(0),e.qs_stroke_outline_count(0)));
const sp=e.qs_save_ptr(), sl2=e.qs_save_len(), bytes=new Uint8Array(e.memory.buffer,sp,sl2).slice();
check("save header QSK2", String.fromCharCode(...bytes.slice(0,4))==="QSK2");
const e2=boot(); let p=e2.qs_alloc(bytes.length); new Uint8Array(e2.memory.buffer,p,bytes.length).set(bytes);
check("load QSK2", e2.qs_load(p,bytes.length)===1 && e2.qs_stroke_count()===1);
const after=Array.from(f32(e2,e2.qs_stroke_outline_ptr(0),e2.qs_stroke_outline_count(0)));
check("reloaded outline identical", before.length===after.length && before.every((v,i)=>Math.abs(v-after[i])<1e-4));
check("fresh file has no undo history", e2.qs_can_undo()===0);

// corrupt / truncated file must not wipe the drawing
const trunc=bytes.slice(0,bytes.length-10); p=e2.qs_alloc(trunc.length); new Uint8Array(e2.memory.buffer,p,trunc.length).set(trunc);
check("truncated file rejected", e2.qs_load(p,trunc.length)===0);
check("drawing survives bad load", e2.qs_stroke_count()===1 && e2.qs_stroke_alive(0)===1);

// legacy QSK1 still loads
const q1=[...Buffer.from("QSK1")]; const dv=new DataView(new ArrayBuffer(4+4+12+12*3));
dv.setUint32(0,0x514b5331,false); dv.setUint32(4,1,true); dv.setUint32(8,0xff0000ff,true); dv.setFloat32(12,5,true); dv.setUint32(16,3,true);
[[0,0,.5],[20,0,.5],[40,5,.5]].forEach((v,i)=>{dv.setFloat32(20+i*12,v[0],true);dv.setFloat32(24+i*12,v[1],true);dv.setFloat32(28+i*12,v[2],true);});
const legacy=new Uint8Array(dv.buffer); legacy.set(q1,0);
const e3=boot(); p=e3.qs_alloc(legacy.length); new Uint8Array(e3.memory.buffer,p,legacy.length).set(legacy);
check("legacy QSK1 loads", e3.qs_load(p,legacy.length)===1 && e3.qs_stroke_count()===1 && e3.qs_stroke_outline_count(0)>0);

console.log(ok?"\nALL ENGINE TESTS PASS":"\nSOME TESTS FAILED"); process.exit(ok?0:1);
